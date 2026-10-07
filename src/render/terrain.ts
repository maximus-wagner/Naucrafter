import { geoArea, geoBounds, geoContains, geoEquirectangular, geoPath, type GeoPermissibleObjects } from 'd3-geo';
import type { ForestShape, Item, MapDoc, MountainShape, VegetationKind } from '../doc/model';
import { areaPolygon, detailLevel, type GeometryCache } from '../doc/cache';
import type { RegionElement } from '../doc/regionLayout';
import { RAD } from '../doc/geometry';
import { fromLonLat, lineToLonLat } from '../vector/geo';
import { Fbm } from '../core/noise';
import { EMPTY, INK, PAPER, SHADE, SNOW, cellHash, plantSprite, type IndexSprite } from '../pixel/procedural';
import { OUTSIDE, TRUNK, makeTree, outlineDistance, sampleTree, shadowOf, type Tree, type TreeShape } from '../pixel/canopy';
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
  return { light, fill, dark, edge: mix(dark, ink, 0.45), ink, ramp, trunk: mix(ink, hexToRgba('#6b5438'), 0.5), shadow: mix(dark, ink, 0.3) };
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

/** Bilinear sample, or `outside` beyond the grid. */
function sample(g: GeoGrid, lon: number, lat: number, outside: number): number {
  let l = lon - g.lon0;
  l -= 360 * Math.round(l / 360);
  const fx = (l - g.x0) / g.d, fy = (g.y1 - lat) / g.d;
  if (fx < 0 || fy < 0 || fx > g.w - 1 || fy > g.h - 1) return outside;
  const x = Math.min(g.w - 2, Math.floor(fx)), y = Math.min(g.h - 2, Math.floor(fy));
  const tx = fx - x, ty = fy - y, i = y * g.w + x, D = g.data;
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
  coast: GeoGrid | null = null;
  ranges: RangeField[] = [];
  reliefs: ReliefField[] = [];
  lifts: { amount: number; field: GeoGrid }[] = [];
  rivers: GeoGrid[] = [];
  /** Changes whenever any field changes. */
  version = 0;
  private built = new Map<string, { key: string; bounds: Bounds; value: unknown }>();
  private landKey = '';

  /** Rebuild what changed; returns the areas whose terrain changed (for tile invalidation). */
  update(doc: MapDoc, cache: GeometryCache): Bounds[] {
    const dirty: Bounds[] = [];
    const landKey = doc.seed + '|' + doc.items.filter((i) => i.kind === 'land').map((i) => `${i.id}:${i.rev}`).join(',');
    if (landKey !== this.landKey) {
      this.landKey = landKey;
      const land = cache.land(doc, 0);
      const g: GridShape = { lon0: 0, x0: -180, y1: 90, d: 360 / 2048, w: 2049, h: 1025 };
      const m = rasterize(g, (ctx, path) => {
        ctx.beginPath();
        path(land.geo);
        ctx.fill('evenodd');
      });
      const din = gridDistance(g, (i) => !m[i]);
      const data = new Float32Array(m.length);
      for (let i = 0; i < m.length; i++) data[i] = m[i] ? din[i] : -1;
      this.coast = { ...g, data };
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
      } else if (item.kind === 'river' && item.path.nodes.length >= 2) {
        const geo = cache.river(doc, item);
        const coords = lineToLonLat(geo.main);
        const margin = 1.5 + item.width * 3;
        this.rivers.push(get(item, `${item.rev}|${doc.seed}|${coords.length}|${coords[Math.floor(coords.length / 2)]}`, () => boundsOf({ type: 'LineString', coordinates: coords }, margin), () => lineField(coords, margin)));
      }
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
  z: number;
  used: number;
}

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
    for (let j = 0; j < TEX; j++) {
      const lat = lat1 - j * step;
      for (let i = 0; i < TEX; i++) {
        const r = this.heightAt(lon0 + i * step, lat, level);
        h[j * TEX + i] = r.h;
        sd[j * TEX + i] = r.sd;
      }
    }
    this.tiles.set(tileKey(z, tx, ty), { h, sd, z, used: ++this.clock });
    if (this.tiles.size > 900) {
      const old = [...this.tiles.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 200);
      for (const [k] of old) this.tiles.delete(k);
    }
  }

  private last: { z: number; want: number; tile: Tile; tx: number; ty: number; lon0: number; lat1: number; deg: number } | null = null;

  /** Height from the finest cached tile at or above level `z`; null if none is cached. */
  sample(z: number, lon: number, lat: number): { h: number; sd: number; exact: boolean } | null {
    const L = this.last;
    if (L && L.want === z && lat <= L.lat1 && lat >= L.lat1 - L.deg) {
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
  private read(t: Tile, deg: number, dLon: number, dLat: number, exact: boolean): { h: number; sd: number; exact: boolean } {
    const fx = Math.min(TS - 1e-6, (dLon / deg) * TS), fy = Math.min(TS - 1e-6, Math.max(0, (dLat / deg) * TS));
    const x = Math.floor(fx), y = Math.floor(fy), ax = fx - x, ay = fy - y, i = y * TEX + x;
    const bl = (A: Float32Array) => (A[i] * (1 - ax) + A[i + 1] * ax) * (1 - ay) + (A[i + TEX] * (1 - ax) + A[i + TEX + 1] * ax) * ay;
    return { h: bl(t.h), sd: bl(t.sd), exact };
  }

  /** Terrain height (and height above the snow line) at a geographic point. */
  heightAt(lon: number, lat: number, level: number): { h: number; sd: number } {
    const F = this.fields;
    const coast = F.coast ? sample(F.coast, lon, lat, -1) : -1;
    if (coast < 0) return { h: 0, sd: -9 };
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
    // Rivers carve valleys, deepest through mountains.
    let river = 9;
    for (const g of F.rivers) river = Math.min(river, sample(g, lon, lat, 9));
    const valley = smooth(0, 0.014, river);
    let out = h * (0.8 + 0.2 * valley) + mountain * (0.2 + 0.8 * valley);
    // Soft floor: deep valleys flatten out gently instead of being cut off.
    if (out < 0.06) out = 0.06 - (0.06 - out) * 0.25;
    return { h: out, sd: out - snow };
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
const VEG: Record<VegetationKind, { trees: TreeShape[] | null; plant?: 'shrub' | 'grass'; keep: number; conifers?: number }> = {
  broadleaf: { trees: ['round'], keep: 1 },
  conifer: { trees: ['cone'], keep: 1 },
  mixed: { trees: ['round', 'cone'], keep: 1, conifers: 0.35 },
  jungle: { trees: ['jungle'], keep: 1 },
  shrubs: { trees: null, plant: 'shrub', keep: 0.6 },
  grass: { trees: null, plant: 'grass', keep: 0.5 },
};

/** Trees across a vegetation area at scale 1 (more, smaller trees read as woodland, not icons). */
const TREES_ACROSS = 36;

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

/** Geo-anchored jittered points about `spacingRad` apart over a region (steps a quarter-octave apart). */
function lattice(p: Painter, poly: GeoPermissibleObjects, spacingRad: number, salt: number): { pts: { x: number; y: number; cell: number; at: [number, number] }[]; step: number } {
  const level = Math.max(0, Math.ceil(4 * Math.log2(spacingRad / 0.00025)));
  let step = 0.00025 * 2 ** (level / 4);
  const [[lonA, latA], [lonB, latB]] = geoBounds(poly as Parameters<typeof geoBounds>[0]);
  const pts: { x: number; y: number; cell: number; at: [number, number] }[] = [];
  for (let tries = 0; tries < 6; tries++) {
    pts.length = 0;
    const r0 = Math.floor((latA / DEG + Math.PI / 2) / step), r1 = Math.floor((latB / DEG + Math.PI / 2) / step);
    let count = 0;
    for (let r = r0; r <= r1 && count < 60000; r++) {
      const phi = -Math.PI / 2 + (r + 0.5) * step;
      const cols = Math.max(1, Math.floor((2 * Math.PI * Math.cos(phi)) / step));
      const colStep = (2 * Math.PI) / cols;
      const span = lonA <= lonB ? [lonA, lonB] : [lonA, lonB + 360];
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
    this.palettes = [reliefPalette(style)];
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

  private heightAt(g: [number, number]): { h: number; sd: number } {
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
    // About TREES_ACROSS crowns across the area whatever the zoom; never under 3 px (it simplifies).
    const scale = p.projection.scale();
    const extent = Math.sqrt(geoArea(poly));
    const nominal = (extent / TREES_ACROSS) * f.scale;
    const spacingRad = Math.max(nominal / Math.max(0.4, f.density), (3 * art) / scale);
    const grid = lattice(p, poly, spacingRad, 5);
    // Size plants from the grid's real step so neighbours overlap.
    const spacing = (grid.step * scale) / art;
    const treeLine = 0.6 + 0.2 * f.height;
    const wood = noise(doc.seed, 'wood'), stands = noise(doc.seed, 'stands');
    const fq = 3.5 / Math.max(1e-3, extent);
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
        if (this.heightAt(q.at).h > treeLine + (cellHash(q.cell, 1, 3) - 0.5) * 0.08) continue;
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
        const r = spacing * (shape === 'cone' ? 1.0 : shape === 'jungle' ? 0.95 : 0.8) * vary * size;
        if (r < 1.2) continue;
        const tone = (cellHash(q.cell, 8, 3) - 0.5) * 0.16 + 0.12 * n;
        this.trees.push({ tree: makeTree(x, y, r, shape, f.height, q.cell, tone), colors });
      } else {
        const w = Math.max(2, Math.round(spacing * 1.1 * vary)), h = Math.max(2, Math.round(spacing * 0.9 * f.height * vary));
        this.scatter.push({ x, y, sprite: plantSprite(look.plant!, w, h, q.cell % 16, true), colors });
      }
    }
  }

  private renderTile([x0, y0, x1, y1]: [number, number, number, number]): void {
    const { W, H, out } = this;
    const tw = x1 - x0 + 2, th = y1 - y0 + 2;
    const hs = new Float32Array(tw * th), sds = new Float32Array(tw * th).fill(-9);
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
        c = step < 0 ? mix(c, pal.shadow, -step * 0.2) : step > 0 ? mix(c, pal.light, step * 0.18) : c;
        out.set(c, i * 4);
      }
    }
    this.drawTrees(x0, y0, x1, y1);
    this.drawScatter(x0, y0, x1, y1);
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
        if (lum[t] === TRUNK) {
          out.set(colors.trunk, px);
          continue;
        }
        // Neighbours off the screen count as the same tree, so no rim runs along the frame.
        const up = y > 0 ? owner[t - tw] : k, left = x > 0 ? owner[t - 1] : k, right = x < W - 1 ? owner[t + 1] : k, down = y < H - 1 ? owner[t + tw] : k;
        let c: RGBA;
        if (up < 0 || left < 0 || right < 0 || down < 0) c = up < 0 || left < 0 ? mix(colors.dark, colors.edge, 0.5) : colors.edge;
        else if (up !== k && up < k) c = colors.ramp[0];
        else c = colors.ramp[Math.max(0, Math.min(4, Math.floor(lum[t] * 4 + (dither(x, y) - 0.5) * 0.8 + 0.5)))];
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

  constructor(private requestRender: () => void) {}

  /** True while following a change with quick frames (vectors can skip slow work too). */
  get moving(): boolean {
    return !this.settled;
  }

  /** Make sure fields and the tile cache match the document (deferring rebuilds mid-edit). */
  private sync(doc: MapDoc, cache: GeometryCache, editing: boolean): void {
    if (!this.heights || this.seed !== doc.seed) {
      this.seed = doc.seed;
      this.fields = new TerrainFields();
      this.fields.update(doc, cache);
      this.heights = new HeightTiles(doc.seed, this.fields);
      return;
    }
    if (!editing) this.heights.invalidate(this.fields.update(doc, cache));
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
      if (done || (started && now - this.lastShown > 150)) {
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
