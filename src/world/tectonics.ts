import type { SphereMesh } from './sphereMesh';
import { plateVelocity, type PlateState } from './plates';

export const BOUNDARY = { NONE: 0, CONVERGENT: 1, DIVERGENT: 2, TRANSFORM: 3 } as const;
export const BOUNDARY_NAMES = ['interior', 'convergent', 'divergent', 'transform'];

export interface Boundaries {
  type: Uint8Array;
  /** Mean closing speed across the boundary (+ = plates approaching, − = separating). */
  pressure: Float32Array;
  /** Mean sliding speed along the boundary. */
  shear: Float32Array;
  /** The cell across the boundary with the strongest interaction (−1 for interior cells). */
  other: Int32Array;
}

/** Classify each cell on a plate border by the relative motion of the two plates there. */
export function computeBoundaries(mesh: SphereMesh, ps: PlateState): Boundaries {
  const { n, xyz, adjOffset, adj } = mesh;
  const { plates, plateOf } = ps;
  const type = new Uint8Array(n);
  const pressure = new Float32Array(n);
  const shear = new Float32Array(n);
  const other = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const px = xyz[i * 3], py = xyz[i * 3 + 1], pz = xyz[i * 3 + 2];
    const mine = plateOf[i];
    const vi = plateVelocity(plates[mine], px, py, pz);
    let count = 0, prSum = 0, shSum = 0, strongest = -1, strongestPr = -1;
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      const j = adj[k];
      if (plateOf[j] === mine) continue;
      const vj = plateVelocity(plates[plateOf[j]], px, py, pz);
      // Tangent direction from i toward j.
      let nx = xyz[j * 3] - px, ny = xyz[j * 3 + 1] - py, nz = xyz[j * 3 + 2] - pz;
      const along = nx * px + ny * py + nz * pz;
      nx -= px * along; ny -= py * along; nz -= pz * along;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const rx = vi[0] - vj[0], ry = vi[1] - vj[1], rz = vi[2] - vj[2];
      const pr = rx * nx + ry * ny + rz * nz;
      const sh = Math.hypot(rx - nx * pr, ry - ny * pr, rz - nz * pr);
      prSum += pr;
      shSum += sh;
      count++;
      if (Math.abs(pr) > strongestPr) {
        strongest = j;
        strongestPr = Math.abs(pr);
      }
    }
    if (count === 0) continue;
    pressure[i] = prSum / count;
    shear[i] = shSum / count;
    other[i] = strongest;
  }

  // Wiggly borders make per-cell normals noisy; average along the boundary so each stretch
  // of border gets one coherent classification.
  const border: number[] = [];
  for (let i = 0; i < n; i++) if (other[i] >= 0) border.push(i);
  for (let iter = 0; iter < 4; iter++) {
    const np = pressure.slice(), ns = shear.slice();
    for (const i of border) {
      let sp = pressure[i], ss = shear[i], cnt = 1;
      for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
        const j = adj[k];
        if (other[j] >= 0 && plateOf[j] === plateOf[i]) {
          sp += pressure[j];
          ss += shear[j];
          cnt++;
        }
      }
      np[i] = sp / cnt;
      ns[i] = ss / cnt;
    }
    pressure.set(np);
    shear.set(ns);
  }

  for (const i of border) {
    const head = Math.abs(pressure[i]);
    type[i] = head > 0.03 && head >= shear[i] * 0.5 ? (pressure[i] > 0 ? BOUNDARY.CONVERGENT : BOUNDARY.DIVERGENT) : BOUNDARY.TRANSFORM;
  }
  return { type, pressure, shear, other };
}
