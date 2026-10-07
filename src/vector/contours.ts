import { halfedgeEnd, type SphereMesh } from '../world/sphereMesh';
import { chaikinClosed } from './geo';

/**
 * Closed iso-lines of `values` at `level` by marching triangles over the Delaunay mesh.
 * Each ring is flat xyz with the region `value >= level` on its LEFT (counter-clockwise seen
 * from outside). Because the mesh is closed, every iso-line is a closed ring.
 */
export function isoRings(mesh: SphereMesh, values: ArrayLike<number>, level: number, smoothing = 1): number[][] {
  const { triangles: T, twin, xyz } = mesh;
  const nt = T.length / 3;
  // Per triangle: the half-edge where the line enters (above→below) and leaves (below→above).
  const enter = new Int32Array(nt).fill(-1);
  const leave = new Int32Array(nt).fill(-1);
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const h = t * 3 + e;
      const a = values[T[h]] >= level, b = values[halfedgeEnd(T, h)] >= level;
      if (a && !b) enter[t] = h;
      else if (!a && b) leave[t] = h;
    }
  }

  const done = new Uint8Array(nt);
  const rings: number[][] = [];
  for (let t0 = 0; t0 < nt; t0++) {
    if (enter[t0] < 0 || done[t0]) continue;
    const ring: number[] = [];
    let t = t0;
    for (let guard = 0; guard < nt; guard++) {
      done[t] = 1;
      const h = enter[t], a = T[h], b = halfedgeEnd(T, h);
      const f = (level - values[a]) / (values[b] - values[a]);
      const x = xyz[a * 3] + (xyz[b * 3] - xyz[a * 3]) * f;
      const y = xyz[a * 3 + 1] + (xyz[b * 3 + 1] - xyz[a * 3 + 1]) * f;
      const z = xyz[a * 3 + 2] + (xyz[b * 3 + 2] - xyz[a * 3 + 2]) * f;
      const l = Math.hypot(x, y, z);
      ring.push(x / l, y / l, z / l);
      t = (twin[leave[t]] / 3) | 0;
      if (t === t0) break;
    }
    rings.push(smoothing > 0 ? chaikinClosed(ring, smoothing) : ring);
  }
  return rings;
}
