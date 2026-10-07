import { describe, expect, it } from 'vitest';
import { geoArea, geoCircle } from 'd3-geo';
import { angle, flatten, moveNode, roughen, setSmooth, splitSegment } from '../src/doc/geometry';
import { composeLand } from '../src/doc/land';
import { parseDoc, sampleDoc, serializeDoc } from '../src/doc/io';
import { GeometryCache } from '../src/doc/cache';
import type { VPath } from '../src/doc/model';
import { fromLonLat, type LonLat } from '../src/vector/geo';
import type { Vec3 } from '../src/core/math';

const FULL = 4 * Math.PI;

/** Closed ring (flat xyz) approximating a circle of `radius` degrees. */
function circleRing(center: LonLat, radius: number, reverse = false): number[] {
  const coords = geoCircle().center(center).radius(radius).precision(2)().coordinates[0].slice(0, -1) as LonLat[];
  if (reverse) coords.reverse();
  return coords.flatMap((c) => fromLonLat(c));
}
const capArea = (deg: number) => (2 * Math.PI * (1 - Math.cos((deg * Math.PI) / 180))) / FULL;
const areaOf = (g: unknown) => geoArea(g as Parameters<typeof geoArea>[0]) / FULL;

function squarePath(): VPath {
  const path: VPath = { closed: true, nodes: ([[0, 0], [10, 0], [10, 10], [0, 10]] as LonLat[]).map((p) => ({ p: fromLonLat(p), hin: null, hout: null })) };
  for (let i = 0; i < 4; i++) setSmooth(path, i, true);
  return path;
}

describe('paths', () => {
  it('splitting a segment keeps the curve shape', () => {
    const path = squarePath();
    const before = flatten(path, 0.002).pts;
    splitSegment(path, 1, 0.4);
    expect(path.nodes.length).toBe(5);
    const after = flatten(path, 0.002).pts;
    // Every point of the new curve lies on the old one.
    for (let i = 0; i < after.length; i += 30) {
      const p: Vec3 = [after[i], after[i + 1], after[i + 2]];
      let best = Infinity;
      for (let j = 0; j < before.length; j += 3) best = Math.min(best, angle(p, [before[j], before[j + 1], before[j + 2]]));
      expect(best).toBeLessThan(0.003);
    }
  });

  it('moving a node carries its handles', () => {
    const path = squarePath();
    const n = path.nodes[0];
    const handleDist = angle(n.p, n.hout!);
    moveNode(n, fromLonLat([3, -4]));
    expect(angle(n.p, n.hout!)).toBeCloseTo(handleDist, 6);
  });

  it('roughening is deterministic and local', () => {
    const base = flatten(squarePath(), 0.004).pts;
    const a = roughen(base, true, 1, 'seed');
    expect(roughen(base, true, 1, 'seed')).toEqual(a);
    expect(a.length).toBeGreaterThan(base.length);
    // Displacement stays within a couple of degrees.
    for (let i = 0; i < a.length; i += 3) {
      let best = Infinity;
      for (let j = 0; j < base.length; j += 3) best = Math.min(best, angle([a[i], a[i + 1], a[i + 2]], [base[j], base[j + 1], base[j + 2]]));
      expect(best).toBeLessThan((2 * Math.PI) / 180);
    }
  });
});

describe('land composition', () => {
  it('a single shape keeps its area whichever way it was drawn', () => {
    for (const reverse of [false, true]) {
      const land = composeLand([{ op: 'add', ring: circleRing([20, 10], 15, reverse) }]);
      expect(areaOf(land.geo)).toBeCloseTo(capArea(15), 3);
    }
  });

  it('overlapping shapes merge into one polygon', () => {
    const land = composeLand([
      { op: 'add', ring: circleRing([0, 0], 10) },
      { op: 'add', ring: circleRing([12, 0], 10) },
    ]);
    expect(land.polygons.length).toBe(1);
    const a = areaOf(land.geo);
    expect(a).toBeGreaterThan(capArea(10));
    expect(a).toBeLessThan(2 * capArea(10));
  });

  it('a cut makes a lake (hole)', () => {
    const land = composeLand([
      { op: 'add', ring: circleRing([0, 0], 20) },
      { op: 'cut', ring: circleRing([0, 0], 5, true) },
    ]);
    expect(land.polygons.length).toBe(1);
    expect(land.polygons[0].length).toBe(2);
    expect(areaOf(land.geo)).toBeCloseTo(capArea(20) - capArea(5), 3);
  });

  it('separate shapes across the date line stay separate', () => {
    const land = composeLand([
      { op: 'add', ring: circleRing([178, 0], 5) },
      { op: 'add', ring: circleRing([-60, 40], 5) },
    ]);
    expect(land.polygons.length).toBe(2);
    expect(areaOf(land.geo)).toBeCloseTo(2 * capArea(5), 3);
  });

  it('no land shapes means no land', () => {
    expect(areaOf(composeLand([]).geo)).toBe(0);
  });
});

describe('documents', () => {
  it('round-trips through JSON', () => {
    const doc = sampleDoc();
    const again = parseDoc(serializeDoc(doc));
    expect(again.items.length).toBe(doc.items.length);
    const cache = new GeometryCache();
    expect(areaOf(new GeometryCache().land(again).geo)).toBeCloseTo(areaOf(cache.land(doc).geo), 3);
  });

  it('the sample map has land with a lake', () => {
    const land = new GeometryCache().land(sampleDoc());
    expect(areaOf(land.geo)).toBeGreaterThan(0.02);
    expect(land.polygons.some((p) => p.length > 1)).toBe(true);
  });
});
