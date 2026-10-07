import { describe, expect, it } from 'vitest';
import { angle } from '../src/doc/geometry';
import { bearingDeg, compass, distanceKm, formatArea, formatDays, formatDistance, greatCircle, lineLengthKm, ringAreaKm2 } from '../src/doc/measure';
import { EARTH_RADIUS_KM } from '../src/doc/model';
import { fromLonLat } from '../src/vector/geo';

const at = (lon: number, lat: number) => fromLonLat([lon, lat]);

describe('measuring', () => {
  it('a quarter of the equator is a quarter of the circumference', () => {
    const km = distanceKm(at(0, 0), at(90, 0), EARTH_RADIUS_KM);
    expect(km).toBeCloseTo((2 * Math.PI * EARTH_RADIUS_KM) / 4, 3);
  });

  it('distance scales with the planet radius', () => {
    const a = at(10, 20), b = at(40, 35);
    expect(distanceKm(a, b, 3390) / distanceKm(a, b, 6780)).toBeCloseTo(0.5, 9);
  });

  it('great-circle samples run from a to b and stay on the sphere', () => {
    const a = at(-30, 10), b = at(60, 50);
    const pts = greatCircle(a, b, 0.02);
    expect(pts[0]).toEqual(a);
    expect(pts[pts.length - 1]).toEqual(b);
    expect(pts.length).toBeGreaterThan(10);
    for (const p of pts) expect(Math.hypot(...p)).toBeCloseTo(1, 9);
    // evenly spaced, and no longer than the requested step
    const gaps = pts.slice(1).map((p, i) => angle(pts[i], p));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(0.02 + 1e-9);
    expect(gaps.reduce((s, g) => s + g, 0)).toBeCloseTo(angle(a, b), 9);
  });

  it('measures a polyline as the sum of its legs', () => {
    const a = at(0, 0), b = at(10, 0), c = at(10, 10);
    const flat = [...a, ...b, ...c];
    expect(lineLengthKm(flat, 1000)).toBeCloseTo(distanceKm(a, b, 1000) + distanceKm(b, c, 1000), 9);
  });

  it('bearings point the right way', () => {
    expect(bearingDeg(at(0, 0), at(0, 10))).toBeCloseTo(0, 6);
    expect(bearingDeg(at(0, 0), at(10, 0))).toBeCloseTo(90, 6);
    expect(bearingDeg(at(0, 0), at(0, -10))).toBeCloseTo(180, 6);
    expect(bearingDeg(at(0, 0), at(-10, 0))).toBeCloseTo(270, 6);
    expect(compass(44)).toBe('NE');
    expect(compass(359)).toBe('N');
  });

  it('area of a 10° square near the equator is close to the flat estimate', () => {
    const sq = [at(0, 0), at(10, 0), at(10, 10), at(0, 10)];
    const side = (Math.PI / 18) * EARTH_RADIUS_KM;
    expect(ringAreaKm2(sq, EARTH_RADIUS_KM) / (side * side)).toBeGreaterThan(0.97);
    expect(ringAreaKm2(sq, EARTH_RADIUS_KM) / (side * side)).toBeLessThan(1.03);
    // winding must not matter
    expect(ringAreaKm2([...sq].reverse(), EARTH_RADIUS_KM)).toBeCloseTo(ringAreaKm2(sq, EARTH_RADIUS_KM), 3);
    expect(ringAreaKm2(sq.slice(0, 2), EARTH_RADIUS_KM)).toBe(0);
  });

  it('formats distances, areas and travel times', () => {
    expect(formatDistance(0.4, 'km')).toBe('400 m');
    expect(formatDistance(4.5, 'km')).toBe('4.50 km');
    expect(formatDistance(1234.6, 'km')).toBe('1,235 km');
    expect(formatDistance(100, 'mi')).toBe('62.1 mi');
    expect(formatArea(2_500_000, 'km')).toBe('2.50 million km²');
    expect(formatArea(12_345, 'km')).toBe('12,345 km²');
    expect(formatDays(0.3)).toBe('under a day');
    expect(formatDays(4.26)).toBe('4.3 days');
    expect(formatDays(41.7)).toBe('42 days');
  });
});
