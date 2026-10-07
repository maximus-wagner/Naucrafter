import type { Vec3 } from '../core/math';
import { azimuthal, unit } from './geometry';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function vectors(pts: number[]): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < pts.length; i += 3) out.push([pts[i], pts[i + 1], pts[i + 2]]);
  return out;
}

/** Radius of the circle through three points (Infinity when they are collinear or coincide). */
export function circumradius(a: Vec3, b: Vec3, c: Vec3): number {
  const ab = sub(b, a), ac = sub(c, a), bc = sub(c, b);
  const cx = ab[1] * ac[2] - ab[2] * ac[1], cy = ab[2] * ac[0] - ab[0] * ac[2], cz = ab[0] * ac[1] - ab[1] * ac[0];
  const area2 = Math.hypot(cx, cy, cz);
  return area2 < 1e-18 ? Infinity : (Math.hypot(...ab) * Math.hypot(...ac) * Math.hypot(...bc)) / (2 * area2);
}

/** Fraction (0–1) of the way along the polyline of every point, by chord length. */
export function arcFractions(pts: number[]): number[] {
  const n = pts.length / 3;
  const along: number[] = [0];
  for (let i = 1; i < n; i++) {
    const a = i * 3 - 3, b = i * 3;
    along.push(along[i - 1] + Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1], pts[b + 2] - pts[a + 2]));
  }
  const total = along[n - 1] || 1;
  return along.map((d) => d / total);
}

/**
 * Round off any bend of an open polyline (flat xyz on the unit sphere) that is tighter than
 * `minRadius(fraction along the line)` radians, by pulling the offending points towards the
 * midpoint of their neighbours until the bend opens up. Endpoints stay put. A river drawn
 * with this never folds over itself: its banks can't overlap at a bend.
 */
export function relaxBends(pts: number[], minRadius: (frac: number) => number, maxPasses = 400): number[] {
  const n = pts.length / 3;
  if (n < 3) return pts;
  const p = vectors(pts);
  const limit = arcFractions(pts).map(minRadius);
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (let i = 1; i < n - 1; i++) {
      if (circumradius(p[i - 1], p[i], p[i + 1]) >= limit[i]) continue;
      const a = p[i - 1], b = p[i + 1], c = p[i];
      p[i] = unit(c[0] + ((a[0] + b[0]) / 2 - c[0]) * 0.5, c[1] + ((a[1] + b[1]) / 2 - c[1]) * 0.5, c[2] + ((a[2] + b[2]) / 2 - c[2]) * 0.5);
      moved = true;
    }
    if (!moved) break;
  }
  return p.flatMap((v) => v);
}

type P2 = [number, number];

/** Where segments ab and cd cross (as a fraction along ab), or null if they don't properly cross. */
function crossing(a: P2, b: P2, c: P2, d: P2): number | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-18) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denom;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denom;
  return t > 0 && t < 1 && u > 0 && u < 1 ? t : null;
}

/**
 * Cut out every loop where an open polyline (flat xyz) crosses itself, keeping the course either
 * side of it: water can't flow across itself. Cuts are made in a flat map centred on the line.
 */
export function removeLoops(pts: number[], maxCuts = 64): number[] {
  const n0 = pts.length / 3;
  if (n0 < 4) return pts;
  let p = vectors(pts);
  const centre = unit(...(p.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]) as Vec3));
  const flat = azimuthal(centre);
  let q: P2[] = p.map((v) => flat.forward(...v));
  let cuts = 0;
  for (let i = 0; i < q.length - 3 && cuts < maxCuts; i++) {
    const a = q[i], b = q[i + 1];
    const lox = Math.min(a[0], b[0]), hix = Math.max(a[0], b[0]), loy = Math.min(a[1], b[1]), hiy = Math.max(a[1], b[1]);
    for (let j = i + 2; j < q.length - 1; j++) {
      const c = q[j], d = q[j + 1];
      if (Math.max(c[0], d[0]) < lox || Math.min(c[0], d[0]) > hix || Math.max(c[1], d[1]) < loy || Math.min(c[1], d[1]) > hiy) continue;
      const t = crossing(a, b, c, d);
      if (t === null) continue;
      const x: P2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      p = [...p.slice(0, i + 1), flat.inverse(...x), ...p.slice(j + 1)];
      q = [...q.slice(0, i + 1), x, ...q.slice(j + 1)];
      cuts++;
      i--; // look at the same segment again: the new course might cross something else
      break;
    }
  }
  return cuts ? p.flatMap((v) => v) : pts;
}
