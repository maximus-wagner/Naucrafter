import { describe, expect, it } from 'vitest';
import { EMPTY, INK, PAPER, SHADE, SNOW, composeGroup, hillSprite, mountainSprite, plantSprite, treeSprite, type IndexSprite } from '../src/pixel/procedural';

const count = (s: IndexSprite, v: number) => s.px.reduce((n, p) => n + (p === v ? 1 : 0), 0);
const filled = (s: IndexSprite) => s.px.length - count(s, EMPTY);

describe.each([
  ['mountain', mountainSprite],
  ['hill', hillSprite],
  ['tree', treeSprite],
] as const)('%s sprites', (_name, make) => {
  it('are drawn at the requested height, with ink outlines', () => {
    for (const h of [4, 9, 20, 40]) {
      const s = make(h, 3);
      expect(s.h).toBe(h);
      expect(s.px.length).toBe(s.w * s.h);
      expect(count(s, INK)).toBeGreaterThan(0);
      expect(filled(s)).toBeGreaterThan(h);
    }
  });

  it('are deterministic per variant and differ between variants', () => {
    expect(make(24, 5).px).toEqual(make(24, 5).px);
    const variants = new Set(Array.from({ length: 8 }, (_, v) => make(24, v).px.join('')));
    expect(variants.size).toBeGreaterThan(3);
  });
});

describe('detail scales with size', () => {
  it('large mountains get snow caps, small ones do not', () => {
    expect(count(mountainSprite(30, 1), SNOW)).toBeGreaterThan(0);
    expect(count(mountainSprite(6, 1), SNOW)).toBe(0);
  });

  it('mountains keep their proportions across sizes', () => {
    const small = mountainSprite(12, 7), big = mountainSprite(36, 7);
    expect(big.w / big.h).toBeCloseTo(small.w / small.h, 0);
  });
});

describe('grouping', () => {
  const square = (n: number, v: number) => ({ w: n, h: n, px: new Uint8Array(n * n).fill(v) });

  it('outlines only the silhouette and where a nearer shape overlaps one behind', () => {
    // Two overlapping 6×6 blocks; the second (front) is drawn lower-right of the first.
    const g = composeGroup(12, 12, [{ sprite: square(6, PAPER), x: 1, y: 1 }, { sprite: square(6, SHADE), x: 4, y: 4 }], false);
    const at = (x: number, y: number) => g.px[y * 12 + x];
    expect(at(1, 1)).toBe(INK); // outer silhouette
    expect(at(3, 3)).toBe(PAPER); // inside the back shape: no line
    expect(at(5, 4)).toBe(INK); // front shape's top edge over the back shape
    expect(at(6, 6)).toBe(SHADE); // inside the front shape
  });

  it('respects a mask and an open ground line', () => {
    const mask = new Uint8Array(100).fill(1);
    for (let i = 0; i < 10; i++) mask[i * 10 + 9] = 0; // last column is "sea"
    const g = composeGroup(10, 10, [{ sprite: square(10, PAPER), x: 0, y: 0 }], true, mask);
    expect(g.px[5 * 10 + 9]).toBe(EMPTY);
    expect(g.px[9 * 10 + 4]).toBe(PAPER); // bottom row stays open
  });
});

describe('plants', () => {
  it.each(['round', 'cone', 'jungle', 'shrub', 'grass'] as const)('%s plants fill their box at the requested size', (shape) => {
    const s = plantSprite(shape, 15, 12, 4);
    expect(s.w).toBe(15);
    expect(s.h).toBe(12);
    expect(count(s, INK)).toBeGreaterThan(0);
  });

  it('taller settings make taller mountains on the same footprint', () => {
    const flat = mountainSprite(20, 2, true, { height: 1 }), tall = mountainSprite(20, 2, true, { height: 2 });
    expect(tall.w).toBeLessThan(flat.w);
  });

  it('snow can be turned off', () => {
    expect(count(mountainSprite(30, 1, true, { snow: 0 }), SNOW)).toBe(0);
  });
});
