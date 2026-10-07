import type { Vec3 } from '../core/math';
import { slerp } from '../doc/geometry';
import { bearingDeg, distanceKm, formatArea, formatDistance, greatCircle, ringAreaKm2, type Units } from '../doc/measure';
import type { CanvasPainter } from '../render/painter';
import { ACCENT, HANDLE_FILL, screenLines, screenOf, type Tool, type ToolEvent, type ToolHost } from './base';

const UNITS_KEY = 'naucrafter.units';
/** Pointer distance (px) within which a click grabs an existing point or snaps to a feature. */
const GRAB_PX = 8;
const SAMPLE_STEP = 0.01;

function loadUnits(): Units {
  try {
    return localStorage.getItem(UNITS_KEY) === 'mi' ? 'mi' : 'km';
  } catch {
    return 'km';
  }
}

export interface Readout {
  points: number;
  closed: boolean;
  /** Length of each leg in km (a closed loop includes the leg back to the start). */
  legsKm: number[];
  totalKm: number;
  /** Compass bearing of the most recent leg, degrees. */
  bearing: number | null;
  areaKm2: number | null;
}

/**
 * A ruler: click points across the map to read the distance along the great circle between them
 * in real kilometres for this planet. Drag to measure a straight line, click the first point to
 * close a loop and get its area. Points snap to symbols and path nodes. Nothing is added to the map.
 */
export class MeasureTool implements Tool {
  readonly id = 'measure';
  readonly cursor = 'crosshair';
  readonly hint =
    'Measure · click points along the way to read the distance · drag for a straight line · click the first point to close a loop and get its area · Enter finishes, Esc clears, Backspace removes a point · Alt: no snapping';
  units: Units = loadUnits();
  private points: Vec3[] = [];
  private closed = false;
  private finished = false;
  private cursorV: Vec3 | null = null;
  private cursorXY: [number, number] = [0, 0];
  private snapped = false;
  private drag: { index: number; down: [number, number]; added: boolean } | null = null;

  constructor(private host: ToolHost) {}

  setUnits(u: Units): void {
    this.units = u;
    try {
      localStorage.setItem(UNITS_KEY, u);
    } catch {
      // Remembering the unit is a convenience only.
    }
    this.host.app.view.requestOverlay();
  }

  clear(): void {
    this.points = [];
    this.closed = this.finished = false;
    this.drag = null;
    this.host.app.view.requestOverlay();
    this.host.refresh();
  }

  /** Numbers for the panel. */
  readout(): Readout {
    const radius = this.host.app.doc.planet.radiusKm;
    const pts = this.points;
    const legs: number[] = [];
    for (let i = 1; i < pts.length; i++) legs.push(distanceKm(pts[i - 1], pts[i], radius));
    if (this.closed) legs.push(distanceKm(pts[pts.length - 1], pts[0], radius));
    const n = pts.length;
    const last = this.closed ? [pts[n - 1], pts[0]] : n >= 2 ? [pts[n - 2], pts[n - 1]] : null;
    return {
      points: n,
      closed: this.closed,
      legsKm: legs,
      totalKm: legs.reduce((s, d) => s + d, 0),
      bearing: last && !this.closed ? bearingDeg(last[0], last[1]) : null,
      areaKm2: this.closed && n >= 3 ? ringAreaKm2(pts, radius) : null,
    };
  }

  /** A town, city or path node near the pointer, so distances can be taken between real features. */
  private snap(e: { x: number; y: number; alt: boolean }): Vec3 | null {
    if (e.alt) return null;
    const app = this.host.app;
    let best: Vec3 | null = null;
    let bestD = GRAB_PX;
    const consider = (v: Vec3) => {
      const s = screenOf(app, v);
      const d = s ? Math.hypot(s[0] - e.x, s[1] - e.y) : Infinity;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    };
    for (const it of app.doc.items) {
      if (it.kind === 'symbol') consider(it.at);
      else if (it.kind !== 'label' && it.kind !== 'relief') for (const n of it.path.nodes) consider(n.p);
    }
    return best;
  }

  private pointAt(x: number, y: number): number {
    for (let i = this.points.length - 1; i >= 0; i--) {
      const s = screenOf(this.host.app, this.points[i]);
      if (s && Math.hypot(s[0] - x, s[1] - y) < GRAB_PX) return i;
    }
    return -1;
  }

  down(e: ToolEvent): void {
    if (!e.v) return;
    const hit = this.pointAt(e.x, e.y);
    if (hit === 0 && this.points.length >= 3 && !this.closed) {
      this.closed = this.finished = true;
      this.host.app.view.requestOverlay();
      this.host.refresh();
      return;
    }
    if (hit >= 0) {
      this.drag = { index: hit, down: [e.x, e.y], added: false };
      return;
    }
    if (this.finished) {
      this.points = [];
      this.closed = this.finished = false;
    }
    this.points.push(this.snap(e) ?? e.v);
    this.drag = { index: this.points.length - 1, down: [e.x, e.y], added: true };
    this.host.app.view.requestOverlay();
    this.host.refresh();
  }

  move(e: ToolEvent): void {
    this.cursorV = e.v;
    this.cursorXY = [e.x, e.y];
    const snap = e.v ? this.snap(e) : null;
    this.snapped = !!snap;
    const d = this.drag;
    if (d && !d.added && e.buttons & 1 && e.v) this.points[d.index] = snap ?? e.v;
    if (snap) this.cursorV = snap;
    this.host.app.view.requestOverlay();
  }

  up(e: ToolEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    // Press, drag, release: the release point is the other end of a straight measurement.
    if (d.added && e.v && Math.hypot(e.x - d.down[0], e.y - d.down[1]) > 6) this.points.push(this.snap(e) ?? e.v);
    this.host.app.view.requestOverlay();
    this.host.refresh();
  }

  dblclick(): void {
    if (this.points.length) this.finished = true;
    this.host.app.view.requestOverlay();
  }

  key(e: KeyboardEvent): boolean {
    if (!this.points.length) return false;
    if (e.key === 'Enter') this.finished = true;
    else if (e.key === 'Escape') {
      this.clear();
      return true;
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      if (this.closed) this.closed = this.finished = false;
      else this.points.pop();
      this.host.refresh();
    } else return false;
    this.host.app.view.requestOverlay();
    return true;
  }

  overlay(p: CanvasPainter): void {
    const app = this.host.app;
    const pts = this.points;
    if (!pts.length) return;
    const radius = app.doc.planet.radiusKm;
    const fmt = (km: number) => formatDistance(km, this.units);

    const chain: Vec3[] = this.closed ? [...pts, pts[0]] : pts;
    const flat: number[] = [];
    for (let i = 1; i < chain.length; i++) for (const v of greatCircle(chain[i - 1], chain[i], SAMPLE_STEP)) flat.push(...v);
    const stroke = (lines: [number, number][][], dash: number[] = []) => {
      for (const line of lines) {
        p.polyline(line, { stroke: HANDLE_FILL, width: 4.5, opacity: 0.85, dash });
        p.polyline(line, { stroke: ACCENT, width: 1.8, dash });
      }
    };
    if (flat.length >= 6) stroke(screenLines(p, flat));

    // The leg being drawn follows the pointer.
    const tail = pts[pts.length - 1];
    const tailXY = screenOf(app, tail, 1e6);
    const grabbing = !!this.drag && !this.drag.added;
    // No rubber band while the pointer rests on the last point (it would read "0 m").
    const live =
      !this.finished && !this.closed && this.cursorV && !grabbing && !(tailXY && Math.hypot(tailXY[0] - this.cursorXY[0], tailXY[1] - this.cursorXY[1]) < GRAB_PX + 2)
        ? this.cursorV
        : null;
    if (live) {
      const rubber: number[] = [];
      for (const v of greatCircle(tail, live, SAMPLE_STEP)) rubber.push(...v);
      stroke(screenLines(p, rubber), [6, 4]);
    }

    // Distance tags: one per finished leg, and a running tag at the pointer.
    const legs: [Vec3, Vec3][] = [];
    for (let i = 1; i < chain.length; i++) legs.push([chain[i - 1], chain[i]]);
    let total = 0;
    for (const [a, b] of legs) {
      const km = distanceKm(a, b, radius);
      total += km;
      const s = screenOf(app, slerp(a, b, 0.5), 0);
      const e0 = screenOf(app, a, 1e6), e1 = screenOf(app, b, 1e6);
      if (s && (legs.length === 1 || !e0 || !e1 || Math.hypot(e1[0] - e0[0], e1[1] - e0[1]) > 70)) tag(p, fmt(km), s[0], s[1] - 13);
    }
    if (live) {
      const km = distanceKm(tail, live, radius);
      const text = pts.length >= 2 ? `${fmt(km)} · total ${fmt(total + km)}` : fmt(km);
      tag(p, text, this.cursorXY[0] + 14, this.cursorXY[1] - 16, 'left');
    } else if (this.closed && pts.length >= 3) {
      // A loop reads out its area in the middle, where no leg tag sits.
      const screen = pts.map((v) => screenOf(app, v, 1e6));
      if (screen.every((s) => s)) {
        const cx = screen.reduce((s, q) => s + q![0], 0) / screen.length, cy = screen.reduce((s, q) => s + q![1], 0) / screen.length;
        tag(p, `${formatArea(ringAreaKm2(pts, radius), this.units)}`, cx, cy);
      }
    } else if (legs.length > 1) {
      const s = screenOf(app, chain[chain.length - 1], 0);
      if (s) tag(p, `total ${fmt(total)}`, s[0] + 12, s[1] - 16, 'left');
    }

    pts.forEach((v, i) => {
      const s = screenOf(app, v, 0);
      if (s) p.circle(s[0], s[1], i === 0 ? 5 : 4, { fill: i === 0 ? ACCENT : HANDLE_FILL, stroke: ACCENT, width: 1.4 });
    });
    if (!this.finished && pts.length >= 3 && Math.hypot(...this.firstOffset()) < GRAB_PX) {
      const s = screenOf(app, pts[0], 0);
      if (s) p.circle(s[0], s[1], 9, { stroke: ACCENT, width: 1.5 });
    }
    if (this.snapped && !this.finished) p.circle(this.cursorXY[0], this.cursorXY[1], 7, { stroke: ACCENT, width: 1, dash: [2, 2] });
  }

  private firstOffset(): [number, number] {
    const s = screenOf(this.host.app, this.points[0], 0);
    return s ? [s[0] - this.cursorXY[0], s[1] - this.cursorXY[1]] : [Infinity, 0];
  }
}

/** A small paper label with the ink border used by the editing overlays. */
function tag(p: CanvasPainter, text: string, x: number, y: number, align: 'center' | 'left' = 'center'): void {
  const ctx = p.ctx;
  ctx.save();
  ctx.font = '600 12px Georgia, "Times New Roman", serif';
  const w = ctx.measureText(text).width + 12;
  const left = align === 'center' ? x - w / 2 : x;
  ctx.globalAlpha = 0.94;
  ctx.fillStyle = HANDLE_FILL;
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(Math.round(left) + 0.5, Math.round(y - 10) + 0.5, Math.round(w), 20);
  ctx.fill();
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#2a2219';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, left + 6, y + 0.5);
  ctx.restore();
}
