import { fromLonLat, lineToLonLat, type LonLat } from '../vector/geo';
import type { GeometryCache } from './cache';
import { routeRiver, slopeBetween, type RoutedRiver } from './flow';
import { angle, setSmooth } from './geometry';
import type { MapDoc, PathNode, RiverSection, RiverShape, VPath } from './model';

const DEG = 180 / Math.PI;

/** What the generator needs to know about the terrain (see `TerrainLayer.probe`). */
export interface TerrainProbe {
  height(lon: number, lat: number): number;
  /** Radians from the nearest sea; negative off the land. */
  coastDistance(lon: number, lat: number): number;
}

export interface GeneratedRiver {
  path: VPath;
  routed: RoutedRiver;
  /** Length of the course in radians of arc. */
  length: number;
}

/**
 * The stretch kind for terrain falling `slope` height per radian: fast and straight in steep
 * country, plain on moderate slopes, bending on flats, and where it is very flat and low the
 * river leaves oxbow lakes (or, near the mouth of a long river, braids into a delta).
 */
export function sectionForSlope(slope: number, nearMouth: boolean, long: boolean): RiverSection {
  if (slope > 5) return 'rapids';
  if (slope > 2.2) return 'plain';
  if (slope < 0.5 && nearMouth && long) return 'braided';
  if (slope < 0.8) return 'oxbow';
  return 'meander';
}

/**
 * Plan a river that flows downhill from `at` to the sea, or into an existing river (other than
 * `ignore`, the river being replaced). Null if `at` isn't on land.
 */
export function generateRiverPath(doc: MapDoc, cache: GeometryCache, probe: TerrainProbe, at: LonLat, ignore?: string): GeneratedRiver | null {
  const coast = probe.coastDistance(at[0], at[1]);
  if (!(coast > 0)) return null;
  const radiusDeg = Math.max(3, Math.min(45, coast * DEG * 2.4 + 1.5));
  const rivers: LonLat[][] = doc.items
    .filter((i): i is RiverShape => i.kind === 'river' && i.id !== ignore && i.path.nodes.length >= 2)
    .map((r) => lineToLonLat(cache.river(doc, r).main));
  const routed = routeRiver((lon, lat) => probe.height(lon, lat), at, { radiusDeg, rivers });
  if (!routed || routed.path.length < 2) return null;

  const nodes: PathNode[] = routed.path.map((p) => ({ p: fromLonLat(p), hin: null, hout: null }));
  const path: VPath = { closed: false, nodes };
  for (let i = 0; i < nodes.length; i++) setSmooth(path, i, true);
  let length = 0;
  const along: number[] = [0];
  for (let i = 1; i < nodes.length; i++) {
    length += angle(nodes[i - 1].p, nodes[i].p);
    along.push(length);
  }
  const long = length * DEG > 6;
  for (let i = 0; i < nodes.length - 1; i++) {
    const slope = slopeBetween(routed.path[i], routed.heights[i], routed.path[i + 1], routed.heights[i + 1]);
    nodes[i].section = sectionForSlope(slope, along[i] > length * 0.6, long);
  }
  return { path, routed, length };
}
