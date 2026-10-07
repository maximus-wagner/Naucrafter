import { describe, expect, it } from 'vitest';
import { geoContains } from 'd3-geo';
import type { Polygon } from 'geojson';
import { layoutElements, MAX_ELEMENTS } from '../src/doc/regionLayout';
import { fromLonLat, lineToLonLat, toLonLat, type LonLat } from '../src/vector/geo';

const ringOf = (pts: LonLat[]) => pts.flatMap((p) => fromLonLat(p));
const ellipse = (rx: number, ry: number, n = 120): LonLat[] => Array.from({ length: n }, (_, i) => [rx * Math.cos((i / n) * 2 * Math.PI), ry * Math.sin((i / n) * 2 * Math.PI)]);

describe('region layout', () => {
  it('a round blob is one element', () => {
    expect(layoutElements(ringOf(ellipse(8, 8))).length).toBe(1);
  });

  it('a long, thin range becomes a chain of several elements', () => {
    const n = layoutElements(ringOf(ellipse(25, 3))).length;
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThanOrEqual(MAX_ELEMENTS);
  });

  it('an intricate outline never exceeds the cap, and every element sits inside it', () => {
    const star: LonLat[] = Array.from({ length: 200 }, (_, i) => {
      const a = (i / 200) * 2 * Math.PI, r = 10 + 6 * Math.sin(a * 9);
      return [r * Math.cos(a), r * Math.sin(a)];
    });
    const ring = ringOf(star);
    const els = layoutElements(ring);
    expect(els.length).toBeGreaterThan(1);
    expect(els.length).toBeLessThanOrEqual(MAX_ELEMENTS);
    const coords = lineToLonLat(ring);
    coords.push(coords[0]);
    const poly: Polygon = { type: 'Polygon', coordinates: [coords.reverse()] };
    for (const e of els) expect(geoContains(poly, toLonLat(...e.at))).toBe(true);
  });

  it('is independent of where on the planet the shape is', () => {
    const shifted = ellipse(25, 3).map(([x, y]): LonLat => [x + 120, y + 40]);
    expect(layoutElements(ringOf(shifted)).length).toBe(layoutElements(ringOf(ellipse(25, 3))).length);
  });
});

describe('neighbours shape the layout', () => {
  it('a river through a round forest splits it into elements on both banks', () => {
    const ring = ringOf(ellipse(8, 8));
    const river = { pts: ringOf([[-12, 0], [0, 0.3], [12, 0]]), halfWidth: 0.02 };
    const els = layoutElements(ring, 20, { lines: [river] });
    expect(els.length).toBeGreaterThanOrEqual(2);
    const lats = els.map((e) => toLonLat(...e.at)[1]);
    expect(Math.min(...lats)).toBeLessThan(0);
    expect(Math.max(...lats)).toBeGreaterThan(0);
  });

  it('an area covering the region leaves nothing to place', () => {
    expect(layoutElements(ringOf(ellipse(5, 5)), 20, { areas: [ringOf(ellipse(10, 10))] }).length).toBe(0);
  });
});
