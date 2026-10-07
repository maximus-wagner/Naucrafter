import type { GeoProjection } from 'd3-geo';
import type { Vec3 } from '../core/math';
import type { Label } from '../doc/model';
import { RAD, unit } from '../doc/geometry';
import { toLonLat } from '../vector/geo';
import { fontString, screenPoint, type Affine, type TextStyle } from './painter';
import type { MapStyle } from './styles';

/** Glyphs are drawn at this font size and transformed to their size on the map. */
export const GLYPH_FONT_SIZE = 64;

export interface PlacedGlyph {
  ch: string;
  m: Affine;
  /** Screen position of the glyph centre. */
  x: number;
  y: number;
  /** Approximate glyph height on screen. */
  px: number;
}

export function labelText(label: Label): string {
  return label.style === 'region' ? label.text.toUpperCase() : label.text;
}

/** Letter spacing (ems) and type style per label kind. */
export function labelLook(label: Label, style: MapStyle): { spacing: number; text: TextStyle } {
  const base = { size: GLYPH_FONT_SIZE, font: style.font };
  switch (label.style) {
    case 'region':
      return { spacing: 0.32, text: { ...base, color: label.color ?? style.label } };
    case 'water':
      return { spacing: 0.12, text: { ...base, color: label.color ?? style.waterLabel, italic: true } };
    default:
      return { spacing: 0.02, text: { ...base, color: label.color ?? style.label, halo: style.land } };
  }
}

let measureCtx: CanvasRenderingContext2D | null = null;
const widths = new Map<string, number>();

/** Advance width of a character in ems. */
function advance(ch: string, st: TextStyle): number {
  const key = `${fontString(st)}|${ch}`;
  let w = widths.get(key);
  if (w === undefined) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!;
    measureCtx.font = fontString(st);
    w = measureCtx.measureText(ch).width / st.size;
    widths.set(key, w);
  }
  return w;
}

/** A baseline on the sphere: position and unit tangent at arc length s ∈ [0, length]. */
interface Baseline {
  length: number;
  at(s: number): { p: Vec3; t: Vec3 };
}

/** Level text follows the parallel (line of latitude) through the label's anchor. */
function parallelBaseline(at: Vec3, length: number): Baseline {
  const [lon0, lat0] = toLonLat(...at).map((v) => v * RAD);
  const c = Math.max(0.05, Math.cos(lat0));
  return {
    length,
    at(s) {
      const lon = lon0 + (s - length / 2) / c;
      return {
        p: [Math.cos(lat0) * Math.sin(lon), Math.sin(lat0), Math.cos(lat0) * Math.cos(lon)],
        t: [Math.cos(lon), 0, -Math.sin(lon)],
      };
    },
  };
}

/** Curved text follows a polyline on the sphere (flat xyz). */
function polylineBaseline(pts: number[]): Baseline {
  const n = pts.length / 3;
  const cum = [0];
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * 3, b = i * 3;
    cum.push(cum[i - 1] + Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1], pts[b + 2] - pts[a + 2]));
  }
  return {
    length: cum[n - 1],
    at(s) {
      let i = 0;
      while (i < n - 2 && cum[i + 1] < s) i++;
      const a = i * 3, b = (i + 1) * 3;
      const f = Math.max(0, Math.min(1, (s - cum[i]) / (cum[i + 1] - cum[i] || 1)));
      return {
        p: unit(pts[a] + (pts[b] - pts[a]) * f, pts[a + 1] + (pts[b + 1] - pts[a + 1]) * f, pts[a + 2] + (pts[b + 2] - pts[a + 2]) * f),
        t: unit(pts[b] - pts[a], pts[b + 1] - pts[a + 1], pts[b + 2] - pts[a + 2]),
      };
    },
  };
}

/** The level baseline of a straight label: its two ends and a point a little above the middle. */
export function labelSpan(label: Label, style: MapStyle): { start: Vec3; mid: Vec3; end: Vec3 } {
  const { spacing, text } = labelLook(label, style);
  const em = label.size * RAD;
  const len = [...labelText(label)].reduce((sum, ch) => sum + (advance(ch, text) + spacing) * em, 0);
  const base = parallelBaseline(label.at, len);
  const mid = base.at(len / 2);
  const up = unit(mid.p[1] * mid.t[2] - mid.p[2] * mid.t[1], mid.p[2] * mid.t[0] - mid.p[0] * mid.t[2], mid.p[0] * mid.t[1] - mid.p[1] * mid.t[0]);
  return {
    start: base.at(0).p,
    mid: unit(mid.p[0] + up[0] * em * 0.4, mid.p[1] + up[1] * em * 0.4, mid.p[2] + up[2] * em * 0.4),
    end: base.at(len).p,
  };
}

/**
 * Lay a label out glyph by glyph on the sphere and project each glyph with the projection's local
 * stretch and rotation, so text curves and foreshortens around the globe and splits correctly
 * where a flat map cuts the world open. Glyphs on the far side are dropped.
 */
export function layoutLabel(projection: GeoProjection, width: number, height: number, label: Label, style: MapStyle, pathPts: number[] | null): PlacedGlyph[] {
  const { spacing, text } = labelLook(label, style);
  const chars = [...labelText(label)];
  const em = label.size * RAD;
  const adv = chars.map((ch) => (advance(ch, text) + spacing) * em);
  const total = adv.reduce((a, b) => a + b, 0) - spacing * em;
  const base = pathPts && pathPts.length >= 6 ? polylineBaseline(pathPts) : parallelBaseline(label.at, total);

  // Read left to right on screen: walk the baseline backwards if it runs right to left.
  const ends = [base.at(0).p, base.at(base.length).p].map((p) => projection(toLonLat(...p)));
  const reverse = !!ends[0] && !!ends[1] && ends[1][0] < ends[0][0];
  const offset = (base.length - total) / 2;

  const out: PlacedGlyph[] = [];
  let s = 0;
  chars.forEach((ch, i) => {
    const centre = offset + s + (adv[i] - spacing * em) / 2;
    s += adv[i];
    const pos = base.at(reverse ? base.length - centre : centre);
    const p = pos.p;
    const t: Vec3 = reverse ? [-pos.t[0], -pos.t[1], -pos.t[2]] : pos.t;
    const up: Vec3 = [p[1] * t[2] - p[2] * t[1], p[2] * t[0] - p[0] * t[2], p[0] * t[1] - p[1] * t[0]];
    const sc = screenPoint(projection, toLonLat(...p), width, height, 60);
    if (!sc) return;
    const eps = em * 0.25;
    const along = projection(toLonLat(...unit(p[0] + t[0] * eps, p[1] + t[1] * eps, p[2] + t[2] * eps)));
    const above = projection(toLonLat(...unit(p[0] + up[0] * eps, p[1] + up[1] * eps, p[2] + up[2] * eps)));
    if (!along || !above) return;
    const k = em / eps / GLYPH_FONT_SIZE;
    const m: Affine = [(along[0] - sc[0]) * k, (along[1] - sc[1]) * k, -(above[0] - sc[0]) * k, -(above[1] - sc[1]) * k, sc[0], sc[1]];
    // A mirrored or collapsed transform means the glyph is turning away over the horizon.
    if (m[0] * m[3] - m[1] * m[2] <= 1e-6) return;
    out.push({ ch, m, x: sc[0], y: sc[1], px: (Math.hypot(above[0] - sc[0], above[1] - sc[1]) / eps) * em });
  });
  return out;
}
