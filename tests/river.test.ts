import { describe, expect, it } from 'vitest';
import { riverGeometry } from '../src/doc/river';
import { setSmooth } from '../src/doc/geometry';
import type { RiverSection, VPath } from '../src/doc/model';
import { fromLonLat, type LonLat } from '../src/vector/geo';

function river(section: RiverSection): VPath {
  const path: VPath = { closed: false, nodes: ([[0, 0], [10, 1], [20, 0]] as LonLat[]).map((p) => ({ p: fromLonLat(p), hin: null, hout: null, section })) };
  for (let i = 0; i < 3; i++) setSmooth(path, i, true);
  return path;
}
const W = 0.3 * (Math.PI / 180);
const sideways = (pts: number[]) => Math.max(...pts.filter((_, i) => i % 3 === 1).map(Math.abs)); // y ≈ sin(lat)

describe('river sections', () => {
  it('plain rivers follow the drawn line', () => {
    const g = riverGeometry(river('plain'), W, 0, 's');
    expect(g.side.length + g.lakes.length + g.ticks.length).toBe(0);
    expect(sideways(g.main)).toBeLessThan(Math.sin((1.5 * Math.PI) / 180));
  });

  it('bends meander away from the line', () => {
    expect(sideways(riverGeometry(river('meander'), W, 0, 's').main)).toBeGreaterThan(sideways(riverGeometry(river('plain'), W, 0, 's').main));
  });

  it('oxbows leave crescent lakes', () => {
    const g = riverGeometry(river('oxbow'), W, 0, 's');
    expect(g.lakes.length).toBeGreaterThan(0);
    for (const lake of g.lakes) expect(lake.length / 3).toBeGreaterThan(10);
  });

  it('chutes add a cut-off channel, braids add two, rapids add cross strokes', () => {
    expect(riverGeometry(river('chute'), W, 0, 's').side.length).toBe(2);
    expect(riverGeometry(river('braided'), W, 0, 's').side.length).toBe(4);
    expect(riverGeometry(river('rapids'), W, 0, 's').ticks.length).toBeGreaterThan(5);
  });

  it('through mountains a river straightens and gets rapids', () => {
    const free = riverGeometry(river('meander'), W, 0, 's');
    const mountains = riverGeometry(river('meander'), W, 0, 's', () => true);
    expect(mountains.ticks.length).toBeGreaterThan(0);
    expect(sideways(mountains.main)).toBeLessThan(sideways(free.main));
  });
});
