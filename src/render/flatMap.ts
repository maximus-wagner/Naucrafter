import type { World } from '../world/world';
import { nearestCell, type CellHit } from '../world/sphereMesh';
import { ARROW_SCALE, plateVelocity } from '../world/plates';
import { latLonToVec, normalize, vecToLatLon, type Vec3 } from '../core/math';
import { buildLookup, renderRaster, type RasterLookup } from './raster';
import type { Layer } from './colors';

export const MAP_W = 1280;
export const MAP_H = 640;

/** Equirectangular map. Wraps east–west; wheel zooms, right/middle drag pans (left too in navigate mode). */
export class FlatMapView {
  readonly canvas = document.createElement('canvas');
  navigate = true;
  showArrows = false;
  private ctx: CanvasRenderingContext2D;
  private raster = document.createElement('canvas');
  private rctx: CanvasRenderingContext2D;
  private image: ImageData;
  private lookup: RasterLookup | null = null;
  private world: World | null = null;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private lastCell = 0;
  private cursor: { point: Vec3; radius: number } | null = null;

  constructor(private container: HTMLElement) {
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.raster.width = MAP_W;
    this.raster.height = MAP_H;
    this.rctx = this.raster.getContext('2d')!;
    this.image = this.rctx.createImageData(MAP_W, MAP_H);

    new ResizeObserver(() => this.resize()).observe(container);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    let pan: { x: number; y: number } | null = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || e.button === 2 || (e.button === 0 && this.navigate)) {
        pan = { x: e.clientX, y: e.clientY };
        this.canvas.setPointerCapture(e.pointerId);
      }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!pan) return;
      this.panX += e.clientX - pan.x;
      this.panY += e.clientY - pan.y;
      pan = { x: e.clientX, y: e.clientY };
      this.draw();
    });
    const endPan = () => (pan = null);
    this.canvas.addEventListener('pointerup', endPan);
    this.canvas.addEventListener('pointercancel', endPan);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.draw();
  }

  private layout(): { s: number; ox: number; oy: number; cw: number; ch: number } {
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    const s = Math.min(cw / MAP_W, ch / MAP_H) * this.zoom;
    const maxPanY = Math.max(0, (MAP_H * s - ch) / 2 + ch * 0.25);
    this.panY = Math.max(-maxPanY, Math.min(maxPanY, this.panY));
    return { s, ox: (cw - MAP_W * s) / 2 + this.panX, oy: (ch - MAP_H * s) / 2 + this.panY, cw, ch };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const before = this.layout();
    const u = (sx - before.ox) / before.s, v = (sy - before.oy) / before.s;
    this.zoom = Math.max(1, Math.min(16, this.zoom * Math.exp(-e.deltaY * 0.0015)));
    const s = Math.min(before.cw / MAP_W, before.ch / MAP_H) * this.zoom;
    this.panX = sx - u * s - (before.cw - MAP_W * s) / 2;
    this.panY = sy - v * s - (before.ch - MAP_H * s) / 2;
    this.draw();
  }

  render(world: World, layer: Layer, relief: number): void {
    if (!this.lookup || this.lookup.mesh !== world.mesh) {
      this.lookup = buildLookup(world.mesh, MAP_W, MAP_H);
      this.lastCell = 0;
    }
    this.world = world;
    renderRaster(world, layer, this.lookup, this.image.data, relief);
    this.rctx.putImageData(this.image, 0, 0);
    this.draw();
  }

  draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0d13';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.lookup) return;
    const { s, ox, oy, cw } = this.layout();
    const Ws = MAP_W * s;
    let x0 = ox % Ws;
    if (x0 > 0) x0 -= Ws;
    ctx.imageSmoothingEnabled = s < 1.5;
    const copies: number[] = [];
    for (let x = x0; x < cw; x += Ws) {
      ctx.drawImage(this.raster, x, oy, Ws, MAP_H * s);
      copies.push(x);
    }

    const toScreen = (p: Vec3, x: number): [number, number] => {
      const [lat, lon] = vecToLatLon(...p);
      return [x + ((lon + Math.PI) / (2 * Math.PI)) * Ws, oy + ((Math.PI / 2 - lat) / Math.PI) * MAP_H * s];
    };

    if (this.showArrows && this.world) {
      const world = this.world;
      world.plates.plates.forEach((plate, i) => {
        const c = world.centroid(i);
        if (Math.hypot(...c) < 0.5) return;
        const v = plateVelocity(plate, ...c);
        if (Math.hypot(...v) < 1e-3) return;
        const tip = normalize([c[0] + v[0] * ARROW_SCALE, c[1] + v[1] * ARROW_SCALE, c[2] + v[2] * ARROW_SCALE]);
        for (const x of copies) {
          const [ax, ay] = toScreen(c, x);
          let [bx, by] = toScreen(tip, x);
          if (bx - ax > Ws / 2) bx -= Ws;
          if (ax - bx > Ws / 2) bx += Ws;
          drawArrow(ctx, ax, ay, bx, by);
        }
      });
    }

    if (this.cursor) {
      const [lat] = vecToLatLon(...this.cursor.point);
      const ry = (this.cursor.radius / Math.PI) * MAP_H * s;
      const rx = Math.min(Ws / 2, ry / Math.max(0.05, Math.cos(lat)));
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      for (const x of copies) {
        const [cx, cy] = toScreen(this.cursor.point, x);
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  pick(clientX: number, clientY: number, world: World): CellHit | null {
    const r = this.canvas.getBoundingClientRect();
    const { s, ox, oy } = this.layout();
    let u = (clientX - r.left - ox) / s;
    const v = (clientY - r.top - oy) / s;
    if (v < 0 || v >= MAP_H) return null;
    u = ((u % MAP_W) + MAP_W) % MAP_W;
    const point = latLonToVec(Math.PI / 2 - (v / MAP_H) * Math.PI, (u / MAP_W) * 2 * Math.PI - Math.PI);
    this.lastCell = nearestCell(world.mesh, ...point, this.lastCell);
    return { cell: this.lastCell, point };
  }

  setCursor(point: Vec3 | null, radius: number): void {
    this.cursor = point ? { point, radius } : null;
    this.draw();
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number): void {
  const ang = Math.atan2(by - ay, bx - ax);
  const head = Math.min(10, Math.hypot(bx - ax, by - ay) * 0.5);
  ctx.lineCap = 'round';
  for (const [style, width] of [['rgba(0,0,0,0.6)', 4], ['#fff', 2]] as const) {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.moveTo(bx - head * Math.cos(ang - 0.45), by - head * Math.sin(ang - 0.45));
    ctx.lineTo(bx, by);
    ctx.lineTo(bx - head * Math.cos(ang + 0.45), by - head * Math.sin(ang + 0.45));
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(ax, ay, 3, 0, Math.PI * 2);
  ctx.fill();
}
