import { geoArea, geoContains } from 'd3-geo';
import type { Polygon } from 'geojson';
import type { App } from '../app';
import type { Vec3 } from '../core/math';
import type { CanvasPainter } from '../render/painter';
import { screenPoint } from '../render/painter';
import { screenRuns } from '../render/drawMap';
import { layoutLabel, type PlacedGlyph } from '../render/labels';
import { pathOf, type Item, type Label, type VPath } from '../doc/model';
import { RAD } from '../doc/geometry';
import { lineToLonLat, toLonLat, type LonLat } from '../vector/geo';

export type ToolId = 'select' | 'hand' | 'measure' | 'land' | 'cut' | 'river' | 'border' | 'forest' | 'mountains' | 'relief' | 'stamp' | 'text';

export interface ToolEvent {
  x: number;
  y: number;
  /** Position on the world, or null when pointing off it. */
  v: Vec3 | null;
  geo: LonLat | null;
  shift: boolean;
  alt: boolean;
  /** Mouse buttons currently held (MouseEvent.buttons). */
  buttons: number;
}

export interface Tool {
  readonly id: ToolId;
  /** Shown in the status bar. */
  readonly hint: string;
  readonly cursor: string;
  down?(e: ToolEvent): void;
  move?(e: ToolEvent): void;
  up?(e: ToolEvent): void;
  dblclick?(e: ToolEvent): void;
  /** Return true if the key was handled. */
  key?(e: KeyboardEvent): boolean;
  overlay?(p: CanvasPainter): void;
  deactivate?(): void;
}

/** Services the UI provides to tools. */
export interface ToolHost {
  app: App;
  /** Open the inline text editor at a screen position; `done` gets null on cancel. */
  editText(initial: string, x: number, y: number, done: (text: string | null) => void): void;
  /** Say something short in the status line for a few seconds. */
  notify(message: string): void;
  /** Rebuild the properties panel (after the tool's own state changed). */
  refresh(): void;
  /** Change the pointer for the active tool; null = the tool's usual cursor. */
  setCursor(cursor: string | null): void;
}

export const ACCENT = '#b0391f';
export const HANDLE_FILL = '#fffaf0';

export function screenOf(app: App, v: Vec3, margin = 40): [number, number] | null {
  const { view } = app;
  return screenPoint(view.projection, toLonLat(...v), view.width, view.height, margin);
}

/** Visible screen polylines of flat xyz points. */
export function screenLines(p: CanvasPainter, pts: number[]): [number, number][][] {
  return screenRuns(p, pts).map((r) => r.pts);
}

function distToSegment(x: number, y: number, a: [number, number], b: [number, number]): { d: number; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const dd = dx * dx + dy * dy;
  const t = dd > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / dd)) : 0;
  return { d: Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t), t };
}

/** Nearest point of a projected polyline (flat xyz) to (x, y): distance and index along it. */
export function nearestOnLine(app: App, pts: number[], x: number, y: number): { d: number; index: number } {
  let best = { d: Infinity, index: -1 };
  let prev: [number, number] | null = null;
  const jump = Math.max(app.view.width, app.view.height) / 3;
  for (let i = 0; i < pts.length; i += 3) {
    const s = screenOf(app, [pts[i], pts[i + 1], pts[i + 2]], 1e6);
    if (s && prev && Math.hypot(s[0] - prev[0], s[1] - prev[1]) < jump) {
      const { d, t } = distToSegment(x, y, prev, s);
      if (d < best.d) best = { d, index: i / 3 - 1 + t };
    } else if (s && !prev) {
      const d = Math.hypot(x - s[0], y - s[1]);
      if (d < best.d) best = { d, index: i / 3 };
    }
    prev = s;
  }
  return best;
}

/** The drawn (un-roughened) shape of a closed path as a d3 polygon, smaller side inside. */
function polygonOf(pts: number[]): Polygon {
  const ring = lineToLonLat(pts);
  ring.push(ring[0]);
  let poly: Polygon = { type: 'Polygon', coordinates: [ring] };
  if (geoArea(poly) > 2 * Math.PI) poly = { type: 'Polygon', coordinates: [ring.slice().reverse()] };
  return poly;
}

export function basePoints(app: App, item: Item, path: VPath) {
  return app.cache.base(item.id, item.rev, path);
}

/** Flattened points of a path with the closing segment included, for drawing outlines. */
export function closedPoints(path: VPath, pts: number[]): number[] {
  return path.closed && pts.length >= 3 ? pts.concat(pts.slice(0, 3)) : pts;
}

/** Where a label's glyphs are on screen right now. */
export function labelGlyphs(app: App, label: Label): PlacedGlyph[] {
  const pathPts = label.path && label.path.nodes.length >= 2 ? basePoints(app, label, label.path).pts : null;
  return layoutLabel(app.view.projection, app.view.width, app.view.height, label, app.style, pathPts);
}

/** Screen box around a label's visible glyphs. */
export function labelBox(app: App, label: Label): { x: number; y: number; w: number; h: number } | null {
  const glyphs = labelGlyphs(app, label);
  if (!glyphs.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of glyphs) {
    x0 = Math.min(x0, g.x - g.px * 0.4);
    x1 = Math.max(x1, g.x + g.px * 0.4);
    y0 = Math.min(y0, g.y - g.px * 0.6);
    y1 = Math.max(y1, g.y + g.px * 0.6);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Topmost item under a screen point. Labels and symbols sit above lines, lines above land. */
export function hitItem(app: App, x: number, y: number, geo: LonLat | null): Item | null {
  const items = app.doc.items;
  const ppd = app.view.projection.scale() * RAD;
  const order: Item['kind'][] = ['label', 'symbol', 'border', 'river', 'forest', 'mountains', 'relief', 'land'];
  for (const kind of order) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind !== kind) continue;
      if (it.kind === 'label') {
        if (labelGlyphs(app, it).some((g) => Math.hypot(x - g.x, y - g.y) < Math.max(6, g.px * 0.65))) return it;
      } else if (it.kind === 'symbol') {
        const s = screenOf(app, it.at);
        const r = Math.max(6, Math.min(60, it.size * ppd));
        if (s && Math.abs(x - s[0]) <= r && y >= s[1] - r && y <= s[1] + r * 0.6) return it;
      } else if (it.kind === 'river' || it.kind === 'border' || (it.kind === 'relief' && !it.path.closed)) {
        if (nearestOnLine(app, app.cache.shape(it, app.doc.seed), x, y).d < 6) return it;
      } else if ((it.kind === 'land' || it.kind === 'forest' || it.kind === 'mountains' || it.kind === 'relief') && it.path.nodes.length >= 3) {
        const pts = basePoints(app, it, it.path).pts;
        if (geo && geoContains(polygonOf(pts), geo)) return it;
        if (nearestOnLine(app, pts, x, y).d < 5) return it;
      }
    }
  }
  return null;
}

/** Which part of the selected item's path is under the pointer: a handle, a node, or a segment. */
export function hitPath(
  app: App,
  item: Item,
  selectedNode: number | null,
  x: number,
  y: number,
): { part: 'hin' | 'hout' | 'node'; node: number } | { part: 'segment'; seg: number; t: number } | null {
  const path = pathOf(item);
  if (!path) return null;
  const R = 7;
  if (selectedNode !== null && path.nodes[selectedNode]) {
    const n = path.nodes[selectedNode];
    for (const part of ['hin', 'hout'] as const) {
      const h = n[part];
      const s = h && screenOf(app, h);
      if (s && Math.hypot(x - s[0], y - s[1]) < R) return { part, node: selectedNode };
    }
  }
  for (let i = path.nodes.length - 1; i >= 0; i--) {
    const s = screenOf(app, path.nodes[i].p);
    if (s && Math.hypot(x - s[0], y - s[1]) < R) return { part: 'node', node: i };
  }
  const { pts, seg } = basePoints(app, item, path);
  const near = nearestOnLine(app, pts, x, y);
  if (near.d < 6) {
    const k = Math.floor(near.index);
    const segIndex = seg[Math.min(seg.length - 1, k)];
    const first = seg.indexOf(segIndex);
    const count = seg.lastIndexOf(segIndex) - first + 1;
    return { part: 'segment', seg: segIndex, t: Math.max(0.02, Math.min(0.98, (near.index - first) / count)) };
  }
  return null;
}

/** Draw a path being edited: line, nodes, and the handles of one node. */
export function drawPathEditing(p: CanvasPainter, app: App, path: VPath, pts: number[], activeNode: number | null, color = ACCENT): void {
  for (const line of screenLines(p, closedPoints(path, pts))) p.polyline(line, { stroke: color, width: 1.2 });
  const showHandles = (i: number) => {
    const n = path.nodes[i];
    const s = n && screenOf(app, n.p);
    if (!s) return;
    for (const h of [n.hin, n.hout]) {
      const hs = h && screenOf(app, h);
      if (!hs) continue;
      p.polyline([s, hs], { stroke: color, width: 1 });
      p.circle(hs[0], hs[1], 3.5, { fill: HANDLE_FILL, stroke: color, width: 1 });
    }
  };
  if (activeNode !== null) showHandles(activeNode);
  path.nodes.forEach((n, i) => {
    const s = screenOf(app, n.p);
    if (!s) return;
    const active = i === activeNode;
    p.rect(s[0] - 3.5, s[1] - 3.5, 7, 7, { fill: active ? color : HANDLE_FILL, stroke: color, width: 1 });
  });
}
