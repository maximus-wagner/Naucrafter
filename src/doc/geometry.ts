import type { Vec3 } from '../core/math';
import { Fbm } from '../core/noise';
import type { PathNode, VPath } from './model';

export const RAD = Math.PI / 180;

export function unit(x: number, y: number, z: number): Vec3 {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Angle between two unit vectors (radians). */
export function angle(a: Vec3, b: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Point a fraction `t` of the way along the great circle from a to b. */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const w = angle(a, b);
  if (w < 1e-9) return a;
  const s = Math.sin(w);
  const ka = Math.sin((1 - t) * w) / s, kb = Math.sin(t * w) / s;
  return unit(a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb);
}

/** Cubic Bézier evaluated in 3D and pushed back onto the sphere. */
export function bezier(p0: Vec3, c0: Vec3, c1: Vec3, p1: Vec3, t: number): Vec3 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return unit(
    a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0],
    a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1],
    a * p0[2] + b * c0[2] + c * c1[2] + d * p1[2],
  );
}

export function segmentCount(path: VPath): number {
  return path.closed ? path.nodes.length : Math.max(0, path.nodes.length - 1);
}

export function segmentControls(path: VPath, i: number): [Vec3, Vec3, Vec3, Vec3] {
  const a = path.nodes[i], b = path.nodes[(i + 1) % path.nodes.length];
  return [a.p, a.hout ?? a.p, b.hin ?? b.p, b.p];
}

/**
 * Sample a path every ~`step` radians. Returns flat xyz points and, per point, the segment it
 * lies on (used to insert nodes where the user clicks).
 */
export function flatten(path: VPath, step: number): { pts: number[]; seg: number[] } {
  const pts: number[] = [];
  const seg: number[] = [];
  const segs = segmentCount(path);
  for (let i = 0; i < segs; i++) {
    const [p0, c0, c1, p1] = segmentControls(path, i);
    const len = angle(p0, c0) + angle(c0, c1) + angle(c1, p1);
    const samples = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < samples; k++) {
      const q = bezier(p0, c0, c1, p1, k / samples);
      pts.push(q[0], q[1], q[2]);
      seg.push(i);
    }
  }
  if (!path.closed && path.nodes.length) {
    const last = path.nodes[path.nodes.length - 1].p;
    pts.push(last[0], last[1], last[2]);
    seg.push(Math.max(0, segs - 1));
  }
  return { pts, seg };
}

/** Split segment i at parameter t (de Casteljau) without changing the curve's shape. */
export function splitSegment(path: VPath, i: number, t: number): number {
  const n = path.nodes.length;
  const a = path.nodes[i], b = path.nodes[(i + 1) % n];
  const [p0, p1, p2, p3] = segmentControls(path, i);
  const q0 = lerp(p0, p1, t), q1 = lerp(p1, p2, t), q2 = lerp(p2, p3, t);
  const r0 = lerp(q0, q1, t), r1 = lerp(q1, q2, t);
  const s = lerp(r0, r1, t);
  const curved = a.hout !== null || b.hin !== null;
  if (a.hout) a.hout = unit(...q0);
  if (b.hin) b.hin = unit(...q2);
  const mid: PathNode = { p: unit(...s), hin: curved ? unit(...r0) : null, hout: curved ? unit(...r1) : null };
  if (a.section) mid.section = a.section;
  path.nodes.splice(i + 1, 0, mid);
  return i + 1;
}

/** Rotation of the sphere that carries `a` onto `b` along the great circle between them. */
export function rotation(a: Vec3, b: Vec3): (v: Vec3) => Vec3 {
  const kx = a[1] * b[2] - a[2] * b[1], ky = a[2] * b[0] - a[0] * b[2], kz = a[0] * b[1] - a[1] * b[0];
  const s = Math.hypot(kx, ky, kz);
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (s < 1e-12) return (v) => v;
  const x = kx / s, y = ky / s, z = kz / s;
  return (v) => {
    const kv = x * v[0] + y * v[1] + z * v[2];
    return unit(
      v[0] * c + (y * v[2] - z * v[1]) * s + x * kv * (1 - c),
      v[1] * c + (z * v[0] - x * v[2]) * s + y * kv * (1 - c),
      v[2] * c + (x * v[1] - y * v[0]) * s + z * kv * (1 - c),
    );
  };
}

/** Move a node, carrying its handles with it. */
export function moveNode(node: PathNode, to: Vec3): void {
  const r = rotation(node.p, to);
  node.p = to;
  if (node.hin) node.hin = r(node.hin);
  if (node.hout) node.hout = r(node.hout);
}

/** Point reflection through `p` on the sphere (180° turn about p): mirrors a handle. */
export function mirror(p: Vec3, h: Vec3): Vec3 {
  const d = 2 * (p[0] * h[0] + p[1] * h[1] + p[2] * h[2]);
  return unit(d * p[0] - h[0], d * p[1] - h[1], d * p[2] - h[2]);
}

/** Make a node smooth (handles along the neighbours' direction) or a sharp corner. */
export function setSmooth(path: VPath, i: number, smooth: boolean): void {
  const node = path.nodes[i];
  delete node.corner;
  if (!smooth) {
    node.hin = node.hout = null;
    return;
  }
  const n = path.nodes.length;
  const prev = path.nodes[(i - 1 + n) % n].p, next = path.nodes[(i + 1) % n].p;
  const hasPrev = path.closed || i > 0, hasNext = path.closed || i < n - 1;
  const from = hasPrev ? prev : node.p, to = hasNext ? next : node.p;
  const dir = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const reach = (Math.min(hasPrev ? angle(prev, node.p) : Infinity, hasNext ? angle(next, node.p) : Infinity) / 3) || 0.02;
  const off: Vec3 = [(dir[0] / len) * reach, (dir[1] / len) * reach, (dir[2] / len) * reach];
  node.hout = unit(node.p[0] + off[0], node.p[1] + off[1], node.p[2] + off[2]);
  node.hin = unit(node.p[0] - off[0], node.p[1] - off[1], node.p[2] - off[2]);
}

/** Azimuthal equidistant projection centred on `c`: exact angles from the centre, fine up to ~170°. */
export function azimuthal(c: Vec3) {
  const up: Vec3 = Math.abs(c[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  const e = unit(up[1] * c[2] - up[2] * c[1], up[2] * c[0] - up[0] * c[2], up[0] * c[1] - up[1] * c[0]);
  const n: Vec3 = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]];
  return {
    forward(x: number, y: number, z: number): [number, number] {
      const a = Math.acos(Math.max(-1, Math.min(1, x * c[0] + y * c[1] + z * c[2])));
      const px = x * e[0] + y * e[1] + z * e[2], py = x * n[0] + y * n[1] + z * n[2];
      const l = Math.hypot(px, py);
      return l < 1e-12 ? [0, 0] : [(px / l) * a, (py / l) * a];
    },
    inverse(px: number, py: number): Vec3 {
      const a = Math.hypot(px, py);
      if (a < 1e-12) return c;
      const s = Math.sin(a) / a, co = Math.cos(a);
      return unit(c[0] * co + (e[0] * px + n[0] * py) * s, c[1] * co + (e[1] * px + n[1] * py) * s, c[2] * co + (e[2] * px + n[2] * py) * s);
    },
  };
}

// ---------------------------------------------------------------- roughening

const ROUGH_STEP = 0.1 * RAD;
const ROUGH_AMPLITUDE = 0.9 * RAD;
const ROUGH_FREQUENCY = 9;
const noiseCache = new Map<string, Fbm>();

function densify(pts: number[], closed: boolean, step: number): number[] {
  const n = pts.length / 3;
  const out: number[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a: Vec3 = [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
    const j = (i + 1) % n;
    const b: Vec3 = [pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2]];
    const k = Math.max(1, Math.ceil(angle(a, b) / step));
    for (let s = 0; s < k; s++) out.push(...unit(...lerp(a, b, s / k)));
  }
  if (!closed && n) out.push(pts[(n - 1) * 3], pts[(n - 1) * 3 + 1], pts[(n - 1) * 3 + 2]);
  return out;
}

/**
 * Non-destructive procedural detail: push each point sideways by fractal noise sampled at its
 * position on the planet. Because the noise is tied to position, untouched stretches keep their
 * detail while you edit elsewhere, and detail slides smoothly while you drag.
 * Open paths keep their endpoints fixed.
 */
/** `level` adds finer detail for deep zoom (each level halves the sample spacing). */
export function roughen(pts: number[], closed: boolean, amount: number, seed: string, level = 0): number[] {
  if (amount <= 0 || pts.length < 6) return pts;
  let noise = noiseCache.get(seed);
  if (!noise) noiseCache.set(seed, (noise = new Fbm(seed, 'roughen')));
  const dense = densify(pts, closed, ROUGH_STEP / 2 ** level);
  const n = dense.length / 3;
  const out: number[] = [];
  const at = (i: number): Vec3 => {
    const k = closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    return [dense[k * 3], dense[k * 3 + 1], dense[k * 3 + 2]];
  };
  for (let i = 0; i < n; i++) {
    const p = at(i), prev = at(i - 1), next = at(i + 1);
    const t: Vec3 = [next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]];
    // Left normal in the tangent plane: p × t.
    const nx = p[1] * t[2] - p[2] * t[1], ny = p[2] * t[0] - p[0] * t[2], nz = p[0] * t[1] - p[1] * t[0];
    const nl = Math.hypot(nx, ny, nz) || 1;
    const taper = closed ? 1 : Math.min(1, Math.min(i, n - 1 - i) / 12);
    const d = amount * ROUGH_AMPLITUDE * taper * noise.fbmDetail(p[0] * ROUGH_FREQUENCY, p[1] * ROUGH_FREQUENCY, p[2] * ROUGH_FREQUENCY, 7, level, 2, 0.55);
    out.push(...unit(p[0] + (nx / nl) * d, p[1] + (ny / nl) * d, p[2] + (nz / nl) * d));
  }
  return out;
}
