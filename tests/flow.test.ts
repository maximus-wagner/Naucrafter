import { describe, expect, it } from 'vitest';
import { routeRiver, slopeBetween } from '../src/doc/flow';

/** A cone-shaped island of radius 20° centred on (0, 0): sea outside, high in the middle. */
const cone = (lon: number, lat: number) => {
  const r = Math.hypot(lon, lat);
  return r >= 20 ? 0 : 0.05 + 0.75 * (1 - r / 20);
};

describe('routeRiver', () => {
  it('runs downhill from a point on a cone island to the sea', () => {
    const r = routeRiver(cone, [3, 2], { radiusDeg: 25, cells: 101 })!;
    expect(r).not.toBeNull();
    expect(r.reachedSea).toBe(true);
    expect(r.path[0][0]).toBeCloseTo(3, 5);
    const end = r.path[r.path.length - 1];
    expect(Math.hypot(end[0], end[1])).toBeGreaterThan(19);
    // Heights never rise by more than a grid cell's worth of noise.
    for (let i = 1; i < r.heights.length; i++) expect(r.heights[i]).toBeLessThanOrEqual(r.heights[i - 1] + 0.02);
    expect(r.path.length).toBeLessThan(40);
  });

  it('refuses a source in the sea', () => {
    expect(routeRiver(cone, [30, 0], { radiusDeg: 10, cells: 41 })).toBeNull();
  });

  it('leaves a basin through its lowest pass, not over the ridge', () => {
    // A plateau, sea to the east beyond lon 20, a high ridge at lon 3 with one low gap at lat 8–10.
    const land = (lon: number, lat: number) => {
      if (lon >= 20) return 0;
      const ridge = Math.abs(lon - 3) < 1.2;
      if (ridge) return lat > 7.5 && lat < 10.5 ? 0.35 : 0.9;
      return 0.3 + 0.002 * (20 - lon);
    };
    const r = routeRiver(land, [0, 0], { radiusDeg: 25, cells: 161 })!;
    expect(r.reachedSea).toBe(true);
    const crossing = r.path.find((p, i) => i > 0 && r.path[i - 1][0] < 3 && p[0] >= 3);
    expect(crossing).toBeDefined();
    expect(crossing![1]).toBeGreaterThan(6.5);
    expect(crossing![1]).toBeLessThan(11.5);
  });

  it('joins an existing river as a tributary', () => {
    const river: [number, number][] = [[10, -6], [10, 0], [10, 6]];
    const r = routeRiver(cone, [8.5, 2], { radiusDeg: 25, cells: 101, rivers: [river] })!;
    expect(r.joined).toBe(true);
    expect(r.reachedSea).toBe(false);
    const end = r.path[r.path.length - 1];
    expect(end[0]).toBeCloseTo(10, 5);
    expect(end[1]).toBeGreaterThan(-6);
    expect(end[1]).toBeLessThan(6);
  });

  it('with no sea in reach, water leaves over the edge of the grid', () => {
    const r = routeRiver((lon) => 0.5 - lon * 0.01, [0, 0], { radiusDeg: 5, cells: 41 })!;
    expect(r.reachedSea).toBe(false);
    expect(r.path[r.path.length - 1][0]).toBeGreaterThan(3);
  });
});

describe('slopeBetween', () => {
  it('is height drop per radian of arc, and zero uphill', () => {
    expect(slopeBetween([0, 0], 0.5, [1, 0], 0.4)).toBeCloseTo(0.1 / (Math.PI / 180), 4);
    expect(slopeBetween([0, 0], 0.4, [1, 0], 0.5)).toBe(0);
  });
});
