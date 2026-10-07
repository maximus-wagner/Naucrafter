import type { SphereMesh } from './sphereMesh';
import { chord } from './sphereMesh';
import { rngFor, type Rng } from '../core/rng';
import { Fbm } from '../core/noise';
import { MinHeap } from '../core/heap';
import { clamp, cross, normalize, type Vec3 } from '../core/math';

export interface Plate {
  /** Euler pole: the plate rotates about this unit axis through the planet's centre. */
  axis: Vec3;
  /** Angular speed (arbitrary units; ~0.2–1.5). */
  omega: number;
  /** Relative density; when two oceanic plates collide the denser one subducts. */
  density: number;
  color: Vec3;
}

export interface PlateState {
  plates: Plate[];
  /** Plate index of each cell. */
  plateOf: Uint16Array;
  /** 1 = continental crust, 0 = oceanic crust (per cell, so continents may straddle plates). */
  crust: Uint8Array;
}

export interface PlateParams {
  plateCount: number;
  /** Fraction of the surface with continental crust. */
  continentFraction: number;
  /** How wiggly plate borders are (0 = straight Voronoi-like borders). */
  borderNoise: number;
}

/** Arrow length on screen per unit of plate speed (radians of arc). */
export const ARROW_SCALE = 0.15;

export function plateColor(i: number): Vec3 {
  const h = (i * 0.618034 + 0.08) % 1;
  const s = 0.5, l = 0.6;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

export function randomPlate(rng: Rng, index: number): Plate {
  const z = rng() * 2 - 1;
  const t = rng() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return {
    axis: [r * Math.cos(t), r * Math.sin(t), z],
    omega: 0.25 + rng() * 0.75,
    density: rng(),
    color: plateColor(index),
  };
}

/** Velocity of a plate at point p (tangent to the sphere). */
export function plateVelocity(plate: Plate, x: number, y: number, z: number): Vec3 {
  const [ax, ay, az] = plate.axis;
  const w = plate.omega;
  return [w * (ay * z - az * y), w * (az * x - ax * z), w * (ax * y - ay * x)];
}

/** Set a plate's motion so its velocity at `centre` points toward `target`, with the arrow ending there. */
export function setPlateMotionFromDrag(plate: Plate, centre: Vec3, target: Vec3): void {
  let v: Vec3 = [target[0] - centre[0], target[1] - centre[1], target[2] - centre[2]];
  const along = v[0] * centre[0] + v[1] * centre[1] + v[2] * centre[2];
  v = [v[0] - centre[0] * along, v[1] - centre[1] * along, v[2] - centre[2] * along];
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-6) {
    plate.omega = 0;
    return;
  }
  // (c × v) × c = v for unit c ⟂ v, so rotating about c × v moves c along v.
  plate.axis = normalize(cross(centre, v));
  plate.omega = Math.min(2.5, len / ARROW_SCALE);
}

export function generatePlates(mesh: SphereMesh, seed: string, p: PlateParams): PlateState {
  const { n, xyz, adjOffset, adj } = mesh;
  const rng = rngFor(seed, 'plates');
  const border = new Fbm(seed, 'plate-borders');
  const count = clamp(Math.round(p.plateCount), 2, Math.min(250, Math.floor(n / 40)));

  // Weighted multi-source flood fill: heavier plates grow faster, noise bends the borders.
  const plates: Plate[] = [];
  const weight: number[] = [];
  const owner = new Int32Array(n).fill(-1);
  const dist = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap(n);
  for (let i = 0; i < count; i++) {
    let cell: number;
    do cell = Math.floor(rng() * n);
    while (owner[cell] !== -1);
    owner[cell] = i;
    dist[cell] = 0;
    heap.push(cell, 0);
    plates.push(randomPlate(rng, i));
    // Growth speed; area scales roughly with its square, so keep the spread modest.
    weight.push(0.75 + 0.75 * rng() * rng());
  }
  while (heap.size > 0) {
    const d = heap.minKey();
    const c = heap.pop();
    if (d > dist[c]) continue;
    const o = owner[c];
    for (let k = adjOffset[c]; k < adjOffset[c + 1]; k++) {
      const j = adj[k];
      const mx = xyz[c * 3] + xyz[j * 3], my = xyz[c * 3 + 1] + xyz[j * 3 + 1], mz = xyz[c * 3 + 2] + xyz[j * 3 + 2];
      const wobble = 1 + p.borderNoise * border.fbm(mx * 2, my * 2, mz * 2, 5);
      const nd = d + (chord(xyz, c, j) * Math.max(0.08, wobble)) / weight[o];
      if (nd < dist[j]) {
        dist[j] = nd;
        owner[j] = o;
        heap.push(j, nd);
      }
    }
  }
  const plateOf = Uint16Array.from(owner);

  // Continental crust: low-frequency noise nudged per plate, thresholded to hit the target fraction.
  const crustNoise = new Fbm(seed, 'crust');
  const bias = plates.map(() => (rng() - 0.5) * 0.35);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    v[i] = crustNoise.fbm(xyz[i * 3] * 1.3, xyz[i * 3 + 1] * 1.3, xyz[i * 3 + 2] * 1.3, 5) + bias[plateOf[i]];
  }
  const sorted = Float32Array.from(v).sort();
  const threshold = sorted[Math.floor(clamp(1 - p.continentFraction, 0, 1) * (n - 1))];
  const crust = new Uint8Array(n);
  for (let i = 0; i < n; i++) crust[i] = v[i] > threshold ? 1 : 0;

  return { plates, plateOf, crust };
}

/** Unit-length centroid per plate (zero vector for plates with no cells). */
export function plateCentroids(mesh: SphereMesh, ps: PlateState): Float32Array {
  const out = new Float32Array(ps.plates.length * 3);
  for (let i = 0; i < mesh.n; i++) {
    const p = ps.plateOf[i] * 3;
    out[p] += mesh.xyz[i * 3];
    out[p + 1] += mesh.xyz[i * 3 + 1];
    out[p + 2] += mesh.xyz[i * 3 + 2];
  }
  for (let p = 0; p < out.length; p += 3) {
    const l = Math.hypot(out[p], out[p + 1], out[p + 2]);
    if (l > 1e-9) {
      out[p] /= l;
      out[p + 1] /= l;
      out[p + 2] /= l;
    }
  }
  return out;
}
