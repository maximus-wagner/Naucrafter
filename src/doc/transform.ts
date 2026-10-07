import type { Vec3 } from '../core/math';
import { azimuthal, unit } from './geometry';

/** A 2×2 matrix [a, b, c, d]: (x, y) → (a·x + b·y, c·x + d·y), in screen axes (x right, y up). */
export type Mat2 = [number, number, number, number];

export const rotationMat = (phi: number): Mat2 => [Math.cos(phi), -Math.sin(phi), Math.sin(phi), Math.cos(phi)];
export const scaleMat = (kx: number, ky = kx): Mat2 => [kx, 0, 0, ky];

/** Farthest a point may be pushed from the centre (radians); the azimuthal map folds over at π. */
const MAX_REACH = 3.0;

/** Mean direction of some points: the middle of a selection on the sphere. */
export function centroid(points: Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return Math.hypot(x, y, z) < 1e-9 ? (points[0] ?? [0, 0, 1]) : unit(x, y, z);
}

/**
 * Direction of screen-right at `c`, as an angle in the azimuthal frame around `c`. `right` is any
 * point a little to the right of `c` on screen.
 */
export function frameAngle(c: Vec3, right: Vec3): number {
  const [px, py] = azimuthal(c).forward(right[0], right[1], right[2]);
  return Math.atan2(py, px);
}

/**
 * Apply a linear map around `c`. The sphere is flattened with the azimuthal-equidistant map centred
 * on `c` (distances and bearings from `c` stay true), the 2×2 matrix `m` is applied in screen axes
 * (`theta` says where screen-right points in that frame), and the result is put back on the sphere.
 * A rotation matrix is an exact rotation about `c`; a uniform scale moves every point along its great
 * circle from `c`; anything else stretches or flips.
 */
export function affineAbout(c: Vec3, theta: number, m: Mat2): (v: Vec3) => Vec3 {
  const proj = azimuthal(c);
  const ct = Math.cos(theta), st = Math.sin(theta);
  return (v) => {
    const [px, py] = proj.forward(v[0], v[1], v[2]);
    const x = px * ct + py * st, y = -px * st + py * ct;
    let x2 = m[0] * x + m[1] * y, y2 = m[2] * x + m[3] * y;
    const reach = Math.hypot(x2, y2);
    if (reach > MAX_REACH) {
      x2 *= MAX_REACH / reach;
      y2 *= MAX_REACH / reach;
    }
    return proj.inverse(x2 * ct - y2 * st, x2 * st + y2 * ct);
  };
}
