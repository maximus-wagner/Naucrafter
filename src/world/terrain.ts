import { spread, type SphereMesh } from './sphereMesh';
import type { PlateState } from './plates';
import { BOUNDARY, type Boundaries } from './tectonics';
import { Fbm } from '../core/noise';
import { clamp, smoothstep } from '../core/math';

export interface TerrainParams {
  mountainScale: number;
  noiseAmount: number;
}

/** Peak uplift (m) and half-width (radians of arc, 0.01 ≈ 64 km on an Earth-sized world). */
interface Feature {
  uplift: number;
  width: number;
}

export const FEATURES = {
  collision: { uplift: 5500, width: 0.1 }, // continent–continent (Himalaya)
  andean: { uplift: 3800, width: 0.065 }, // continental side of a subduction zone (Andes)
  trench: { uplift: -3500, width: 0.025 }, // subducting oceanic plate
  islandArc: { uplift: 4300, width: 0.035 }, // overriding oceanic plate (Japan, Aleutians)
  rift: { uplift: -1800, width: 0.035 }, // continental divergence (East African Rift)
  ridge: { uplift: 2200, width: 0.07 }, // mid-ocean ridge
  passiveRift: { uplift: -600, width: 0.03 }, // continent pulling away from ocean crust
} satisfies Record<string, Feature>;

function featureFor(ps: PlateState, b: Boundaries, i: number): Feature | null {
  const j = b.other[i];
  const ci = ps.crust[i] === 1, cj = ps.crust[j] === 1;
  if (b.type[i] === BOUNDARY.CONVERGENT) {
    if (ci && cj) return FEATURES.collision;
    if (ci) return FEATURES.andean;
    if (cj) return FEATURES.trench;
    const mine = ps.plates[ps.plateOf[i]].density, theirs = ps.plates[ps.plateOf[j]].density;
    return mine > theirs ? FEATURES.trench : FEATURES.islandArc;
  }
  if (b.type[i] === BOUNDARY.DIVERGENT) {
    if (ci && cj) return FEATURES.rift;
    if (!ci) return FEATURES.ridge;
    return FEATURES.passiveRift;
  }
  return null;
}

/** Elevation in metres from crust type, plate-boundary features and noise. */
export function generateTerrain(mesh: SphereMesh, ps: PlateState, b: Boundaries, seed: string, tp: TerrainParams): Float32Array {
  const { n, xyz, adjOffset, adj } = mesh;
  const { plateOf, crust } = ps;

  // 1. Distance to the nearest change of crust type → continental shelves and raised interiors.
  const crustEdges: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      if (crust[adj[k]] !== crust[i]) {
        crustEdges.push(i);
        break;
      }
    }
  }
  const crustDist = spread(mesh, crustEdges).dist;

  // 2. Boundary features become uplift sources, smoothed along the boundary to avoid seams.
  const up = new Float32Array(n);
  const wid = new Float32Array(n);
  const isSource = new Uint8Array(n);
  const sources: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = featureFor(ps, b, i);
    if (!f) continue;
    const intensity = Math.min(1.5, Math.abs(b.pressure[i]) / 0.5);
    up[i] = f.uplift * intensity;
    wid[i] = f.width;
    isSource[i] = 1;
    sources.push(i);
  }
  for (let iter = 0; iter < 3; iter++) {
    const nu = up.slice(), nw = wid.slice();
    for (const s of sources) {
      let su = up[s], sw = wid[s], cnt = 1;
      for (let k = adjOffset[s]; k < adjOffset[s + 1]; k++) {
        const j = adj[k];
        if (isSource[j] && plateOf[j] === plateOf[s]) {
          su += up[j];
          sw += wid[j];
          cnt++;
        }
      }
      nu[s] = su / cnt;
      nw[s] = sw / cnt;
    }
    up.set(nu);
    wid.set(nw);
  }
  // Each feature spreads only within its own plate, up to its width.
  const reach = spread(mesh, sources, (a, c) => plateOf[a] === plateOf[c], (s) => wid[s]);

  // 3. Combine base, features and noise.
  const coarse = new Fbm(seed, 'terrain-coarse');
  const fine = new Fbm(seed, 'terrain-fine');
  const ridges = new Fbm(seed, 'terrain-ridges');
  const elev = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
    const land = crust[i] === 1;
    const d = crustDist[i];
    let e = land ? 150 + 550 * smoothstep(0.02, 0.2, d) : -200 - 3800 * smoothstep(0.005, 0.07, d);

    const s = reach.src[i];
    if (s >= 0) {
      const t = Math.min(1, reach.dist[i] / wid[s]);
      let u = up[s] * (0.5 + 0.5 * Math.cos(Math.PI * t)) * tp.mountainScale;
      if (u > 0) u *= 0.45 + 0.9 * ridges.ridged(x * 7, y * 7, z * 7, 5);
      e += u;
    }

    e += tp.noiseAmount * (coarse.fbm(x * 2.5, y * 2.5, z * 2.5, 5) * (land ? 650 : 350) + fine.fbm(x * 12, y * 12, z * 12, 4) * (land ? 220 : 120));
    elev[i] = clamp(e, -11000, 9000);
  }
  return elev;
}
