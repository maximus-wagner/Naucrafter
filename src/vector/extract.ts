import type { GeoPermissibleObjects } from 'd3-geo';
import type { MultiLineString, Polygon } from 'geojson';
import type { World } from '../world/world';
import { cellsInBrush } from '../world/sphereMesh';
import { rngFor } from '../core/rng';
import { isoRings } from './contours';
import { borderNetwork, type BorderNetwork } from './borders';
import { lineToLonLat, ringToLonLat, toLonLat, type LonLat } from './geo';

export const SPHERE: GeoPermissibleObjects = { type: 'Sphere' };
const EMPTY: MultiLineString = { type: 'MultiLineString', coordinates: [] };

export interface Contour {
  /** Everything at or above the level (fill it). */
  area: GeoPermissibleObjects;
  /** The iso-lines themselves (stroke them). */
  lines: MultiLineString;
  /** Raw rings, flat xyz, area on the left. */
  rings: number[][];
}

export interface ReliefMark {
  kind: 'mountain' | 'hill';
  at: LonLat;
  /** Height above sea level (m). */
  height: number;
}

export interface PlateVectors {
  network: BorderNetwork;
  regions: { plate: number; area: GeoPermissibleObjects }[];
  /** Plate borders split by boundary type (index = BOUNDARY value; 0 unused). */
  bordersByType: MultiLineString[];
}

export interface CrustVectors {
  network: BorderNetwork;
  continental: GeoPermissibleObjects;
  oceanic: GeoPermissibleObjects;
}

/** Rings (ours: area on the left) → a d3 polygon. No rings means all-or-nothing. */
function area(rings: number[][], everything: boolean): GeoPermissibleObjects {
  if (rings.length === 0) return everything ? SPHERE : EMPTY;
  const poly: Polygon = { type: 'Polygon', coordinates: rings.map((r) => ringToLonLat(r, true)) };
  return poly;
}

function lines(rings: number[][]): MultiLineString {
  return { type: 'MultiLineString', coordinates: rings.map((r) => ringToLonLat(r, false)) };
}

/**
 * Vector geometry derived from a world's cells. Everything is computed lazily and cached;
 * call the invalidate methods when the underlying cells change.
 */
export class VectorData {
  private contours = new Map<number, Contour>();
  private plateCache: PlateVectors | null = null;
  private crustCache: CrustVectors | null = null;
  private reliefCache: ReliefMark[] | null = null;

  constructor(readonly world: World) {}

  invalidateElevation(): void {
    this.contours.clear();
    this.reliefCache = null;
  }

  invalidatePlates(): void {
    this.plateCache = null;
    this.crustCache = null;
    this.invalidateElevation();
  }

  /** Contour at a height relative to sea level (m). */
  contour(relHeight: number): Contour {
    const level = relHeight + this.world.params.seaLevel;
    let c = this.contours.get(level);
    if (!c) {
      const rings = isoRings(this.world.mesh, this.world.elevation, level, 1);
      const everything = rings.length === 0 && this.world.elevation.some((e) => e >= level);
      c = { area: area(rings, everything), lines: lines(rings), rings };
      this.contours.set(level, c);
    }
    return c;
  }

  plates(): PlateVectors {
    if (this.plateCache) return this.plateCache;
    const { mesh, plates, boundaries } = this.world;
    const network = borderNetwork(mesh, plates.plateOf, 2);
    const present = new Set(plates.plateOf);
    const regions = [...present].map((plate) => ({ plate, area: area(network.ringsFor(plate), present.size === 1) }));

    const byType: [number, number][][][] = [[], [], [], []];
    for (const chain of network.chains) {
      const pts = lineToLonLat(chain.xyz);
      let run: LonLat[] = [pts[0]];
      let runType = -1;
      for (let s = 0; s < pts.length - 1; s++) {
        const type = boundaries.type[mesh.triangles[chain.edges[chain.segSource[s]]]];
        if (type !== runType && run.length > 1) {
          byType[runType].push(run);
          run = [pts[s]];
        }
        runType = type;
        run.push(pts[s + 1]);
      }
      if (runType >= 0 && run.length > 1) byType[runType].push(run);
    }
    const bordersByType = byType.map((coordinates): MultiLineString => ({ type: 'MultiLineString', coordinates }));
    this.plateCache = { network, regions, bordersByType };
    return this.plateCache;
  }

  crust(): CrustVectors {
    if (this.crustCache) return this.crustCache;
    const { mesh, plates } = this.world;
    const network = borderNetwork(mesh, plates.crust, 2);
    const hasLand = plates.crust.includes(1), hasOcean = plates.crust.includes(0);
    this.crustCache = {
      network,
      continental: area(network.ringsFor(1), hasLand && !hasOcean),
      oceanic: area(network.ringsFor(0), hasOcean && !hasLand),
    };
    return this.crustCache;
  }

  /** Mountain and hill marks, spaced out, ordered north to south so lower marks overlap upper ones. */
  relief(): ReliefMark[] {
    if (this.reliefCache) return this.reliefCache;
    const { mesh, elevation, params } = this.world;
    const rng = rngFor(params.seed, 'relief-marks');
    const candidates: number[] = [];
    for (let i = 0; i < mesh.n; i++) if (elevation[i] - params.seaLevel > 700) candidates.push(i);
    candidates.sort((a, b) => elevation[b] - elevation[a]);
    const blocked = new Uint8Array(mesh.n);
    const marks: ReliefMark[] = [];
    const jitter = mesh.spacing * 0.35;
    for (const c of candidates) {
      if (blocked[c]) continue;
      const height = elevation[c] - params.seaLevel;
      const kind = height > 1800 ? 'mountain' : 'hill';
      const x = mesh.xyz[c * 3], y = mesh.xyz[c * 3 + 1], z = mesh.xyz[c * 3 + 2];
      for (const b of cellsInBrush(mesh, { cell: c, point: [x, y, z] }, mesh.spacing * (kind === 'mountain' ? 1.9 : 1.6)).cells) blocked[b] = 1;
      marks.push({ kind, height, at: toLonLat(x + (rng() - 0.5) * jitter, y + (rng() - 0.5) * jitter, z + (rng() - 0.5) * jitter) });
    }
    marks.sort((a, b) => b.at[1] - a.at[1]);
    this.reliefCache = marks;
    return marks;
  }
}
