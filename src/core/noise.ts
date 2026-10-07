import { createNoise3D, type NoiseFunction3D } from 'simplex-noise';
import { rngFor } from './rng';

/** Seeded 3D simplex noise with fractal helpers. Sample on the unit sphere scaled by a frequency. */
export class Fbm {
  private noise: NoiseFunction3D;

  constructor(seed: string, purpose: string) {
    this.noise = createNoise3D(rngFor(seed, purpose));
  }

  /** Fractal Brownian motion, roughly in [-1, 1]. */
  fbm(x: number, y: number, z: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * fbm with `extra` finer octaves added on top of `base` ones, normalised as if only `base` were
   * used: the coarse shape stays put and zooming in only adds detail.
   */
  fbmDetail(x: number, y: number, z: number, base: number, extra: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < base + extra; o++) {
      sum += amp * this.noise(x * freq, y * freq, z * freq);
      if (o < base) norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in roughly [0, 1]: sharp crests, good for mountain ranges. */
  ridged(x: number, y: number, z: number, octaves = 5): number {
    let amp = 0.5, freq = 1, sum = 0, norm = 0, prev = 1;
    for (let o = 0; o < octaves; o++) {
      let v = 1 - Math.abs(this.noise(x * freq, y * freq, z * freq));
      v *= v;
      sum += v * amp * prev;
      norm += amp;
      prev = v;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }
}
