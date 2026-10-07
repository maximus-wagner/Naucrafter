import { geoContains, geoDistance, geoGraticule10, type GeoPermissibleObjects } from 'd3-geo';
import type { MapDoc, RiverShape } from '../doc/model';
import { areaPolygon, detailLevel, type GeometryCache } from '../doc/cache';
import { lineToLonLat, toLonLat, type LonLat } from '../vector/geo';
import { symbolSprite, variantOf } from '../pixel/sprites';
import { labelLook, layoutLabel } from './labels';
import { renderTerrain, type TerrainLayer } from './terrain';
import { CanvasPainter, type Painter } from './painter';
import { paintMouths, paintRivers, planRivers } from './rivers';
import { pxPerDegree, screenRuns } from './screen';
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

export { pxPerDegree, screenRuns };

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
  const rivers = planRivers(p, doc.items.filter((i): i is RiverShape => i.kind === 'river' && i.path.nodes.length >= 2).map((river) => ({ river, geo: cache.river(doc, river) })), style);
  paintRivers(p, rivers, style);
  for (const item of doc.items) {
    if (item.kind !== 'border' || item.path.nodes.length < 2) continue;
    const coords = lineToLonLat(cache.shape(item, doc.seed, level));
    if (item.path.closed) coords.push(coords[0]);
    const national = item.line === 'national';
    p.path({ type: 'LineString', coordinates: coords }, { stroke: item.color ?? style.border, width: national ? 1.6 : 1, dash: national ? [7, 3, 1.5, 3] : [3, 3], opacity: 0.85 });
  }
  p.endClip();

  p.path(land.lines, { stroke: style.ink, width: style.coastWidth });
  // Where a river runs into the sea or a lake, the coast would cut across its mouth: water over water.
  const lakes = doc.items.filter((i) => i.kind === 'land' && i.op === 'cut' && i.color && i.path.nodes.length >= 3);
  paintMouths(p, rivers, land.geo, (at: LonLat) => {
    for (const lake of lakes) if (lake.kind === 'land' && geoContains(areaPolygon(cache.shape(lake, doc.seed, level)), at)) return lake.color!;
    return style.sea;
  });

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

