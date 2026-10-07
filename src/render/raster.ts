import { nearestCell, type SphereMesh } from '../world/sphereMesh';
import type { World } from '../world/world';
import { cellColor, HYPSO, hypsoIndex, type Layer } from './colors';

/** Per-pixel triangle + barycentric weights for an equirectangular image of the sphere. */
export interface RasterLookup {
  w: number;
  h: number;
  mesh: SphereMesh;
  tri: Int32Array;
  /** Two weights per pixel (third = 1 − w0 − w1), for the triangle's vertices in order. */
  wts: Float32Array;
}

export function buildLookup(mesh: SphereMesh, W: number, H: number): RasterLookup {
  const { xyz, triangles: T, triOffset, cellTris } = mesh;
  const tri = new Int32Array(W * H);
  const wts = new Float32Array(W * H * 2);
  let cell = 0;
  for (let py = 0; py < H; py++) {
    const lat = Math.PI / 2 - ((py + 0.5) / H) * Math.PI;
    const cl = Math.cos(lat), y = Math.sin(lat);
    for (let px = 0; px < W; px++) {
      const lon = -Math.PI + ((px + 0.5) / W) * 2 * Math.PI;
      const x = cl * Math.sin(lon), z = cl * Math.cos(lon);
      cell = nearestCell(mesh, x, y, z, cell);
      // The containing triangle is incident to the nearest cell. For an outward CCW triangle (a,b,c),
      // d·(b×c), d·(c×a), d·(a×b) are all ≥ 0 iff d is inside, and proportional to barycentrics.
      let bestT = 0, bestMin = -Infinity, b0 = 1, b1 = 0, b2 = 0;
      for (let k = triOffset[cell]; k < triOffset[cell + 1]; k++) {
        const t = cellTris[k];
        const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
        const wa = triple(x, y, z, xyz[b], xyz[b + 1], xyz[b + 2], xyz[c], xyz[c + 1], xyz[c + 2]);
        const wb = triple(x, y, z, xyz[c], xyz[c + 1], xyz[c + 2], xyz[a], xyz[a + 1], xyz[a + 2]);
        const wc = triple(x, y, z, xyz[a], xyz[a + 1], xyz[a + 2], xyz[b], xyz[b + 1], xyz[b + 2]);
        const m = Math.min(wa, wb, wc);
        if (m > bestMin) {
          bestMin = m;
          bestT = t;
          b0 = Math.max(0, wa); b1 = Math.max(0, wb); b2 = Math.max(0, wc);
          if (m >= 0) break;
        }
      }
      const sum = b0 + b1 + b2 || 1;
      const p = py * W + px;
      tri[p] = bestT;
      wts[p * 2] = b0 / sum;
      wts[p * 2 + 1] = b1 / sum;
    }
  }
  return { w: W, h: H, mesh, tri, wts };
}

function triple(dx: number, dy: number, dz: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  return dx * (by * cz - bz * cy) + dy * (bz * cx - bx * cz) + dz * (bx * cy - by * cx);
}

/** Smoothly interpolated elevation (m) per pixel. */
export function elevationRaster(world: World, lk: RasterLookup): Float32Array {
  const T = world.mesh.triangles, E = world.elevation;
  const out = new Float32Array(lk.w * lk.h);
  for (let p = 0; p < out.length; p++) {
    const t = lk.tri[p] * 3, w0 = lk.wts[p * 2], w1 = lk.wts[p * 2 + 1];
    out[p] = w0 * E[T[t]] + w1 * E[T[t + 1]] + (1 - w0 - w1) * E[T[t + 2]];
  }
  return out;
}

/** Render a layer into RGBA pixels. `relief` scales hillshading in the elevation layer. */
export function renderRaster(world: World, layer: Layer, lk: RasterLookup, out: Uint8ClampedArray, relief: number): void {
  const { w: W, h: H, tri, wts } = lk;

  if (layer === 'elevation') {
    const E = elevationRaster(world, lk);
    const sea = world.params.seaLevel;
    const dLon = (2 * Math.PI) / W, dLat = Math.PI / H;
    const k = relief / 120000;
    for (let py = 0; py < H; py++) {
      const lat = Math.PI / 2 - (py + 0.5) * dLat;
      const cosL = Math.max(0.05, Math.cos(lat));
      const row = py * W, up = Math.max(0, py - 1) * W, down = Math.min(H - 1, py + 1) * W;
      for (let px = 0; px < W; px++) {
        const xl = px === 0 ? W - 1 : px - 1, xr = px === W - 1 ? 0 : px + 1;
        const h = E[row + px] - sea;
        const gEast = (E[row + xr] - E[row + xl]) / (2 * dLon * cosL);
        const gNorth = (E[up + px] - E[down + px]) / (2 * dLat);
        // Light from the north-west: slopes facing it (rising to the south-east) are brightened.
        const lit = 0.7071 * (gEast - gNorth) * k * (h < 0 ? 0.25 : 1);
        const shade = 1 + (lit < -0.55 ? -0.55 : lit > 0.55 ? 0.55 : lit);
        const c = hypsoIndex(h), o = (row + px) * 4;
        out[o] = HYPSO[c] * shade;
        out[o + 1] = HYPSO[c + 1] * shade;
        out[o + 2] = HYPSO[c + 2] * shade;
        out[o + 3] = 255;
      }
    }
    return;
  }

  const T = world.mesh.triangles, plateOf = world.plates.plateOf;
  const rgb = [0, 0, 0];
  const borderShade = layer === 'plates' ? 0.35 : layer === 'crust' ? 0.7 : 1;
  for (let p = 0; p < W * H; p++) {
    const t = tri[p] * 3, a = T[t], b = T[t + 1], c = T[t + 2];
    const w0 = wts[p * 2], w1 = wts[p * 2 + 1], w2 = 1 - w0 - w1;
    const v = w0 >= w1 && w0 >= w2 ? a : w1 >= w2 ? b : c;
    cellColor(world, layer, v, rgb);
    const f = plateOf[a] !== plateOf[b] || plateOf[b] !== plateOf[c] ? borderShade : 1;
    const o = p * 4;
    out[o] = rgb[0] * f;
    out[o + 1] = rgb[1] * f;
    out[o + 2] = rgb[2] * f;
    out[o + 3] = 255;
  }
}
