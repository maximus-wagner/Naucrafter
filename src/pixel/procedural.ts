import { mulberry32 } from '../core/rng';

/** Palette indices used by procedural sprites; colours come from the map style. */
export const EMPTY = 0, INK = 1, PAPER = 2, SHADE = 3, SNOW = 4;

export interface IndexSprite {
  w: number;
  h: number;
  /** Row-major palette indices. */
  px: Uint8Array;
}

function blank(w: number, h: number): IndexSprite {
  return { w, h, px: new Uint8Array(w * h) };
}

function get(s: IndexSprite, x: number, y: number): number {
  return x < 0 || y < 0 || x >= s.w || y >= s.h ? EMPTY : s.px[y * s.w + x];
}

function put(s: IndexSprite, x: number, y: number, v: number): void {
  if (x >= 0 && y >= 0 && x < s.w && y < s.h) s.px[y * s.w + x] = v;
}

/** Filled pixels touching empty space become ink. With `ground`, the bottom edge stays open. */
function outline(s: IndexSprite, ground: boolean): void {
  const out = s.px.slice();
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const v = get(s, x, y);
      if (v === EMPTY || v === INK) continue;
      const exposed = get(s, x, y - 1) === EMPTY || get(s, x - 1, y) === EMPTY || get(s, x + 1, y) === EMPTY || (!ground && get(s, x, y + 1) === EMPTY);
      if (exposed) out[y * s.w + x] = INK;
    }
  }
  s.px = out;
}

/** Stable per-pixel noise in [0, 1). */
function hash(x: number, y: number, v: number): number {
  let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(v + 1, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const odd = (n: number) => (n % 2 === 0 ? n + 1 : n);

/**
 * A mountain `height` pixels tall. The shape's proportions depend only on `variant`, so the same
 * mountain keeps its character as it is redrawn at other sizes; detail (secondary peaks, ridge
 * line, snow, hatching) appears as it gets bigger.
 */
/** Mountain look: aspect (height relative to width, 1 = default), jaggedness 0–1, snow 0–0.6 (fraction of height). */
export interface MountainLook {
  height?: number;
  jag?: number;
  snow?: number;
}

export function mountainSprite(height: number, variant: number, outlined = true, look: MountainLook = {}): IndexSprite {
  const H = Math.max(3, Math.min(96, Math.round(height)));
  const rng = mulberry32(variant * 7919 + 17);
  const W = odd(Math.max(5, Math.round((H * (1.7 + rng() * 0.5)) / Math.max(0.3, look.height ?? 1))));
  const mainX = (0.42 + rng() * 0.16) * (W - 1);
  const side = rng() < 0.5 ? -1 : 1;
  const second = { x: mainX + side * (0.22 + rng() * 0.1) * W, h: H * (0.5 + rng() * 0.2) };
  const third = { x: mainX - side * (0.2 + rng() * 0.1) * W, h: H * (0.38 + rng() * 0.15) };
  const jag = Array.from({ length: 9 }, () => rng() - 0.5);

  const peaks = [{ x: mainX, h: H, l: H / (mainX + 1), r: H / (W - mainX) }];
  if (H >= 7) peaks.push({ ...second, l: peaks[0].l * 1.15, r: peaks[0].r * 1.15 });
  if (H >= 14) peaks.push({ ...third, l: peaks[0].l * 1.2, r: peaks[0].r * 1.2 });

  const s = blank(W, H);
  const owner = new Int8Array(W);
  for (let x = 0; x < W; x++) {
    let best = 0;
    peaks.forEach((p, i) => {
      const v = p.h - Math.abs(x - p.x) * (x < p.x ? p.l : p.r);
      if (v > best) {
        best = v;
        owner[x] = i;
      }
    });
    if (H >= 10 && best > 2 && best < H - 1) {
      const f = (x / (W - 1)) * (jag.length - 1), i = Math.floor(f);
      best += (jag[i] + (jag[Math.min(jag.length - 1, i + 1)] - jag[i]) * (f - i)) * (H / 7) * 2 * (look.jag ?? 0.5);
    }
    const top = Math.max(0, Math.min(H, Math.round(best)));
    for (let k = 0; k < top; k++) {
      const p = peaks[owner[x]];
      // The shadowed face is right of a ridge that leans outward as it descends.
      const ridge = p.x + (p.h - k) * 0.3;
      put(s, x, H - 1 - k, x > ridge ? SHADE : PAPER);
    }
  }
  const snow = look.snow ?? 0.22;
  if (H >= 12 && snow > 0) {
    for (let k = Math.ceil(H * (1 - snow)); k < H; k++) {
      for (let x = 0; x < W; x++) if (get(s, x, H - 1 - k) === PAPER && owner[x] === 0) put(s, x, H - 1 - k, SNOW);
    }
  }
  if (outlined) outline(s, true);
  if (H >= 9) {
    for (const p of peaks.slice(0, H >= 20 ? 3 : 1)) {
      for (let k = Math.round(p.h) - 2; k > p.h * 0.45; k--) {
        const x = Math.round(p.x + (p.h - k) * 0.3);
        if (get(s, x, H - 1 - k) !== EMPTY) put(s, x, H - 1 - k, INK);
      }
    }
  }
  if (H >= 14) {
    const step = H >= 26 ? 3 : 4;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (get(s, x, y) === SHADE && (x + (H - 1 - y)) % step === 0 && hash(x, y, variant) > 0.25) put(s, x, y, INK);
      }
    }
  }
  return s;
}

/** A rounded hill, wide and low; shading and a few hatch strokes on the far side. */
export function hillSprite(height: number, variant: number, outlined = true): IndexSprite {
  const H = Math.max(2, Math.min(64, Math.round(height)));
  const rng = mulberry32(variant * 6007 + 5);
  const W = odd(Math.max(5, Math.round(H * (2.4 + rng() * 0.6))));
  const c = (W - 1) / 2 + (rng() - 0.5) * W * 0.1;
  const s = blank(W, H);
  for (let x = 0; x < W; x++) {
    const t = (x - c) / (W / 2);
    const top = Math.round(H * Math.pow(Math.max(0, 1 - t * t), 0.9));
    for (let k = 0; k < top; k++) put(s, x, H - 1 - k, x > c + (H - k) * 0.15 ? SHADE : PAPER);
  }
  if (outlined) outline(s, true);
  if (H >= 8) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (get(s, x, y) === SHADE && (x + (H - 1 - y)) % 3 === 0 && H - 1 - y < H * 0.6) put(s, x, y, INK);
      }
    }
  }
  return s;
}

/** A tree: mostly round broadleaf, sometimes a tiered conifer (fixed per variant). */
export function treeSprite(height: number, variant: number): IndexSprite {
  const H = Math.max(3, Math.min(64, Math.round(height)));
  const rng = mulberry32(variant * 104729 + 3);
  const conifer = rng() < 0.3;
  const W = odd(Math.max(3, Math.round(H * (conifer ? 0.62 : 0.8))));
  const s = blank(W, H);
  const trunkH = Math.max(1, Math.round(H * 0.2));
  const canopyH = H - trunkH;
  const cx = (W - 1) / 2;

  if (conifer) {
    const tiers = H >= 18 ? 3 : H >= 10 ? 2 : 1;
    for (let y = 0; y < canopyH; y++) {
      const t = (y + 1) / canopyH;
      const local = (t * tiers) % 1 || 1;
      const half = (W / 2) * Math.min(1, t * 1.05) * (tiers > 1 ? 0.7 + 0.3 * local : 1);
      for (let x = 0; x < W; x++) if (Math.abs(x - cx) <= half - 0.25) put(s, x, y, x > cx ? SHADE : PAPER);
    }
  } else {
    const r = Math.min(W, canopyH) / 2;
    const cy = canopyH - r;
    const lumps = [{ x: cx, y: cy, r }];
    const extra = Array.from({ length: 3 }, () => ({ a: Math.PI * (0.15 + rng() * 0.7), d: 0.5 + rng() * 0.15, r: 0.5 + rng() * 0.15 }));
    if (H >= 8) for (const e of extra.slice(0, H >= 16 ? 3 : 2)) lumps.push({ x: cx + Math.cos(e.a) * r * e.d, y: cy - Math.sin(e.a) * r * e.d, r: r * e.r });
    for (let y = 0; y < canopyH; y++) {
      for (let x = 0; x < W; x++) {
        if (!lumps.some((l) => Math.hypot(x - l.x, y - l.y) <= l.r + 0.25)) continue;
        put(s, x, y, (x - cx) * 0.8 + (y - cy) * 0.6 > r * 0.2 ? SHADE : PAPER);
      }
    }
  }
  outline(s, false);
  if (!conifer && H >= 10) {
    for (let y = 0; y < canopyH; y++) {
      for (let x = 0; x < W; x++) {
        const v = get(s, x, y);
        if ((v === PAPER || v === SHADE) && hash(x, y, variant) < 0.07) put(s, x, y, INK);
      }
    }
  }
  const tw = H >= 18 ? 3 : 1;
  for (let y = canopyH; y < H; y++) for (let x = Math.round(cx - (tw - 1) / 2); x < Math.round(cx - (tw - 1) / 2) + tw; x++) put(s, x, y, INK);
  return s;
}

/** Shapes a vegetation area can be filled with. */
export type PlantShape = 'round' | 'cone' | 'jungle' | 'shrub' | 'grass';

/**
 * One plant for packing into a vegetation mass, `w` × `h` pixels: round broadleaf crowns, tiered
 * conifers, lumpy jungle canopy, low shrubs, or ink grass tufts. Lit top-left, shaded bottom-right.
 */
export function plantSprite(shape: PlantShape, width: number, height: number, variant: number, outlined = true): IndexSprite {
  const H = Math.max(2, Math.min(80, Math.round(height)));
  const W = odd(Math.max(2, Math.min(96, Math.round(width))));
  const rng = mulberry32(variant * 48271 + 11);
  const s = blank(W, H);
  const cx = (W - 1) / 2;

  if (shape === 'grass') {
    // A tuft of 3–5 blades fanning out from the base.
    // Blades start a little apart and fan outwards, so even tiny tufts read as "|/".
    const blades = 3 + Math.floor(rng() * 2);
    for (let b = 0; b < blades; b++) {
      const rel = (b / (blades - 1)) * 2 - 1;
      const base = cx + rel * (W - 1) * 0.2, tip = cx + rel * (W - 1) * 0.5;
      const tall = Math.max(2, Math.round(H * (rel === 0 ? 1 : 0.6 + rng() * 0.3)));
      for (let k = 0; k < tall; k++) put(s, Math.round(base + ((tip - base) * k) / Math.max(1, tall - 1)), H - 1 - k, INK);
    }
    return s;
  }

  if (shape === 'cone') {
    const tiers = H >= 16 ? 3 : H >= 8 ? 2 : 1;
    for (let y = 0; y < H; y++) {
      const t = (y + 1) / H;
      const local = (t * tiers) % 1 || 1;
      const half = (W / 2) * Math.min(1, t * 1.08) * (tiers > 1 ? 0.68 + 0.32 * local : 1);
      for (let x = 0; x < W; x++) if (Math.abs(x - cx) <= half - 0.25) put(s, x, y, x > cx + (y - H) * 0.05 ? SHADE : PAPER);
    }
  } else {
    // Round family: crowns built from overlapping circles (one for broadleaf, several for jungle).
    const blobs: { x: number; y: number; r: number }[] = [];
    const rx = W / 2, ry = H / 2;
    if (shape === 'jungle') {
      const n = 4 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rng();
        blobs.push({ x: cx + Math.cos(a) * rx * 0.42, y: ry + Math.sin(a) * ry * 0.38 - ry * 0.05, r: 0.5 + rng() * 0.12 });
      }
      blobs.push({ x: cx, y: ry * 0.85, r: 0.62 });
    } else {
      blobs.push({ x: cx, y: (H - 1) / 2, r: 1 });
    }
    const lumps = 5 + Math.floor(rng() * 3), phase = rng() * Math.PI * 2;
    const flatBottom = shape === 'shrub';
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let inside = false;
        for (const b of blobs) {
          const dx = (x - b.x) / (rx * b.r), dy = (y - b.y) / (ry * b.r);
          if (flatBottom && y > b.y) {
            if (Math.abs(dx) <= 1) inside = true;
            continue;
          }
          const edge = H >= 7 ? 0.9 + 0.1 * Math.sin(Math.atan2(dy, dx) * lumps + phase) : 1;
          if (Math.hypot(dx, dy) <= edge + 0.05) inside = true;
        }
        if (!inside) continue;
        const ldx = (x - cx) / rx, ldy = (y - (H - 1) / 2) / ry;
        put(s, x, y, ldx * 0.7 + ldy * 0.7 > (outlined ? 0.15 : 0.45) ? SHADE : PAPER);
      }
    }
  }
  if (outlined) outline(s, false);
  return s;
}

export interface Stamp {
  sprite: IndexSprite;
  /** Top-left corner in the group's pixel grid. */
  x: number;
  y: number;
}

/**
 * Merge many un-outlined shapes (canopies, peaks) into one mass. Stamps go back to front; ink is
 * added only on the outer silhouette and where a nearer shape overlaps one behind it, so the
 * result reads as a single grouped forest or range rather than separate icons. With `ground`
 * the bottom edge stays open (mountains stand on the land). `mask` (1 = allowed) clips it, e.g.
 * to the coastline.
 */
export function composeGroup(w: number, h: number, stamps: Stamp[], ground: boolean, mask?: Uint8Array, sideLines = true): IndexSprite {
  const out = blank(w, h);
  const owner = new Int32Array(w * h).fill(-1);
  stamps.forEach((st, k) => {
    const sp = st.sprite;
    for (let sy = 0; sy < sp.h; sy++) {
      const Y = st.y + sy;
      if (Y < 0 || Y >= h) continue;
      for (let sx = 0; sx < sp.w; sx++) {
        const v = sp.px[sy * sp.w + sx];
        const X = st.x + sx;
        if (v === EMPTY || X < 0 || X >= w) continue;
        const i = Y * w + X;
        if (mask && !mask[i]) continue;
        out.px[i] = v;
        owner[i] = k;
      }
    }
  });
  const ownerAt = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : owner[y * w + x]);
  const res = out.px.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const me = owner[i];
      if (me < 0 || out.px[i] === INK) continue;
      const up = ownerAt(x, y - 1), left = ownerAt(x - 1, y), right = ownerAt(x + 1, y), down = ownerAt(x, y + 1);
      const exposed = up < 0 || left < 0 || right < 0 || (!ground && down < 0);
      const overBehind = (up >= 0 && up < me) || (sideLines && ((left >= 0 && left < me) || (right >= 0 && right < me)));
      if (exposed || overBehind) res[i] = INK;
    }
  }
  out.px = res;
  return out;
}

/** Stable per-cell noise in [0, 1) for procedural placement. */
export function cellHash(a: number, b: number, c: number): number {
  return hash(a, b, c);
}

/** Palette indices → RGBA. `palette[i]` is [r, g, b, a] for index i (index 0 is ignored). */
export function colorize(s: IndexSprite, palette: number[][]): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(s.w * s.h * 4);
  for (let i = 0; i < s.px.length; i++) {
    const v = s.px[i];
    if (v === EMPTY) continue;
    out.set(palette[v], i * 4);
  }
  return out;
}
