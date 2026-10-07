import { geoArea } from 'd3-geo';
import type { Polygon } from 'geojson';
import type { Vec3 } from '../core/math';
import { toLonLat } from '../vector/geo';
import { angle, slerp } from './geometry';

export type Units = 'km' | 'mi';

const MI_PER_KM = 0.621371;

/** Samples along the great circle from a to b, ends included, about `step` radians apart. */
export function greatCircle(a: Vec3, b: Vec3, step: number): Vec3[] {
  const n = Math.max(1, Math.min(400, Math.ceil(angle(a, b) / step)));
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) out.push(i === 0 ? a : i === n ? b : slerp(a, b, i / n));
  return out;
}

/** Distance along the great circle between two points, in km on a planet of this radius. */
export function distanceKm(a: Vec3, b: Vec3, radiusKm: number): number {
  return angle(a, b) * radiusKm;
}

/** Length of a flat xyz polyline (e.g. a river's drawn course), in km. */
export function lineLengthKm(pts: number[], radiusKm: number): number {
  let sum = 0;
  for (let i = 3; i < pts.length; i += 3) {
    sum += distanceKm([pts[i - 3], pts[i - 2], pts[i - 1]], [pts[i], pts[i + 1], pts[i + 2]], radiusKm);
  }
  return sum;
}

/** Area enclosed by great-circle edges through the points, in km² (the smaller side of the ring). */
export function ringAreaKm2(points: Vec3[], radiusKm: number): number {
  if (points.length < 3) return 0;
  const ring = points.map((p) => toLonLat(...p));
  ring.push(ring[0]);
  let poly: Polygon = { type: 'Polygon', coordinates: [ring] };
  if (geoArea(poly) > 2 * Math.PI) poly = { type: 'Polygon', coordinates: [ring.slice().reverse()] };
  return geoArea(poly) * radiusKm * radiusKm;
}

/** `ringAreaKm2` for a closed outline given as flat xyz (the last point is not repeated). */
export function flatRingAreaKm2(pts: number[], radiusKm: number): number {
  const ring: Vec3[] = [];
  for (let i = 0; i + 2 < pts.length; i += 3) ring.push([pts[i], pts[i + 1], pts[i + 2]]);
  return ringAreaKm2(ring, radiusKm);
}

/** Initial compass bearing from a to b in degrees, 0 = north, 90 = east. */
export function bearingDeg(a: Vec3, b: Vec3): number {
  const [l1, p1] = toLonLat(...a).map((d) => (d * Math.PI) / 180);
  const [l2, p2] = toLonLat(...b).map((d) => (d * Math.PI) / 180);
  const dl = l2 - l1;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (((Math.atan2(y, x) * 180) / Math.PI) % 360 + 360) % 360;
}

const WINDS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg: number): string => WINDS[Math.round(deg / 45) % 8];

const group = (n: number): string => Math.round(n).toLocaleString('en');

export function formatDistance(km: number, units: Units): string {
  if (units === 'mi') {
    const mi = km * MI_PER_KM;
    if (mi < 0.1) return `${Math.round(mi * 5280)} ft`;
    return mi < 100 ? `${mi.toFixed(mi < 10 ? 2 : 1)} mi` : `${group(mi)} mi`;
  }
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return km < 100 ? `${km.toFixed(km < 10 ? 2 : 1)} km` : `${group(km)} km`;
}

export function formatArea(km2: number, units: Units): string {
  const v = units === 'mi' ? km2 * MI_PER_KM * MI_PER_KM : km2;
  const unit = units === 'mi' ? 'sq mi' : 'km²';
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} million ${unit}`;
  return v < 100 ? `${v.toFixed(1)} ${unit}` : `${group(v)} ${unit}`;
}

/** Travel speeds in km per day: rough, for fantasy journeys along the measured line. */
export const TRAVEL: { label: string; kmPerDay: number }[] = [
  { label: 'On foot', kmPerDay: 30 },
  { label: 'By horse', kmPerDay: 60 },
  { label: 'By ship', kmPerDay: 150 },
];

export function formatDays(days: number): string {
  if (days < 0.95) return 'under a day';
  return days < 10 ? `${days.toFixed(1)} days` : `${group(days)} days`;
}
