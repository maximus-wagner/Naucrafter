import { geoArea, geoBounds, geoContains, geoEquirectangular, geoPath, type GeoPermissibleObjects } from 'd3-geo';
import type { ForestShape, Item, MapDoc, MountainShape, VegetationKind } from '../doc/model';
import { areaPolygon, detailLevel, type GeometryCache } from '../doc/cache';
import type { RegionElement } from '../doc/regionLayout';
import { RAD } from '../doc/geometry';
import { fromLonLat, lineToLonLat } from '../vector/geo';
import { Fbm } from '../core/noise';
import { EMPTY, INK, PAPER, SHADE, SNOW, cellHash, plantSprite, type IndexSprite } from '../pixel/procedural';
import { OUTSIDE, TRUNK, TRUNK_LIT, makeTree, outlineDistance, sampleTree, shadowOf, type Tree, type TreeShape } from '../pixel/canopy';
import { hexToRgba, mix, type RGBA } from '../pixel/palette';
import type { Painter } from './painter';
import type { MapStyle } from './styles';

const DEG = 180 / Math.PI;

// ================================================================ palettes

/** Relief colours per style: lowland → hills → upland → rock → snow. */
interface ReliefPalette {
  bands: RGBA[];
  shadow: RGBA;
  light: RGBA;
}

function reliefPalette(style: MapStyle): ReliefPalette {
  const land = hexToRgba(style.land), ink = hexToRgba(style.symbolInk);
  const atlas = style.id.startsWith('atlas'), inkStyle = style.id.startsWith('ink');
  const tan = hexToRgba(atlas ? '#d9c48f' : '#cdb487');
  const green = hexToRgba(atlas ? '#a9c48a' : inkStyle ? '#ecebe4' : '#cfcf9c');
  const low = mix(land, green, inkStyle ? 0.1 : 0.45);
  return {
    bands: [low, mix(low, tan, 0.45), tan, mix(tan, hexToRgba('#9c9184'), 0.6), mix(land, hexToRgba('#ffffff'), 0.75)],
    shadow: mix(ink, hexToRgba('#3d4a5a'), 0.3),
    light: hexToRgba('#fffdf4'),
  };
}

type CanopyColors = {
  light: RGBA;
  fill: RGBA;
  dark: RGBA;
  edge: RGBA;
  ink: RGBA;
  /** Deep shadow → highlight, five steps; shadows lean cool, highlights warm. */
  ramp: RGBA[];
  trunk: RGBA;
  trunkLight: RGBA;
  /** Ground colour under a crown's cast shadow. */
  shadow: RGBA;
};

/** Canopy greens per vegetation kind, adjusted per style. */
function canopyColors(kind: VegetationKind, style: MapStyle, override?: string): CanopyColors {
  const ink = hexToRgba(style.symbolInk);
  const inkStyle = style.id.startsWith('ink');
  const base: Record<VegetationKind, string> = { broadleaf: '#8aa564', conifer: '#5f8463', mixed: '#7a9a60', jungle: '#4f7d48', shrubs: '#a3a66a', grass: '#b4b874' };
  let fill = hexToRgba(override ?? base[kind]);
  if (!override && style.id.startsWith('parchment')) fill = mix(fill, hexToRgba('#b8a66e'), 0.35);
  if (!override && inkStyle) fill = mix(fill, hexToRgba('#f4f2ea'), 0.8);
  const cool = inkStyle ? ink : hexToRgba('#2d4a42'), warm = hexToRgba(inkStyle ? '#ffffff' : '#f1ecb0');
  const dark = mix(mix(fill, cool, inkStyle ? 0.4 : 0.5), ink, 0.12);
  const deep = mix(dark, ink, 0.5);
  const light = mix(fill, warm, 0.38);
  const ramp = [deep, dark, fill, light, mix(light, hexToRgba('#fffbe0'), 0.5)];
  return { light, fill, dark, edge: mix(dark, ink, 0.45), ink, ramp, trunk: mix(ink, hexToRgba('#6b5438'), 0.5), trunkLight: mix(hexToRgba('#6b5438'), hexToRgba('#c9a97a'), 0.45), shadow: mix(dark, ink, 0.3) };
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const dither = (x: number, y: number) => BAYER[(y & 3) * 4 + (x & 3)];

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const noiseFor = new Map<string, Fbm>();
function noise(seed: string, purpose: string): Fbm {
  const k = `${seed}|${purpose}`;
  let n = noiseFor.get(k);
  if (!n) noiseFor.set(k, (n = new Fbm(seed, purpose)));
  return n;
}

// ================================================================ geographic distance fields

/** A lon/lat grid (rotated to centre on `lon0`) holding a distance in radians per texel. */
interface GeoGrid {
  lon0: number;
  /** West edge (rotated longitude, degrees) and north edge (latitude). */
  x0: number;
  y1: number;
  /** Texel size, degrees. */
  d: number;
  w: number;
  h: number;
  data: Float32Array;
}
type GridShape = Omit<GeoGrid, 'data'>;

let rasterCanvas: HTMLCanvasElement | null = null;

function rasterize(g: GridShape, draw: (ctx: CanvasRenderingContext2D, path: ReturnType<typeof geoPath>) => void): Uint8Array {
  if (!rasterCanvas) rasterCanvas = document.createElement('canvas');
  rasterCanvas.width = g.w;
  rasterCanvas.height = g.h;
  const ctx = rasterCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, g.w, g.h);
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  const proj = geoEquirectangular().rotate([-g.lon0, 0]).scale(DEG / g.d).translate([-g.x0 / g.d, g.y1 / g.d]).precision(0.2);
  draw(ctx, geoPath(proj, ctx));
  const px = ctx.getImageData(0, 0, g.w, g.h).data;
  const out = new Uint8Array(g.w * g.h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3] > 127 ? 1 : 0;
  return out;
}

/** Chamfer distance in radians on a lon/lat grid (texels narrow towards the poles). */
function gridDistance(g: GridShape, target: (i: number) => boolean): Float32Array {
  const { w, h } = g;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = target(i) ? 0 : 1e9;
  const dr = g.d / DEG;
  const wx = new Float32Array(h), wd = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    wx[y] = Math.max(0.01, Math.cos((g.y1 - y * g.d) / DEG)) * dr;
    wd[y] = Math.hypot(wx[y], dr);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + wx[y]);
      if (y > 0) {
        v = Math.min(v, d[i - w] + dr);
        if (x > 0) v = Math.min(v, d[i - w - 1] + wd[y]);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + wd[y]);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + wx[y]);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + dr);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + wd[y]);
        if (x > 0) v = Math.min(v, d[i + w - 1] + wd[y]);
      }
      d[i] = v;
    }
  }
  return d;
}

/** A grid covering `geo`'s bounds plus a margin (degrees), at most `max` texels across. */
function gridAround(geo: GeoPermissibleObjects, marginDeg: number, max = 512): GridShape {
  const [[lonA, latA], [lonB, latB]] = geoBounds(geo as Parameters<typeof geoBounds>[0]);
  const span = lonA <= lonB ? lonB - lonA : lonB + 360 - lonA;
  const lon0 = lonA + span / 2;
  const half = Math.min(180, span / 2 + marginDeg / Math.max(0.2, Math.cos((latA + latB) / 2 / DEG)));
  const top = Math.min(90, latB + marginDeg), bottom = Math.max(-90, latA - marginDeg);
  const d = Math.max(0.0015, Math.max(2 * half, top - bottom) / max);
  return { lon0, x0: -half, y1: top, d, w: Math.ceil((2 * half) / d) + 1, h: Math.ceil((top - bottom) / d) + 1 };
}

/** Signed distance (radians): positive inside the area, negative outside. */
function areaField(poly: GeoPermissibleObjects, marginDeg: number, max?: number): GeoGrid {
  const g = gridAround(poly, marginDeg, max);
  const m = rasterize(g, (ctx, path) => {
    ctx.beginPath();
    path(poly);
    ctx.fill('evenodd');
  });
  const din = gridDistance(g, (i) => !m[i]), dout = gridDistance(g, (i) => m[i] === 1);
  const data = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) data[i] = m[i] ? din[i] : -dout[i];
  return { ...g, data };
}

/** Distance (radians) to a line. */
function lineField(coords: [number, number][], marginDeg: number): GeoGrid {
  const line: GeoPermissibleObjects = { type: 'LineString', coordinates: coords };
  const g = gridAround(line, marginDeg);
  const m = rasterize(g, (ctx, path) => {
    ctx.lineWidth = 1;
    ctx.beginPath();
    path(line);
    ctx.stroke();
  });
  return { ...g, data: gridDistance(g, (i) => m[i] === 1) };
}

/** Chamfer distance (radians) that also remembers which seed texel is nearest to each texel. */
function gridNearest(g: GridShape, seed: Int32Array): { dist: Float32Array; near: Int32Array } {
  const { w, h } = g;
  const d = new Float32Array(w * h), near = seed.slice();
  for (let i = 0; i < d.length; i++) d[i] = seed[i] >= 0 ? 0 : 1e9;
  const dr = g.d / DEG;
  const wx = new Float32Array(h), wd = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    wx[y] = Math.max(0.01, Math.cos((g.y1 - y * g.d) / DEG)) * dr;
    wd[y] = Math.hypot(wx[y], dr);
  }
  const relax = (i: number, j: number, cost: number) => {
    const v = d[j] + cost;
    if (v < d[i]) {
      d[i] = v;
      near[i] = near[j];
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) relax(i, i - 1, wx[y]);
      if (y > 0) {
        relax(i, i - w, dr);
        if (x > 0) relax(i, i - w - 1, wd[y]);
        if (x < w - 1) relax(i, i - w + 1, wd[y]);
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) relax(i, i + 1, wx[y]);
      if (y < h - 1) {
        relax(i, i + w, dr);
        if (x < w - 1) relax(i, i + w + 1, wd[y]);
        if (x > 0) relax(i, i + w - 1, wd[y]);
      }
    }
  }
  return { dist: d, near };
}

/**
 * A river as a field: distance to its course, plus, for the nearest point of the course, how far
 * down the river it is (0 source … 1 mouth) and the height of the river bed there. The bed is the
 * terrain along the course with its low points carried downstream (a running minimum, lightly
 * smoothed), so water never runs uphill: ridges the course crosses become gorges, hollows beside
 * it can fill.
 */
interface RiverField extends GeoGrid {
  /** Position along the river (0 source … 1 mouth) and bed height of the nearest course point, blurred smooth. */
  t: Float32Array;
  bed: Float32Array;
  /** Mouth width and how far the valley reaches, radians. */
  width: number;
  reach: number;
}

const SEA_FLOOR = 0.05;

function riverField(coords: [number, number][], marginDeg: number, widthRad: number, base: (lon: number, lat: number) => number): RiverField {
  const g = gridAround({ type: 'LineString', coordinates: coords }, marginDeg);
  const cos = Math.max(0.1, Math.cos(coords[Math.floor(coords.length / 2)][1] / DEG));
  // Walk the course in steps of half a texel, reading the terrain under it.
  const along: { lon: number; lat: number; s: number }[] = [];
  let total = 0;
  for (let i = 0; i + 1 < coords.length; i++) {
    const [a, b] = [coords[i], coords[i + 1]];
    const len = Math.hypot((b[0] - a[0]) * cos, b[1] - a[1]);
    const steps = Math.max(1, Math.ceil((len / g.d) * 2));
    for (let k = 0; k < steps; k++) along.push({ lon: a[0] + ((b[0] - a[0]) * k) / steps, lat: a[1] + ((b[1] - a[1]) * k) / steps, s: total + (len * k) / steps });
    total += len;
  }
  const last = coords[coords.length - 1];
  along.push({ lon: last[0], lat: last[1], s: total });
  let bed = along.map((a) => base(a.lon, a.lat));
  const downhill = (v: number[]) => {
    let low = Infinity;
    return v.map((x) => (low = Math.min(low, x)));
  };
  bed = downhill(bed);
  // Smooth the stair-steps of the running minimum, then make sure it still never rises.
  const win = Math.max(2, Math.round(along.length / 40));
  bed = downhill(bed.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - win); k <= Math.min(bed.length - 1, i + win); k++, n++) sum += bed[k];
    return sum / n;
  }));
  bed[bed.length - 1] = Math.min(bed[bed.length - 1], SEA_FLOOR);
  const seed = new Int32Array(g.w * g.h).fill(-1);
  const ts: number[] = [], beds: number[] = [];
  along.forEach((a, i) => {
    let l = a.lon - g.lon0;
    l -= 360 * Math.round(l / 360);
    const x = Math.round((l - g.x0) / g.d), y = Math.round((g.y1 - a.lat) / g.d);
    if (x < 0 || y < 0 || x >= g.w || y >= g.h || seed[y * g.w + x] >= 0) return;
    seed[y * g.w + x] = ts.length;
    ts.push(total > 0 ? a.s / total : 0);
    beds.push(bed[i]);
  });
  const { dist, near } = gridNearest(g, seed);
  // Values of the nearest course point change in steps where two points' areas meet; blur them
  // so valleys have no seams.
  const tg = new Float32Array(g.w * g.h), bg = new Float32Array(g.w * g.h);
  for (let i = 0; i < near.length; i++) {
    const k = near[i];
    if (k >= 0) {
      tg[i] = ts[k];
      bg[i] = beds[k];
    }
  }
  // Wide enough to round off the straight, axis-aligned lines where the nearest course point
  // changes (a distance field built on a grid has them), or ponds and marsh end in L-shaped corners.
  const radius = Math.max(3, Math.round(g.w / 40));
  blur(tg, g.w, g.h, radius);
  blur(bg, g.w, g.h, radius);
  return { ...g, data: dist, t: tg, bed: bg, width: widthRad, reach: (marginDeg / DEG) * 0.9 };
}

/**
 * Distance from the sea (radians) over the land, -1 elsewhere. One grid per landmass, each sized
 * to fit it: a single world-sized grid has texels ~0.18° across, so an island a few degrees wide is
 * a handful of texels and every contour drawn from the field is a staircase of horizontal, vertical
 * and diagonal runs (the L-shaped ridges, valleys and ponds).
 */
class CoastField {
  private grids: GeoGrid[] = [];

  constructor(land: GeoPermissibleObjects) {
    const polygons = (land as { type: string; coordinates: unknown[] }).coordinates as [number, number][][][] | undefined;
    for (const rings of polygons ?? []) {
      if (rings.length && rings[0].length >= 4) this.grids.push(coastGrid({ type: 'Polygon', coordinates: rings }));
    }
  }

  at(lon: number, lat: number): number {
    let best = -1;
    for (const g of this.grids) {
      const d = sample(g, lon, lat, -1);
      if (d > best) best = d;
    }
    return best;
  }
}

/** Target texel size of a landmass's coast grid, degrees: ~2 km on an Earth-sized planet. */
const COAST_TEXEL = 0.02;

function coastGrid(poly: GeoPermissibleObjects): GeoGrid {
  const [[lonA, latA], [lonB, latB]] = geoBounds(poly as Parameters<typeof geoBounds>[0]);
  const extent = Math.max(lonA <= lonB ? lonB - lonA : lonB + 360 - lonA, latB - latA);
  const g = gridAround(poly, 0.05 + extent * 0.03, Math.round(Math.min(640, Math.max(48, extent / COAST_TEXEL))));
  const m = rasterize(g, (ctx, path) => {
    ctx.beginPath();
    path(poly);
    ctx.fill('evenodd');
  });
  const din = gridDistance(g, (i) => !m[i]);
  const data = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) data[i] = m[i] ? din[i] : -1;
  return { ...g, data };
}

/** Two passes of a separable box blur (≈ a gaussian) in place. */
function blur(a: Float32Array, w: number, h: number, r: number): void {
  const n = Math.max(w, h);
  const tmp = new Float32Array(n), run = new Float64Array(n + 1);
  // Running sums make a wide window as cheap as a narrow one.
  const line = (len: number, at: (i: number) => number, put: (i: number, v: number) => void) => {
    for (let i = 0; i < len; i++) run[i + 1] = run[i] + at(i);
    for (let i = 0; i < len; i++) {
      const lo = Math.max(0, i - r), hi = Math.min(len - 1, i + r);
      tmp[i] = (run[hi + 1] - run[lo]) / (hi - lo + 1);
    }
    for (let i = 0; i < len; i++) put(i, tmp[i]);
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) line(w, (x) => a[y * w + x], (x, v) => (a[y * w + x] = v));
    for (let x = 0; x < w; x++) line(h, (y) => a[y * w + x], (y, v) => (a[y * w + x] = v));
  }
}

/** Bilinear sample, or `outside` beyond the grid. */
function sample(g: GeoGrid, lon: number, lat: number, outside: number): number {
  return sampleData(g, g.data, lon, lat, outside);
}

/** Bilinear sample of any array laid out like the grid. */
function sampleData(g: GridShape, data: Float32Array, lon: number, lat: number, outside: number): number {
  let l = lon - g.lon0;
  l -= 360 * Math.round(l / 360);
  const fx = (l - g.x0) / g.d, fy = (g.y1 - lat) / g.d;
  if (fx < 0 || fy < 0 || fx > g.w - 1 || fy > g.h - 1) return outside;
  const x = Math.min(g.w - 2, Math.floor(fx)), y = Math.min(g.h - 2, Math.floor(fy));
  const tx = fx - x, ty = fy - y, i = y * g.w + x, D = data;
  return (D[i] * (1 - tx) + D[i + 1] * tx) * (1 - ty) + (D[i + g.w] * (1 - tx) + D[i + g.w + 1] * tx) * ty;
}

/** lonMin, latMin, lonMax, latMax (lonMax may pass 180 for areas across the date line). */
type Bounds = [number, number, number, number];

function boundsOf(geo: GeoPermissibleObjects, marginDeg: number): Bounds {
  const [[a, b], [c, d]] = geoBounds(geo as Parameters<typeof geoBounds>[0]);
  return [a - marginDeg, b - marginDeg, (c < a ? c + 360 : c) + marginDeg, d + marginDeg];
}

interface RangeField {
  item: MountainShape;
  field: GeoGrid;
  elements: RegionElement[];
  widest: number;
  freq: number;
  foot: number;
}
interface ReliefField {
  amount: number;
  width: number;
  field: GeoGrid;
  area: boolean;
}

/**
 * Everything the heightfield needs from the drawing, as geographic fields. Each item's field is
 * built once per edit of that item — panning and zooming never rebuild them.
 */
class TerrainFields {
  coast: CoastField | null = null;
  ranges: RangeField[] = [];
  reliefs: ReliefField[] = [];
  lifts: { amount: number; field: GeoGrid }[] = [];
  rivers: RiverField[] = [];
  /** Changes whenever any field changes. */
  version = 0;
  private built = new Map<string, { key: string; bounds: Bounds; value: unknown }>();
  private landKey = '';

  /** Rebuild what changed; returns the areas whose terrain changed (for tile invalidation). */
  update(doc: MapDoc, cache: GeometryCache, bed: (lon: number, lat: number) => number): Bounds[] {
    const dirty: Bounds[] = [];
    const landKey = doc.seed + '|' + doc.items.filter((i) => i.kind === 'land').map((i) => `${i.id}:${i.rev}`).join(',');
    if (landKey !== this.landKey) {
      this.landKey = landKey;
      this.coast = new CoastField(cache.land(doc, 0).geo);
      dirty.push([-180, -90, 540, 90]);
    }
    const seen = new Set<string>();
    const get = <T>(item: Item, key: string, bounds: () => Bounds, build: () => T): T => {
      seen.add(item.id);
      const hit = this.built.get(item.id);
      if (hit && hit.key === key) return hit.value as T;
      const b = bounds();
      if (hit) dirty.push(hit.bounds);
      dirty.push(b);
      const value = build();
      this.built.set(item.id, { key, bounds: b, value });
      return value;
    };
    this.ranges = [];
    this.reliefs = [];
    this.lifts = [];
    this.rivers = [];
    for (const item of doc.items) {
      if (item.kind === 'mountains' && item.path.nodes.length >= 3) {
        const elements = cache.elements(doc, item);
        const widest = Math.max(1e-4, ...elements.map((e) => e.radius));
        const poly = areaPolygon(cache.shape(item, doc.seed));
        const margin = widest * DEG * 1.2 + 0.5;
        const key = `${item.rev}|${doc.seed}|${elements.map((e) => e.radius.toFixed(5)).join(',')}`;
        const field = get(item, key, () => boundsOf(poly, margin), () => areaField(poly, margin));
        this.ranges.push({ item, field, elements, widest, freq: (32 * (0.6 + 0.4 * item.density)) / item.scale, foot: item.foothills ? 0.3 : 0 });
      } else if (item.kind === 'relief' && item.path.nodes.length >= 2) {
        const margin = item.width * 3 + 0.3;
        const pts = cache.shape(item, doc.seed);
        if (item.path.closed) {
          const poly = areaPolygon(pts);
          const field = get(item, `${item.rev}|${doc.seed}`, () => boundsOf(poly, margin), () => areaField(poly, margin));
          this.reliefs.push({ amount: item.amount, width: item.width * RAD, field, area: true });
        } else {
          const coords = lineToLonLat(pts);
          const field = get(item, `${item.rev}|${doc.seed}`, () => boundsOf({ type: 'LineString', coordinates: coords }, margin), () => lineField(coords, margin));
          this.reliefs.push({ amount: item.amount, width: item.width * RAD, field, area: false });
        }
      } else if (item.kind === 'land' && item.op === 'add' && item.elevation && item.path.nodes.length >= 3) {
        const poly = areaPolygon(cache.shape(item, doc.seed));
        const field = get(item, `${item.rev}|${doc.seed}`, () => boundsOf(poly, 2), () => areaField(poly, 2, 384));
        this.lifts.push({ amount: item.elevation, field });
      }
    }
    // Rivers last: their bed follows the terrain the other items make (and are rebuilt when it changes).
    const terrainSig = landKey + '|' + doc.items.filter((i) => i.kind === 'mountains' || i.kind === 'relief').map((i) => `${i.id}:${i.rev}`).join(',');
    for (const item of doc.items) {
      if (item.kind !== 'river' || item.path.nodes.length < 2) continue;
      const coords = lineToLonLat(cache.river(doc, item).main);
      const margin = 4.5 + item.width * 3;
      const key = `${item.rev}|${doc.seed}|${coords.length}|${coords[Math.floor(coords.length / 2)]}|${terrainSig}`;
      this.rivers.push(get(item, key, () => boundsOf({ type: 'LineString', coordinates: coords }, margin), () => riverField(coords, margin, item.width * RAD, bed)));
    }
    for (const [id, v] of this.built) {
      if (!seen.has(id)) {
        dirty.push(v.bounds);
        this.built.delete(id);
      }
    }
    if (dirty.length) this.version++;
    return dirty;
  }
}

// ================================================================ the height-tile pyramid

const TS = 64;
const TEX = TS + 1;

interface Tile {
  /** Terrain height and (height − snow line) per texel, (TS+1)² with shared edges. */
  h: Float32Array;
  sd: Float32Array;
  /** Standing water above the ground (WET_SCALE per unit height) and marsh wetness (0–255 = 0–1). */
  wet: Uint8Array;
  marsh: Uint8Array;
  z: number;
  used: number;
}

/** What one point of terrain holds besides its height. */
interface Wet {
  /** Depth of standing water over the ground: lakes, bays and hollows by a river. */
  w: number;
  /** How marshy the ground is, 0–1. */
  m: number;
}
const WET_SCALE = 500;
/** Land lower than this is under water. */
const SEA_LEVEL = -0.03;
const FLOODED = 0.002;

const tileKey = (z: number, tx: number, ty: number) => (z * 4194304 + tx) * 2097152 + ty;

/** Tile level whose texels are a little finer than `radPerPixel`. */
function tileLevelFor(radPerPixel: number): number {
  const texelDeg = radPerPixel * DEG * 0.8;
  return Math.max(1, Math.min(21, Math.ceil(Math.log2(180 / (TS * texelDeg)))));
}

/**
 * Heights cached in geographic tiles (equirectangular, 64×64 texels) at power-of-two levels. A place
 * you've seen keeps its tiles; edits drop only the tiles near what changed; a missing tile borrows
 * from a coarser one until it's computed.
 */
class HeightTiles {
  private tiles = new Map<number, Tile>();
  private clock = 0;
  private hills: Fbm;
  private ridges: Fbm;

  constructor(seed: string, private fields: TerrainFields) {
    this.hills = noise(seed, 'terrain-hills');
    this.ridges = noise(seed, 'terrain-ridges');
  }

  get size(): number {
    return this.tiles.size;
  }

  invalidate(dirty: Bounds[]): void {
    if (!dirty.length) return;
    for (const [k, t] of this.tiles) {
      const z = Math.floor(k / 4194304 / 2097152);
      const tx = Math.floor(k / 2097152) - z * 4194304, ty = k - Math.floor(k / 2097152) * 2097152;
      const deg = 180 / 2 ** z;
      const lon0 = -180 + tx * deg, lat1 = 90 - ty * deg;
      const hit = dirty.some(([a, b, c, d]) => lat1 >= b && lat1 - deg <= d && [0, -360, 360].some((s) => lon0 + s + deg >= a && lon0 + s <= c));
      if (hit) this.tiles.delete(k);
      void t;
    }
  }

  has(z: number, tx: number, ty: number): boolean {
    return this.tiles.has(tileKey(z, tx, ty));
  }

  tileAt(z: number, lon: number, lat: number): [number, number] {
    const deg = 180 / 2 ** z;
    const cols = 2 ** (z + 1), rows = 2 ** z;
    const tx = ((Math.floor((lon + 180) / deg) % cols) + cols) % cols;
    const ty = Math.max(0, Math.min(rows - 1, Math.floor((90 - lat) / deg)));
    return [tx, ty];
  }

  compute(z: number, tx: number, ty: number): void {
    const deg = 180 / 2 ** z, step = deg / TS;
    const lon0 = -180 + tx * deg, lat1 = 90 - ty * deg;
    const level = detailLevel(1 / ((step / DEG) * 1.25));
    const h = new Float32Array(TEX * TEX), sd = new Float32Array(TEX * TEX).fill(-9);
    const wet = new Uint8Array(TEX * TEX), marsh = new Uint8Array(TEX * TEX);
    for (let j = 0; j < TEX; j++) {
      const lat = lat1 - j * step;
      for (let i = 0; i < TEX; i++) {
        const r = this.heightAt(lon0 + i * step, lat, level);
        h[j * TEX + i] = r.h;
        sd[j * TEX + i] = r.sd;
        wet[j * TEX + i] = Math.min(255, Math.round(r.w * WET_SCALE));
        marsh[j * TEX + i] = Math.round(r.m * 255);
      }
    }
    this.tiles.set(tileKey(z, tx, ty), { h, sd, wet, marsh, z, used: ++this.clock });
    if (this.tiles.size > 900) {
      const old = [...this.tiles.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 200);
      for (const [k] of old) this.tiles.delete(k);
    }
  }

  private last: { z: number; want: number; tile: Tile; tx: number; ty: number; lon0: number; lat1: number; deg: number } | null = null;

  /** Height from the finest cached tile at or above level `z`; null if none is cached. */
  sample(z: number, lon: number, lat: number): { h: number; sd: number; w: number; m: number; exact: boolean } | null {
    const L = this.last;
    // Only reuse a tile of exactly the wanted level. A borrowed coarser one may have been replaced
    // by the real tile since, and reusing it paints whole lon/lat boxes with coarse data: seams
    // along straight vertical and horizontal lines.
    if (L && L.z === z && lat <= L.lat1 && lat >= L.lat1 - L.deg) {
      let l = lon - L.lon0;
      l -= 360 * Math.floor(l / 360);
      if (l <= L.deg && this.tiles.get(tileKey(L.z, L.tx, L.ty)) === L.tile) return this.read(L.tile, L.deg, l, L.lat1 - lat, L.z === z);
    }
    for (let lv = z; lv >= 0; lv--) {
      const [tx, ty] = this.tileAt(lv, lon, lat);
      const t = this.tiles.get(tileKey(lv, tx, ty));
      if (!t) continue;
      t.used = ++this.clock;
      const deg = 180 / 2 ** lv;
      this.last = { z: lv, want: z, tile: t, tx, ty, lon0: -180 + tx * deg, lat1: 90 - ty * deg, deg };
      let l = lon - (-180 + tx * deg);
      l -= 360 * Math.floor(l / 360);
      return this.read(t, deg, l, 90 - ty * deg - lat, lv === z);
    }
    return null;
  }

  /** Bilinear read at (dLon, dLat) degrees from a tile's north-west corner. */
  private read(t: Tile, deg: number, dLon: number, dLat: number, exact: boolean): { h: number; sd: number; w: number; m: number; exact: boolean } {
    const fx = Math.min(TS - 1e-6, (dLon / deg) * TS), fy = Math.min(TS - 1e-6, Math.max(0, (dLat / deg) * TS));
    const x = Math.floor(fx), y = Math.floor(fy), ax = fx - x, ay = fy - y, i = y * TEX + x;
    const bl = (A: Float32Array | Uint8Array) => (A[i] * (1 - ax) + A[i + 1] * ax) * (1 - ay) + (A[i + TEX] * (1 - ax) + A[i + TEX + 1] * ax) * ay;
    return { h: bl(t.h), sd: bl(t.sd), w: bl(t.wet) / WET_SCALE, m: bl(t.marsh) / 255, exact };
  }

  /** The terrain the rivers start from: low ground plus relief and mountains, before any river cuts into it. */
  private parts(lon: number, lat: number, level: number): { h: number; mountain: number; snow: number; px: number; py: number; pz: number } | null {
    const F = this.fields;
    const coast = F.coast ? F.coast.at(lon, lat) : -1;
    if (coast < 0) return null;
    const la = lat / DEG, lo = lon / DEG, c = Math.cos(la);
    const px = c * Math.sin(lo), py = Math.sin(la), pz = c * Math.cos(lo);
    const inland = 1 - Math.exp(-coast / 0.06);
    let h = 0.05 + 0.2 * inland + 0.1 * this.hills.fbmDetail(px * 7, py * 7, pz * 7, 4, level, 2, 0.5);
    for (const l of F.lifts) {
      const s = sample(l.field, lon, lat, -1);
      if (s > 0) h += l.amount * 0.35 * smooth(0, 0.03, s);
    }
    for (const r of F.reliefs) {
      // Areas: soft-edged plateaus/basins (half height at the outline); lines: ridges/valleys.
      const s = sample(r.field, lon, lat, r.area ? -9 : 9);
      const f = r.area ? (s >= 0 ? 0.5 + 0.5 * smooth(0, r.width, s) : 0.5 * (1 - smooth(0, r.width, -s))) : Math.exp(-((s / r.width) ** 2) * 1.5);
      if (f > 0.001) h += r.amount * 0.42 * f * (0.75 + 0.5 * this.hills.fbmDetail(px * 18, py * 18, pz * 18, 3, level, 2, 0.55));
    }
    let mountain = 0, snow = 9;
    for (const R of F.ranges) {
      const s = sample(R.field, lon, lat, -9);
      const f = s >= 0 ? R.foot + (1 - R.foot) * smooth(0, R.widest * 0.9, s) : R.foot * (1 - smooth(0, R.widest * 0.8, -s));
      if (f <= 0) continue;
      let massif = 0;
      for (const e of R.elements) {
        const d = Math.hypot(px - e.at[0], py - e.at[1], pz - e.at[2]) / (e.radius * 1.15);
        massif += Math.exp(-d * d);
      }
      massif = R.elements.length ? Math.min(1, 0.35 + massif) : 1;
      const rugged = this.ridges.ridged(px * R.freq, py * R.freq, pz * R.freq, 5 + level);
      const m = R.item.height * f * massif * (0.35 + R.item.ruggedness * 1.1 * rugged + (1 - R.item.ruggedness) * 0.45);
      if (m > mountain) {
        mountain = m;
        snow = R.item.height * (1.3 - R.item.snow * 1.4);
      }
    }
    return { h, mountain, snow, px, py, pz };
  }

  /** Height of the river bed at a point if a river ran there (the terrain, cut down a little, more under mountains). */
  bedBase(lon: number, lat: number): number {
    const p = this.parts(lon, lat, 0);
    return p ? 0.8 * p.h + 0.2 * p.mountain : 0;
  }

  /**
   * Erosion. Rivers cut valleys: a flat floor just above the river bed, with the terrain pulled
   * towards it less and less — a short steep fall-off under mountains (a gorge), a long gentle one
   * on lowland (a floodplain) — and valleys widen downstream. Mountains are also dissected by
   * ravines, deep and plentiful on the flanks near a river and faint elsewhere.
   */
  private erode(out: number, mountain: number, lon: number, lat: number, px: number, py: number, pz: number, wet: Wet): number {
    const mt = smooth(0.12, 0.55, mountain);
    let near = 0, floor = 0;
    for (const R of this.fields.rivers) {
      const d = sample(R, lon, lat, 9);
      if (d > R.reach) continue;
      const t = sampleData(R, R.t, lon, lat, 0), bed = sampleData(R, R.bed, lon, lat, 0);
      const channel = R.width * (0.1 + 0.9 * Math.pow(t, 0.8)) * 0.5;
      const valleyFloor = bed + 0.004;
      const flat = channel * (1.4 + 2.5 * (1 - mt)) + 0.0015;
      // Everything fades out by `reach`, the edge of the river's field. Past it the river is
      // ignored, so a longer fall-off would end in a hard edge: a polygon of straight runs whose
      // corners are the L shapes in the ground.
      const fall = Math.min((0.07 - 0.045 * mt) * (1 + 0.8 * t), R.reach - flat);
      if (fall <= 0) continue;
      // Water seeps into ground lower than the river beside it (a hollow fills like a pond), and
      // low flat ground close to a river stays damp.
      const touching = 1 - smooth(flat, flat + fall * 0.8, d);
      if (touching > 0) {
        const below = bed + 0.002 - out;
        if (below > 0) wet.w = Math.max(wet.w, below * touching);
        else if (mt < 0.5) {
          const damp = touching * (1 - smooth(0.12, 0.3, out)) * (1 - mt * 2) * smooth(-0.25, 0.35, this.hills.fbm(px * 40, py * 40, pz * 40, 2));
          wet.m = Math.max(wet.m, 0.7 * damp);
        }
      }
      if (out > valleyFloor) out = valleyFloor + (out - valleyFloor) * smooth(flat, flat + fall, d);
      const close = smooth(Math.min(0.1, R.reach), 0.02, d);
      if (close > near) {
        near = close;
        floor = valleyFloor;
      }
    }
    if (mt > 0.05) {
      const n = this.hills.fbm(px * 70, py * 70, pz * 70, 2);
      const gully = Math.max(0, 1 - Math.abs(n) * 5);
      const bottom = near > 0 ? floor : 0.06;
      out -= (0.035 + 0.065 * near) * mt * gully * gully * Math.min(1, Math.max(0, out - bottom) * 4);
    }
    return out;
  }

  /** Terrain height (and height above the snow line) at a geographic point. */
  heightAt(lon: number, lat: number, level: number): { h: number; sd: number; w: number; m: number } {
    const p = this.parts(lon, lat, level);
    if (!p) return { h: 0, sd: -9, w: 0, m: 0 };
    const wet: Wet = { w: 0, m: 0 };
    let out = this.erode(p.h + p.mountain, p.mountain, lon, lat, p.px, p.py, p.pz, wet);
    // Land the elevation tool has lowered below sea level is flooded; its shores are marshy.
    if (out < SEA_LEVEL) wet.w = Math.max(wet.w, SEA_LEVEL - out);
    else if (out < SEA_LEVEL + 0.03) wet.m = Math.max(wet.m, 0.8 * (1 - (out - SEA_LEVEL) / 0.03));
    // Soft floor: deep valleys flatten out gently instead of being cut off.
    if (out < 0.06) out = 0.06 - (0.06 - out) * 0.25;
    return { h: out, sd: out - p.snow, w: wet.w, m: wet.m };
  }
}

// ================================================================ the screen frame

export interface TerrainInputs {
  doc: MapDoc;
  cache: GeometryCache;
  style: MapStyle;
  pixelScale: number;
  /** Coastline detail level to draw with (defaults to what the zoom needs). */
  level?: number;
}

interface Scatter {
  x: number;
  y: number;
  sprite: IndexSprite;
  colors: CanopyColors;
}

/** `trees` names the tree shapes a mass is made of; conifers in a mixed wood come in stands. */
const VEG: Record<VegetationKind, { trees: TreeShape[] | null; plant?: 'shrub' | 'grass'; keep: number; conifers?: number; cover: number }> = {
  broadleaf: { trees: ['round'], keep: 1, cover: 1 },
  conifer: { trees: ['cone'], keep: 1, cover: 1 },
  mixed: { trees: ['round', 'cone'], keep: 1, conifers: 0.35, cover: 1 },
  jungle: { trees: ['jungle'], keep: 1, cover: 1 },
  shrubs: { trees: ['shrub'], keep: 0.7, cover: 0.55 },
  grass: { trees: null, plant: 'grass', keep: 0.5, cover: 0.4 },
};

/**
 * Distance between trees on the map, radians of arc (scaled by the area's Size and Density). Trees
 * have a fixed size, so they grow as you zoom in; from far away they are finer than a pixel and the
 * wood is drawn as a canopy mass instead, with trees fading in once they are big enough to read.
 */
const TREE_SPACING = 0.0025;
/** Below this spacing (art pixels) no individual trees are drawn, only the canopy. */
const MIN_TREE_SPACING = 2.6;

/** What a frame knows about each vegetation area, for the canopy mass drawn under and beyond its trees. */
interface FrameForest {
  colors: CanopyColors;
  cover: number;
  /** Noise frequencies (per unit of sphere): density patches over the whole area, mottling at tree scale. */
  fq: number;
  mf: number;
  /** Mass is darker as trees become visible, so crowns stand out against the forest floor. */
  dim: number;
  treeLine: number;
  wood: Fbm;
  mottle: Fbm;
}

interface PlacedTree {
  tree: Tree;
  colors: CanopyColors;
}

/**
 * Distance from lattice points to a forest's outline, computed lazily and remembered per
 * (forest edit, lattice step) so panning and refining don't redo it.
 */
const edgeCache = new Map<string, Map<number, number>>();
function edgeDistances(f: ForestShape, step: number, outline: number[]): { get(cell: number, x: number, y: number, z: number): number } {
  const key = `${f.id}:${f.rev}:${step}`;
  let known = edgeCache.get(key);
  if (!known) {
    if (edgeCache.size >= 12) edgeCache.delete(edgeCache.keys().next().value!);
    edgeCache.set(key, (known = new Map()));
  }
  const memo = known;
  return {
    get(cell, x, y, z) {
      let d = memo.get(cell);
      if (d === undefined) memo.set(cell, (d = outlineDistance(outline, x, y, z)));
      return d;
    },
  };
}

let maskCanvas: HTMLCanvasElement | null = null;

/** Render `geo` into a coverage mask on the screen's art-pixel grid. */
function screenMask(p: Painter, w: number, h: number, art: number, geo: GeoPermissibleObjects): Uint8Array {
  if (!maskCanvas) maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.setTransform(1 / art, 0, 0, 1 / art, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  geoPath(p.projection, ctx)(geo);
  ctx.fill('evenodd');
  const data = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] > 127 ? 1 : 0;
  return out;
}

/** Distance (chamfer, 3 per pixel) from each masked pixel to the mask's edge; the screen's border is not an edge. */
function insideDistance(mask: Uint8Array, w: number, h: number, out: Uint8Array): void {
  const d = new Uint8Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 255 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = Math.min(255, v);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = Math.min(255, v);
    }
  }
  for (let i = 0; i < d.length; i++) if (mask[i]) out[i] = d[i];
}

/** The part of the world the screen shows, padded: latitude range and a longitude interval (degrees). */
interface ViewBounds {
  lon0: number;
  lon1: number;
  lat0: number;
  lat1: number;
}

function viewBounds(p: Painter): ViewBounds {
  const W = p.width, H = p.height, m = 80;
  let lat0 = 90, lat1 = -90, lonC = NaN, dMin = 0, dMax = 0, seen = 0;
  for (let j = 0; j <= 10; j++) {
    for (let i = 0; i <= 10; i++) {
      const x = -m + ((W + 2 * m) * i) / 10, y = -m + ((H + 2 * m) * j) / 10;
      const g = p.projection.invert?.([x, y]);
      if (!g || !Number.isFinite(g[0]) || !Number.isFinite(g[1]) || Math.abs(g[1]) > 90) continue;
      const back = p.projection(g as [number, number]);
      // Inverse projections happily extrapolate past the edge of the world.
      if (!back || Math.hypot(back[0] - x, back[1] - y) > 2) continue;
      seen++;
      lat0 = Math.min(lat0, g[1]);
      lat1 = Math.max(lat1, g[1]);
      if (Number.isNaN(lonC)) lonC = g[0];
      const dl = ((g[0] - lonC + 540) % 360) - 180;
      dMin = Math.min(dMin, dl);
      dMax = Math.max(dMax, dl);
    }
  }
  if (!seen) return { lon0: -180, lon1: 180, lat0: -90, lat1: 90 };
  const padLat = (lat1 - lat0) * 0.1 + 0.3;
  lat0 = Math.max(-90, lat0 - padLat);
  lat1 = Math.min(90, lat1 + padLat);
  const padLon = (dMax - dMin) * 0.1 + 0.3 / Math.max(0.05, Math.cos(Math.max(Math.abs(lat0), Math.abs(lat1)) / DEG));
  if (lat0 < -80 || lat1 > 80 || dMax - dMin + 2 * padLon > 340) return { lon0: -180, lon1: 180, lat0, lat1 };
  return { lon0: lonC + dMin - padLon, lon1: lonC + dMax + padLon, lat0, lat1 };
}

/** Geo-anchored jittered points about `spacingRad` apart over a region (steps a quarter-octave apart). */
function lattice(p: Painter, poly: GeoPermissibleObjects, spacingRad: number, salt: number, view?: ViewBounds): { pts: { x: number; y: number; cell: number; at: [number, number] }[]; step: number } {
  const level = Math.max(0, Math.ceil(4 * Math.log2(spacingRad / 0.00025)));
  let step = 0.00025 * 2 ** (level / 4);
  const [[lonA, latA], [lonB, latB]] = geoBounds(poly as Parameters<typeof geoBounds>[0]);
  const pts: { x: number; y: number; cell: number; at: [number, number] }[] = [];
  // Only the part of the area the screen shows needs points.
  let lat0 = latA, lat1 = latB, span = lonA <= lonB ? [lonA, lonB] : [lonA, lonB + 360];
  if (view) {
    lat0 = Math.max(lat0, view.lat0);
    lat1 = Math.min(lat1, view.lat1);
    if (lat0 > lat1) return { pts, step };
    if (view.lon1 - view.lon0 < 359) {
      const shift = 360 * Math.round(((span[0] + span[1]) / 2 - (view.lon0 + view.lon1) / 2) / 360);
      const i0 = Math.max(span[0], view.lon0 + shift), i1 = Math.min(span[1], view.lon1 + shift);
      if (i0 > i1) return { pts, step };
      span = [i0, i1];
    }
  }
  for (let tries = 0; tries < 6; tries++) {
    pts.length = 0;
    const r0 = Math.floor((lat0 / DEG + Math.PI / 2) / step), r1 = Math.floor((lat1 / DEG + Math.PI / 2) / step);
    let count = 0;
    for (let r = r0; r <= r1 && count < 60000; r++) {
      const phi = -Math.PI / 2 + (r + 0.5) * step;
      const cols = Math.max(1, Math.floor((2 * Math.PI * Math.cos(phi)) / step));
      const colStep = (2 * Math.PI) / cols;
      const c0 = Math.floor((span[0] / DEG + Math.PI) / colStep) - 1, c1 = Math.ceil((span[1] / DEG + Math.PI) / colStep) + 1;
      for (let cc = c0; cc <= c1; cc++) {
        count++;
        const c = ((cc % cols) + cols) % cols;
        const lam = -Math.PI + (c + (r % 2 ? 0.5 : 0) + (cellHash(r, c, salt) - 0.5) * 0.7) * colStep;
        const la = phi + (cellHash(c, r, salt + 1) - 0.5) * 0.7 * step;
        const at: [number, number] = [lam * DEG, la * DEG];
        const s = p.visible(at, 60);
        if (s) pts.push({ x: s[0], y: s[1], cell: (Math.imul(r, 92821) ^ c) >>> 0, at });
      }
    }
    if (count < 60000) return { pts, step };
    step *= 2;
  }
  return { pts, step };
}

const SCREEN_TILE = 48;

/**
 * One screen image of the terrain at `art` screen px per pixel: heights sampled from the tile
 * pyramid, hill-shaded and colour-banded with ordered dithering, then puffy canopy masses and
 * scattered shrubs/grass. Rendered in tiles nearest the centre first.
 */
class TerrainFrame {
  readonly W: number;
  readonly H: number;
  readonly canvas = document.createElement('canvas');
  private out: Uint8ClampedArray<ArrayBuffer>;
  private ctx: CanvasRenderingContext2D;
  private land!: Uint8Array;
  private tintOf!: Uint8Array;
  private palettes: ReliefPalette[] = [];
  private trees: PlacedTree[] = [];
  private forests: FrameForest[] = [];
  /** Per pixel: the vegetation area (1-based index into `forests`) covering it, and the distance to its edge. */
  private forestOf!: Uint8Array;
  private edgeOf!: Uint8Array;
  private waterColors!: { ramp: RGBA[]; rim: RGBA; marsh: RGBA; reed: RGBA };
  private scatter: Scatter[] = [];
  private tiles: [number, number, number, number][] = [];
  private next = 0;
  private empty = false;
  readonly z: number;

  constructor(private p: Painter, private inputs: TerrainInputs, private heights: HeightTiles, private fields: TerrainFields, readonly art: number) {
    this.W = Math.max(1, Math.ceil(p.width / art));
    this.H = Math.max(1, Math.ceil(p.height / art));
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d')!;
    this.out = new Uint8ClampedArray(this.W * this.H * 4);
    this.z = tileLevelFor(art / p.projection.scale());
    this.prepare();
  }

  get finished(): boolean {
    return this.empty || this.next >= this.tiles.length;
  }

  private prepare(): void {
    const { p, W, H, art } = this;
    const { doc, cache, style } = this.inputs;
    const level = this.inputs.level ?? detailLevel(p.projection.scale());
    this.land = screenMask(p, W, H, art, cache.land(doc, level).geo);
    if (!this.land.includes(1)) return void (this.empty = true);
    this.tintOf = new Uint8Array(W * H);
    this.forestOf = new Uint8Array(W * H);
    this.edgeOf = new Uint8Array(W * H);
    this.palettes = [reliefPalette(style)];
    {
      const sea = hexToRgba(style.sea), ink = hexToRgba(style.ink), land = hexToRgba(style.land);
      this.waterColors = {
        ramp: [mix(sea, land, 0.3), sea, mix(sea, ink, 0.2)],
        rim: mix(ink, sea, 0.3),
        marsh: mix(sea, hexToRgba('#6f8b5a'), 0.5),
        reed: mix(ink, hexToRgba('#6f8b5a'), 0.45),
      };
    }
    for (const item of doc.items) {
      if (item.kind !== 'land' || item.op !== 'add' || !item.color || item.path.nodes.length < 3) continue;
      const m = screenMask(p, W, H, art, areaPolygon(cache.shape(item, doc.seed, level)));
      this.palettes.push(reliefPalette({ ...style, land: item.color }));
      for (let i = 0; i < m.length; i++) if (m[i]) this.tintOf[i] = this.palettes.length - 1;
    }
    for (const f of doc.items) if (f.kind === 'forest' && f.path.nodes.length >= 3) this.placePlants(f);
    this.trees.sort((a, b) => a.tree.foot - b.tree.foot);
    this.scatter.sort((a, b) => a.y - b.y);
    for (let y = 0; y < H; y += SCREEN_TILE) for (let x = 0; x < W; x += SCREEN_TILE) this.tiles.push([x, y, Math.min(W, x + SCREEN_TILE), Math.min(H, y + SCREEN_TILE)]);
    const cx = W / 2, cy = H / 2;
    const dist = (t: number[]) => Math.hypot((t[0] + t[2]) / 2 - cx, (t[1] + t[3]) / 2 - cy);
    this.tiles.sort((a, b) => dist(a) - dist(b));
  }

  private geoAt(x: number, y: number): [number, number] | null {
    return this.p.projection.invert!([(x + 0.5) * this.art, (y + 0.5) * this.art]) as [number, number] | null;
  }

  private heightAt(g: [number, number]): { h: number; sd: number; w: number; m: number } {
    return this.heights.sample(this.z, g[0], g[1]) ?? this.heights.heightAt(g[0], g[1], 0);
  }

  /**
   * Plants: geo-anchored (they stay put while panning), on land, below the tree line, off river
   * banks. Woods are thicker in the middle, thin and shrink towards the edge, have glades and
   * lighter and darker stands (low-frequency noise), and a few saplings stray past the outline.
   */
  private placePlants(f: ForestShape): void {
    const { p, W, H, art } = this;
    const { doc, cache, style } = this.inputs;
    const look = VEG[f.vegetation] ?? VEG.mixed;
    const outline = cache.shape(f, doc.seed);
    const poly = areaPolygon(outline);
    const fm = screenMask(p, W, H, art, poly);
    const colors = canopyColors(f.vegetation, style, f.color);
    // Trees have a fixed size on the map. Far away they are finer than a pixel: only the canopy mass
    // is drawn, and trees fade in as they grow big enough to show their silhouettes.
    const scale = p.projection.scale();
    const extent = Math.sqrt(geoArea(poly));
    const spacingRad = (TREE_SPACING * f.scale) / Math.max(0.4, f.density);
    const spacingArt = (spacingRad * scale) / art;
    const treeLine = 0.6 + 0.2 * f.height;
    const wood = noise(doc.seed, 'wood'), stands = noise(doc.seed, 'stands');
    const fq = 3.5 / Math.max(1e-3, extent);
    this.addCanopy(fm, {
      colors, cover: look.cover, fq, treeLine, wood, mottle: noise(doc.seed, 'canopy'),
      mf: 1 / Math.max(2.2 * spacingRad, (4 * art) / scale),
      dim: 0.18 * smooth(MIN_TREE_SPACING, 8, spacingArt),
    });
    // Quick frames (while moving) show the canopy only; the trees settle in once the view is still.
    if (spacingArt < MIN_TREE_SPACING || art > this.inputs.pixelScale + 1e-6) return;
    const grid = lattice(p, poly, spacingRad, 5, viewBounds(p));
    // Size plants from the grid's real step so neighbours overlap.
    const spacing = (grid.step * scale) / art;
    const edges = edgeDistances(f, grid.step, outline);
    for (const q of grid.pts) {
      const x = q.x / art, y = q.y / art, xi = Math.floor(x), yi = Math.floor(y);
      const onScreen = xi >= 0 && yi >= 0 && xi < W && yi < H;
      let inside: boolean;
      if (onScreen) {
        const i = yi * W + xi;
        if (!this.land[i]) continue;
        inside = fm[i] === 1;
      } else {
        // Just off-screen: no masks there, so check the outline directly (its crown may reach in).
        if (xi < -spacing * 2 || yi < -spacing * 2 || xi > W + spacing * 2 || yi > H + spacing * 2) continue;
        inside = geoContains(poly, q.at);
      }
      if (!inside && cellHash(q.cell, 21, 2) > 0.34) continue;
      const [ux, uy, uz] = fromLonLat(q.at);
      const toEdge = edges.get(q.cell, ux, uy, uz) / grid.step;
      if (!inside && toEdge > 0.9) continue;
      if (onScreen) {
        let river = 9;
        for (const g of this.fields.rivers) river = Math.min(river, sample(g, q.at[0], q.at[1], 9));
        if (river < 0.004 + spacingRad * 0.3) continue;
        const ground = this.heightAt(q.at);
        if (ground.w > FLOODED || ground.h > treeLine + (cellHash(q.cell, 1, 3) - 0.5) * 0.08) continue;
      }
      if (cellHash(q.cell, 11, 2) > look.keep) continue;
      const n = wood.fbm(ux * fq, uy * fq, uz * fq, 3);
      // 0 at the outline (and past it), 1 well inside.
      const depth = inside ? smooth(0, 2.5, toEdge) : 0;
      if (inside) {
        if (cellHash(q.cell, 23, 4) > (0.8 + 0.8 * n) * (0.6 + 0.4 * depth)) continue;
      } else if (cellHash(q.cell, 25, 4) > 1 - toEdge / 0.9) continue;
      let vary = 1 + (cellHash(q.cell, 5, 1) - 0.5) * f.variety * 1.4;
      if (cellHash(q.cell, 6, 8) < 0.07) vary *= 1.3;
      const size = (inside ? 0.55 + 0.45 * depth : 0.45) * (0.92 + 0.16 * n);
      if (look.trees) {
        let shape: TreeShape;
        if (look.conifers !== undefined) {
          const stand = stands.fbm(ux * fq * 1.3, uy * fq * 1.3, uz * fq * 1.3, 2);
          shape = cellHash(q.cell, 3, 9) < Math.max(0.04, Math.min(0.96, look.conifers + 1.1 * stand)) ? 'cone' : 'round';
        } else shape = look.trees[Math.floor(cellHash(q.cell, 3, 9) * look.trees.length)];
        const r = spacing * (shape === 'cone' ? 1.0 : shape === 'jungle' ? 0.95 : shape === 'shrub' ? 0.85 : 0.8) * vary * size;
        if (r < 1.6 * (0.8 + 0.4 * cellHash(q.cell, 31, 6))) continue;
        const tone = (cellHash(q.cell, 8, 3) - 0.5) * 0.16 + 0.12 * n;
        this.trees.push({ tree: makeTree(x, y, r, shape, shape === 'shrub' ? 0.6 * f.height : f.height, q.cell, tone), colors });
      } else {
        const w = Math.max(2, Math.round(spacing * 1.1 * vary)), h = Math.max(2, Math.round(spacing * 0.9 * f.height * vary));
        this.scatter.push({ x, y, sprite: plantSprite(look.plant!, w, h, q.cell % 16, true), colors });
      }
    }
  }

  /** Claim the pixels of a vegetation area for the canopy mass, and measure how far each is from the edge. */
  private addCanopy(fm: Uint8Array, forest: FrameForest): void {
    if (this.forests.length >= 255) return;
    this.forests.push(forest);
    const id = this.forests.length;
    let any = false;
    for (let i = 0; i < fm.length; i++) {
      if (fm[i]) {
        this.forestOf[i] = id;
        any = true;
      }
    }
    if (any) insideDistance(fm, this.W, this.H, this.edgeOf);
  }

  /**
   * The wood as a mass, seen from afar: mottled canopy greens in a dither, thinning in glades and
   * towards the edge, with a darker rim. Under visible trees it is their shaded forest floor.
   * `edge` is how many pixels inside the outline the pixel is (1 = the outermost).
   */
  private massPixel(c: RGBA, f: FrameForest, x: number, y: number, dens: number, mottle: number, edge: number): RGBA {
    // Dense where the wood is thick, bare in glades, with a narrow dithered transition between.
    const dense = smooth(0.28, 0.72, Math.max(0, Math.min(1, 0.8 + 0.8 * dens)) * (0.5 + 0.5 * smooth(0, 3, edge)));
    if (dense < 0.04) return c;
    const lum = 0.46 + 0.3 * mottle + 0.1 * dens - f.dim;
    const tone = f.colors.ramp[Math.max(1, Math.min(3, Math.floor(lum * 4 + (dither(x + 1, y + 2) - 0.5) * 0.7 + 0.5)))];
    // Scrub and grass are a light tint over the ground, not a solid canopy.
    if (f.cover < 0.9) return mix(c, tone, f.cover * dense * 0.8);
    if (edge <= 1.01 && dense > 0.3) return f.colors.edge;
    // Bare patches keep a faint green wash, so glades read as undergrowth, not speckle.
    if (dither(x, y) >= dense) return mix(c, f.colors.ramp[2], 0.3 * dense);
    return tone;
  }

  private renderTile([x0, y0, x1, y1]: [number, number, number, number]): void {
    const { W, H, out } = this;
    const tw = x1 - x0 + 2, th = y1 - y0 + 2;
    const hs = new Float32Array(tw * th), sds = new Float32Array(tw * th).fill(-9);
    const ws = new Float32Array(tw * th), ms = new Float32Array(tw * th);
    const nds = new Float32Array(tw * th), nms = new Float32Array(tw * th);
    for (let ty = 0; ty < th; ty++) {
      const y = y0 - 1 + ty;
      if (y < 0 || y >= H) continue;
      for (let tx = 0; tx < tw; tx++) {
        const x = x0 - 1 + tx;
        if (x < 0 || x >= W || !this.land[y * W + x]) continue;
        const g = this.geoAt(x, y);
        if (!g) continue;
        const r = this.heightAt(g);
        hs[ty * tw + tx] = r.h;
        sds[ty * tw + tx] = r.sd;
        ws[ty * tw + tx] = r.w;
        ms[ty * tw + tx] = r.m;
        const fid = this.forestOf[y * W + x];
        if (fid) {
          const F = this.forests[fid - 1];
          const [ux, uy, uz] = fromLonLat(g);
          let river = 9;
          for (const rg of this.fields.rivers) river = Math.min(river, sample(rg, g[0], g[1], 9));
          // No canopy over rivers, standing water or above the tree line.
          nds[ty * tw + tx] = river < 0.004 || r.h > F.treeLine ? -2 : F.wood.fbm(ux * F.fq, uy * F.fq, uz * F.fq, 3);
          nms[ty * tw + tx] = F.mottle.fbm(ux * F.mf, uy * F.mf, uz * F.mf, 2);
        }
      }
    }
    const E = 0.035, L = [-0.55, -0.55, 0.63];
    const rpa = this.art / this.p.projection.scale();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        if (!this.land[i]) continue;
        const t = (y - y0 + 1) * tw + (x - x0 + 1);
        const hl = x > 0 && this.land[i - 1] ? hs[t - 1] : hs[t], hr = x < W - 1 && this.land[i + 1] ? hs[t + 1] : hs[t];
        const hu = y > 0 && this.land[i - W] ? hs[t - tw] : hs[t], hd = y < H - 1 && this.land[i + W] ? hs[t + tw] : hs[t];
        const gx = ((hr - hl) / (2 * rpa)) * E, gy = ((hd - hu) / (2 * rpa)) * E;
        const nl = Math.hypot(gx, gy, 1);
        const lit = (-gx * L[0] - gy * L[1] + L[2]) / nl - L[2];
        // A dead zone keeps flat ground calm; slopes break into dithered steps.
        const l = Math.abs(lit) < 0.06 ? 0 : lit - Math.sign(lit) * 0.06;
        const step = Math.max(-2, Math.min(2, Math.floor(l * 3 + dither(x, y))));
        const h = hs[t];
        const band0 = h < 0.18 ? 0 : h < 0.32 ? 1 : h < 0.55 ? 2 : 3;
        let band = band0 + (band0 < 3 && dither(y, x) < (h - [0.18, 0.32, 0.55, 9][band0] + 0.02) / 0.04 ? 1 : 0);
        if (sds[t] > (dither(x + 1, y) - 0.5) * 0.08) band = 4;
        const pal = this.palettes[this.tintOf[i]];
        let c = pal.bands[Math.min(4, band)];
        const fid = this.forestOf[i];
        if (fid && ws[t] <= FLOODED) c = this.massPixel(c, this.forests[fid - 1], x, y, nds[t], nms[t], this.edgeOf[i] / 3);
        c = step < 0 ? mix(c, pal.shadow, -step * 0.2) : step > 0 ? mix(c, pal.light, step * 0.18) : c;
        if (ws[t] > FLOODED) c = this.waterPixel(x, y, ws[t], [ws[t - 1], ws[t + 1], ws[t - tw], ws[t + tw]], [this.land[i - 1], this.land[i + 1], this.land[i - W], this.land[i + W]]);
        else if (ms[t] > 0.12) c = this.marshPixel(c, x, y, ms[t]);
        out.set(c, i * 4);
      }
    }
    this.drawTrees(x0, y0, x1, y1);
    this.drawScatter(x0, y0, x1, y1);
  }

  /** Standing water: three depth steps (dithered between), a shore line where it meets dry land. */
  private waterPixel(x: number, y: number, depth: number, around: number[], isLand: number[]): RGBA {
    const wp = this.waterColors;
    for (let k = 0; k < 4; k++) if (isLand[k] && around[k] <= FLOODED) return wp.rim;
    return wp.ramp[Math.max(0, Math.min(2, Math.floor(Math.min(2, depth * 22) + (dither(x, y) - 0.5) * 0.7 + 0.5)))];
  }

  /** Damp ground: the land colour pulled towards a murky green in a dither, with a few reed ticks. */
  private marshPixel(c: RGBA, x: number, y: number, wetness: number): RGBA {
    const wp = this.waterColors;
    if (cellHash(x, y, 77) < 0.05 * wetness) return wp.reed;
    return dither(x + 3, y) < wetness * 0.9 ? mix(c, wp.marsh, 0.55) : c;
  }

  /**
   * Trees back to front: cast shadows on the ground first, then crowns shaded from a brightness
   * onto the colour ramp (ordered dither between steps). A dark rim marks the outer silhouette and
   * a deep line where a nearer crown overlaps one behind it.
   */
  private drawTrees(x0: number, y0: number, x1: number, y1: number): void {
    const { W, H, out } = this;
    const near = this.trees.filter(({ tree: t }) => t.box[2] >= x0 - 1 && t.box[0] <= x1 && t.box[3] >= y0 - 1 && t.box[1] <= y1);
    if (!near.length) return;
    const tw = x1 - x0 + 2, th = y1 - y0 + 2;
    const owner = new Int32Array(tw * th).fill(-1);
    const lum = new Float32Array(tw * th);
    const shade = new Float32Array(tw * th);
    const shadeOf = new Int32Array(tw * th).fill(-1);
    near.forEach(({ tree: t }, k) => {
      const [sx, sy, rx, ry] = shadowOf(t);
      for (let y = Math.max(y0 - 1, Math.floor(sy - ry)); y <= Math.min(y1, Math.ceil(sy + ry)); y++) {
        for (let x = Math.max(x0 - 1, Math.floor(sx - rx)); x <= Math.min(x1, Math.ceil(sx + rx)); x++) {
          const e = ((x + 0.5 - sx) / rx) ** 2 + ((y + 0.5 - sy) / ry) ** 2;
          const i = (y - y0 + 1) * tw + (x - x0 + 1);
          if (e < 1 && 1 - e > shade[i]) {
            shade[i] = 1 - e;
            shadeOf[i] = k;
          }
        }
      }
      for (let y = Math.max(y0 - 1, t.box[1]); y <= Math.min(y1, t.box[3]); y++) {
        if (y < 0 || y >= H) continue;
        for (let x = Math.max(x0 - 1, t.box[0]); x <= Math.min(x1, t.box[2]); x++) {
          if (x < 0 || x >= W || !this.land[y * W + x]) continue;
          const v = sampleTree(t, x + 0.5, y + 0.5);
          if (v === OUTSIDE) continue;
          const i = (y - y0 + 1) * tw + (x - x0 + 1);
          owner[i] = k;
          lum[i] = v;
        }
      }
    });
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const t = (y - y0 + 1) * tw + (x - x0 + 1);
        const k = owner[t];
        const px = (y * W + x) * 4;
        if (k < 0) {
          const s = shade[t];
          if (s > 0.12 && this.land[y * W + x] && (s > 0.5 || dither(x, y) < (s - 0.12) / 0.38)) {
            out.set(mix([out[px], out[px + 1], out[px + 2], 255], near[shadeOf[t]].colors.shadow, 0.42), px);
          }
          continue;
        }
        const { colors } = near[k];
        if (lum[t] === TRUNK || lum[t] === TRUNK_LIT) {
          out.set(lum[t] === TRUNK ? colors.trunk : colors.trunkLight, px);
          continue;
        }
        // Neighbours off the screen count as the same tree, so no rim runs along the frame.
        const up = y > 0 ? owner[t - tw] : k, left = x > 0 ? owner[t - 1] : k, right = x < W - 1 ? owner[t + 1] : k, down = y < H - 1 ? owner[t + tw] : k;
        let c: RGBA;
        if (up < 0 || left < 0 || right < 0 || down < 0) c = up < 0 || left < 0 ? mix(colors.dark, colors.edge, 0.5) : colors.edge;
        else if (up !== k && up < k) c = colors.ramp[0];
        else c = colors.ramp[Math.max(0, Math.min(4, Math.floor(lum[t] * 4 + (dither(x, y) - 0.5) * 0.45 + 0.5)))];
        out.set(c, px);
      }
    }
  }

  private drawScatter(x0: number, y0: number, x1: number, y1: number): void {
    const { W, out } = this;
    for (const s of this.scatter) {
      const sx = Math.round(s.x - s.sprite.w / 2), sy = Math.round(s.y - s.sprite.h + 1);
      if (sx > x1 || sy > y1 || sx + s.sprite.w < x0 || sy + s.sprite.h < y0) continue;
      const pal: Partial<Record<number, RGBA>> = { [INK]: s.colors.edge, [PAPER]: s.colors.light, [SHADE]: s.colors.dark, [SNOW]: s.colors.light };
      for (let y = 0; y < s.sprite.h; y++) {
        const Y = sy + y;
        if (Y < y0 || Y >= y1) continue;
        for (let x = 0; x < s.sprite.w; x++) {
          const X = sx + x;
          const v = s.sprite.px[y * s.sprite.w + x];
          if (v === EMPTY || X < x0 || X >= x1 || !this.land[Y * W + X]) continue;
          const c = pal[v];
          if (c) out.set(c, (Y * W + X) * 4);
        }
      }
    }
  }

  /** Render tiles for up to `budgetMs`, then show them. Returns true when the whole view is done. */
  step(budgetMs: number): boolean {
    if (this.empty) return true;
    const t0 = performance.now();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    while (this.next < this.tiles.length && (this.next === 0 || performance.now() - t0 < budgetMs)) {
      const t = this.tiles[this.next++];
      this.renderTile(t);
      x0 = Math.min(x0, t[0]);
      y0 = Math.min(y0, t[1]);
      x1 = Math.max(x1, t[2]);
      y1 = Math.max(y1, t[3]);
    }
    if (x1 > x0) this.ctx.putImageData(new ImageData(this.out, this.W, this.H), 0, 0, x0, y0, x1 - x0, y1 - y0);
    return this.finished;
  }

  runAll(): HTMLCanvasElement | null {
    if (this.empty) return null;
    while (!this.step(1e9));
    return this.canvas;
  }

  /** Height tiles this view wants that aren't cached yet, nearest the centre first. */
  missingTiles(): [number, number, number][] {
    const out: [number, number, number][] = [];
    const seen = new Set<number>();
    const { W, H } = this;
    if (this.empty) return out;
    const stride = Math.max(2, Math.round(12 / this.art));
    const pts: [number, number][] = [];
    for (let y = 0; y < H; y += stride) for (let x = 0; x < W; x += stride) pts.push([x, y]);
    pts.sort((a, b) => Math.hypot(a[0] - W / 2, a[1] - H / 2) - Math.hypot(b[0] - W / 2, b[1] - H / 2));
    for (const [x, y] of pts) {
      if (!this.land[y * W + x]) continue;
      const g = this.geoAt(x, y);
      if (!g) continue;
      const [tx, ty] = this.heights.tileAt(this.z, g[0], g[1]);
      const k = tileKey(this.z, tx, ty);
      if (seen.has(k) || this.heights.has(this.z, tx, ty)) continue;
      seen.add(k);
      out.push([this.z, tx, ty]);
    }
    return out;
  }
}

// ================================================================ the screen layer and exports

/**
 * The map's terrain. Influence fields rebuild only for items you change; heights live in a tile
 * pyramid that remembers places you've been; the screen image is cheap sampling. While moving,
 * frames render at a pixel size chosen to fit the frame budget; once still, missing height tiles
 * fill in and the full-detail image builds from the centre outwards in small time slices.
 */
export class TerrainLayer {
  private fields = new TerrainFields();
  private heights: HeightTiles | null = null;
  private seed = '';
  private key = '';
  private quick: TerrainFrame | null = null;
  private fine: TerrainFrame | null = null;
  private settleTimer = 0;
  private settled = false;
  private msPerPixel = 0.0006;
  private lastShown = 0;
  private lastDocKey = '';
  private lastDocChange = 0;
  /** Time and coarseness of the last quick frame (for tuning and checks). */
  lastQuick = { ms: 0, factor: 1 };

  /** `renderCost` says how long the map's last full redraw took (ms), so progress frames don't swamp a slow one. */
  constructor(private requestRender: () => void, private renderCost: () => number = () => 0) {}

  /** True while following a change with quick frames (vectors can skip slow work too). */
  get moving(): boolean {
    return !this.settled;
  }

  /** Make sure fields and the tile cache match the document (deferring rebuilds mid-edit). */
  private sync(doc: MapDoc, cache: GeometryCache, editing: boolean): void {
    if (!this.heights || this.seed !== doc.seed) {
      this.seed = doc.seed;
      this.fields = new TerrainFields();
      const heights = (this.heights = new HeightTiles(doc.seed, this.fields));
      this.fields.update(doc, cache, (lon, lat) => heights.bedBase(lon, lat));
      return;
    }
    const heights = this.heights;
    if (!editing) heights.invalidate(this.fields.update(doc, cache, (lon, lat) => heights.bedBase(lon, lat)));
  }

  draw(p: Painter, inputs: TerrainInputs): void {
    const { doc, cache, style, pixelScale } = inputs;
    const docKey = doc.seed + '|' + doc.items.filter((i) => i.kind !== 'label' && i.kind !== 'symbol' && i.kind !== 'border').map((i) => `${i.id}:${i.rev}`).join(',');
    const now = performance.now();
    if (docKey !== this.lastDocKey) {
      this.lastDocKey = docKey;
      this.lastDocChange = now;
    }
    // Mid-edit (changes arriving quickly), keep the old fields; rebuild once the edit settles.
    this.sync(doc, cache, now - this.lastDocChange < 150 && !this.settled);
    const heights = this.heights!;
    const proj = p.projection;
    const key = [style.id, pixelScale, docKey, this.fields.version, inputs.level ?? '', proj.rotate(), proj.scale(), proj.translate(), p.width, p.height].join('|');

    if (key !== this.key) {
      this.key = key;
      this.settled = false;
      this.fine = null;
      if (!heights.has(1, 0, 0)) for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 4; tx++) heights.compute(1, tx, ty);
      // A quick frame now, at a pixel size that fits the frame budget.
      const pixels = (p.width / pixelScale) * (p.height / pixelScale);
      const factor = Math.max(1, Math.min(4, Math.ceil(Math.sqrt((pixels * this.msPerPixel) / 12))));
      const t0 = performance.now();
      const frame = new TerrainFrame(p, inputs, heights, this.fields, pixelScale * factor);
      frame.runAll();
      const ms = performance.now() - t0;
      if (frame.W * frame.H > 0) this.msPerPixel = this.msPerPixel * 0.7 + (ms / (frame.W * frame.H)) * 0.3;
      this.lastQuick = { ms, factor };
      this.quick = frame;
      clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => {
        this.settled = true;
        this.requestRender();
      }, 160);
    } else if (this.settled && !this.fine) {
      this.refine(p, inputs);
    }
    const base = this.fine?.finished ? this.fine : this.quick;
    if (base) p.sprite(base.canvas, (base.W * base.art) / 2, (base.H * base.art) / 2, base.art);
    if (this.fine && !this.fine.finished) p.sprite(this.fine.canvas, (this.fine.W * this.fine.art) / 2, (this.fine.H * this.fine.art) / 2, this.fine.art);
  }

  /** Once still: fill missing height tiles (centre first), then build the full-detail image. */
  private refine(p: Painter, inputs: TerrainInputs): void {
    const heights = this.heights!;
    const key = this.key;
    // Fields deferred during an edit are rebuilt now that it has settled.
    this.sync(inputs.doc, inputs.cache, false);
    const fine = new TerrainFrame(p, inputs, heights, this.fields, inputs.pixelScale);
    this.fine = fine;
    const missing = fine.missingTiles();
    let started = false;
    const tick = () => {
      if (this.key !== key || this.fine !== fine) return;
      const t0 = performance.now();
      while (missing.length && performance.now() - t0 < 8) {
        const [z, tx, ty] = missing.shift()!;
        if (!heights.has(z, tx, ty)) heights.compute(z, tx, ty);
      }
      let done = false;
      if (!missing.length) {
        started = true;
        done = fine.step(Math.max(2, 8 - (performance.now() - t0)));
      }
      const now = performance.now();
      if (done || (started && now - this.lastShown > Math.max(150, 3 * this.renderCost()))) {
        this.lastShown = now;
        this.requestRender();
      }
      if (!done) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** A full-detail image right now (exports). */
  renderNow(p: Painter, inputs: TerrainInputs): HTMLCanvasElement | null {
    this.sync(inputs.doc, inputs.cache, false);
    const frame = new TerrainFrame(p, inputs, this.heights!, this.fields, inputs.pixelScale);
    for (const [z, tx, ty] of frame.missingTiles()) this.heights!.compute(z, tx, ty);
    return frame.runAll();
  }

  /**
   * Terrain height and distance from the sea at geographic points, for planning things on the map
   * (where a river would flow). Brings the fields up to date with the document first.
   */
  probe(doc: MapDoc, cache: GeometryCache): { height(lon: number, lat: number): number; coastDistance(lon: number, lat: number): number } {
    this.sync(doc, cache, false);
    const heights = this.heights!, fields = this.fields;
    return {
      height: (lon, lat) => {
        const r = heights.heightAt(lon, lat, 0);
        return r.w > FLOODED ? 0 : r.h;
      },
      /** Radians from the nearest sea; negative off the land. */
      coastDistance: (lon, lat) => (fields.coast ? fields.coast.at(lon, lat) : -1),
    };
  }

  /** True once the view is shown at full detail (nothing left to refine). */
  get isRefined(): boolean {
    return this.settled && !!this.fine?.finished;
  }

  /** For checks: how many height tiles are cached. */
  get cachedTiles(): number {
    return this.heights?.size ?? 0;
  }
}

/** Full terrain for exports, without a screen layer to borrow caches from. */
export function renderTerrain(p: Painter, inputs: TerrainInputs): HTMLCanvasElement | null {
  return new TerrainLayer(() => {}).renderNow(p, inputs);
}
