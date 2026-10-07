import polygonClipping, { type MultiPolygon as PlanarMulti, type Polygon as PlanarPolygon, type Ring as PlanarRing } from 'polygon-clipping';
import type { GeoPermissibleObjects } from 'd3-geo';
import type { MultiLineString, MultiPolygon } from 'geojson';
import type { Vec3 } from '../core/math';
import { angle, azimuthal, unit } from './geometry';
import { ringToLonLat } from '../vector/geo';

export interface LandInput {
  op: 'add' | 'cut';
  /** Closed ring, flat xyz (either winding). */
  ring: number[];
}

export interface LandResult {
  /** Polygons as rings (flat xyz); exteriors counter-clockwise seen from outside, holes clockwise. */
  polygons: number[][][];
  /** The same, ready for d3 (empty MultiPolygon when there is no land). */
  geo: GeoPermissibleObjects;
  /**
   * Every coastline as a closed line. Stroke these, not the polygon: a clipped polygon gains
   * artificial edges along the globe's horizon and the date line, and those must not be inked.
   */
  lines: MultiLineString;
}

function capOf(ring: number[]): { c: Vec3; r: number } {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < ring.length; i += 3) {
    x += ring[i];
    y += ring[i + 1];
    z += ring[i + 2];
  }
  const c = unit(x, y, z);
  let r = 0;
  for (let i = 0; i < ring.length; i += 3) r = Math.max(r, angle(c, [ring[i], ring[i + 1], ring[i + 2]]));
  return { c, r };
}

/**
 * Land = union of "add" shapes minus union of "cut" shapes. Boolean ops run in a planar
 * projection per cluster of overlapping shapes, which keeps distortion irrelevant to topology.
 */
export function composeLand(inputs: LandInput[]): LandResult {
  const items = inputs.filter((s) => s.ring.length >= 9).map((s) => ({ ...s, cap: capOf(s.ring) }));

  // Union-find clusters of shapes whose bounding caps overlap.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (angle(items[i].cap.c, items[j].cap.c) < items[i].cap.r + items[j].cap.r) parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, typeof items>();
  items.forEach((it, i) => {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(it);
  });

  const polygons: number[][][] = [];
  for (const cluster of clusters.values()) {
    const adds = cluster.filter((s) => s.op === 'add');
    if (adds.length === 0) continue;
    let sx = 0, sy = 0, sz = 0;
    for (const s of cluster) {
      sx += s.cap.c[0] * s.cap.r;
      sy += s.cap.c[1] * s.cap.r;
      sz += s.cap.c[2] * s.cap.r;
    }
    const centre = unit(sx, sy, sz);
    if (cluster.some((s) => angle(centre, s.cap.c) + s.cap.r > 170 * (Math.PI / 180))) {
      // Too big to flatten safely: draw the land shapes as they are.
      for (const s of adds) polygons.push([s.ring]);
      continue;
    }
    const proj = azimuthal(centre);
    const toPlanar = (ring: number[]): PlanarPolygon => {
      const r: PlanarRing = [];
      for (let i = 0; i < ring.length; i += 3) r.push(proj.forward(ring[i], ring[i + 1], ring[i + 2]));
      r.push(r[0]);
      return [r];
    };
    let land: PlanarMulti = polygonClipping.union(toPlanar(adds[0].ring), ...adds.slice(1).map((s) => toPlanar(s.ring)));
    const cuts = cluster.filter((s) => s.op === 'cut');
    if (cuts.length) land = polygonClipping.difference(land, ...cuts.map((s) => toPlanar(s.ring)));
    for (const poly of land) {
      polygons.push(
        poly.map((ring) => {
          const out: number[] = [];
          for (let k = 0; k < ring.length - 1; k++) out.push(...proj.inverse(ring[k][0], ring[k][1]));
          return out;
        }),
      );
    }
  }

  const geo: MultiPolygon = { type: 'MultiPolygon', coordinates: polygons.map((rings) => rings.map((r) => ringToLonLat(r, true))) };
  const lines: MultiLineString = { type: 'MultiLineString', coordinates: polygons.flatMap((rings) => rings.map((r) => ringToLonLat(r, false))) };
  return { polygons, geo, lines };
}
