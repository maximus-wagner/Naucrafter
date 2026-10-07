import type { LonLat } from '../vector/geo';

/**
 * Where a river starting at a point would flow. Water goes downhill, never over a ridge higher than
 * its source, and leaves a basin by its lowest pass: a "priority flood" over a local grid grows
 * outwards from the sea (and from existing rivers, which a new river joins as a tributary), always
 * from the lowest cell, so every cell learns which neighbour its water drains to. Following those
 * links from the source gives the course.
 */
export interface RoutedRiver {
  /** Source → mouth, smoothed and thinned, as [lon, lat]. */
  path: LonLat[];
  /** Terrain height at each point of `path`. */
  heights: number[];
  /** True if the course ended in the sea; false if it ended in another river or at the grid edge. */
  reachedSea: boolean;
  /** True if it ended by joining one of the `rivers` passed in. */
  joined: boolean;
}

export interface RouteOptions {
  /** Half-size of the grid around the source, degrees of latitude. */
  radiusDeg: number;
  /** Cells across the grid (odd). */
  cells?: number;
  /** Existing river lines to join, as [lon, lat] points. */
  rivers?: LonLat[][];
}

const SEA = 1e-4;
const EPS = 1e-6;
const DEG = Math.PI / 180;

/** Minimal binary min-heap of (key, cell) pairs. */
class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, val: number): void {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }
  pop(): [number, number] {
    const { keys, vals } = this;
    const top: [number, number] = [keys[0], vals[0]];
    const key = keys.pop()!, val = vals.pop()!;
    const n = keys.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return top;
  }
}

/** Chaikin corner cutting: rounds a stair-stepped grid path without moving its ends. */
function chaikin(pts: LonLat[], rounds: number): LonLat[] {
  let out = pts;
  for (let r = 0; r < rounds && out.length > 2; r++) {
    const next: LonLat[] = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const [a, b] = [out[i], out[i + 1]];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/** Douglas–Peucker thinning; `scaleX` squashes longitude so the tolerance is in true-ish degrees. */
function thin(pts: LonLat[], tol: number, scaleX: number): LonLat[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a][0] * scaleX, ay = pts[a][1], dx = pts[b][0] * scaleX - ax, dy = pts[b][1] - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] * scaleX - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Nearest point of a polyline to (lon, lat), in a locally flat frame. */
function nearestOnLine(line: LonLat[], lon: number, lat: number, scaleX: number): { at: LonLat; d: number } {
  let best = { at: line[0], d: Infinity };
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, b] = [line[i], line[i + 1]];
    const dx = (b[0] - a[0]) * scaleX, dy = b[1] - a[1];
    const dd = dx * dx + dy * dy;
    const t = dd > 0 ? Math.max(0, Math.min(1, (((lon - a[0]) * scaleX) * dx + (lat - a[1]) * dy) / dd)) : 0;
    const at: LonLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const d = Math.hypot((at[0] - lon) * scaleX, at[1] - lat);
    if (d < best.d) best = { at, d };
  }
  return best;
}

/**
 * Route a river from `source` down to the sea. `height` gives terrain height at a point (0 or less
 * = sea). Returns null if the source is in the sea.
 */
export function routeRiver(height: (lon: number, lat: number) => number, source: LonLat, opts: RouteOptions): RoutedRiver | null {
  const n = (opts.cells ?? 160) | 1, c = (n - 1) / 2;
  const dLat = opts.radiusDeg / c;
  const cosLat = Math.max(0.1, Math.cos(source[1] * DEG));
  const dLon = dLat / cosLat;
  const lonOf = (i: number) => source[0] + (i - c) * dLon;
  const latOf = (j: number) => Math.max(-89.5, Math.min(89.5, source[1] + (c - j) * dLat));

  const H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = height(lonOf(i), latOf(j));
  const src = c * n + c;
  if (H[src] <= SEA) return null;

  const filled = new Float64Array(n * n).fill(Infinity);
  const parent = new Int32Array(n * n).fill(-1);
  const closed = new Uint8Array(n * n);
  const isRiver = new Uint8Array(n * n);
  const heap = new Heap();
  let seaCells = 0;
  for (let k = 0; k < n * n; k++) {
    if (H[k] <= SEA) {
      filled[k] = 0;
      heap.push(0, k);
      seaCells++;
    }
  }
  // Existing rivers: cells they pass through are outlets whose level is their own height.
  for (const line of opts.rivers ?? []) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [a, b] = [line[i], line[i + 1]];
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]) / dLon, Math.abs(b[1] - a[1]) / dLat) * 2));
      for (let s = 0; s <= steps; s++) {
        const lon = a[0] + ((b[0] - a[0]) * s) / steps, lat = a[1] + ((b[1] - a[1]) * s) / steps;
        const ci = Math.round((lon - source[0]) / dLon + c), cj = Math.round(c - (lat - source[1]) / dLat);
        if (ci < 0 || cj < 0 || ci >= n || cj >= n) continue;
        const k = cj * n + ci;
        if (H[k] <= SEA || isRiver[k]) continue;
        isRiver[k] = 1;
        filled[k] = H[k];
        heap.push(H[k], k);
      }
    }
  }
  // No sea or river in reach: water leaves over the grid's edge.
  if (!heap.size) {
    for (let k = 0; k < n * n; k++) {
      const i = k % n, j = (k / n) | 0;
      if (i === 0 || j === 0 || i === n - 1 || j === n - 1) {
        filled[k] = H[k];
        heap.push(H[k], k);
      }
    }
  }

  while (heap.size) {
    const [key, k] = heap.pop();
    if (closed[k] || key > filled[k]) continue;
    closed[k] = 1;
    if (k === src) break;
    const i = k % n, j = (k / n) | 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const nk = nj * n + ni;
        if (closed[nk] || H[nk] <= SEA) continue;
        const nf = Math.max(H[nk], filled[k] + EPS * (di && dj ? 1.4142 : 1));
        if (nf < filled[nk]) {
          filled[nk] = nf;
          parent[nk] = k;
          heap.push(nf, nk);
        }
      }
    }
  }
  if (parent[src] < 0 && !isRiver[src]) return null;

  const cells: number[] = [src];
  for (let k = src, guard = 0; parent[k] >= 0 && guard < n * n; guard++) {
    k = parent[k];
    cells.push(k);
  }
  const last = cells[cells.length - 1];
  const reachedSea = H[last] <= SEA;
  const joined = !reachedSea && isRiver[last] === 1;
  const raw: LonLat[] = cells.map((k) => [lonOf(k % n), latOf((k / n) | 0)]);
  if (joined) {
    // End exactly on the river rather than at the centre of the nearest cell.
    let best: { at: LonLat; d: number } | null = null;
    for (const line of opts.rivers ?? []) {
      const near = nearestOnLine(line, raw[raw.length - 1][0], raw[raw.length - 1][1], cosLat);
      if (!best || near.d < best.d) best = near;
    }
    if (best) raw[raw.length - 1] = best.at;
  }
  const smoothed = chaikin(raw, 2);
  const path = thin(smoothed, dLat * 0.7, cosLat);
  const heights = path.map(([lon, lat]) => {
    const i = Math.max(0, Math.min(n - 1, Math.round((lon - source[0]) / dLon + c))), j = Math.max(0, Math.min(n - 1, Math.round(c - (lat - source[1]) / dLat)));
    return H[j * n + i];
  });
  return { path, heights, reachedSea, joined };
}

/** Terrain slope (height per radian of arc) between two points of a routed river. */
export function slopeBetween(a: LonLat, ha: number, b: LonLat, hb: number): number {
  const la = a[1] * DEG, lb = b[1] * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const cosd = Math.sin(la) * Math.sin(lb) + Math.cos(la) * Math.cos(lb) * Math.cos(dLon);
  const arc = Math.acos(Math.max(-1, Math.min(1, cosd)));
  return arc > 1e-9 ? Math.max(0, ha - hb) / arc : 0;
}
