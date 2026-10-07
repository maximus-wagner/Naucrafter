import { RAD } from '../doc/geometry';
import { toLonLat } from '../vector/geo';
import type { Painter } from './painter';

/**
 * Project a polyline (flat xyz) to screen, split into visible runs: breaks where it passes
 * behind the globe or jumps across the sheet edge (date line).
 */
export function screenRuns(p: Painter, pts: number[], extra?: number[]): { pts: [number, number][]; extra: number[] }[] {
  const runs: { pts: [number, number][]; extra: number[] }[] = [];
  let cur: { pts: [number, number][]; extra: number[] } | null = null;
  const jump = Math.max(p.width, p.height) / 3;
  for (let i = 0; i < pts.length; i += 3) {
    const s = p.visible(toLonLat(pts[i], pts[i + 1], pts[i + 2]), 1e6);
    const prev = cur?.pts[cur.pts.length - 1];
    if (!s || (prev && Math.hypot(s[0] - prev[0], s[1] - prev[1]) > jump)) {
      if (cur && cur.pts.length > 1) runs.push(cur);
      cur = null;
      if (!s) continue;
    }
    if (!cur) cur = { pts: [], extra: [] };
    cur.pts.push(s);
    if (extra) cur.extra.push(extra[i / 3]);
  }
  if (cur && cur.pts.length > 1) runs.push(cur);
  return runs;
}

/** Pixels per degree of arc at the current zoom. */
export const pxPerDegree = (p: Painter) => p.projection.scale() * RAD;
