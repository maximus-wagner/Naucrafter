import type { Vec3 } from '../core/math';
import { azimuthal, unit } from './geometry';

/** One generated piece of a region: a massif or a clump of plants, centred on the sphere. */
export interface RegionElement {
  at: Vec3;
  /** Radius of the area it covers (radians). */
  radius: number;
}

export const MAX_ELEMENTS = 20;

/** Things that keep elements out: rivers (with a corridor half-width) and other areas. Flat xyz. */
export interface Barriers {
  lines?: { pts: number[]; halfWidth: number }[];
  areas?: number[][];
}

function inside(poly: [number, number][], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[j];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) hit = !hit;
  }
  return hit;
}

function edgeDistance(poly: [number, number][], x: number, y: number, closed: boolean): number {
  let d = Infinity;
  const n = poly.length;
  for (let i = closed ? 0 : 1, j = closed ? n - 1 : 0; i < n; j = i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[j];
    const dx = bx - ax, dy = by - ay, dd = dx * dx + dy * dy;
    const t = dd > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / dd)) : 0;
    d = Math.min(d, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return d;
}
const GRID = 72;

/**
 * Cover a drawn outline with a few elements: repeatedly put the biggest circle that fits into the
 * part not yet covered. A round blob gets one element; long or intricate outlines get more (up to
 * `max`). Tiny leftovers are ignored. Independent of zoom, so the result can be finalised.
 */
export function layoutElements(ring: number[], max = MAX_ELEMENTS, barriers: Barriers = {}): RegionElement[] {
  const n = ring.length / 3;
  if (n < 3) return [];
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < ring.length; i += 3) {
    sx += ring[i];
    sy += ring[i + 1];
    sz += ring[i + 2];
  }
  const proj = azimuthal(unit(sx, sy, sz));
  const centre = unit(sx, sy, sz);
  const flat = (pts: number[]) => {
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length; i += 3) {
      // Only the near side of the planet can be flattened around this centre.
      if (pts[i] * centre[0] + pts[i + 1] * centre[1] + pts[i + 2] * centre[2] > -0.2) out.push(proj.forward(pts[i], pts[i + 1], pts[i + 2]));
    }
    return out;
  };
  const poly = flat(ring);
  const lines = (barriers.lines ?? []).map((l) => ({ pts: flat(l.pts), halfWidth: l.halfWidth })).filter((l) => l.pts.length > 1);
  const areas = (barriers.areas ?? []).map(flat).filter((a) => a.length > 2);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const cell = Math.max(x1 - x0, y1 - y0) / GRID;
  if (!(cell > 0)) return [];
  const cols = Math.ceil((x1 - x0) / cell), rows = Math.ceil((y1 - y0) / cell);

  // Inside cells and their distance to the outline.
  const cells: { x: number; y: number; d: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = x0 + (c + 0.5) * cell, y = y0 + (r + 0.5) * cell;
      if (!inside(poly, x, y)) continue;
      let d = edgeDistance(poly, x, y, true);
      // Neighbours carve this region: a river leaves a corridor, another area leaves a hole.
      for (const l of lines) d = Math.min(d, edgeDistance(l.pts, x, y, false) - l.halfWidth);
      for (const a of areas) d = inside(a, x, y) ? -1 : Math.min(d, edgeDistance(a, x, y, true));
      if (d > 0) cells.push({ x, y, d });
    }
  }
  if (!cells.length) return [];

  const covered = new Uint8Array(cells.length);
  const out: RegionElement[] = [];
  let left = cells.length;
  while (out.length < max && left > cells.length * 0.08) {
    let best = -1;
    for (let i = 0; i < cells.length; i++) if (!covered[i] && (best < 0 || cells[i].d > cells[best].d)) best = i;
    if (best < 0) break;
    const { x, y, d } = cells[best];
    const r = Math.max(d, cell);
    if (out.length && r < out[0].radius * 0.22) break;
    out.push({ at: proj.inverse(x, y), radius: r });
    for (let i = 0; i < cells.length; i++) {
      if (!covered[i] && Math.hypot(cells[i].x - x, cells[i].y - y) < r * 0.9) {
        covered[i] = 1;
        left--;
      }
    }
  }
  return out;
}
