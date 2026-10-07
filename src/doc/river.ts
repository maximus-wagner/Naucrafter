import type { Vec3 } from '../core/math';
import type { RiverSection, VPath } from './model';
import { angle, bezier, roughen, segmentControls, segmentCount, unit } from './geometry';

export interface RiverGeometry {
  /** Main channel, source to mouth (flat xyz). */
  main: number[];
  /** Side channels (chutes, braids), drawn thinner (flat xyz each). */
  side: number[][];
  /** Oxbow lakes: closed rings (flat xyz). */
  lakes: number[][];
  /** Rapids: little cross strokes, two points each (flat xyz, 6 numbers). */
  ticks: number[][];
}

export const RIVER_SECTIONS: [RiverSection, string][] = [
  ['plain', 'Plain'],
  ['meander', 'Bends (meanders)'],
  ['oxbow', 'Oxbow lakes'],
  ['chute', 'Chutes'],
  ['braided', 'Braided'],
  ['rapids', 'Rapids'],
];

interface Sample {
  p: Vec3;
  /** Left normal in the tangent plane. */
  n: Vec3;
  s: number;
}

function offset(a: Sample, d: number): Vec3 {
  return unit(a.p[0] + a.n[0] * d, a.p[1] + a.n[1] * d, a.p[2] + a.n[2] * d);
}

/** Sample one Bézier segment finely, with arc length and left normals. */
function sampleSegment(path: VPath, i: number, step: number): Sample[] {
  const [p0, c0, c1, p1] = segmentControls(path, i);
  const len = angle(p0, c0) + angle(c0, c1) + angle(c1, p1);
  const n = Math.max(8, Math.min(800, Math.ceil(len / step)));
  const pts: Vec3[] = [];
  for (let k = 0; k <= n; k++) pts.push(bezier(p0, c0, c1, p1, k / n));
  let s = 0;
  return pts.map((p, k) => {
    if (k > 0) s += angle(pts[k - 1], p);
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n, k + 1)];
    const t: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    return { p, n: unit(p[1] * t[2] - p[2] * t[1], p[2] * t[0] - p[0] * t[2], p[0] * t[1] - p[1] * t[0]), s };
  });
}

/**
 * Build a river's drawing from its path. Each stretch (node to next node) has a section kind:
 * bends meander with a wavelength tied to the river's width, oxbows leave crescent lakes beside
 * the bends, chutes cut straight across them, braids split and rejoin, rapids zig-zag with cross
 * strokes. Where `inMountains` says a point is in a range, plain and bending stretches straighten
 * and get rapids — rivers run fast through mountains.
 */
export function riverGeometry(path: VPath, widthRad: number, rough: number, seed: string, inMountains?: (p: Vec3) => boolean): RiverGeometry {
  const out: RiverGeometry = { main: [], side: [], lakes: [], ticks: [] };
  const w = Math.max(widthRad, 1e-5);
  const segs = segmentCount(path);
  for (let i = 0; i < segs; i++) {
    const section = path.nodes[i].section ?? 'plain';
    const samples = sampleSegment(path, i, w * 0.5);
    const L = samples[samples.length - 1].s || 1e-9;
    const waves = Math.max(1, Math.round(L / (w * 16)));
    const lambda = L / waves;
    const A = lambda * 0.3;
    const win = (s: number) => Math.pow(Math.sin((Math.PI * s) / L), 0.6);
    const mountain = samples.map((a) => !!inMountains?.(a.p));

    const main = samples.map((a, k) => {
      const calm = mountain[k] ? 0.2 : 1;
      const wave = Math.sin((2 * Math.PI * a.s) / lambda);
      switch (section) {
        case 'meander':
        case 'chute':
          return offset(a, A * win(a.s) * wave * calm);
        case 'oxbow':
          return offset(a, A * 0.55 * win(a.s) * wave * calm);
        case 'braided':
          return offset(a, A * 0.15 * win(a.s) * Math.sin((2 * Math.PI * a.s) / (lambda * 0.6)));
        case 'rapids':
          return offset(a, w * 0.5 * win(a.s) * Math.sin((2 * Math.PI * a.s) / (w * 5)));
        default:
          return a.p;
      }
    });
    for (let k = i === 0 ? 0 : 1; k < main.length; k++) out.main.push(...main[k]);

    if (section === 'chute') out.side.push(samples.flatMap((a) => a.p));
    if (section === 'braided') {
      for (const sign of [1, -1]) {
        out.side.push(samples.flatMap((a) => offset(a, sign * w * 2.4 * win(a.s) * (0.8 + 0.3 * Math.sin((2 * Math.PI * a.s) / (lambda * 0.7) + sign)))));
      }
    }
    if (section === 'oxbow') {
      // A crescent lake beyond every other bend: the old loop the river has abandoned.
      // Bend crests sit at (c/2 + 1/4)·λ, alternating sides; keep every third so lakes vary in side.
      for (let c = 0; c < waves * 2; c++) {
        if (c % 3 !== 1 && waves > 1) continue;
        const sc = (c / 2 + 0.25) * lambda;
        if (sc < lambda * 0.2 || sc > L - lambda * 0.2) continue;
        const sign = c % 2 === 0 ? 1 : -1;
        const span = lambda * 0.22;
        const at = (s: number) => samples[Math.max(0, Math.min(samples.length - 1, samples.findIndex((a) => a.s >= s)))];
        const upper: number[] = [], lower: number[] = [];
        for (let u = -1; u <= 1.0001; u += 0.1) {
          const a = at(sc + u * span);
          const mid = sign * A * (0.75 + 0.55 * (1 - u * u));
          const half = w * 0.9 * Math.sqrt(Math.max(0, 1 - u * u)) + w * 0.15;
          upper.push(...offset(a, mid + half));
          lower.unshift(...offset(a, mid - half));
        }
        out.lakes.push([...upper, ...lower]);
      }
    }
    // Rapids: cross strokes along the stretch (and wherever it runs through mountains).
    let next = 0;
    samples.forEach((a, k) => {
      if (section !== 'rapids' && !mountain[k]) return;
      if (a.s < next || a.s < w || a.s > L - w) return;
      next = a.s + w * 3;
      const c = main[k];
      out.ticks.push([...offset({ ...a, p: c }, w * 1.3), ...offset({ ...a, p: c }, -w * 1.3)]);
    });
  }
  out.main = roughen(out.main, false, rough * 0.2, seed);
  return out;
}
