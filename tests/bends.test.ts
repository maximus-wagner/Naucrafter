import { describe, expect, it } from 'vitest';
import { arcFractions, circumradius, relaxBends, removeLoops } from '../src/doc/bends';
import { riverGeometry } from '../src/doc/river';
import type { Vec3 } from '../src/core/math';
import type { VPath } from '../src/doc/model';
import { fromLonLat, type LonLat } from '../src/vector/geo';

const D = Math.PI / 180;
const line = (pts: LonLat[]) => pts.flatMap((p) => fromLonLat(p));
const vec = (pts: number[], i: number): Vec3 => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
const radii = (pts: number[]) => Array.from({ length: pts.length / 3 - 2 }, (_, i) => circumradius(vec(pts, i), vec(pts, i + 1), vec(pts, i + 2)));

/** Does any pair of non-adjacent segments cross, in plain lon/lat (fine for small test lines)? */
function selfCrosses(pts: number[]): boolean {
  const q = Array.from({ length: pts.length / 3 }, (_, i) => [Math.atan2(pts[i * 3 + 2], pts[i * 3]), Math.asin(pts[i * 3 + 1])]);
  const side = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < q.length - 1; i++) {
    for (let j = i + 2; j < q.length - 1; j++) {
      if (side(q[i], q[i + 1], q[j]) * side(q[i], q[i + 1], q[j + 1]) < 0 && side(q[j], q[j + 1], q[i]) * side(q[j], q[j + 1], q[i + 1]) < 0) return true;
    }
  }
  return false;
}

describe('bends', () => {
  it('circumradius of points on a circle is its radius', () => {
    const r = 0.1;
    const at = (a: number): Vec3 => [Math.cos(a) * r, Math.sin(a) * r, 0];
    expect(circumradius(at(0), at(0.3), at(0.6))).toBeCloseTo(r, 6);
    expect(circumradius([0, 0, 0], [1, 0, 0], [2, 0, 0])).toBe(Infinity);
  });

  it('opens a sharp corner into a bend no tighter than the limit, keeping both ends', () => {
    const zig = line([[0, 0], [1, 0], [2, 0], [2.02, 0.5], [2.02, 1], [3, 1], [4, 1]].map(([x, y]) => [x * D * 10, y * D * 10] as LonLat));
    const limit = 0.04 * D * 10;
    const out = relaxBends(zig, () => limit);
    expect(vec(out, 0)).toEqual(vec(zig, 0));
    expect(vec(out, out.length / 3 - 1)).toEqual(vec(zig, zig.length / 3 - 1));
    const before = Math.min(...radii(zig));
    expect(before).toBeLessThan(limit);
    expect(Math.min(...radii(out))).toBeGreaterThanOrEqual(limit * 0.999);
  });

  it('leaves a gentle line alone', () => {
    const gentle = line(Array.from({ length: 20 }, (_, i) => [i * 0.2, Math.sin(i * 0.2) * 0.2] as LonLat));
    expect(relaxBends(gentle, () => 0.001 * D)).toEqual(gentle);
  });

  it('cuts out a loop where the line crosses itself', () => {
    // Goes right, loops back across its own path, then carries on right.
    const looped = line([[0, 0], [2, 0], [4, 0], [5, 1], [4, 2], [3, 1], [3, -1], [5, -1], [8, -1]].map(([x, y]) => [x * D, y * D] as LonLat));
    expect(selfCrosses(looped)).toBe(true);
    const out = removeLoops(looped);
    expect(selfCrosses(out)).toBe(false);
    expect(out.length).toBeLessThan(looped.length);
    expect(vec(out, 0)).toEqual(vec(looped, 0));
    expect(vec(out, out.length / 3 - 1)).toEqual(vec(looped, looped.length / 3 - 1));
  });

  it('arc fractions run from 0 to 1', () => {
    const f = arcFractions(line([[0, 0], [1, 0], [3, 0]]));
    expect(f[0]).toBe(0);
    expect(f[1]).toBeCloseTo(1 / 3, 4);
    expect(f[2]).toBe(1);
  });
});

describe('river geometry bends', () => {
  const W = 0.3 * D;
  /** A river drawn with corner nodes in a Z, the way a click-by-click river is. */
  const zigzag = (section: 'plain' | 'meander'): VPath => ({
    closed: false,
    nodes: ([[0, 0], [6, 0], [5.2, 0.6], [6.4, 1.2], [12, 1.2]] as LonLat[]).map((p) => ({ p: fromLonLat(p), hin: null, hout: null, section })),
  });

  it('sharp corners are rounded to the width of the channel', () => {
    for (const section of ['plain', 'meander'] as const) {
      const g = riverGeometry(zigzag(section), W, 0, 's');
      const frac = arcFractions(g.main);
      const r = radii(g.main);
      // Tightest allowed bend is 1.5 half-widths (see river.ts); skip the hairline source.
      for (let i = 0; i < r.length; i++) {
        if (frac[i + 1] < 0.3) continue;
        expect(r[i]).toBeGreaterThanOrEqual(1.5 * 0.5 * 1.6 * W * g.taper[i + 1] * 0.98);
      }
      expect(selfCrosses(g.main)).toBe(false);
    }
  });

  it('has a width for every point, from a trickle to the full mouth width', () => {
    const g = riverGeometry(zigzag('plain'), W, 0, 's');
    expect(g.taper.length).toBe(g.main.length / 3);
    expect(g.taper[0]).toBeCloseTo(0.1, 6);
    expect(g.taper[g.taper.length - 1]).toBeCloseTo(1, 6);
  });
});
