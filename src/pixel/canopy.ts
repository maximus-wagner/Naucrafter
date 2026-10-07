import { cellHash } from './procedural';

/**
 * Pixel-art trees for vegetation masses. Pure geometry and shading (no canvas): `sampleTree` says,
 * for one art pixel, whether a tree covers it and how brightly it is lit. The caller maps the
 * brightness onto a colour ramp, so the same trees work in every map style.
 *
 * Broadleaf crowns are clusters of domed lobes. The surface is the highest dome at each pixel and
 * its normal is lit from the top-left, so shading follows the lumps and the seams between lobes
 * darken by themselves. Conifers are stacks of ragged skirts, each shadowed by the one above.
 */

export type TreeShape = 'round' | 'cone' | 'jungle';

/** Returned by `sampleTree` for pixels no tree covers, and for trunk pixels. Otherwise 0–1. */
export const OUTSIDE = -1;
export const TRUNK = -2;

interface Lobe {
  x: number;
  y: number;
  r: number;
  /** Depth bias: lobes lower on the crown stand in front of the ones above. */
  z: number;
}

export interface Tree {
  /** Crown centre (a pixel centre), art pixels. */
  x: number;
  y: number;
  /** Half-width of a broadleaf crown; conifers are 0.74 of this wide. */
  r: number;
  shape: TreeShape;
  /** Vertical stretch above the centre. */
  tall: number;
  cell: number;
  /** Lightness shift for this tree, about ±0.1. */
  tone: number;
  lobes: Lobe[];
  tiers: number;
  /** Where the trunk meets the ground. */
  foot: number;
  /** Pixels the tree, trunk and cast shadow can touch: x0, y0, x1, y1. */
  box: [number, number, number, number];
}

const SQUASH = 0.92;
const CONE_HALF = 0.74;
const CONE_TOP = 1.35;
/** Light from the top-left, toward the viewer. */
const LX = -0.5, LY = -0.58, LZ = 0.64;

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function lobesFor(cell: number, shape: 'round' | 'jungle', r: number): Lobe[] {
  const h = (k: number, s: number) => cellHash(cell, k, s);
  const jungle = shape === 'jungle';
  const lobes: Lobe[] = [{ x: (h(0, 31) - 0.5) * 0.12, y: 0.02 + (h(1, 31) - 0.5) * 0.1, r: jungle ? 0.7 : 0.66, z: 0 }];
  const n = (jungle ? 6 : 5) + Math.floor(h(2, 31) * 2);
  const a0 = h(3, 31) * Math.PI * 2;
  for (let k = 0; k < n; k++) {
    const a = a0 + ((k + (h(k, 33) - 0.5) * 0.6) / n) * Math.PI * 2;
    const rho = 0.5 + h(k, 35) * 0.14;
    const x = Math.cos(a) * rho, y = Math.sin(a) * rho * 0.82 + 0.05;
    lobes.push({ x, y, r: 0.4 + h(k, 37) * 0.14, z: y * 0.28 });
  }
  // Leaf clusters on top of the crown: appear only once the tree is big enough to show them.
  const extra = r >= 10 ? Math.min(8, Math.floor((r - 6) / 3)) : 0;
  for (let k = 0; k < extra; k++) {
    const a = h(k, 41) * Math.PI * 2, d = Math.sqrt(h(k, 43)) * 0.7;
    const y = Math.sin(a) * d * 0.8;
    lobes.push({ x: Math.cos(a) * d, y, r: 0.2 + h(k, 45) * 0.12, z: y * 0.28 + 0.13 });
  }
  return lobes;
}

/** A tree of crown radius `r` art pixels centred near (x, y). Positions snap to a pixel centre. */
export function makeTree(x: number, y: number, r: number, shape: TreeShape, tall: number, cell: number, tone: number): Tree {
  const cx = Math.floor(x) + 0.5, cy = Math.floor(y) + 0.5;
  const cone = shape === 'cone';
  const tiers = cone ? Math.min(6, (r < 4 ? 2 : r < 8 ? 3 : r < 14 ? 4 : 5) + (cellHash(cell, 51, 5) < 0.3 ? 1 : 0)) : 0;
  const reach = cone ? CONE_HALF : 1;
  const top = cone ? CONE_TOP * tall : 1.05 * tall;
  const foot = cy + 0.95 * r;
  return {
    x: cx, y: cy, r, shape, tall, cell, tone,
    lobes: cone ? [] : lobesFor(cell, shape as 'round' | 'jungle', r),
    tiers, foot,
    box: [Math.floor(cx - (reach + 0.05) * r - 1), Math.floor(cy - top * r - 1), Math.ceil(cx + (reach + 0.45) * r + 1), Math.ceil(foot + 0.3 * r + 1)],
  };
}

/** Ground shadow of a tree as an ellipse: centre x, y and half-sizes. */
export function shadowOf(t: Tree): [number, number, number, number] {
  const w = t.shape === 'cone' ? CONE_HALF : 0.9;
  return [t.x + 0.3 * t.r, t.foot - 0.04 * t.r, w * t.r, 0.26 * t.r];
}

function leafNoise(t: Tree, px: number, py: number): number {
  const xi = Math.floor(px), yi = Math.floor(py), c = t.cell & 0xff;
  return (cellHash(xi, yi, c) - 0.5) * 0.1 + (cellHash(xi >> 1, yi >> 1, c + 7) - 0.5) * 0.12;
}

function roundLum(t: Tree, dx: number, dy: number, px: number, py: number): number {
  const u = dx / t.r;
  let v = dy / t.r;
  const vt = v < 0 ? v / t.tall : v;
  let best = -9, second = -9, nx = 0, ny = 0, nz = 1;
  for (const l of t.lobes) {
    const du = (u - l.x) / l.r, dv = (vt - l.y) / (l.r * SQUASH), d2 = du * du + dv * dv;
    if (d2 >= 1) continue;
    const hh = Math.sqrt(1 - d2), s = l.z + l.r * hh;
    if (s > best) {
      second = best;
      best = s;
      nx = du;
      ny = dv;
      nz = hh;
    } else if (s > second) second = s;
  }
  if (best === -9) {
    const trunk = t.r >= 12 ? 1.1 : 0.6;
    return t.r >= 6 && v > 0.7 && v < 1.0 && Math.abs(dx) < trunk ? TRUNK : OUTSIDE;
  }
  v = vt;
  let lum = 0.5 + (nx * LX + ny * LY + nz * LZ - 0.55) * 0.95;
  lum -= 0.22 * smooth(0, 1, v);
  const diff = best - second;
  if (second > -9 && diff < 0.1) lum -= 0.3 * (1 - diff / 0.1);
  if (t.r >= 5) lum += leafNoise(t, px, py);
  return Math.max(0, Math.min(1, lum + t.tone));
}

function coneLum(t: Tree, dx: number, dy: number, px: number, py: number): number {
  const w = CONE_HALF * t.r;
  const uc = dx / w, v = dy / t.r;
  const top = -CONE_TOP * t.tall, bottom = 0.85;
  const T = (v - top) / (bottom - top);
  const n = t.tiers, len = 2 / (n + 1), step = n > 1 ? (1 - len) / (n - 1) : 0;
  const heightPx = (bottom - top) * t.r;
  const rowJitter = (k: number) => (cellHash(Math.floor(py), t.cell & 0xff, 60 + k) - 0.5) * 0.14;
  for (let k = n - 1; k >= 0; k--) {
    const wk = 0.5 + (n > 1 ? 0.5 * (k / (n - 1)) : 0.5);
    const au = Math.abs(uc);
    const a = k * step;
    // Each skirt droops a little at its outer ends.
    const bottomT = a + len + 0.035 * Math.min(1, au / wk) ** 2;
    const tt = (T - a) / (bottomT - a);
    if (tt < 0 || tt > 1) continue;
    const hw = wk * (0.2 + 0.8 * tt ** 0.85) * (1 + rowJitter(k));
    if (au > hw) continue;
    let lum = 0.55 - 0.42 * (uc / Math.max(hw, 0.2));
    if (k > 0) lum -= 0.4 * (1 - smooth(0, 0.3, tt));
    const under = (bottomT - T) * heightPx;
    if (t.r >= 7 && under < 1) return Math.max(0, 0.04 + t.tone * 0.3);
    if (t.r >= 4 && under < 2) lum -= 0.22;
    if (t.r >= 5) lum += leafNoise(t, px, py) * 0.8;
    return Math.max(0, Math.min(1, lum + t.tone));
  }
  const trunk = t.r >= 12 ? 1.1 : 0.6;
  return t.r >= 6 && v > 0.8 && v < 1.0 && Math.abs(dx) < trunk ? TRUNK : OUTSIDE;
}

/** Brightness 0–1 of the tree at the pixel centred (px, py), `OUTSIDE`, or `TRUNK`. */
export function sampleTree(t: Tree, px: number, py: number): number {
  const dx = px - t.x, dy = py - t.y;
  return t.shape === 'cone' ? coneLum(t, dx, dy, px, py) : roundLum(t, dx, dy, px, py);
}

/**
 * Distance from the unit-sphere point `v` to the closed outline `pts` (flat xyz), as a chord
 * length (≈ radians for small distances). Used to thin out and shrink trees towards a forest edge.
 */
export function outlineDistance(pts: number[], vx: number, vy: number, vz: number): number {
  let best = Infinity;
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[i * 3], ay = pts[i * 3 + 1], az = pts[i * 3 + 2];
    const ex = pts[j * 3] - ax, ey = pts[j * 3 + 1] - ay, ez = pts[j * 3 + 2] - az;
    const len2 = ex * ex + ey * ey + ez * ez;
    const s = len2 > 0 ? Math.max(0, Math.min(1, ((vx - ax) * ex + (vy - ay) * ey + (vz - az) * ez) / len2)) : 0;
    const d2 = (ax + ex * s - vx) ** 2 + (ay + ey * s - vy) ** 2 + (az + ez * s - vz) ** 2;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}
