import type { Vec3 } from '../core/math';

/** Geographic position in degrees: [longitude, latitude] (GeoJSON / d3 order). */
export type LonLat = [number, number];

export const DEG = 180 / Math.PI;

export function toLonLat(x: number, y: number, z: number): LonLat {
  return [Math.atan2(x, z) * DEG, Math.asin(Math.max(-1, Math.min(1, y))) * DEG];
}

export function fromLonLat([lon, lat]: LonLat): Vec3 {
  const la = lat / DEG, lo = lon / DEG, c = Math.cos(la);
  return [c * Math.sin(lo), Math.sin(la), c * Math.cos(lo)];
}

function pushUnit(out: number[], x: number, y: number, z: number): void {
  const l = Math.hypot(x, y, z) || 1;
  out.push(x / l, y / l, z / l);
}

/** Chaikin corner cutting on a closed ring of flat xyz points, kept on the unit sphere. */
export function chaikinClosed(pts: number[], iterations: number): number[] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const n = cur.length / 3;
    if (n < 3) return cur;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = i * 3, b = ((i + 1) % n) * 3;
      pushUnit(out, 0.75 * cur[a] + 0.25 * cur[b], 0.75 * cur[a + 1] + 0.25 * cur[b + 1], 0.75 * cur[a + 2] + 0.25 * cur[b + 2]);
      pushUnit(out, 0.25 * cur[a] + 0.75 * cur[b], 0.25 * cur[a + 1] + 0.75 * cur[b + 1], 0.25 * cur[a + 2] + 0.75 * cur[b + 2]);
    }
    cur = out;
  }
  return cur;
}

/**
 * Chaikin on an open polyline with fixed endpoints. `attrs` holds one value per segment and is
 * carried through, so callers can still tell which source segment each output segment came from.
 */
export function chaikinOpen(pts: number[], attrs: number[], iterations: number): { pts: number[]; attrs: number[] } {
  let cur = pts, cattr = attrs;
  for (let it = 0; it < iterations; it++) {
    const n = cur.length / 3;
    if (n < 3) break;
    const out: number[] = [cur[0], cur[1], cur[2]];
    const oattr: number[] = [cattr[0]];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 3, b = a + 3;
      pushUnit(out, 0.75 * cur[a] + 0.25 * cur[b], 0.75 * cur[a + 1] + 0.25 * cur[b + 1], 0.75 * cur[a + 2] + 0.25 * cur[b + 2]);
      pushUnit(out, 0.25 * cur[a] + 0.75 * cur[b], 0.25 * cur[a + 1] + 0.75 * cur[b + 1], 0.25 * cur[a + 2] + 0.75 * cur[b + 2]);
      oattr.push(cattr[i], i < n - 2 ? cattr[i + 1] : cattr[i]);
    }
    out.push(cur[(n - 1) * 3], cur[(n - 1) * 3 + 1], cur[(n - 1) * 3 + 2]);
    cur = out;
    cattr = oattr;
  }
  return { pts: cur, attrs: cattr };
}

function segDist(px: number, py: number, pz: number, pts: number[], a: number, b: number): number {
  const ax = pts[a * 3], ay = pts[a * 3 + 1], az = pts[a * 3 + 2];
  const dx = pts[b * 3] - ax, dy = pts[b * 3 + 1] - ay, dz = pts[b * 3 + 2] - az;
  const dd = dx * dx + dy * dy + dz * dz;
  const t = dd > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / dd)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t, pz - az - dz * t);
}

/** Douglas–Peucker on an open polyline (flat xyz); returns kept indices, always including both ends. */
export function simplifyIndices(pts: number[], first: number, last: number, tol: number): number[] {
  const keep = [first];
  const stack: [number, number][] = [[first, last]];
  const marked = new Set<number>([first, last]);
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], pts, a, b);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      marked.add(worst);
      stack.push([a, worst], [worst, b]);
    }
  }
  for (let i = first + 1; i <= last; i++) if (marked.has(i)) keep.push(i);
  return keep;
}

/** A small set of control points that reproduces a polyline (flat xyz) within `tol`. */
export function controlPoints(pts: number[], closed: boolean, tol: number): Vec3[] {
  const n = pts.length / 3;
  const at = (i: number): Vec3 => [pts[(i % n) * 3], pts[(i % n) * 3 + 1], pts[(i % n) * 3 + 2]];
  if (!closed) return simplifyIndices(pts, 0, n - 1, tol).map(at);
  // Split the ring in two halves so Douglas–Peucker has fixed ends to work from.
  const half = Math.floor(n / 2);
  const ring = pts.concat(pts.slice(0, 3));
  const idx = [...simplifyIndices(ring, 0, half, tol), ...simplifyIndices(ring, half, n, tol).slice(1, -1)];
  if (idx.length < 3) idx.splice(1, 0, Math.floor(half / 2));
  return idx.map(at);
}

/** Catmull–Rom spline through control points on the sphere, sampled every ~`step` (chord). */
export function catmullRom(ctrl: Vec3[], closed: boolean, step: number): { pts: Vec3[]; span: number[] } {
  const n = ctrl.length;
  const get = (i: number) => (closed ? ctrl[((i % n) + n) % n] : ctrl[Math.max(0, Math.min(n - 1, i))]);
  const spans = closed ? n : n - 1;
  const pts: Vec3[] = [];
  const span: number[] = [];
  for (let s = 0; s < spans; s++) {
    const p0 = get(s - 1), p1 = get(s), p2 = get(s + 1), p3 = get(s + 2);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
    const samples = Math.max(2, Math.ceil(len / step));
    for (let k = 0; k < samples; k++) {
      const t = k / samples, t2 = t * t, t3 = t2 * t;
      const v = [0, 1, 2].map(
        (c) => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3),
      );
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      pts.push([v[0] / l, v[1] / l, v[2] / l]);
      span.push(s);
    }
  }
  if (!closed) {
    pts.push(ctrl[n - 1]);
    span.push(spans - 1);
  }
  return { pts, span };
}

/** Flat xyz ring → closed GeoJSON ring. d3 wants exterior rings clockwise, the reverse of ours. */
export function ringToLonLat(pts: number[], reverse: boolean): LonLat[] {
  const n = pts.length / 3;
  const out: LonLat[] = [];
  for (let k = 0; k < n; k++) {
    const i = reverse ? n - 1 - k : k;
    out.push(toLonLat(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]));
  }
  out.push(out[0]);
  return out;
}

export function lineToLonLat(pts: number[]): LonLat[] {
  const out: LonLat[] = [];
  for (let i = 0; i < pts.length; i += 3) out.push(toLonLat(pts[i], pts[i + 1], pts[i + 2]));
  return out;
}
