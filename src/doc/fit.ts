/**
 * Turns a hand-drawn stroke into a few smooth cubic Bézier segments (Philip J. Schneider's
 * curve-fitting algorithm, "Graphics Gems", 1990 — the approach behind Illustrator's pencil).
 * Works in 2D; callers flatten the sphere locally first.
 */
export type P2 = [number, number];

export interface Cubic {
  p0: P2;
  c0: P2;
  c1: P2;
  p1: P2;
  /** True if p0 is a sharp corner (handles independent). */
  corner: boolean;
}

const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const mul = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const norm = (a: P2): P2 => {
  const l = Math.hypot(a[0], a[1]);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0];
};

function bez(b: Cubic, t: number): P2 {
  const u = 1 - t;
  const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
  return [k0 * b.p0[0] + k1 * b.c0[0] + k2 * b.c1[0] + k3 * b.p1[0], k0 * b.p0[1] + k1 * b.c0[1] + k2 * b.c1[1] + k3 * b.p1[1]];
}

/** Evenly spaced points along a polyline (removes the jitter of uneven mouse sampling). */
function resample(pts: P2[], step: number, closed: boolean): P2[] {
  const src = closed ? [...pts, pts[0]] : pts;
  const out: P2[] = [src[0]];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    const len = dist(a, b);
    let d = step - carry;
    while (d <= len) {
      out.push(add(a, mul(sub(b, a), d / len)));
      d += step;
    }
    carry = len - (d - step);
  }
  if (closed) {
    if (out.length > 1 && dist(out[out.length - 1], out[0]) < step * 0.5) out.pop();
  } else if (dist(out[out.length - 1], src[src.length - 1]) > step * 0.3) {
    out.push(src[src.length - 1]);
  }
  return out;
}

function smooth(pts: P2[], closed: boolean): P2[] {
  const n = pts.length;
  return pts.map((p, i) => {
    if (!closed && (i === 0 || i === n - 1)) return p;
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
  });
}

/** Indices where the stroke turns sharply (local maxima of turning angle above the threshold). */
function corners(pts: P2[], closed: boolean, reach: number, minAngle: number): number[] {
  const n = pts.length;
  const turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!closed && (i < reach || i >= n - reach)) continue;
    const a = pts[(i - reach + n) % n], p = pts[i], b = pts[(i + reach) % n];
    const u = norm(sub(p, a)), v = norm(sub(b, p));
    turn[i] = Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < minAngle) continue;
    let isMax = true;
    for (let k = -reach; k <= reach && isMax; k++) {
      const j = closed ? (i + k + n) % n : i + k;
      if (j >= 0 && j < n && k !== 0 && (turn[j] > turn[i] || (turn[j] === turn[i] && k < 0))) isMax = false;
    }
    if (isMax) out.push(i);
  }
  return out;
}

function chordParams(d: P2[]): number[] {
  const u = [0];
  for (let i = 1; i < d.length; i++) u.push(u[i - 1] + dist(d[i], d[i - 1]));
  const total = u[u.length - 1] || 1;
  return u.map((x) => x / total);
}

function generate(d: P2[], u: number[], t1: P2, t2: P2): Cubic {
  const first = d[0], last = d[d.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < d.length; i++) {
    const t = u[i], s = 1 - t;
    const b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
    const a0 = mul(t1, b1), a1 = mul(t2, b2);
    c00 += dot(a0, a0);
    c01 += dot(a0, a1);
    c11 += dot(a1, a1);
    const tmp = sub(d[i], add(mul(first, b0 + b1), mul(last, b2 + b3)));
    x0 += dot(a0, tmp);
    x1 += dot(a1, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let al = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let ar = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const seg = dist(first, last);
  if (al < 1e-6 * seg || ar < 1e-6 * seg) al = ar = seg / 3;
  return { p0: first, c0: add(first, mul(t1, al)), c1: add(last, mul(t2, ar)), p1: last, corner: false };
}

function maxError(d: P2[], b: Cubic, u: number[]): { err: number; at: number } {
  let err = 0, at = Math.floor(d.length / 2);
  for (let i = 1; i < d.length - 1; i++) {
    const e = dist(bez(b, u[i]), d[i]);
    if (e > err) {
      err = e;
      at = i;
    }
  }
  return { err, at };
}

/** One Newton–Raphson step per point towards the closest parameter on the curve. */
function reparameterize(d: P2[], b: Cubic, u: number[]): number[] {
  return u.map((t, i) => {
    const s = 1 - t;
    const q = bez(b, t);
    const q1 = add(add(mul(sub(b.c0, b.p0), 3 * s * s), mul(sub(b.c1, b.c0), 6 * s * t)), mul(sub(b.p1, b.c1), 3 * t * t));
    const q2 = add(mul(add(sub(b.c1, mul(b.c0, 2)), b.p0), 6 * s), mul(add(sub(b.p1, mul(b.c1, 2)), b.c0), 6 * t));
    const diff = sub(q, d[i]);
    const den = dot(q1, q1) + dot(diff, q2);
    return den === 0 ? t : Math.max(0, Math.min(1, t - dot(diff, q1) / den));
  });
}

function fitPiece(d: P2[], t1: P2, t2: P2, tol: number, out: Cubic[], depth = 0): void {
  if (d.length === 2) {
    const k = dist(d[0], d[1]) / 3;
    out.push({ p0: d[0], c0: add(d[0], mul(t1, k)), c1: add(d[1], mul(t2, k)), p1: d[1], corner: false });
    return;
  }
  let u = chordParams(d);
  let b = generate(d, u, t1, t2);
  let { err, at } = maxError(d, b, u);
  if (err < tol) return void out.push(b);
  if (err < tol * 4) {
    for (let i = 0; i < 20; i++) {
      u = reparameterize(d, b, u);
      b = generate(d, u, t1, t2);
      ({ err, at } = maxError(d, b, u));
      if (err < tol) return void out.push(b);
    }
  }
  if (depth > 30 || d.length < 4) return void out.push(b);
  at = Math.max(1, Math.min(d.length - 2, at));
  const centre = norm(sub(d[at - 1], d[at + 1]));
  fitPiece(d.slice(0, at + 1), t1, centre, tol, out, depth + 1);
  fitPiece(d.slice(at), mul(centre, -1), t2, tol, out, depth + 1);
}

/** Tangent leaving index i heading towards increasing indices, averaged over a few points. */
function tangentAt(d: P2[], i: number, dir: 1 | -1, reach: number): P2 {
  const j = Math.max(0, Math.min(d.length - 1, i + dir * reach));
  return norm(sub(d[j], d[i]));
}

/**
 * Fit a stroke. `tol` is the allowed deviation and `step` the resampling distance, both in the
 * stroke's units; corners sharper than `cornerDeg` are kept sharp.
 */
export function fitStroke(raw: P2[], closed: boolean, tol: number, step = tol, cornerDeg = 65): Cubic[] {
  if (raw.length < 2) return [];
  let pts = resample(raw, step, closed);
  if (pts.length < 3) {
    if (closed || pts.length < 2) return [];
    return [{ p0: pts[0], c0: add(pts[0], mul(sub(pts[1], pts[0]), 1 / 3)), c1: add(pts[0], mul(sub(pts[1], pts[0]), 2 / 3)), p1: pts[1], corner: false }];
  }
  pts = smooth(smooth(pts, closed), closed);
  const reach = 3;
  const cs = corners(pts, closed, reach, (cornerDeg * Math.PI) / 180);
  const out: Cubic[] = [];

  if (closed && cs.length === 0) {
    // Smooth loop: start anywhere, with the same tangent leaving and arriving.
    const loop = [...pts, pts[0]];
    const t = norm(sub(pts[1], pts[pts.length - 1]));
    fitPiece(loop, t, mul(t, -1), tol, out);
    return out;
  }

  // Split at corners (for loops, rotate so the stroke starts on a corner).
  const n = pts.length;
  const cuts = closed ? cs : [0, ...cs.filter((c) => c > 0 && c < n - 1), n - 1];
  const pieces = closed ? cuts.length : cuts.length - 1;
  for (let k = 0; k < pieces; k++) {
    const a = cuts[k], b = closed ? cuts[(k + 1) % cuts.length] : cuts[k + 1];
    const piece: P2[] = [];
    for (let i = a; ; i = (i + 1) % n) {
      piece.push(pts[i]);
      if (i === b && piece.length > 1) break;
      if (piece.length > n + 1) break;
    }
    if (piece.length < 2) continue;
    const start = out.length;
    fitPiece(piece, tangentAt(piece, 0, 1, reach), tangentAt(piece, piece.length - 1, -1, reach), tol, out);
    if (closed || k > 0) out[start].corner = true;
  }
  return out;
}
