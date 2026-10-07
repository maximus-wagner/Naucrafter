import {
  geoEqualEarth,
  geoEquirectangular,
  geoMercator,
  geoNaturalEarth1,
  geoOrthographic,
  type GeoProjection,
} from 'd3-geo';
import { CanvasPainter } from './painter';
import { fromLonLat, type LonLat } from '../vector/geo';
import type { Vec3 } from '../core/math';

export type ProjectionId = 'orthographic' | 'equalEarth' | 'naturalEarth' | 'equirectangular' | 'mercator';

export const PROJECTIONS: Record<ProjectionId, { name: string; make: () => GeoProjection }> = {
  orthographic: { name: 'Globe (orthographic)', make: geoOrthographic },
  equalEarth: { name: 'Equal Earth', make: geoEqualEarth },
  naturalEarth: { name: 'Natural Earth', make: geoNaturalEarth1 },
  equirectangular: { name: 'Equirectangular', make: geoEquirectangular },
  mercator: { name: 'Mercator', make: geoMercator },
};

/** Deep zoom: coastlines gain detail in steps; symbols and areas stop growing past their limits. */
const MAX_ZOOM = 5000;

/**
 * Two stacked canvases: `base` holds the rendered map, `overlay` (on top, receives input) holds
 * editing feedback. Only the overlay redraws while you point and drag.
 */
export class MapView {
  readonly base = document.createElement('canvas');
  readonly overlay = document.createElement('canvas');
  projectionId: ProjectionId = 'orthographic';
  projection: GeoProjection = geoOrthographic();
  width = 0;
  height = 0;
  /** Zoom to apply once the view first gets a size. */
  initialZoom = 1;
  onRender: (p: CanvasPainter) => void = () => {};
  onOverlay: (p: CanvasPainter) => void = () => {};
  onViewChange: () => void = () => {};
  private fitScale = 1;
  private needsFit = true;
  private queued = { base: false, overlay: false };

  constructor(private container: HTMLElement) {
    this.base.className = 'map-base';
    this.overlay.className = 'map-overlay';
    container.append(this.base, this.overlay);
    new ResizeObserver(() => this.resize()).observe(container);
    this.overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = this.eventPos(e);
      this.zoomAt(x, y, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.base, this.overlay]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    // Keep the zoom level across resizes, but recentre.
    const zoom = this.width ? this.zoom() : this.initialZoom;
    this.width = w;
    this.height = h;
    this.fit();
    this.projection.scale(this.fitScale * zoom);
    this.requestRender();
    this.onViewChange();
  }

  private fit(): void {
    const m = 24;
    const r = this.projection.rotate();
    this.projection.rotate([r[0], this.projectionId === 'orthographic' ? r[1] : 0]);
    this.projection.fitExtent([[m, m], [this.width - m, this.height - m]], { type: 'Sphere' });
    this.fitScale = this.projection.scale();
    this.needsFit = false;
  }

  zoom(): number {
    return this.projection.scale() / this.fitScale;
  }

  /** Set the zoom around the view centre (applied on first layout if the view has no size yet). */
  setZoom(z: number): void {
    if (!this.width) {
      this.initialZoom = z;
      return;
    }
    this.zoomAt(this.width / 2, this.height / 2, z / this.zoom());
  }

  setProjection(id: ProjectionId): void {
    const [lambda, phi] = this.projection.rotate();
    this.projectionId = id;
    this.projection = PROJECTIONS[id].make().precision(0.3);
    this.projection.rotate([lambda, id === 'orthographic' ? phi : 0]);
    this.needsFit = true;
    if (this.width) this.fit();
    this.requestRender();
    this.onViewChange();
  }

  resetView(): void {
    this.projection.rotate([0, 0]);
    this.fit();
    this.requestRender();
    this.onViewChange();
  }

  /** Pan by a screen delta: orthographic turns the globe, flat maps slide east–west and up–down. */
  panBy(dx: number, dy: number): void {
    const p = this.projection;
    const k = 180 / Math.PI / p.scale();
    const [lambda, phi] = p.rotate();
    if (this.projectionId === 'orthographic') {
      p.rotate([lambda + dx * k, Math.max(-90, Math.min(90, phi - dy * k))]);
    } else {
      p.rotate([lambda + dx * k, phi]);
      const [tx, ty] = p.translate();
      p.translate([tx, ty + dy]);
    }
    this.requestRender();
    this.onViewChange();
  }

  zoomAt(x: number, y: number, factor: number): void {
    const p = this.projection;
    const s = Math.max(this.fitScale * 0.5, Math.min(this.fitScale * MAX_ZOOM, p.scale() * factor));
    if (this.projectionId === 'orthographic') {
      p.scale(s);
    } else {
      const before = p.invert?.([x, y]);
      p.scale(s);
      const after = before && p(before);
      if (after) {
        const [tx, ty] = p.translate();
        p.translate([tx + x - after[0], ty + y - after[1]]);
      }
    }
    this.requestRender();
    this.onViewChange();
  }

  eventPos(e: MouseEvent): [number, number] {
    const r = this.overlay.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Screen → geographic position, or null off the world. */
  toGeo(x: number, y: number): LonLat | null {
    const g = this.projection.invert?.([x, y]);
    if (!g || !Number.isFinite(g[0]) || !Number.isFinite(g[1]) || Math.abs(g[1]) > 90) return null;
    // Reject points outside the projected world (inverse projections happily extrapolate).
    const back = this.projection(g);
    if (!back || Math.hypot(back[0] - x, back[1] - y) > 1) return null;
    return [g[0], g[1]];
  }

  toVec(x: number, y: number): Vec3 | null {
    const g = this.toGeo(x, y);
    return g && fromLonLat(g);
  }

  requestRender(): void {
    this.request('base');
  }

  requestOverlay(): void {
    this.request('overlay');
  }

  private request(kind: 'base' | 'overlay'): void {
    if (this.queued.base || this.queued.overlay) {
      this.queued[kind] = true;
      return;
    }
    this.queued[kind] = true;
    requestAnimationFrame(() => {
      if (this.needsFit && this.width) this.fit();
      if (this.queued.base) this.draw(this.base, this.onRender);
      this.draw(this.overlay, this.onOverlay, true);
      this.queued.base = this.queued.overlay = false;
    });
  }

  private draw(canvas: HTMLCanvasElement, fn: (p: CanvasPainter) => void, clear = false): void {
    if (!this.width) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (clear) ctx.clearRect(0, 0, this.width, this.height);
    fn(new CanvasPainter(this.projection, ctx, this.width, this.height));
  }
}
