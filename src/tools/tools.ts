import { geoContains } from 'd3-geo';
import type { Vec3 } from '../core/math';
import { fromLonLat } from '../vector/geo';
import { angle, flatten, mirror, moveNode, rotation, setSmooth, slerp, splitSegment } from '../doc/geometry';
import { FLATTEN_STEP } from '../doc/cache';
import { newId, pathOf, type Item, type PathNode, type VPath } from '../doc/model';
import { strokeToPath } from '../doc/freehand';
import { RAD } from '../doc/geometry';
import type { CanvasPainter } from '../render/painter';
import { symbolSprite } from '../pixel/sprites';
import {
  ACCENT,
  basePoints,
  closedPoints,
  drawPathEditing,
  hitItem,
  hitPath,
  labelBox,
  screenLines,
  screenOf,
  type Tool,
  type ToolEvent,
  type ToolHost,
} from './base';

/** Move one handle; on a smooth node the opposite handle turns to stay in line (keeping its length). */
function setHandle(node: PathNode, which: 'hin' | 'hout', v: Vec3, keepSmooth: boolean): void {
  node[which] = v;
  const other = which === 'hin' ? 'hout' : 'hin';
  const o = node[other];
  if (!keepSmooth || !o || node.corner) return;
  const m = mirror(node.p, v);
  const dm = angle(node.p, m);
  if (dm > 1e-6) node[other] = slerp(node.p, m, angle(node.p, o) / dm);
}

/** Apply a rotation of the sphere to everything positional in an item (used to drag items). */
function transformItem(item: Item, r: (v: Vec3) => Vec3): void {
  const path = pathOf(item);
  if (path) {
    for (const n of path.nodes) {
      n.p = r(n.p);
      if (n.hin) n.hin = r(n.hin);
      if (n.hout) n.hout = r(n.hout);
    }
  }
  if (item.kind === 'symbol' || item.kind === 'label') item.at = r(item.at);
}

const minNodes = (path: VPath) => (path.closed ? 3 : 2);

// ---------------------------------------------------------------- select / edit

export class SelectTool implements Tool {
  readonly id = 'select';
  readonly cursor = 'default';
  readonly hint = 'Click to select · drag nodes and handles to reshape (Alt breaks a smooth node) · double-click a line to add a node, a node to toggle smooth/corner · Del deletes';
  private drag: { kind: 'node' | 'hin' | 'hout' | 'item'; node: number; last: Vec3; started: boolean } | null = null;
  private hover: Item | null = null;

  constructor(private host: ToolHost) {}

  down(e: ToolEvent): void {
    const app = this.host.app;
    const sel = app.selected();
    if (sel && e.v) {
      const h = hitPath(app, sel, app.selection!.node, e.x, e.y);
      if (h && h.part !== 'segment') {
        if (h.part === 'node') app.select({ id: sel.id, node: h.node });
        this.drag = { kind: h.part, node: h.node, last: e.v, started: false };
        return;
      }
    }
    const item = hitItem(app, e.x, e.y, e.geo);
    if (!item) {
      app.select(null);
      return;
    }
    if (sel?.id !== item.id) app.select({ id: item.id, node: null });
    if (e.v) this.drag = { kind: 'item', node: -1, last: e.v, started: false };
  }

  move(e: ToolEvent): void {
    const app = this.host.app;
    if (this.drag && e.v && e.buttons & 1) {
      const item = app.selected();
      if (!item) return;
      if (!this.drag.started) {
        app.checkpoint();
        this.drag.started = true;
      }
      const path = pathOf(item);
      if (this.drag.kind === 'item') {
        transformItem(item, rotation(this.drag.last, e.v));
        this.drag.last = e.v;
      } else if (path) {
        const node = path.nodes[this.drag.node];
        if (this.drag.kind === 'node') moveNode(node, e.v);
        else setHandle(node, this.drag.kind, e.v, !e.alt);
      }
      app.touch(item);
      app.view.requestOverlay();
      return;
    }
    const hover = hitItem(app, e.x, e.y, e.geo);
    if (hover !== this.hover) {
      this.hover = hover;
      app.view.requestOverlay();
    }
  }

  up(): void {
    if (this.drag?.started) this.host.app.emit();
    this.drag = null;
  }

  dblclick(e: ToolEvent): void {
    const app = this.host.app;
    const sel = app.selected();
    if (!sel) return;
    const path = pathOf(sel);
    const h = path && hitPath(app, sel, app.selection!.node, e.x, e.y);
    if (path && h?.part === 'node') {
      app.checkpoint();
      const n = path.nodes[h.node];
      setSmooth(path, h.node, !(n.hin || n.hout));
      app.touch(sel);
      app.select({ id: sel.id, node: h.node });
    } else if (path && h?.part === 'segment') {
      app.checkpoint();
      const i = splitSegment(path, h.seg, h.t);
      app.touch(sel);
      app.select({ id: sel.id, node: i });
    } else if (sel.kind === 'label') {
      this.host.editText(sel.text, e.x, e.y, (text) => {
        if (text === null || text === sel.text) return;
        app.checkpoint();
        sel.text = text;
        app.touch(sel);
        app.emit();
      });
    }
  }

  key(e: KeyboardEvent): boolean {
    const app = this.host.app;
    const sel = app.selected();
    if (e.key === 'Escape' && sel) {
      app.select(null);
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      app.checkpoint();
      const path = pathOf(sel);
      const node = app.selection!.node;
      if (path && node !== null && path.nodes.length > minNodes(path)) {
        path.nodes.splice(node, 1);
        app.touch(sel);
        app.select({ id: sel.id, node: null });
      } else {
        app.remove(sel.id);
      }
      return true;
    }
    return false;
  }

  overlay(p: CanvasPainter): void {
    const app = this.host.app;
    const sel = app.selected();
    if (this.hover && this.hover !== sel) outline(p, this.host, this.hover, true);
    if (!sel) return;
    const path = pathOf(sel);
    if (path) drawPathEditing(p, app, path, basePoints(app, sel, path).pts, app.selection!.node);
    else outline(p, this.host, sel, false);
  }
}

/** Light outline of an item (hover) or a box around a symbol / label (selection). */
function outline(p: CanvasPainter, host: ToolHost, item: Item, hover: boolean): void {
  const app = host.app;
  const paint = { stroke: ACCENT, width: 1, dash: hover ? [3, 3] : [], opacity: hover ? 0.8 : 1 };
  const path = pathOf(item);
  if (path) {
    for (const line of screenLines(p, closedPoints(path, basePoints(app, item, path).pts))) p.polyline(line, paint);
    return;
  }
  if (item.kind === 'symbol') {
    const s = screenOf(app, item.at);
    const r = Math.max(6, Math.min(60, item.size * p.projection.scale() * RAD));
    if (s) p.rect(s[0] - r - 2, s[1] - r - 2, 2 * r + 4, 1.6 * r + 4, paint);
  } else if (item.kind === 'label') {
    const b = labelBox(app, item);
    if (b) p.rect(b.x - 3, b.y - 2, b.w + 6, b.h + 4, paint);
  }
}

// ---------------------------------------------------------------- pencils

export type PenKind = 'land' | 'cut' | 'river' | 'border' | 'forest' | 'mountains' | 'relief';

const SPRING_HINT = 'River spring · click a spot on land and a river is generated from it, flowing downhill to the sea (or into a river it meets) · switch back to Draw in the panel to draw by hand';

const PEN_HINTS: Record<PenKind, string> = {
  land: 'Land · draw a coastline freely and it becomes a smooth, editable outline · or click to place points (click the first one, double-click or Enter to close)',
  cut: 'Water · draw lakes and bays freely; they are cut out of the land · or click to place points',
  river: 'River · draw from source to mouth · or click points, then double-click or Enter to finish',
  border: 'Border · draw freely; end near the start to close a loop · or click points, then double-click or Enter',
  forest: 'Vegetation · draw the edge of a forest, jungle, scrub or grassland; it fills with plants, finer as you zoom in',
  mountains: 'Mountains · draw the edge of a range; peaks grow towards the middle, hills along the edge',
  relief: 'Elevation · draw an area to raise or lower the land (hills, plateaus, lowlands, basins), or a line for a ridge or valley',
};

/** Allowed deviation between your stroke and the fitted curve, in screen px. */
const FIT_TOLERANCE_PX = 3.5;

/**
 * Pencil with a pen fallback: drag to draw freely (the stroke is curve-fitted into a few smooth
 * nodes when you let go), or click to place corner points one by one.
 */
export class PenTool implements Tool {
  readonly cursor = 'crosshair';
  private nodes: PathNode[] = [];
  private stroke: { pts: Vec3[]; screen: [number, number][]; freehand: boolean } | null = null;
  private cursorV: Vec3 | null = null;
  private cursorXY: [number, number] = [0, 0];

  constructor(private host: ToolHost, readonly id: PenKind) {}

  /** The river tool in Spring mode: a click starts a river that finds its own way downhill. */
  private get spring(): boolean {
    return this.id === 'river' && this.host.app.defaults.riverMode === 'spring';
  }

  get hint(): string {
    return this.spring ? SPRING_HINT : PEN_HINTS[this.id];
  }

  /** Areas always close; rivers and elevation lines never; borders close if you end where you started. */
  private get alwaysClosed(): boolean {
    if (this.id === 'relief') return this.host.app.defaults.relief.shape === 'area';
    return this.id !== 'river' && this.id !== 'border';
  }

  private get canClose(): boolean {
    return this.id !== 'river' && !(this.id === 'relief' && !this.alwaysClosed);
  }

  private nearFirst(x: number, y: number): boolean {
    if (this.nodes.length < 3 || !this.canClose) return false;
    const s = screenOf(this.host.app, this.nodes[0].p);
    return !!s && Math.hypot(x - s[0], y - s[1]) < 8;
  }

  down(e: ToolEvent): void {
    if (!e.v) return;
    if (this.spring) {
      if (e.geo && !this.host.app.generateRiver(e.geo)) this.host.notify('A spring needs dry land: click on the land, not on water.');
      return;
    }
    if (this.nearFirst(e.x, e.y)) {
      this.finish(true);
      return;
    }
    this.stroke = { pts: [e.v], screen: [[e.x, e.y]], freehand: false };
  }

  move(e: ToolEvent): void {
    this.cursorV = e.v;
    this.cursorXY = [e.x, e.y];
    const st = this.stroke;
    if (st && e.buttons & 1 && e.v) {
      const first = st.screen[0], last = st.screen[st.screen.length - 1];
      if (!st.freehand && Math.hypot(e.x - first[0], e.y - first[1]) > 4) st.freehand = true;
      if (st.freehand && Math.hypot(e.x - last[0], e.y - last[1]) >= 1.5) {
        st.pts.push(e.v);
        st.screen.push([e.x, e.y]);
      }
    }
    this.host.app.view.requestOverlay();
  }

  up(): void {
    const st = this.stroke;
    this.stroke = null;
    if (!st) return;
    if (!st.freehand) {
      this.nodes.push({ p: st.pts[0], hin: null, hout: null });
      this.host.app.view.requestOverlay();
      return;
    }
    const app = this.host.app;
    const tolerance = FIT_TOLERANCE_PX / app.view.projection.scale();
    if (this.nodes.length) {
      // Continuing a clicked path: the drawn stretch is appended to it.
      const part = strokeToPath(st.pts, false, tolerance);
      if (part) this.nodes.push(...part.nodes);
      app.view.requestOverlay();
      return;
    }
    const [a, b] = [st.screen[0], st.screen[st.screen.length - 1]];
    const close = this.alwaysClosed || (this.id === 'border' && Math.hypot(a[0] - b[0], a[1] - b[1]) < 20 && st.screen.length > 10);
    const path = strokeToPath(st.pts, close, tolerance);
    if (!path) return;
    this.nodes = path.nodes;
    this.finish(close);
  }

  dblclick(): void {
    this.finish(this.alwaysClosed);
  }

  key(e: KeyboardEvent): boolean {
    if (!this.nodes.length) return false;
    if (e.key === 'Enter') this.finish(this.alwaysClosed);
    else if (e.key === 'Escape') this.reset();
    else if (e.key === 'Backspace' || e.key === 'Delete') this.nodes.pop();
    else return false;
    this.host.app.view.requestOverlay();
    return true;
  }

  deactivate(): void {
    this.finish(this.alwaysClosed);
  }

  private reset(): void {
    this.nodes = [];
    this.stroke = null;
    this.host.app.view.requestOverlay();
  }

  private finish(close: boolean): void {
    const app = this.host.app;
    // A double-click's second press lands on the previous node; drop such duplicates.
    const nodes = this.nodes.filter((n, i) => {
      if (i === 0) return true;
      const a = screenOf(app, this.nodes[i - 1].p), b = screenOf(app, n.p);
      return !a || !b || Math.hypot(a[0] - b[0], a[1] - b[1]) > 3;
    });
    const path: VPath = { nodes, closed: close };
    if (nodes.length < minNodes(path)) {
      this.reset();
      return;
    }
    app.checkpoint();
    const base = { id: newId(), rev: 0, path };
    const d = app.defaults;
    switch (this.id) {
      case 'land':
      case 'cut':
        app.add({ ...base, kind: 'land', op: this.id === 'cut' ? 'cut' : 'add', rough: d.rough });
        break;
      case 'river':
        for (const n of path.nodes) n.section = d.riverSection;
        app.add({ ...base, kind: 'river', width: d.riverPx / app.ppd(), rough: d.rough });
        break;
      case 'border':
        app.add({ ...base, kind: 'border', line: d.border });
        break;
      case 'forest':
        app.add({ ...base, kind: 'forest', ...d.vegetation });
        break;
      case 'mountains':
        app.add({ ...base, kind: 'mountains', ...d.mountains });
        break;
      case 'relief':
        app.add({ ...base, kind: 'relief', amount: d.relief.amount, width: d.relief.widthPx / app.ppd(), rough: 0.4 });
        break;
    }
    this.nodes = [];
    this.stroke = null;
  }

  overlay(p: CanvasPainter): void {
    const app = this.host.app;
    if (this.stroke?.freehand) p.polyline(this.stroke.screen, { stroke: ACCENT, width: 1.5 });
    if (!this.nodes.length) return;
    const preview: VPath = { closed: false, nodes: [...this.nodes] };
    if (!this.stroke && this.cursorV) preview.nodes.push({ p: this.cursorV, hin: null, hout: null });
    drawPathEditing(p, app, preview, flatten(preview, FLATTEN_STEP).pts, this.nodes.length - 1);
    if (this.alwaysClosed && this.nodes.length >= 2) {
      const a = screenOf(app, preview.nodes[preview.nodes.length - 1].p), b = screenOf(app, this.nodes[0].p);
      if (a && b) p.polyline([a, b], { stroke: ACCENT, width: 1, dash: [3, 4], opacity: 0.7 });
    }
    if (this.nearFirst(...this.cursorXY)) {
      const s = screenOf(app, this.nodes[0].p);
      if (s) p.circle(s[0], s[1], 8, { stroke: ACCENT, width: 1.5 });
    }
  }
}

// ---------------------------------------------------------------- stamp

export class StampTool implements Tool {
  readonly id = 'stamp';
  readonly cursor = 'crosshair';
  readonly hint = 'Stamp · click to place a symbol · with Scatter on, drag to paint many · Alt-drag erases symbols';
  private stroke: { erase: boolean; last: [number, number] } | null = null;
  private at: [number, number] | null = null;
  private alt = false;

  constructor(private host: ToolHost) {}

  private sizePx(): number {
    return this.host.app.defaults.symbolPx;
  }

  private radius(): number {
    return this.sizePx() * 2.6;
  }

  private place(v: Vec3, scale = 1): void {
    const d = this.host.app.defaults;
    this.host.app.add({ id: newId(), rev: 0, kind: 'symbol', symbol: d.symbol, at: v, size: (d.symbolPx / this.host.app.ppd()) * scale }, false);
  }

  private eraseAt(x: number, y: number): void {
    const app = this.host.app;
    const r = this.radius();
    const gone = app.doc.items
      .filter((i) => i.kind === 'symbol')
      .filter((i) => {
        const s = screenOf(app, i.at);
        return s && Math.hypot(s[0] - x, s[1] - y) < r;
      })
      .map((i) => i.id);
    if (gone.length) app.remove(...gone);
  }

  /** Scatter only lands on land; single clicks may place a symbol anywhere. */
  private scatter(x: number, y: number): void {
    const app = this.host.app;
    const r = this.radius();
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
    const geo = app.view.toGeo(x + Math.cos(a) * d, y + Math.sin(a) * d);
    if (geo && geoContains(app.cache.land(app.doc).geo, geo)) this.place(fromLonLat(geo), 0.85 + Math.random() * 0.3);
  }

  down(e: ToolEvent): void {
    if (!e.v) return;
    this.host.app.checkpoint();
    this.stroke = { erase: e.alt, last: [e.x, e.y] };
    if (e.alt) this.eraseAt(e.x, e.y);
    else if (this.host.app.defaults.scatter) this.scatter(e.x, e.y);
    else this.place(e.v);
  }

  move(e: ToolEvent): void {
    this.at = e.v ? [e.x, e.y] : null;
    this.alt = e.alt;
    const s = this.stroke;
    if (s && e.buttons & 1) {
      if (s.erase) this.eraseAt(e.x, e.y);
      else if (this.host.app.defaults.scatter && Math.hypot(e.x - s.last[0], e.y - s.last[1]) > this.sizePx() * 1.3) {
        this.scatter(e.x, e.y);
        s.last = [e.x, e.y];
      }
    }
    this.host.app.view.requestOverlay();
  }

  up(): void {
    if (this.stroke) this.host.app.emit();
    this.stroke = null;
  }

  overlay(p: CanvasPainter): void {
    if (!this.at) return;
    const app = this.host.app;
    const [x, y] = this.at;
    if (this.alt || this.stroke?.erase || app.defaults.scatter) {
      p.circle(x, y, this.radius(), { stroke: ACCENT, width: 1, dash: this.alt || this.stroke?.erase ? [4, 3] : [] });
    }
    if (this.alt || this.stroke?.erase) return;
    const sprite = symbolSprite(app.defaults.symbol, this.sizePx(), app.pixelScale, 0, app.style);
    if (!sprite) return;
    p.ctx.globalAlpha = 0.6;
    p.sprite(sprite.canvas, x, y, sprite.scale);
    p.ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- text

export class TextTool implements Tool {
  readonly id = 'text';
  readonly cursor = 'text';
  readonly hint = 'Text · click on the map to place a label · click a label to change its words';

  constructor(private host: ToolHost) {}

  down(e: ToolEvent): void {
    const app = this.host.app;
    const hit = hitItem(app, e.x, e.y, e.geo);
    if (hit?.kind === 'label') {
      app.select({ id: hit.id, node: null });
      this.host.editText(hit.text, e.x, e.y, (text) => {
        if (text === null || text === hit.text) return;
        app.checkpoint();
        hit.text = text;
        app.touch(hit);
        app.emit();
      });
      return;
    }
    const at = e.v;
    if (!at) return;
    this.host.editText('', e.x, e.y, (text) => {
      if (!text) return;
      app.checkpoint();
      const d = app.defaults;
      app.add({ id: newId(), rev: 0, kind: 'label', text, at, size: d.labelPx / app.ppd(), style: d.labelStyle, path: null });
    });
  }
}

// ---------------------------------------------------------------- hand

/** Panning itself is handled by the tool manager, which pans whenever this tool is active. */
export class HandTool implements Tool {
  readonly id = 'hand';
  readonly cursor = 'grab';
  readonly hint = 'Hand · drag to move the map (also: hold Space, or drag with the right mouse button) · wheel zooms';
}
