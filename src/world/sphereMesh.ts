import Delaunator from 'delaunator';
import type { Rng } from '../core/rng';
import type { Vec3 } from '../core/math';
import { MinHeap } from '../core/heap';

/**
 * Cells are points on the unit sphere; the Delaunay triangulation of those points connects
 * neighbouring cells (their Voronoi regions are the "cells" you see on the map).
 */
export interface SphereMesh {
  n: number;
  /** Unit-sphere positions, xyz interleaved. */
  xyz: Float32Array;
  /** Triangle vertex indices, counter-clockwise seen from outside. */
  triangles: Uint32Array;
  /** CSR adjacency: neighbours of i are adj[adjOffset[i] .. adjOffset[i+1]). */
  adjOffset: Uint32Array;
  adj: Uint32Array;
  /** CSR cell -> incident triangles. */
  triOffset: Uint32Array;
  cellTris: Uint32Array;
  /**
   * Half-edge h = 3t + e runs from triangles[h] to the next vertex of triangle t;
   * twin[h] is the opposite half-edge (in the neighbouring triangle).
   */
  twin: Int32Array;
  /** Spherical circumcentre of each triangle = Voronoi vertex, xyz interleaved. */
  circum: Float32Array;
  /** Mean distance between neighbouring cells (radians, ~chord). */
  spacing: number;
}

export interface CellHit {
  cell: number;
  point: Vec3;
}

export function buildSphereMesh(n: number, rng: Rng, jitter = 0.4): SphereMesh {
  const xyz = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const step = Math.sqrt((4 * Math.PI) / n);
  const pole = n - 1;

  // Fibonacci sphere with jitter; the last point is pinned to the south pole and used as the
  // stereographic projection pole. Points near that pole are left unjittered to keep it clear.
  for (let i = 0; i < pole; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const phi = i * golden;
    const j = y < -1 + 12 / n ? 0 : jitter * step;
    const x = Math.cos(phi) * r + (rng() - 0.5) * j;
    const yy = y + (rng() - 0.5) * j;
    const z = Math.sin(phi) * r + (rng() - 0.5) * j;
    const len = Math.hypot(x, yy, z);
    xyz[i * 3] = x / len;
    xyz[i * 3 + 1] = yy / len;
    xyz[i * 3 + 2] = z / len;
  }
  xyz[pole * 3 + 1] = -1;

  // Stereographic projection from the south pole preserves circles, so the planar Delaunay
  // triangulation equals the spherical one. The hull is then closed with a fan to the pole.
  const coords = new Float64Array(pole * 2);
  for (let i = 0; i < pole; i++) {
    const d = 1 + xyz[i * 3 + 1];
    coords[i * 2] = xyz[i * 3] / d;
    coords[i * 2 + 1] = xyz[i * 3 + 2] / d;
  }
  const del = new Delaunator(coords);
  const hull = del.hull;
  const triangles = new Uint32Array(del.triangles.length + hull.length * 3);
  triangles.set(del.triangles);
  let t = del.triangles.length;
  for (let k = 0; k < hull.length; k++) {
    triangles[t++] = hull[k];
    triangles[t++] = hull[(k + 1) % hull.length];
    triangles[t++] = pole;
  }

  // Orient every triangle counter-clockwise when seen from outside.
  for (let k = 0; k < triangles.length; k += 3) {
    const a = triangles[k] * 3, b = triangles[k + 1] * 3, c = triangles[k + 2] * 3;
    const abx = xyz[b] - xyz[a], aby = xyz[b + 1] - xyz[a + 1], abz = xyz[b + 2] - xyz[a + 2];
    const acx = xyz[c] - xyz[a], acy = xyz[c + 1] - xyz[a + 1], acz = xyz[c + 2] - xyz[a + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const out = nx * (xyz[a] + xyz[b] + xyz[c]) + ny * (xyz[a + 1] + xyz[b + 1] + xyz[c + 1]) + nz * (xyz[a + 2] + xyz[b + 2] + xyz[c + 2]);
    if (out < 0) {
      const tmp = triangles[k + 1];
      triangles[k + 1] = triangles[k + 2];
      triangles[k + 2] = tmp;
    }
  }

  // On a closed, consistently oriented mesh each directed edge a->b occurs exactly once,
  // so collecting directed edges yields every neighbour exactly once.
  const adjOffset = new Uint32Array(n + 1);
  const triOffset = new Uint32Array(n + 1);
  for (let k = 0; k < triangles.length; k++) {
    adjOffset[triangles[k] + 1]++;
    triOffset[triangles[k] + 1]++;
  }
  for (let i = 0; i < n; i++) {
    adjOffset[i + 1] += adjOffset[i];
    triOffset[i + 1] += triOffset[i];
  }
  const adj = new Uint32Array(adjOffset[n]);
  const cellTris = new Uint32Array(triOffset[n]);
  const adjFill = adjOffset.slice(0, n);
  const triFill = triOffset.slice(0, n);
  for (let k = 0; k < triangles.length; k += 3) {
    for (let e = 0; e < 3; e++) {
      const a = triangles[k + e], b = triangles[k + ((e + 1) % 3)];
      adj[adjFill[a]++] = b;
      cellTris[triFill[a]++] = k / 3;
    }
  }

  let total = 0;
  for (let i = 0; i < n; i++) {
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) total += chord(xyz, i, adj[k]);
  }

  const twin = new Int32Array(triangles.length).fill(-1);
  for (let h = 0; h < triangles.length; h++) {
    const a = triangles[h], b = halfedgeEnd(triangles, h);
    for (let k = triOffset[b]; k < triOffset[b + 1] && twin[h] < 0; k++) {
      const t = cellTris[k];
      for (let e = 0; e < 3; e++) {
        if (triangles[t * 3 + e] === b && triangles[t * 3 + ((e + 1) % 3)] === a) twin[h] = t * 3 + e;
      }
    }
  }

  // For an outward CCW triangle the normalised face normal is the spherical circumcentre.
  const circum = new Float32Array(triangles.length);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 3, b = triangles[t + 1] * 3, c = triangles[t + 2] * 3;
    const abx = xyz[b] - xyz[a], aby = xyz[b + 1] - xyz[a + 1], abz = xyz[b + 2] - xyz[a + 2];
    const acx = xyz[c] - xyz[a], acy = xyz[c + 1] - xyz[a + 1], acz = xyz[c + 2] - xyz[a + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const l = Math.hypot(nx, ny, nz) || 1;
    circum[t] = nx / l;
    circum[t + 1] = ny / l;
    circum[t + 2] = nz / l;
  }

  return { n, xyz, triangles, adjOffset, adj, triOffset, cellTris, twin, circum, spacing: total / adj.length };
}

/** End vertex of half-edge h. */
export function halfedgeEnd(triangles: Uint32Array, h: number): number {
  return triangles[h - (h % 3) + ((h % 3) + 1) % 3];
}

export function chord(xyz: Float32Array, a: number, b: number): number {
  const dx = xyz[a * 3] - xyz[b * 3], dy = xyz[a * 3 + 1] - xyz[b * 3 + 1], dz = xyz[a * 3 + 2] - xyz[b * 3 + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function cellVec(mesh: SphereMesh, i: number): Vec3 {
  return [mesh.xyz[i * 3], mesh.xyz[i * 3 + 1], mesh.xyz[i * 3 + 2]];
}

/** Greedy walk over the Delaunay graph; always reaches the true nearest cell. */
export function nearestCell(mesh: SphereMesh, x: number, y: number, z: number, start = 0): number {
  const { xyz, adjOffset, adj } = mesh;
  let cur = start < mesh.n ? start : 0;
  let best = xyz[cur * 3] * x + xyz[cur * 3 + 1] * y + xyz[cur * 3 + 2] * z;
  for (;;) {
    let next = -1;
    for (let k = adjOffset[cur]; k < adjOffset[cur + 1]; k++) {
      const j = adj[k];
      const d = xyz[j * 3] * x + xyz[j * 3 + 1] * y + xyz[j * 3 + 2] * z;
      if (d > best) {
        best = d;
        next = j;
      }
    }
    if (next < 0) return cur;
    cur = next;
  }
}

let stamp = new Uint32Array(0);
let stampId = 0;

/** Cells within `radius` (radians) of `point`, with a smooth falloff weight in (0, 1]. */
export function cellsInBrush(mesh: SphereMesh, hit: CellHit, radius: number): { cells: number[]; weights: number[] } {
  if (stamp.length !== mesh.n) {
    stamp = new Uint32Array(mesh.n);
    stampId = 0;
  }
  stampId++;
  const { xyz, adjOffset, adj } = mesh;
  const [px, py, pz] = hit.point;
  const cosR = Math.cos(radius);
  const cells: number[] = [];
  const weights: number[] = [];
  const stack = [hit.cell];
  stamp[hit.cell] = stampId;
  while (stack.length) {
    const c = stack.pop()!;
    const d = xyz[c * 3] * px + xyz[c * 3 + 1] * py + xyz[c * 3 + 2] * pz;
    if (d < cosR && c !== hit.cell) continue;
    const t = Math.min(1, Math.acos(Math.min(1, d)) / radius);
    cells.push(c);
    weights.push(c === hit.cell ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * t));
    for (let k = adjOffset[c]; k < adjOffset[c + 1]; k++) {
      const j = adj[k];
      if (stamp[j] !== stampId) {
        stamp[j] = stampId;
        stack.push(j);
      }
    }
  }
  return { cells, weights };
}

/**
 * Multi-source Dijkstra over the cell graph. Returns the distance to, and identity of, the nearest
 * source for every cell. `allow` gates edges; `limit` caps how far each source may reach.
 */
export function spread(
  mesh: SphereMesh,
  sources: ArrayLike<number>,
  allow?: (from: number, to: number) => boolean,
  limit?: (source: number) => number,
): { dist: Float64Array; src: Int32Array } {
  const { n, xyz, adjOffset, adj } = mesh;
  const dist = new Float64Array(n).fill(Infinity);
  const src = new Int32Array(n).fill(-1);
  const heap = new MinHeap(sources.length * 4);
  for (let s = 0; s < sources.length; s++) {
    const c = sources[s];
    dist[c] = 0;
    src[c] = c;
    heap.push(c, 0);
  }
  while (heap.size > 0) {
    const d = heap.minKey();
    const c = heap.pop();
    if (d > dist[c]) continue;
    const cap = limit ? limit(src[c]) : Infinity;
    for (let k = adjOffset[c]; k < adjOffset[c + 1]; k++) {
      const j = adj[k];
      if (allow && !allow(c, j)) continue;
      const nd = d + chord(xyz, c, j);
      if (nd < dist[j] && nd <= cap) {
        dist[j] = nd;
        src[j] = src[c];
        heap.push(j, nd);
      }
    }
  }
  return { dist, src };
}
