import type { World } from '../world/world';
import type { Vec3 } from '../core/math';

export type Layer = 'plates' | 'crust' | 'boundaries' | 'elevation';

export const BOUNDARY_COLORS: Vec3[] = [[0, 0, 0], [226, 74, 58], [64, 150, 236], [236, 196, 64]];
const CONTINENTAL: Vec3 = [204, 178, 126];
const OCEANIC: Vec3 = [46, 86, 146];

type Stop = [height: number, r: number, g: number, b: number];
const OCEAN: Stop[] = [[-9000, 8, 18, 56], [-5000, 18, 44, 106], [-3000, 30, 74, 146], [-1000, 50, 110, 176], [-150, 84, 152, 204], [0, 128, 192, 222]];
const LAND: Stop[] = [[0, 84, 136, 78], [300, 118, 160, 90], [900, 172, 172, 112], [1600, 164, 134, 92], [2600, 128, 104, 86], [3800, 156, 150, 146], [5200, 244, 244, 248]];

const LUT_MIN = -11000, LUT_STEP = 10, LUT_SIZE = 2001;
/** Hypsometric tint, rgb per 10 m from −11 000 m to +9 000 m relative to sea level. */
export const HYPSO = new Uint8Array(LUT_SIZE * 3);
for (let k = 0; k < LUT_SIZE; k++) {
  const h = LUT_MIN + k * LUT_STEP;
  const stops = h < 0 ? OCEAN : LAND;
  let s = 0;
  while (s < stops.length - 2 && h > stops[s + 1][0]) s++;
  const [h0, r0, g0, b0] = stops[s], [h1, r1, g1, b1] = stops[s + 1];
  const t = Math.max(0, Math.min(1, (h - h0) / (h1 - h0)));
  HYPSO[k * 3] = r0 + (r1 - r0) * t;
  HYPSO[k * 3 + 1] = g0 + (g1 - g0) * t;
  HYPSO[k * 3 + 2] = b0 + (b1 - b0) * t;
}

/** Offset into HYPSO for a height relative to sea level. */
export function hypsoIndex(h: number): number {
  const k = Math.floor((h - LUT_MIN) / LUT_STEP);
  return (k < 0 ? 0 : k >= LUT_SIZE ? LUT_SIZE - 1 : k) * 3;
}

/** Colour of one cell in a layer, as 0–255 rgb written into `out`. */
export function cellColor(world: World, layer: Layer, i: number, out: number[]): void {
  const ps = world.plates;
  switch (layer) {
    case 'plates': {
      const c = ps.plates[ps.plateOf[i]].color;
      const f = ps.crust[i] ? 1 : 0.62;
      out[0] = c[0] * f; out[1] = c[1] * f; out[2] = c[2] * f;
      return;
    }
    case 'crust': {
      const c = ps.crust[i] ? CONTINENTAL : OCEANIC;
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
      return;
    }
    case 'boundaries': {
      const t = world.boundaries.type[i];
      if (t) {
        const c = BOUNDARY_COLORS[t];
        out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
        return;
      }
      const c = ps.plates[ps.plateOf[i]].color;
      const f = ps.crust[i] ? 0.5 : 0.32;
      out[0] = (c[0] * 0.4 + 140 * 0.6) * f; out[1] = (c[1] * 0.4 + 140 * 0.6) * f; out[2] = (c[2] * 0.4 + 140 * 0.6) * f;
      return;
    }
    case 'elevation': {
      const k = hypsoIndex(world.elevation[i] - world.params.seaLevel);
      out[0] = HYPSO[k]; out[1] = HYPSO[k + 1]; out[2] = HYPSO[k + 2];
      return;
    }
  }
}
