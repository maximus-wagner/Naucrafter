import type { Vec3 } from '../core/math';
import { composeLand } from './land';

/**
 * The outline of the union of closed outlines (flat xyz each), as points going round it. Null when
 * they don't form one connected piece. `holes` counts enclosed gaps that the outline fills in.
 */
export function unionOutline(rings: number[][]): { ring: Vec3[]; holes: number } | null {
  const result = composeLand(rings.map((ring) => ({ op: 'add' as const, ring })));
  if (result.polygons.length !== 1) return null;
  const [outer, ...holes] = result.polygons[0];
  const ring: Vec3[] = [];
  for (let i = 0; i + 2 < outer.length; i += 3) ring.push([outer[i], outer[i + 1], outer[i + 2]]);
  return { ring, holes: holes.length };
}
