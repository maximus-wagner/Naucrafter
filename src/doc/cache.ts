import { geoArea, geoContains } from 'd3-geo';
import type { Polygon } from 'geojson';
import type { ForestShape, Item, LandShape, MapDoc, MountainShape, PathItem, RiverShape, VPath } from './model';
import { flatten, RAD, roughen } from './geometry';
import { composeLand, type LandResult } from './land';
import { layoutElements, type Barriers, type RegionElement } from './regionLayout';
import { riverGeometry, type RiverGeometry } from './river';
import { lineToLonLat, toLonLat } from '../vector/geo';

/** How finely Bézier paths are sampled before roughening (radians), at detail level 0. */
export const FLATTEN_STEP = 0.25 * RAD;
/** Deepest coastline detail level (each level doubles the samples). */
export const MAX_DETAIL = 4;

/** The detail level a view needs: finer coastline sampling as you zoom in. `scale` = px per radian. */
export function detailLevel(scale: number): number {
  const wantedStep = 2.5 / scale;
  return Math.max(0, Math.min(MAX_DETAIL, Math.ceil(Math.log2((0.1 * RAD) / wantedStep))));
}

/** Smaller side of a closed outline as a d3 polygon. */
export function areaPolygon(pts: number[]): Polygon {
  const ring = lineToLonLat(pts);
  ring.push(ring[0]);
  const poly: Polygon = { type: 'Polygon', coordinates: [ring] };
  return geoArea(poly) > 2 * Math.PI ? { type: 'Polygon', coordinates: [ring.slice().reverse()] } : poly;
}

/**
 * Derived geometry for a document, recomputed only when the items it depends on change (every
 * edit bumps an item's `rev`). Everything is flat xyz on the unit sphere. Region layouts and
 * river drawings are "finalised" here: zooming and panning reuse them untouched.
 */
export class GeometryCache {
  private flat = new Map<string, { key: string; pts: number[]; seg: number[] }>();
  private shaped = new Map<string, { key: string; pts: number[] }>();
  private landCache = new Map<number, { key: string; result: LandResult }>();
  private layouts = new Map<string, { key: string; elements: RegionElement[] }>();
  private rivers = new Map<string, { key: string; geo: RiverGeometry }>();

  /** The path as drawn (no roughening): used for editing and hit-testing. */
  base(id: string, rev: number, path: VPath, level = 0): { pts: number[]; seg: number[] } {
    const key = `${rev}:${level}`;
    const k = `${id}:${level}`;
    const hit = this.flat.get(k);
    if (hit && hit.key === key) return hit;
    const f = { key, ...flatten(path, FLATTEN_STEP / 2 ** level) };
    this.flat.set(k, f);
    return f;
  }

  /** The path as rendered: drawn shape plus procedural detail (finer at higher levels). */
  shape(item: PathItem, seed: string, level = 0): number[] {
    const rough = item.kind === 'border' ? 0 : item.rough;
    const key = `${item.rev}:${seed}:${rough}:${level}`;
    const k = `${item.id}:${level}`;
    const hit = this.shaped.get(k);
    if (hit && hit.key === key) return hit.pts;
    const base = this.base(item.id, item.rev, item.path, level).pts;
    const amount = item.kind === 'river' ? rough * 0.35 : item.kind === 'forest' || item.kind === 'mountains' || item.kind === 'relief' ? rough * 0.5 : rough;
    const pts = roughen(base, item.path.closed, amount, seed, level);
    this.shaped.set(k, { key, pts });
    return pts;
  }

  /** `wanted` if that coastline detail is ready, otherwise the closest level that is (or `wanted`). */
  readyLandLevel(doc: MapDoc, wanted: number): number {
    const key = this.landKey(doc);
    let best = -1;
    for (const [lvl, v] of this.landCache) if (v.key === key && (best < 0 || Math.abs(lvl - wanted) < Math.abs(best - wanted))) best = lvl;
    return best < 0 ? wanted : best;
  }

  private landKey(doc: MapDoc): string {
    const shapes = doc.items.filter((i) => i.kind === 'land' && i.path.nodes.length >= 3);
    return doc.seed + '|' + shapes.map((s) => `${s.id}:${s.rev}`).join(',');
  }

  land(doc: MapDoc, level = 0): LandResult {
    const shapes = doc.items.filter((i): i is LandShape => i.kind === 'land' && i.path.nodes.length >= 3);
    const key = doc.seed + '|' + shapes.map((s) => `${s.id}:${s.rev}`).join(',');
    const hit = this.landCache.get(level);
    if (hit && hit.key === key) return hit.result;
    const result = composeLand(shapes.map((s) => ({ op: s.op, ring: this.shape(s, doc.seed, level) })));
    this.landCache.set(level, { key, result });
    return result;
  }

  /** A river's drawing (bends, oxbows, chutes…), reacting to mountain ranges it crosses. */
  river(doc: MapDoc, river: RiverShape, withMountains = true): RiverGeometry {
    const mountains = withMountains ? doc.items.filter((i): i is MountainShape => i.kind === 'mountains' && i.path.nodes.length >= 3) : [];
    const key = `${river.rev}:${doc.seed}:${river.rough}:${river.width}:${mountains.map((m) => `${m.id}:${m.rev}`).join(',')}`;
    const k = `${river.id}:${withMountains}`;
    const hit = this.rivers.get(k);
    if (hit && hit.key === key) return hit.geo;
    const polys = mountains.map((m) => areaPolygon(this.shape(m, doc.seed)));
    const inMountains = polys.length ? (p: [number, number, number]) => polys.some((poly) => geoContains(poly, toLonLat(...p))) : undefined;
    const geo = riverGeometry(river.path, river.width * RAD, river.rough, doc.seed, inMountains);
    this.rivers.set(k, { key, geo });
    return geo;
  }

  /**
   * The finalised elements (1–20) of a vegetation area or mountain range. Rivers carve corridors
   * through both; mountains keep vegetation out. Recomputed only when the area or one of those
   * neighbours is edited.
   */
  elements(doc: MapDoc, item: ForestShape | MountainShape): RegionElement[] {
    const rivers = doc.items.filter((i): i is RiverShape => i.kind === 'river' && i.path.nodes.length >= 2);
    const ranges = item.kind === 'forest' ? doc.items.filter((i): i is MountainShape => i.kind === 'mountains' && i.path.nodes.length >= 3) : [];
    const key = [item.rev, doc.seed, item.rough, ...rivers.map((r) => `${r.id}:${r.rev}`), '|', ...ranges.map((m) => `${m.id}:${m.rev}`)].join(',');
    const hit = this.layouts.get(item.id);
    if (hit && hit.key === key) return hit.elements;
    const barriers: Barriers = {
      // Valleys through mountains are wider than clearings through woods.
      lines: rivers.map((r) => ({ pts: this.river(doc, r, false).main, halfWidth: r.width * RAD * (item.kind === 'mountains' ? 3 : 1.4) })),
      areas: ranges.map((m) => this.shape(m, doc.seed)),
    };
    const elements = layoutElements(this.shape(item, doc.seed), undefined, barriers);
    this.layouts.set(item.id, { key, elements });
    return elements;
  }

  /** Drop entries for items that no longer exist. */
  prune(items: Item[]): void {
    const live = new Set(items.map((i) => i.id));
    const alive = (k: string) => live.has(k.split(':')[0]);
    for (const m of [this.flat, this.shaped, this.layouts, this.rivers] as Map<string, unknown>[]) {
      for (const k of m.keys()) if (!alive(k)) m.delete(k);
    }
  }
}
