import { describe, expect, it } from 'vitest';
import { OUTSIDE, TRUNK, makeTree, outlineDistance, sampleTree, shadowOf, type TreeShape } from '../src/pixel/canopy';

const SHAPES: TreeShape[] = ['round', 'cone', 'jungle', 'shrub'];

/** All pixels in the tree's box with what sampleTree says about them. */
function raster(t: ReturnType<typeof makeTree>) {
  const out: { x: number; y: number; v: number }[] = [];
  for (let y = t.box[1]; y <= t.box[3]; y++) for (let x = t.box[0]; x <= t.box[2]; x++) out.push({ x, y, v: sampleTree(t, x + 0.5, y + 0.5) });
  return out;
}

describe('canopy trees', () => {
  it('snaps to a pixel centre and is deterministic', () => {
    const a = makeTree(10.2, 20.9, 9, 'round', 1, 1234, 0), b = makeTree(10.2, 20.9, 9, 'round', 1, 1234, 0);
    expect([a.x, a.y]).toEqual([10.5, 20.5]);
    expect(raster(a)).toEqual(raster(b));
  });

  for (const shape of SHAPES) {
    it(`${shape}: brightness stays in 0–1, the box holds the whole tree, and far pixels are empty`, () => {
      for (const r of [3, 8, 16, 40]) {
        const t = makeTree(100, 100, r, shape, 1, 77 + r, 0.05);
        const px = raster(t);
        expect(px.some((p) => p.v >= 0)).toBe(true);
        for (const p of px) if (p.v !== OUTSIDE && p.v !== TRUNK) expect(p.v).toBeGreaterThanOrEqual(0), expect(p.v).toBeLessThanOrEqual(1);
        // Nothing just outside the box is covered.
        for (let x = t.box[0] - 2; x <= t.box[2] + 2; x++) for (const y of [t.box[1] - 1, t.box[3] + 1]) expect(sampleTree(t, x + 0.5, y + 0.5)).toBe(OUTSIDE);
        for (let y = t.box[1] - 2; y <= t.box[3] + 2; y++) for (const x of [t.box[0] - 1, t.box[2] + 1]) expect(sampleTree(t, x + 0.5, y + 0.5)).toBe(OUTSIDE);
      }
    });
  }

  it('a conifer is narrower and taller than a broadleaf of the same radius', () => {
    const extent = (shape: TreeShape) => {
      const t = makeTree(100, 100, 16, shape, 1, 5, 0);
      const px = raster(t).filter((p) => p.v >= 0);
      const xs = px.map((p) => p.x), ys = px.map((p) => p.y);
      return { w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 };
    };
    const cone = extent('cone'), round = extent('round');
    expect(cone.w).toBeLessThan(round.w);
    expect(cone.h / cone.w).toBeGreaterThan(round.h / round.w);
  });

  it('broadleaf crowns are lit from the top-left', () => {
    const t = makeTree(100, 100, 20, 'round', 1, 9, 0);
    const lit = raster(t).filter((p) => p.v >= 0);
    const mean = (f: (p: { x: number; y: number }) => boolean) => {
      const s = lit.filter(f);
      return s.reduce((a, p) => a + p.v, 0) / s.length;
    };
    expect(mean((p) => p.x + p.y < 200 - 6)).toBeGreaterThan(mean((p) => p.x + p.y > 200 + 6));
  });

  it('big trees get a trunk below the crown; small trees and shrubs do not', () => {
    const trunks = (shape: TreeShape, r: number) => raster(makeTree(100, 100, r, shape, 1, 3, 0)).filter((p) => p.v === TRUNK).length;
    expect(trunks('round', 12)).toBeGreaterThan(0);
    expect(trunks('cone', 12)).toBeGreaterThan(0);
    expect(trunks('round', 4)).toBe(0);
    expect(trunks('shrub', 12)).toBe(0);
  });

  it('different cells give different trees', () => {
    const a = raster(makeTree(100, 100, 14, 'round', 1, 1, 0)).map((p) => p.v);
    const b = raster(makeTree(100, 100, 14, 'round', 1, 2, 0)).map((p) => p.v);
    expect(a).not.toEqual(b);
  });

  it('puts the cast shadow down-right of the foot', () => {
    const t = makeTree(100, 100, 12, 'round', 1, 3, 0);
    const [sx, sy] = shadowOf(t);
    expect(sx).toBeGreaterThan(t.x);
    expect(sy).toBeGreaterThan(t.y);
  });
});

describe('outlineDistance', () => {
  // A square on the unit sphere's equator-ish: corners in the +z hemisphere.
  const norm = (v: number[]) => v.map((c) => c / Math.hypot(...v));
  const sq = [...norm([-1, -1, 4]), ...norm([1, -1, 4]), ...norm([1, 1, 4]), ...norm([-1, 1, 4])];

  it('is zero on the outline and grows away from it', () => {
    expect(outlineDistance(sq, sq[0], sq[1], sq[2])).toBeCloseTo(0, 9);
    // The outline is straight chords between its points: the chord midpoint is on it exactly,
    // the sphere point beside it is off by the (tiny) sagitta.
    const chord = [(sq[0] + sq[3]) / 2, (sq[1] + sq[4]) / 2, (sq[2] + sq[5]) / 2];
    expect(outlineDistance(sq, chord[0], chord[1], chord[2])).toBeCloseTo(0, 9);
    const mid = norm([0, -1, 4]);
    expect(outlineDistance(sq, mid[0], mid[1], mid[2])).toBeLessThan(0.04);
    const centre = [0, 0, 1], far = norm([0, 0.8, 2]);
    expect(outlineDistance(sq, far[0], far[1], far[2])).toBeGreaterThan(0.1);
    expect(outlineDistance(sq, centre[0], centre[1], centre[2])).toBeGreaterThan(0.2);
  });
});
