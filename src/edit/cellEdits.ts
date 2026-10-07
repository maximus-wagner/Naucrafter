import { geoArea, geoBounds, geoContains } from 'd3-geo';
import type { Polygon } from 'geojson';
import { nearestCell, spread, type SphereMesh } from '../world/sphereMesh';
import type { Vec3 } from '../core/math';
import { toLonLat, type LonLat } from '../vector/geo';

export type Relabel = [cell: number, label: number];

function minDist(p: Vec3, curve: Vec3[]): number {
  let best = Infinity;
  for (const q of curve) {
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Which side of a polyline a point lies on: +1 left, −1 right (seen from outside, walking along
 * the curve), 0 if its nearest point is an open end (the point is "beyond" the curve).
 */
function sideOf(curve: Vec3[], closed: boolean, p: Vec3): number {
  const segs = closed ? curve.length : curve.length - 1;
  let best = Infinity, bestSide = 0;
  for (let s = 0; s < segs; s++) {
    const a = curve[s], b = curve[(s + 1) % curve.length];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const tRaw = dd > 0 ? (ap[0] * d[0] + ap[1] * d[1] + ap[2] * d[2]) / dd : 0;
    const t = Math.max(0, Math.min(1, tRaw));
    const dist = Math.hypot(ap[0] - d[0] * t, ap[1] - d[1] * t, ap[2] - d[2] * t);
    if (dist < best) {
      best = dist;
      const beyondEnd = !closed && ((s === 0 && tRaw < 0) || (s === segs - 1 && tRaw > 1));
      // Left of travel direction d at surface normal p is p × d.
      const lx = p[1] * d[2] - p[2] * d[1], ly = p[2] * d[0] - p[0] * d[2], lz = p[0] * d[1] - p[1] * d[0];
      bestSide = beyondEnd ? 0 : Math.sign(ap[0] * lx + ap[1] * ly + ap[2] * lz);
    }
  }
  return bestSide;
}

/**
 * A border between labels `left` and `right` was reshaped from `oldCurve` to `newCurve`.
 * Returns the cells that change sides; cells of other labels and cells away from the
 * reshaped stretch are left alone.
 */
export function borderEditRelabels(
  mesh: SphereMesh,
  labels: ArrayLike<number>,
  left: number,
  right: number,
  oldCurve: Vec3[],
  newCurve: Vec3[],
  closed: boolean,
): Relabel[] {
  const eps = mesh.spacing * 0.25;
  const changed: Vec3[] = [];
  let maxShift = 0;
  for (const [from, to] of [[newCurve, oldCurve], [oldCurve, newCurve]]) {
    for (const p of from) {
      const d = minDist(p, to);
      if (d > eps) {
        changed.push(p);
        maxShift = Math.max(maxShift, d);
      }
    }
  }
  if (changed.length === 0) return [];

  let hint = 0;
  const seeds = changed.map((p) => (hint = nearestCell(mesh, p[0], p[1], p[2], hint)));
  const reach = maxShift + 2.5 * mesh.spacing;
  const { dist } = spread(mesh, seeds, undefined, () => reach);

  const out: Relabel[] = [];
  for (let c = 0; c < mesh.n; c++) {
    if (dist[c] === Infinity) continue;
    const label = labels[c];
    if (label !== left && label !== right) continue;
    const side = sideOf(newCurve, closed, [mesh.xyz[c * 3], mesh.xyz[c * 3 + 1], mesh.xyz[c * 3 + 2]]);
    const want = side > 0 ? left : side < 0 ? right : label;
    if (want !== label) out.push([c, want]);
  }
  return out;
}

/** Cells whose centres lie inside a drawn polygon (any winding; the smaller side is "inside"). */
export function cellsInPolygon(mesh: SphereMesh, ring: LonLat[]): number[] {
  if (ring.length < 3) return [];
  const closedRing = [...ring, ring[0]];
  let poly: Polygon = { type: 'Polygon', coordinates: [closedRing] };
  if (geoArea(poly) > 2 * Math.PI) poly = { type: 'Polygon', coordinates: [closedRing.slice().reverse()] };
  const [[x0, y0], [x1, y1]] = geoBounds(poly);
  const out: number[] = [];
  for (let c = 0; c < mesh.n; c++) {
    const p = toLonLat(mesh.xyz[c * 3], mesh.xyz[c * 3 + 1], mesh.xyz[c * 3 + 2]);
    if (p[1] < y0 || p[1] > y1) continue;
    if (x0 <= x1 ? p[0] < x0 || p[0] > x1 : p[0] < x0 && p[0] > x1) continue;
    if (geoContains(poly, p)) out.push(c);
  }
  return out;
}
