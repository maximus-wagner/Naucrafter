import { geoContains, type GeoPermissibleObjects } from 'd3-geo';
import type { Vec3 } from '../core/math';
import type { RiverShape } from '../doc/model';
import { MOUTH_SCALE, type RiverGeometry } from '../doc/river';
import { lineToLonLat, toLonLat, type LonLat } from '../vector/geo';
import type { Painter } from './painter';
import { pxPerDegree, screenRuns } from './screen';
import type { MapStyle } from './styles';

type Pt = [number, number];

/** A channel on screen: points and the width (px) of the water at each. */
interface Channel {
  pts: Pt[];
  w: number[];
}

export interface RiverDrawing {
  river: RiverShape;
  geo: RiverGeometry;
}

/** A river projected for the current view. */
export interface RiverPlan {
  drawing: RiverDrawing;
  ink: string;
  /** Width at the mouth, px. Always proportional to zoom: rivers grow and shrink with the map. */
  mouthPx: number;
  channels: Channel[];
  lakes: { type: 'Polygon'; coordinates: LonLat[][] }[];
  ticks: Pt[][];
}

const MIN_WIDTH = 0.8;
const OPEN_FROM = 2.4;
const OPEN_TO = 4.4;
const BANK = 1;
const CHUNK = 4;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Ink width for a channel `w` px wide: a single line while it's a trickle, then two banks' worth. */
const inkWidth = (w: number) => {
  const k = smooth(OPEN_FROM, OPEN_TO, w);
  return Math.max(MIN_WIDTH, w * 0.75) * (1 - k) + (w + BANK) * k;
};
/** Water width for a channel `w` px wide (nothing while it is just an inked line). */
const waterWidth = (w: number) => smooth(OPEN_FROM, OPEN_TO, w) * (w - BANK);

/** Project every river for the current view. */
export function planRivers(p: Painter, rivers: RiverDrawing[], style: MapStyle): RiverPlan[] {
  return rivers.map((drawing) => {
    const { river, geo } = drawing;
    const mouthPx = river.width * pxPerDegree(p) * MOUTH_SCALE;
    const widths = geo.taper.map((t) => Math.max(MIN_WIDTH, mouthPx * t));
    const channels: Channel[] = [];
    for (const side of geo.side) {
      for (const run of screenRuns(p, side)) channels.push({ pts: run.pts, w: run.pts.map(() => Math.max(MIN_WIDTH, mouthPx * 0.42)) });
    }
    for (const run of screenRuns(p, geo.main, widths)) channels.push({ pts: run.pts, w: run.extra });
    const lakes = geo.lakes.map((lake) => {
      const ring = lineToLonLat(lake);
      ring.push(ring[0]);
      return { type: 'Polygon' as const, coordinates: [ring] };
    });
    const ticks = geo.ticks.flatMap((t) => screenRuns(p, t).map((r) => r.pts));
    return { drawing, ink: river.color ?? style.river, mouthPx, channels, lakes, ticks };
  });
}

/** Stroke a channel in short pieces so the width can change along it. */
function stroke(p: Painter, ch: Channel, color: string, widthOf: (w: number) => number, minWidth = 0): void {
  for (let i = 0; i < ch.pts.length - 1; i += CHUNK) {
    const w = widthOf(ch.w[Math.min(ch.w.length - 1, i + (CHUNK >> 1))]);
    if (w > minWidth) p.polyline(ch.pts.slice(i, i + CHUNK + 1), { stroke: color, width: w });
  }
}

/**
 * Draw all rivers (the caller clips to the land). Water is where rivers differ from a pair of
 * inked lines: every river's banks go down first, then every river's water over them, so wherever
 * channels, bends, oxbow lakes or whole rivers meet or overlap they merge into one body of water
 * with no ink between them. Ink is only left on the outside edge.
 */
export function paintRivers(p: Painter, plans: RiverPlan[], style: MapStyle): void {
  const water = style.sea;
  for (const plan of plans) {
    for (const lake of plan.lakes) p.path(lake, { fill: plan.ink, stroke: plan.ink, width: 2 * BANK });
    for (const ch of plan.channels) stroke(p, ch, plan.ink, inkWidth);
  }
  for (const plan of plans) {
    for (const lake of plan.lakes) p.path(lake, { fill: water });
    for (const ch of plan.channels) stroke(p, ch, water, waterWidth, 0.4);
  }
  for (const plan of plans) {
    for (const ch of plan.channels) current(p, ch, plan.ink);
    // Rapids: little white-water strokes across the stream.
    for (const [a, b] of plan.ticks.filter((t) => t.length >= 2).map((t) => [t[0], t[t.length - 1]])) {
      const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      p.polyline([[a[0] * 0.6 + m[0] * 0.4, a[1] * 0.6 + m[1] * 0.4], [b[0] * 0.6 + m[0] * 0.4, b[1] * 0.6 + m[1] * 0.4]], { stroke: '#ffffff', width: 1.4, opacity: 0.85 });
    }
  }
}

/** Faint current strokes along the middle of the widest parts. */
function current(p: Painter, ch: Channel, ink: string): void {
  for (let j = 4; j < ch.pts.length - 4; j += 9) {
    if (ch.w[j] < 7) continue;
    const off = (j % 18 === 4 ? 0.18 : -0.18) * ch.w[j];
    const a = ch.pts[j - 2], b = ch.pts[j + 2];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = (-(b[1] - a[1]) / l) * off, ny = ((b[0] - a[0]) / l) * off;
    p.polyline(ch.pts.slice(j - 2, j + 3).map(([x, y]) => [x + nx, y + ny] as Pt), { stroke: ink, width: 0.8, opacity: 0.45 });
  }
}

// ------------------------------------------------------------------ river mouths

/** Where a river's end meets the edge of the land (sea, or a lake cut out of it). */
interface Mouth {
  /** Index in `main` of the last point on land. */
  at: number;
  /** +1 if the river leaves the land going forward (its mouth), −1 at its start. */
  dir: 1 | -1;
  /** The crossing itself, and the next point beyond it. */
  exit: Vec3;
  beyond: Vec3;
}

const mouthCache = new WeakMap<RiverGeometry, { land: GeoPermissibleObjects; list: Mouth[] }>();

function lerpUnit(a: Vec3, b: Vec3, t: number): Vec3 {
  const v: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Find where each end of a river runs off the land. Cached until the land changes. */
function findMouths(geo: RiverGeometry, land: GeoPermissibleObjects): Mouth[] {
  const hit = mouthCache.get(geo);
  if (hit && hit.land === land) return hit.list;
  const pts = geo.main, n = pts.length / 3;
  const at = (i: number): Vec3 => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
  const onLand = (v: Vec3) => geoContains(land, toLonLat(...v));
  const stride = Math.max(1, Math.floor(n / 48));
  const list: Mouth[] = [];
  if (n >= 2) {
    for (const dir of [1, -1] as const) {
      const from = dir === 1 ? n - 1 : 0;
      if (onLand(at(from))) continue; // this end stays inland
      let sea = from, last = -1;
      for (let k = from - dir * stride; k >= 0 && k < n; k -= dir * stride) {
        if (onLand(at(k))) {
          let lo = k, hi = sea;
          while (Math.abs(hi - lo) > 1) {
            const mid = Math.round((lo + hi) / 2);
            if (onLand(at(mid))) lo = mid;
            else hi = mid;
          }
          last = lo;
          break;
        }
        sea = k;
      }
      if (last < 0) continue;
      const a = at(last), b = at(last + dir);
      let lo = 0, hi = 1;
      for (let s = 0; s < 12; s++) {
        const mid = (lo + hi) / 2;
        if (onLand(lerpUnit(a, b, mid))) lo = mid;
        else hi = mid;
      }
      list.push({ at: last, dir, exit: lerpUnit(a, b, lo), beyond: b });
    }
  }
  mouthCache.set(geo, { land, list });
  return list;
}

/**
 * Where a river runs into the sea or a lake, the coastline would cut straight across its mouth,
 * ink between two bodies of water. Call this after the coast is drawn: it lays the river's water
 * over the coastline across the mouth (and a little way out), so the river simply opens into the sea.
 */
export function paintMouths(p: Painter, plans: RiverPlan[], land: GeoPermissibleObjects, waterAt: (at: LonLat) => string): void {
  const scale = p.projection.scale();
  for (const plan of plans) {
    const { main, taper } = plan.drawing.geo;
    const n = main.length / 3;
    for (const m of findMouths(plan.drawing.geo, land)) {
      const widthAt = (i: number) => Math.max(MIN_WIDTH, plan.mouthPx * taper[i]);
      const w = widthAt(m.at);
      if (waterWidth(w) <= 0.4) continue;
      // Past the crossing as far as the coast's ink (and a skewed crossing) can reach, no further.
      const reach = (0.6 * w + 3) / scale;
      const gap = Math.hypot(m.beyond[0] - m.exit[0], m.beyond[1] - m.exit[1], m.beyond[2] - m.exit[2]) || 1e-12;
      const tip = lerpUnit(m.exit, m.beyond, Math.min(1, reach / gap));
      const inland = Math.min(n - 1, Math.max(0, m.at - m.dir * 6));
      // From a little way inland, in flow order towards the sea.
      const run: number[] = [], widths: number[] = [];
      for (let i = inland; i !== m.at + m.dir; i += m.dir) {
        run.push(main[i * 3], main[i * 3 + 1], main[i * 3 + 2]);
        widths.push(widthAt(i));
      }
      run.push(...m.exit, ...tip);
      widths.push(w, w);
      const colour = waterAt(toLonLat(...m.exit));
      for (const r of screenRuns(p, run, widths)) stroke(p, { pts: r.pts, w: r.extra }, colour, waterWidth, 0.4);
    }
  }
}
