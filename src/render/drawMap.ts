import { geoDistance, geoGraticule10, type GeoPermissibleObjects } from 'd3-geo';
import type { MapDoc, RiverShape } from '../doc/model';
import { areaPolygon, detailLevel, type GeometryCache } from '../doc/cache';
import type { RiverGeometry } from '../doc/river';
import { RAD } from '../doc/geometry';
import { lineToLonLat, toLonLat } from '../vector/geo';
import { symbolSprite, variantOf } from '../pixel/sprites';
import { labelLook, layoutLabel } from './labels';
import { renderTerrain, type TerrainLayer } from './terrain';
import { CanvasPainter, type Painter } from './painter';
import { withInk, type MapStyle } from './styles';

const SPHERE: GeoPermissibleObjects = { type: 'Sphere' };
const GRATICULE = geoGraticule10();

export interface DrawOptions {
  graticule: boolean;
  scaleBar: boolean;
  /** Screen only: cached terrain that re-renders when the view settles. */
  terrain?: TerrainLayer;
  /** Exports: render the terrain in full now, reusing this layer's caches if given. */
  terrainSource?: TerrainLayer;
  /** Screen px per pixel-art pixel. */
  pixelScale: number;
  /** Screen only: leave the area outside the map transparent so the wooden table shows through. */
  onTable?: boolean;
}

/**
 * Project a polyline (flat xyz) to screen, split into visible runs: breaks where it passes
 * behind the globe or jumps across the sheet edge (date line).
 */
export function screenRuns(p: Painter, pts: number[], extra?: number[]): { pts: [number, number][]; extra: number[] }[] {
  const runs: { pts: [number, number][]; extra: number[] }[] = [];
  let cur: { pts: [number, number][]; extra: number[] } | null = null;
  const jump = Math.max(p.width, p.height) / 3;
  for (let i = 0; i < pts.length; i += 3) {
    const s = p.visible(toLonLat(pts[i], pts[i + 1], pts[i + 2]), 1e6);
    const prev = cur?.pts[cur.pts.length - 1];
    if (!s || (prev && Math.hypot(s[0] - prev[0], s[1] - prev[1]) > jump)) {
      if (cur && cur.pts.length > 1) runs.push(cur);
      cur = null;
      if (!s) continue;
    }
    if (!cur) cur = { pts: [], extra: [] };
    cur.pts.push(s);
    if (extra) cur.extra.push(extra[i / 3]);
  }
  if (cur && cur.pts.length > 1) runs.push(cur);
  return runs;
}

/** Pixels per degree of arc at the current zoom. */
export const pxPerDegree = (p: Painter) => p.projection.scale() * RAD;

type Pt = [number, number];

/** Left and right banks of a screen polyline with a width per point. */
function banks(pts: Pt[], widths: number[]): { left: Pt[]; right: Pt[] } {
  const left: Pt[] = [], right: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l, h = widths[i] / 2;
    left.push([pts[i][0] + nx * h, pts[i][1] + ny * h]);
    right.push([pts[i][0] - nx * h, pts[i][1] - ny * h]);
  }
  return { left, right };
}

/**
 * A stylised river: a single ink line near the source that opens into two inked banks with water
 * between as it widens, with faint current strokes in wide stretches and white water at rapids.
 */
function drawRiver(p: Painter, river: RiverShape, geo: RiverGeometry, style: MapStyle): void {
  const ink = river.color ?? style.river;
  const water = style.sea;
  const pts = geo.main;
  // Width tapers from a trickle at the source to full width at the mouth.
  const n = pts.length / 3;
  const along: number[] = [0];
  for (let i = 1; i < n; i++) {
    const a = i * 3 - 3, b = i * 3;
    along.push(along[i - 1] + Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1], pts[b + 2] - pts[a + 2]));
  }
  const total = along[n - 1] || 1;
  const mouth = Math.min(22, Math.max(1.2, river.width * pxPerDegree(p) * 1.6));
  const widths = along.map((d) => Math.max(0.8, mouth * (0.1 + 0.9 * Math.pow(d / total, 0.8))));
  const OPEN = 3.2; // wider than this (px), the river is drawn with two banks

  for (const lake of geo.lakes) {
    const ring = lineToLonLat(lake);
    ring.push(ring[0]);
    p.path({ type: 'Polygon', coordinates: [ring] }, { fill: water, stroke: ink, width: 1 });
  }
  const channel = (run: Pt[], w: number[]) => {
    // Narrow stretches: one tapering ink line, in short chunks so the width can change.
    for (let i = 0; i < run.length - 1; i += 5) {
      const k = Math.min(w.length - 1, i + 2);
      if (w[k] < OPEN) p.polyline(run.slice(i, i + 6), { stroke: ink, width: Math.max(0.8, w[k] * 0.75) });
    }
    // Wide stretches: water between two inked banks.
    let start = -1;
    for (let i = 0; i <= run.length; i++) {
      const open = i < run.length && w[i] >= OPEN;
      if (open && start < 0) start = Math.max(0, i - 1);
      if (!open && start >= 0) {
        const seg = run.slice(start, i), sw = w.slice(start, i);
        const { left, right } = banks(seg, sw);
        p.polyline([...left, ...right.slice().reverse()], { fill: water }, true);
        p.polyline(left, { stroke: ink, width: 1 });
        p.polyline(right, { stroke: ink, width: 1 });
        // Current: short strokes along the middle of the widest parts.
        for (let j = 4; j < seg.length - 4; j += 9) {
          if (sw[j] < 7) continue;
          const off = (j % 18 === 4 ? 0.18 : -0.18) * sw[j];
          const { left: l } = banks(seg.slice(j - 2, j + 3), sw.slice(j - 2, j + 3).map(() => off * 2));
          p.polyline(l, { stroke: ink, width: 0.8, opacity: 0.45 });
        }
        start = -1;
      }
    }
  };
  for (const side of geo.side) {
    for (const run of screenRuns(p, side)) channel(run.pts, run.pts.map(() => Math.max(0.8, mouth * 0.42)));
  }
  for (const run of screenRuns(p, pts, widths)) channel(run.pts, run.extra);
  // Rapids: little white-water strokes across the stream.
  for (const tick of geo.ticks) {
    for (const run of screenRuns(p, tick)) {
      const [a, b] = [run.pts[0], run.pts[run.pts.length - 1]];
      const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      p.polyline([[a[0] * 0.6 + m[0] * 0.4, a[1] * 0.6 + m[1] * 0.4], [b[0] * 0.6 + m[0] * 0.4, b[1] * 0.6 + m[1] * 0.4]], { stroke: '#ffffff', width: 1.4, opacity: 0.85 });
    }
  }
}

/** Draw a whole map document. Same code for the screen (canvas) and exports (SVG/PNG). */
export function drawMap(p: Painter, doc: MapDoc, cache: GeometryCache, style: MapStyle, opts: DrawOptions): void {
  // Coastlines get finer procedural detail as you zoom in.
  // While moving, keep the coastline detail already computed; refine once the view settles.
  const wanted = detailLevel(p.projection.scale());
  const level = opts.terrain?.moving ? cache.readyLandLevel(doc, wanted) : wanted;
  const land = cache.land(doc, level);
  const ppd = pxPerDegree(p);

  if (opts.onTable && p instanceof CanvasPainter) p.ctx.clearRect(0, 0, p.width, p.height);
  else p.background(style.desk);
  p.path(SPHERE, { fill: style.sea });

  // Everything on the map stays inside the world's outline (the globe's disc, the flat map's edge).
  p.beginClip(SPHERE);

  // Water shapes with their own colour (tinted lakes and seas).
  for (const item of doc.items) {
    if (item.kind === 'land' && item.op === 'cut' && item.color && item.path.nodes.length >= 3) p.path(areaPolygon(cache.shape(item, doc.seed, level)), { fill: item.color });
  }

  // Ripples: wide ink stroke, then a slightly narrower sea stroke, leaves a line at that offset.
  for (const r of [...style.ripples].sort((a, b) => b.offset - a.offset)) {
    p.path(land.lines, { stroke: style.ink, width: r.offset * 2 + 0.9, opacity: r.opacity, join: 'bevel' });
    p.path(land.lines, { stroke: style.sea, width: r.offset * 2 - 0.9, join: 'bevel' });
  }
  if (opts.graticule && style.graticule) {
    p.path(GRATICULE, { stroke: style.graticule.color, width: 0.6, opacity: style.graticule.opacity, dash: style.graticule.dash });
  }

  p.path(land.geo, { fill: style.land });
  // Land shapes with their own colour (countries, terrain types…), in drawing order.
  const tinted = doc.items.filter((i) => i.kind === 'land' && i.op === 'add' && i.color && i.path.nodes.length >= 3);
  if (tinted.length) {
    p.beginClip(land.geo);
    for (const item of tinted) if (item.kind === 'land') p.path(areaPolygon(cache.shape(item, doc.seed, level)), { fill: item.color });
    p.endClip();
  }

  // Relief over all land, mountain ranges and vegetation: one pixel-art image for the view.
  const terrainInputs = { doc, cache, style, pixelScale: opts.pixelScale, level };
  if (opts.terrain) opts.terrain.draw(p, terrainInputs);
  else {
    const img = opts.terrainSource ? opts.terrainSource.renderNow(p, terrainInputs) : renderTerrain(p, terrainInputs);
    if (img) p.sprite(img, (img.width * opts.pixelScale) / 2, (img.height * opts.pixelScale) / 2, opts.pixelScale);
  }

  p.beginClip(land.geo);
  for (const item of doc.items) {
    if (item.kind === 'river' && item.path.nodes.length >= 2) drawRiver(p, item, cache.river(doc, item), style);
  }
  for (const item of doc.items) {
    if (item.kind !== 'border' || item.path.nodes.length < 2) continue;
    const coords = lineToLonLat(cache.shape(item, doc.seed, level));
    if (item.path.closed) coords.push(coords[0]);
    const national = item.line === 'national';
    p.path({ type: 'LineString', coordinates: coords }, { stroke: item.color ?? style.border, width: national ? 1.6 : 1, dash: national ? [7, 3, 1.5, 3] : [3, 3], opacity: 0.85 });
  }
  p.endClip();

  p.path(land.lines, { stroke: style.ink, width: style.coastWidth });

  // Symbols, north to south so nearer (lower) marks overlap the ones behind them.
  const symbols = doc.items.filter((i) => i.kind === 'symbol').map((s) => ({ s, at: toLonLat(...s.at) }));
  symbols.sort((a, b) => b.at[1] - a.at[1]);
  for (const { s, at } of symbols) {
    const pos = p.visible(at);
    if (!pos) continue;
    const sprite = symbolSprite(s.symbol, Math.min(90, Math.max(2, s.size * ppd)), opts.pixelScale, variantOf(s.id), withInk(style, s.color));
    if (sprite) p.sprite(sprite.canvas, pos[0], pos[1], sprite.scale);
  }

  for (const label of doc.items) {
    if (label.kind !== 'label' || !label.text) continue;
    const pathPts = label.path && label.path.nodes.length >= 2 ? cache.base(label.id, label.rev, label.path).pts : null;
    const glyphs = layoutLabel(p.projection, p.width, p.height, label, style, pathPts);
    if (!glyphs.length || glyphs[Math.floor(glyphs.length / 2)].px < 5) continue;
    const { text } = labelLook(label, style);
    const halo = text.halo ? { haloWidth: Math.max(2, glyphs[0].px * 0.22) } : {};
    for (const g of glyphs) p.glyph(g.ch, g.m, { ...text, ...halo });
  }

  if (style.grain > 0) p.grain(style.grain);
  p.endClip();
  p.path(SPHERE, { stroke: style.ink, width: 1.2 });
  if (opts.scaleBar) drawScaleBar(p, doc.planet.radiusKm, style);
}

function formatDistance(km: number): string {
  return km >= 1 ? `${km.toLocaleString('en')} km` : `${Math.round(km * 1000)} m`;
}

/** A classic alternating scale bar in a small paper cartouche, measured at the centre of the view. */
function drawScaleBar(p: Painter, radiusKm: number, style: MapStyle): void {
  const cx = p.width / 2, cy = p.height / 2;
  const a = p.projection.invert?.([cx - 25, cy]), b = p.projection.invert?.([cx + 25, cy]);
  if (!a || !b || !a.every(Number.isFinite) || !b.every(Number.isFinite)) return;
  const kmPerPx = (geoDistance(a, b) * radiusKm) / 50;
  if (!(kmPerPx > 0)) return;
  const target = 150 * kmPerPx;
  const pow = 10 ** Math.floor(Math.log10(target));
  const nice = [1, 2, 5].map((m) => m * pow).filter((v) => v <= target).pop() ?? pow;
  const w = nice / kmPerPx, h = 5;
  const x = 22, y = p.height - 30;
  const label = formatDistance(nice);
  p.rect(x - 10, y - 20, w + 20 + label.length * 3.5, 36, { fill: style.land, stroke: style.ink, width: 1 });
  for (let i = 0; i < 4; i++) p.rect(x + (i * w) / 4, y, w / 4, h, { fill: i % 2 ? style.land : style.ink, stroke: style.ink, width: 1 });
  const text = { size: 11, font: style.font, color: style.ink };
  p.glyph('0', [1, 0, 0, 1, x, y - 8], text);
  p.glyph(label, [1, 0, 0, 1, x + w + label.length * 1.75, y - 8], text);
}

