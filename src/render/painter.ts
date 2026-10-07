import { geoDistance, geoPath, type GeoPath, type GeoPermissibleObjects, type GeoProjection } from 'd3-geo';
import type { LonLat } from '../vector/geo';

export interface Paint {
  fill?: string;
  stroke?: string;
  width?: number;
  dash?: number[];
  opacity?: number;
  /** Line join (default round); bevel is much cheaper for wide strokes. */
  join?: CanvasLineJoin;
}

export interface TextStyle {
  size: number;
  font: string;
  color: string;
  italic?: boolean;
  /** Knock-out outline behind the text so it stays readable over linework. */
  halo?: string;
  /** Halo width in screen px. */
  haloWidth?: number;
}

/** 2D affine transform [a, b, c, d, e, f] as used by canvas setTransform and SVG matrix(). */
export type Affine = [number, number, number, number, number, number];

/** Draws geographic and screen-space primitives; one implementation per output (canvas, SVG). */
export abstract class Painter {
  constructor(
    readonly projection: GeoProjection,
    readonly width: number,
    readonly height: number,
  ) {}

  abstract background(color: string): void;
  abstract path(geo: GeoPermissibleObjects, paint: Paint): void;
  /** Screen-space polyline or polygon. */
  abstract polyline(pts: [number, number][], paint: Paint, close?: boolean): void;
  abstract circle(x: number, y: number, r: number, paint: Paint): void;
  abstract rect(x: number, y: number, w: number, h: number, paint: Paint): void;
  /** Pixel art centred on (x, y), each sprite pixel `scale` screen px, snapped to the pixel grid. */
  abstract sprite(img: HTMLCanvasElement, x: number, y: number, scale: number): void;
  /**
   * One character, drawn centred at the origin of `m` at font size `style.size`. Labels are laid
   * out glyph by glyph on the sphere, so `m` carries the projection's local stretch and turn.
   */
  abstract glyph(ch: string, m: Affine, style: TextStyle): void;
  /** Restrict following drawing to the inside of `geo` until endClip(). */
  abstract beginClip(geo: GeoPermissibleObjects): void;
  abstract endClip(): void;
  /** Paper grain over the whole sheet. */
  abstract grain(opacity: number): void;

  /** Screen position of a point, or null if it is on the far side of the globe or off-sheet. */
  visible(p: LonLat, margin = 40): [number, number] | null {
    return screenPoint(this.projection, p, this.width, this.height, margin);
  }
}

/** Screen position of a geographic point, or null if hidden behind the globe or off-screen. */
export function screenPoint(projection: GeoProjection, p: LonLat, width: number, height: number, margin = 40): [number, number] | null {
  const clip = projection.clipAngle();
  if (clip) {
    const r = projection.rotate();
    if (geoDistance(p, [-r[0], -r[1]]) > ((clip - 0.5) * Math.PI) / 180) return null;
  }
  const s = projection(p);
  if (!s || !Number.isFinite(s[0]) || !Number.isFinite(s[1])) return null;
  if (s[0] < -margin || s[1] < -margin || s[0] > width + margin || s[1] > height + margin) return null;
  return s;
}

export const fontString = (st: TextStyle) => `${st.italic ? 'italic ' : ''}${st.size}px ${st.font}`;

let grainCanvas: HTMLCanvasElement | null = null;
function grainTile(): HTMLCanvasElement {
  if (grainCanvas) return grainCanvas;
  grainCanvas = document.createElement('canvas');
  grainCanvas.width = grainCanvas.height = 192;
  const ctx = grainCanvas.getContext('2d')!;
  const img = ctx.createImageData(192, 192);
  let s = 1234567;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = s / 0x7fffffff;
    img.data[i] = 90;
    img.data[i + 1] = 70;
    img.data[i + 2] = 45;
    img.data[i + 3] = v < 0.5 ? v * 70 : 0;
  }
  ctx.putImageData(img, 0, 0);
  return grainCanvas;
}

/** Local units → screen px scale of an affine transform (for line widths inside it). */
const affineScale = (m: Affine) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

export class CanvasPainter extends Painter {
  private geo: GeoPath;

  constructor(projection: GeoProjection, readonly ctx: CanvasRenderingContext2D, width: number, height: number) {
    super(projection, width, height);
    this.geo = geoPath(projection, ctx);
  }

  background(color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  private apply(paint: Paint): void {
    const ctx = this.ctx;
    ctx.globalAlpha = paint.opacity ?? 1;
    if (paint.fill) {
      ctx.fillStyle = paint.fill;
      ctx.fill('evenodd');
    }
    if (paint.stroke) {
      ctx.strokeStyle = paint.stroke;
      ctx.lineWidth = paint.width ?? 1;
      ctx.setLineDash(paint.dash ?? []);
      ctx.lineJoin = paint.join ?? 'round';
      ctx.lineCap = paint.join === 'bevel' ? 'butt' : 'round';
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  path(geo: GeoPermissibleObjects, paint: Paint): void {
    this.ctx.beginPath();
    this.geo(geo);
    this.apply(paint);
  }

  polyline(pts: [number, number][], paint: Paint, close = false): void {
    this.ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? this.ctx.lineTo(x, y) : this.ctx.moveTo(x, y)));
    if (close) this.ctx.closePath();
    this.apply(paint);
  }

  circle(x: number, y: number, r: number, paint: Paint): void {
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.apply(paint);
  }

  rect(x: number, y: number, w: number, h: number, paint: Paint): void {
    this.ctx.beginPath();
    this.ctx.rect(x, y, w, h);
    this.apply(paint);
  }

  sprite(img: HTMLCanvasElement, x: number, y: number, scale: number): void {
    // Work in device pixels so every sprite pixel is a whole number of device pixels and all
    // sprites share one grid, however the canvas is scaled (high-DPI screens, PNG export).
    const ctx = this.ctx;
    const t = ctx.getTransform();
    const d = Math.max(1, Math.round(scale * t.a));
    const w = img.width * d, h = img.height * d;
    const dx = Math.round((x * t.a + t.e - w / 2) / d) * d;
    const dy = Math.round((y * t.d + t.f - h / 2) / d) * d;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, dx, dy, w, h);
    ctx.restore();
  }

  glyph(ch: string, m: Affine, st: TextStyle): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.transform(...m);
    ctx.font = fontString(st);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (st.halo) {
      ctx.strokeStyle = st.halo;
      ctx.lineJoin = 'round';
      ctx.lineWidth = (st.haloWidth ?? 3) / affineScale(m);
      ctx.strokeText(ch, 0, 0);
    }
    ctx.fillStyle = st.color;
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  }

  beginClip(geo: GeoPermissibleObjects): void {
    this.ctx.save();
    this.ctx.beginPath();
    this.geo(geo);
    this.ctx.clip('evenodd');
  }

  endClip(): void {
    this.ctx.restore();
  }

  grain(opacity: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = ctx.createPattern(grainTile(), 'repeat')!;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n2 = (v: number) => v.toFixed(2);
const dataUrls = new WeakMap<HTMLCanvasElement, string>();

export class SvgPainter extends Painter {
  private parts: string[] = [];
  private defs: string[] = [];
  private geo: GeoPath;
  private ids = 0;

  constructor(projection: GeoProjection, width: number, height: number) {
    super(projection, width, height);
    this.geo = geoPath(projection).digits(2);
  }

  private attrs(paint: Paint): string {
    const a = [`fill="${paint.fill ? esc(paint.fill) : 'none'}"`];
    if (paint.fill) a.push('fill-rule="evenodd"');
    if (paint.stroke) {
      a.push(`stroke="${esc(paint.stroke)}"`, `stroke-width="${paint.width ?? 1}"`, 'stroke-linejoin="round"', 'stroke-linecap="round"');
      if (paint.dash?.length) a.push(`stroke-dasharray="${paint.dash.join(' ')}"`);
    }
    if (paint.opacity !== undefined && paint.opacity !== 1) a.push(`opacity="${paint.opacity}"`);
    return a.join(' ');
  }

  background(color: string): void {
    this.parts.push(`<rect width="${this.width}" height="${this.height}" fill="${esc(color)}"/>`);
  }

  path(geo: GeoPermissibleObjects, paint: Paint): void {
    const d = this.geo(geo);
    if (d) this.parts.push(`<path d="${d}" ${this.attrs(paint)}/>`);
  }

  polyline(pts: [number, number][], paint: Paint, close = false): void {
    if (!pts.length) return;
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${n2(x)} ${n2(y)}`).join('') + (close ? 'Z' : '');
    this.parts.push(`<path d="${d}" ${this.attrs(paint)}/>`);
  }

  circle(x: number, y: number, r: number, paint: Paint): void {
    this.parts.push(`<circle cx="${n2(x)}" cy="${n2(y)}" r="${r}" ${this.attrs(paint)}/>`);
  }

  rect(x: number, y: number, w: number, h: number, paint: Paint): void {
    this.parts.push(`<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" ${this.attrs(paint)}/>`);
  }

  sprite(img: HTMLCanvasElement, x: number, y: number, scale: number): void {
    let url = dataUrls.get(img);
    if (!url) dataUrls.set(img, (url = img.toDataURL('image/png')));
    const w = img.width * scale, h = img.height * scale;
    const dx = Math.round((x - w / 2) / scale) * scale, dy = Math.round((y - h / 2) / scale) * scale;
    this.parts.push(`<image href="${url}" x="${n2(dx)}" y="${n2(dy)}" width="${n2(w)}" height="${n2(h)}" preserveAspectRatio="none" style="image-rendering:pixelated"/>`);
  }

  glyph(ch: string, m: Affine, st: TextStyle): void {
    const a = [`transform="matrix(${m.map((v) => v.toFixed(4)).join(' ')})"`, `font-family="${esc(st.font)}"`, `font-size="${st.size}"`, `fill="${esc(st.color)}"`, 'text-anchor="middle"', 'dominant-baseline="central"'];
    if (st.italic) a.push('font-style="italic"');
    if (st.halo) a.push(`stroke="${esc(st.halo)}"`, `stroke-width="${((st.haloWidth ?? 3) / affineScale(m)).toFixed(3)}"`, 'stroke-linejoin="round"', 'paint-order="stroke"');
    this.parts.push(`<text ${a.join(' ')}>${esc(ch)}</text>`);
  }

  beginClip(geo: GeoPermissibleObjects): void {
    const d = this.geo(geo) ?? '';
    const id = `clip${this.ids++}`;
    this.defs.push(`<clipPath id="${id}"><path d="${d}" clip-rule="evenodd"/></clipPath>`);
    this.parts.push(`<g clip-path="url(#${id})">`);
  }

  endClip(): void {
    this.parts.push('</g>');
  }

  grain(opacity: number): void {
    if (!this.defs.some((d) => d.startsWith('<filter id="grain"'))) {
      this.defs.push(
        '<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7"/>' +
          '<feColorMatrix values="0 0 0 0 0.35 0 0 0 0 0.27 0 0 0 0 0.18 0 0 0 -1.4 0.75"/></filter>',
      );
    }
    this.parts.push(`<rect width="${this.width}" height="${this.height}" filter="url(#grain)" opacity="${opacity}"/>`);
  }

  toString(): string {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">` +
      `<defs>${this.defs.join('')}</defs>${this.parts.join('')}</svg>`
    );
  }
}
