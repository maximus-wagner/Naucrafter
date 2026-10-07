import { mulberry32 } from '../core/rng';
import { cellHash } from './procedural';

/**
 * Stylised pixel-art trees for vegetation masses. Pure geometry and shading (no canvas): a tree is
 * a small cached sprite of brightness values, and `sampleTree` reads it. The caller maps the
 * brightness onto a colour ramp, so the same trees work in every map style.
 *
 * Broadleaf crowns are shaded as ONE form (a shadow crescent below, a highlight cap on the lit
 * side) with their texture made of many small leaf clumps separated by dark creases, on an
 * irregular body with a flattened underside and a visible trunk — not a bunch of shaded balls.
 * Conifers are stacks of branch layers: a drooping zig-zag hem, light / mid / dark bands, a shadow
 * cast by the layer above and a dark row under each hem.
 */

export type TreeShape = 'round' | 'cone' | 'jungle' | 'shrub';

/** Returned by `sampleTree` for pixels no tree covers, and for trunk pixels. Otherwise 0–1. */
export const OUTSIDE = -1;
export const TRUNK = -2;
export const TRUNK_LIT = -3;

/** Brightness values of one tree, relative to its crown-centre pixel (`ox`, `oy`). */
export interface TreeSprite {
  w: number;
  h: number;
  ox: number;
  oy: number;
  v: Float32Array;
  /** Rows from the crown centre down to where the trunk meets the ground. */
  footDy: number;
}

export interface Tree {
  /** Crown centre (a pixel centre), art pixels. */
  x: number;
  y: number;
  /** Half-width of a broadleaf crown (quantised); conifers are CONE_HALF of this wide. */
  r: number;
  shape: TreeShape;
  /** Vertical stretch above the centre. */
  tall: number;
  cell: number;
  /** Lightness shift for this tree, about ±0.1. */
  tone: number;
  sprite: TreeSprite;
  /** Where the trunk meets the ground. */
  foot: number;
  /** Pixels the tree, trunk and cast shadow can touch: x0, y0, x1, y1. */
  box: [number, number, number, number];
}

const CONE_HALF = 0.74;
const CONE_TOP = 1.35;
/** Light from the top-left, toward the viewer. */
const LX = -0.5, LY = -0.58, LZ = 0.64;
/** Variants per shape: enough that a wood isn't a field of clones. */
const VARIANTS: Record<TreeShape, number> = { round: 14, cone: 10, jungle: 10, shrub: 10 };

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// ================================================================ broadleaf

interface Lobe {
  x: number;
  y: number;
  r: number;
}

interface Clump {
  x: number;
  y: number;
  rho: number;
  z: number;
}

function buildRound(shape: Exclude<TreeShape, 'cone'>, r: number, variant: number, tall: number): TreeSprite {
  const rng = mulberry32(variant * 7717 + 31 + (shape === 'jungle' ? 1000 : shape === 'shrub' ? 2000 : 0));
  const jungle = shape === 'jungle', shrub = shape === 'shrub';
  const halfW = Math.ceil(1.2 * r) + 1;
  const up = Math.ceil(1.12 * tall * r) + 1;
  const footDy = shrub ? 0.8 * r : 0.98 * r;
  const down = Math.ceil(footDy) + 1;
  const w = 2 * halfW + 1, h = up + down + 1, ox = halfW, oy = up;
  const v = new Float32Array(w * h).fill(OUTSIDE);

  // The body: a few big overlapping masses, wider than tall with a flattened underside.
  const j = () => (rng() - 0.5) * 0.14;
  const body: Lobe[] = [
    { x: j(), y: 0.02 + j(), r: jungle ? 0.76 : 0.7 },
    { x: -0.45 + j(), y: 0.1 + j(), r: 0.55 },
    { x: 0.45 + j(), y: 0.12 + j(), r: 0.53 },
    { x: j(), y: -0.4 + j(), r: 0.55 },
  ];
  if (rng() < 0.5) body.push({ x: -0.22 + j(), y: 0.38, r: 0.34 });
  if (rng() < 0.4) body.push({ x: 0.3 + j(), y: -0.28 + j(), r: 0.36 });
  const unit = (x: number, y: number): [number, number] => [x / r, (y < 0 ? y / tall : y / 0.88) / r];
  const inBody = (x: number, y: number, shrink: number) => {
    const [u, vv] = unit(x, y);
    return body.some((l) => Math.hypot(u - l.x, vv - l.y) <= l.r - shrink);
  };

  // Leaf clumps on a jittered grid: small shaded domes whose union is the scalloped silhouette.
  const clumps: Clump[] = [];
  const cs = Math.max(2.8, Math.min(jungle ? 9 : 7, r * (jungle ? 0.4 : 0.32) + 1));
  if (r >= 5) {
    const n = Math.ceil((1.3 * r) / cs);
    for (let gy = -n; gy <= n; gy++) {
      for (let gx = -n; gx <= n; gx++) {
        const cx = (gx + 0.5 + (rng() - 0.5) * 0.8) * cs, cy = (gy + 0.5 + (rng() - 0.5) * 0.8) * cs;
        const rho = cs * (0.78 + 0.26 * rng());
        if (inBody(cx, cy, (rho * 0.5) / r)) clumps.push({ x: cx, y: cy, rho, z: cy * 0.02 });
      }
    }
  }

  for (let jj = 0; jj < h; jj++) {
    const y = jj - oy;
    for (let ii = 0; ii < w; ii++) {
      const x = ii - ox;
      let inside = false, best = -9, second = -9, nx = 0, ny = 0, nz = 1;
      if (clumps.length) {
        for (const c of clumps) {
          const du = (x - c.x) / c.rho, dv = (y - c.y) / c.rho, d2 = du * du + dv * dv;
          if (d2 >= 1) continue;
          inside = true;
          const hh = Math.sqrt(1 - d2), s = c.z + hh * 0.6;
          if (s > best) {
            second = best;
            best = s;
            nx = du;
            ny = dv;
            nz = hh;
          } else if (s > second) second = s;
        }
      } else inside = inBody(x, y, 0);
      if (!inside && !(clumps.length && inBody(x, y, 0.14))) continue;
      const [u, vv] = unit(x, y);
      // The crown as a whole: an ellipsoid lit from the top-left, with a shadow crescent below
      // and a highlight cap on the lit side.
      const gx = u / 1.05, gy = vv / 0.95, gz = Math.sqrt(Math.max(0.05, 1 - gx * gx - gy * gy));
      const glen = Math.hypot(gx, gy, gz);
      const lamGlobal = (gx * LX + gy * LY + gz * LZ) / glen;
      let lum = 0.5 + 0.6 * (lamGlobal - 0.5);
      lum -= 0.2 * smooth(0.35, 0.85, vv * 0.8 + u * 0.5);
      lum += 0.2 * (1 - smooth(0.15, 0.65, Math.hypot(u + 0.3, vv + 0.35)));
      if (best > -9) {
        // Each clump adds a little of its own lighting, and breaks dark where two meet.
        lum += 0.34 * (nx * LX + ny * LY + nz * LZ - 0.62);
        const diff = best - second;
        if (second > -9 && diff < 0.09) lum -= 0.24 * (1 - diff / 0.09);
      }
      if (r >= 10) lum += (cellHash(x, y, variant) - 0.5) * 0.06;
      v[jj * w + ii] = Math.max(0, Math.min(1, lum));
    }
  }

  // A trunk below the crown, lit on its left.
  if (r >= 6 && !shrub) {
    const wide = r >= 11;
    for (let jj = 0; jj < h; jj++) {
      const y = jj - oy;
      if (y < 0.55 * r || y > footDy) continue;
      const flare = r >= 14 && y > footDy - 2 ? 1 : 0;
      const half = (wide ? 1 : 0) + flare;
      for (let x = -half; x <= half; x++) {
        const i = jj * w + ox + x;
        if (v[i] === OUTSIDE) v[i] = wide && x < 0 ? TRUNK_LIT : TRUNK;
      }
    }
  }
  return { w, h, ox, oy, v, footDy };
}

// ================================================================ conifer

function buildCone(r: number, variant: number, tall: number): TreeSprite {
  const rng = mulberry32(variant * 9173 + 5);
  const wMax = CONE_HALF * r;
  const top = -CONE_TOP * tall * r, bottom = 0.85 * r;
  const H = bottom - top;
  const n = Math.max(2, Math.min(7, (r < 4 ? 2 : r < 8 ? 3 : r < 14 ? 4 : r < 24 ? 5 : 6) + (rng() < 0.3 ? 1 : 0) - (rng() < 0.2 ? 1 : 0)));
  const th = H / (0.62 * (n - 1) + 1), stepY = 0.62 * th;
  const shift = Array.from({ length: n }, () => (rng() - 0.5) * 0.1 * wMax);
  const widen = Array.from({ length: n }, (_, k) => (0.5 + (0.5 * (k + 1)) / n) * (0.92 + 0.16 * rng()));
  const phase = rng();
  const hemAmp = Math.max(1, 0.07 * th);
  const footDy = bottom + 0.2 * r;
  const halfW = Math.ceil(wMax * 1.1) + 1, up = Math.ceil(-top) + 1, down = Math.ceil(footDy) + 1;
  const w = 2 * halfW + 1, h = up + down + 1, ox = halfW, oy = up;
  const v = new Float32Array(w * h).fill(OUTSIDE);
  const tri = (a: number) => Math.abs(2 * (a - Math.floor(a)) - 1);

  for (let jj = 0; jj < h; jj++) {
    const y = jj - oy;
    for (let ii = 0; ii < w; ii++) {
      const x = ii - ox;
      // The lowest layer covering this pixel is the one in front.
      for (let k = n - 1; k >= 0; k--) {
        const yk = top + k * stepY, t = (y - yk) / th;
        if (t < 0) continue;
        const dx = x - shift[k], hwBottom = wMax * widen[k];
        const period = Math.max(3, hwBottom / 2.4);
        const yBot = yk + th + hemAmp * (1 - tri(dx / period + phase));
        if (y > yBot) continue;
        const hw = hwBottom * (0.2 + 0.8 * Math.pow(Math.min(1, t), 0.85));
        if (Math.abs(dx) > hw) continue;
        const s = dx / Math.max(hw, 1);
        // Light on the left, mid in the middle, dark on the right; a stippled seam between them.
        let T = s < -0.3 ? 3 : s < 0.15 ? 2 : 1;
        if (Math.abs(dx + 0.3 * hw) < 0.9) T = 2.5;
        else if (Math.abs(dx - 0.15 * hw) < 0.9) T = 1.5;
        // The layer above shades the top of this one.
        if (k > 0) T -= Math.abs((t - 0.18) * th) < 0.9 ? 0.5 : t < 0.18 ? 1 : 0;
        // A highlight streak down the lit side of each big layer.
        if (r >= 9 && s > -0.75 && s < -0.45 && t > 0.25 && t < 0.55) T = 4;
        const under = yBot - y;
        if (under < 1) T = 0;
        else if (under < 2 && r >= 10) T = Math.min(T, 1);
        v[jj * w + ii] = Math.max(0, Math.min(1, T / 4));
        break;
      }
    }
  }
  if (r >= 6) {
    const wide = r >= 12;
    for (let jj = 0; jj < h; jj++) {
      const y = jj - oy;
      if (y < bottom - 1 || y > footDy) continue;
      for (let x = wide ? -1 : 0; x <= (wide ? 1 : 0); x++) {
        const i = jj * w + ox + x;
        if (v[i] === OUTSIDE) v[i] = wide && x < 0 ? TRUNK_LIT : TRUNK;
      }
    }
  }
  return { w, h, ox, oy, v, footDy };
}

// ================================================================ cache and public API

const sprites = new Map<string, TreeSprite>();

function spriteFor(shape: TreeShape, r: number, variant: number, tall: number): TreeSprite {
  const key = `${shape}|${variant}|${r}|${tall.toFixed(2)}`;
  let s = sprites.get(key);
  if (!s) {
    if (sprites.size > 4000) sprites.clear();
    s = shape === 'cone' ? buildCone(r, variant, tall) : buildRound(shape, r, variant, tall);
    sprites.set(key, s);
  }
  return s;
}

/** Sizes snap to half pixels when small and whole pixels when big, so sprites are shared. */
const quantise = (r: number) => (r < 8 ? Math.round(r * 2) / 2 : Math.round(r));

/** A tree of crown radius about `r` art pixels centred near (x, y). Positions snap to a pixel centre. */
export function makeTree(x: number, y: number, r: number, shape: TreeShape, tall: number, cell: number, tone: number): Tree {
  const cx = Math.floor(x) + 0.5, cy = Math.floor(y) + 0.5;
  const rq = Math.max(1, quantise(r));
  const sprite = spriteFor(shape, rq, cell % VARIANTS[shape], tall);
  const x0 = Math.floor(cx) - sprite.ox, y0 = Math.floor(cy) - sprite.oy;
  const foot = cy + sprite.footDy;
  return {
    x: cx, y: cy, r: rq, shape, tall, cell, tone, sprite, foot,
    // The sprite plus room on the right and below for the cast shadow.
    box: [x0, y0, Math.max(x0 + sprite.w - 1, Math.ceil(cx + 1.3 * rq)), Math.max(y0 + sprite.h - 1, Math.ceil(foot + 0.3 * rq + 1))],
  };
}

/** Ground shadow of a tree as an ellipse: centre x, y and half-sizes. */
export function shadowOf(t: Tree): [number, number, number, number] {
  const w = t.shape === 'cone' ? CONE_HALF : 0.9;
  return [t.x + 0.3 * t.r, t.foot - 0.04 * t.r, w * t.r, 0.26 * t.r];
}

/** Brightness 0–1 of the tree at the pixel centred (px, py), `OUTSIDE`, `TRUNK` or `TRUNK_LIT`. */
export function sampleTree(t: Tree, px: number, py: number): number {
  const s = t.sprite;
  const i = Math.floor(px) - Math.floor(t.x) + s.ox, j = Math.floor(py) - Math.floor(t.y) + s.oy;
  if (i < 0 || j < 0 || i >= s.w || j >= s.h) return OUTSIDE;
  const v = s.v[j * s.w + i];
  return v < 0 ? v : Math.max(0, Math.min(1, v + t.tone));
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
