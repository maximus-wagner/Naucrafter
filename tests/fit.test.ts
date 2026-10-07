import { describe, expect, it } from 'vitest';
import { fitStroke, type Cubic, type P2 } from '../src/doc/fit';

/** Max distance from the raw stroke points to the fitted curve (sampled). */
function deviation(raw: P2[], segs: Cubic[]): number {
  const samples: P2[] = [];
  for (const s of segs) {
    for (let k = 0; k <= 40; k++) {
      const t = k / 40, u = 1 - t;
      samples.push([
        u * u * u * s.p0[0] + 3 * u * u * t * s.c0[0] + 3 * u * t * t * s.c1[0] + t * t * t * s.p1[0],
        u * u * u * s.p0[1] + 3 * u * u * t * s.c0[1] + 3 * u * t * t * s.c1[1] + t * t * t * s.p1[1],
      ]);
    }
  }
  return Math.max(...raw.map((p) => Math.min(...samples.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))));
}

/** A wobbly hand-drawn stroke: dense samples with a little noise. */
const jitter = (pts: P2[], amount: number, seed = 1): P2[] => {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * amount;
  return pts.map(([x, y]) => [x + r(), y + r()]);
};

describe('fitting hand-drawn strokes', () => {
  it('a drawn circle becomes a few smooth segments that close on themselves', () => {
    const raw = jitter(Array.from({ length: 300 }, (_, i): P2 => [100 * Math.cos((i / 300) * 2 * Math.PI), 100 * Math.sin((i / 300) * 2 * Math.PI)]), 0.8);
    const segs = fitStroke(raw, true, 2.5);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs.length).toBeLessThanOrEqual(10);
    expect(segs.every((s) => !s.corner)).toBe(true);
    expect(segs[segs.length - 1].p1).toEqual(segs[0].p0);
    expect(deviation(raw, segs)).toBeLessThan(5);
  });

  it('a drawn square keeps its four corners', () => {
    const side = (a: P2, b: P2): P2[] => Array.from({ length: 60 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / 60, a[1] + ((b[1] - a[1]) * i) / 60]);
    const raw = [...side([0, 0], [100, 0]), ...side([100, 0], [100, 100]), ...side([100, 100], [0, 100]), ...side([0, 100], [0, 0])];
    const segs = fitStroke(raw, true, 2);
    expect(segs.filter((s) => s.corner).length).toBe(4);
    expect(deviation(raw, segs)).toBeLessThan(5);
  });

  it('an open wiggle follows the stroke with far fewer nodes than samples', () => {
    const raw = jitter(Array.from({ length: 400 }, (_, i): P2 => [i, 40 * Math.sin(i / 40)]), 0.6);
    const segs = fitStroke(raw, false, 2.5);
    expect(segs.length).toBeLessThan(20);
    expect(segs[0].p0[0]).toBeCloseTo(raw[0][0], 0);
    expect(segs[segs.length - 1].p1[0]).toBeCloseTo(raw[raw.length - 1][0], 0);
    expect(deviation(raw, segs)).toBeLessThan(5);
  });

  it('handles tiny strokes without crashing', () => {
    expect(fitStroke([[0, 0]], false, 2)).toEqual([]);
    expect(fitStroke([[0, 0], [1, 1]], false, 2).length).toBeLessThanOrEqual(1);
  });
});
