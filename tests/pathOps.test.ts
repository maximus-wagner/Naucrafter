import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import { angle, flatten, setSmooth } from '../src/doc/geometry';
import { flatRingAreaKm2 } from '../src/doc/measure';
import type { PathNode, RiverSection, VPath } from '../src/doc/model';
import { EARTH_RADIUS_KM } from '../src/doc/model';
import { chainJoin, crossings, cutPath, insertAt, joinPaths, locateSample, mapPath, orientForJoin, reversePath, splitAtNode, splitClosed } from '../src/doc/pathOps';
import { affineAbout, centroid, frameAngle, rotationMat, scaleMat } from '../src/doc/transform';
import { unionOutline } from '../src/doc/union';
import { fromLonLat, type LonLat } from '../src/vector/geo';

function smooth(points: LonLat[], closed: boolean): VPath {
  const path: VPath = { closed, nodes: points.map((p): PathNode => ({ p: fromLonLat(p), hin: null, hout: null })) };
  for (let i = 0; i < path.nodes.length; i++) setSmooth(path, i, true);
  return path;
}

/** A round shape of `r` degrees around a point, with n smooth nodes. */
function disc(lon: number, lat: number, r: number, n = 8): VPath {
  return smooth(Array.from({ length: n }, (_, i): LonLat => [lon + r * Math.cos((i / n) * Math.PI * 2), lat + r * Math.sin((i / n) * Math.PI * 2)]), true);
}

const line = (...pts: LonLat[]) => smooth(pts, false);
const area = (path: VPath) => flatRingAreaKm2(flatten(path, 0.002).pts, EARTH_RADIUS_KM);
const pos = (v: Vec3): LonLat => [Math.round((Math.atan2(v[0], v[2]) * 180) / Math.PI * 1e4) / 1e4, Math.round((Math.asin(v[1]) * 180) / Math.PI * 1e4) / 1e4];

describe('transform', () => {
  const c = fromLonLat([20, 10]);
  const right = fromLonLat([20.5, 10]);
  const theta = frameAngle(c, right);

  it('screen-right is east at the equator-ish', () => {
    expect(Math.abs(theta)).toBeLessThan(0.05);
  });

  it('a rotation turns points about the centre without changing their distance from it', () => {
    const p = fromLonLat([24, 10]);
    const q = affineAbout(c, theta, rotationMat(Math.PI / 2))(p);
    expect(angle(c, q)).toBeCloseTo(angle(c, p), 9);
    // a quarter turn counter-clockwise on screen: east of the centre becomes north of it
    expect(pos(q)[1]).toBeGreaterThan(13);
    expect(Math.abs(pos(q)[0] - 20)).toBeLessThan(0.2);
  });

  it('a uniform scale multiplies distance from the centre and keeps the bearing', () => {
    const p = fromLonLat([23, 12]);
    const q = affineAbout(c, theta, scaleMat(2))(p);
    expect(angle(c, q)).toBeCloseTo(angle(c, p) * 2, 6);
    const back = affineAbout(c, theta, scaleMat(0.5))(q);
    expect(angle(back, p)).toBeLessThan(1e-9);
  });

  it('stretches only along the chosen screen axis', () => {
    const east = fromLonLat([22, 10]);
    const north = fromLonLat([20, 12]);
    const m = affineAbout(c, theta, scaleMat(2, 1));
    expect(angle(c, m(east))).toBeCloseTo(angle(c, east) * 2, 3);
    expect(angle(c, m(north))).toBeCloseTo(angle(c, north), 3);
  });

  it('a flip mirrors east and west and leaves north alone', () => {
    const flip = affineAbout(c, theta, scaleMat(-1, 1));
    expect(pos(flip(fromLonLat([22, 10])))[0]).toBeCloseTo(18, 1);
    expect(pos(flip(fromLonLat([20, 12])))[1]).toBeCloseTo(12, 1);
  });

  it('never folds points past the far side of the planet', () => {
    const q = affineAbout(c, theta, scaleMat(500))(fromLonLat([30, 10]));
    expect(Math.hypot(...q)).toBeCloseTo(1, 9);
    expect(Number.isFinite(q[0])).toBe(true);
  });

  it('centroid sits in the middle', () => {
    const m = centroid([fromLonLat([10, 0]), fromLonLat([30, 0])]);
    expect(pos(m)[0]).toBeCloseTo(20, 3);
  });
});

describe('reversing', () => {
  it('runs the path backwards, swapping handles, and twice is the identity', () => {
    const p = line([0, 0], [5, 3], [10, 0], [15, 4]);
    const before = structuredClone(p);
    const nodes = p.nodes.map((n) => n.p);
    reversePath(p);
    expect(p.nodes.map((n) => n.p)).toEqual([...nodes].reverse());
    expect(p.nodes[0].hout).toEqual(before.nodes[3].hin);
    reversePath(p);
    expect(p).toEqual(before);
  });

  it('keeps each river stretch with its stretch', () => {
    const p = line([0, 0], [5, 3], [10, 0], [15, 4]);
    const secs: RiverSection[] = ['meander', 'rapids', 'braided'];
    secs.forEach((s, i) => (p.nodes[i].section = s));
    reversePath(p);
    // Stretches now run 15→10, 10→5, 5→0, i.e. braided, rapids, meander.
    expect(p.nodes.slice(0, 3).map((n) => n.section)).toEqual(['braided', 'rapids', 'meander']);
    expect(p.nodes[3].section).toBeUndefined();
  });
});

describe('splitting', () => {
  it('cuts an open line at a node into two that meet there', () => {
    const p = line([0, 0], [5, 3], [10, 0], [15, 4]);
    const [a, b] = splitAtNode(p, 2);
    expect(a.nodes).toHaveLength(3);
    expect(b.nodes).toHaveLength(2);
    expect(a.nodes[2].p).toEqual(b.nodes[0].p);
    expect(a.nodes[2].hout).toBeNull();
    expect(b.nodes[0].hin).toBeNull();
    expect(a.closed || b.closed).toBe(false);
    // the original curve is unchanged up to the cut
    expect(flatten(a, 0.01).pts.length / 3).toBeGreaterThan(5);
  });

  it('splitting at an end node changes nothing', () => {
    const p = line([0, 0], [5, 3], [10, 0]);
    expect(splitAtNode(p, 0)).toHaveLength(1);
    expect(splitAtNode(p, 2)).toHaveLength(1);
  });

  it('opens a loop at a node', () => {
    const p = disc(0, 0, 5);
    const [open] = splitAtNode(p, 3);
    expect(open.closed).toBe(false);
    expect(open.nodes).toHaveLength(9);
    expect(open.nodes[0].p).toEqual(p.nodes[3].p);
    expect(open.nodes[8].p).toEqual(p.nodes[3].p);
    expect(open.nodes[0].hin).toBeNull();
    expect(open.nodes[8].hout).toBeNull();
  });

  it('cuts a loop in two along the line between two nodes, losing no area', () => {
    const p = disc(0, 0, 5);
    const [a, b] = splitClosed(p, 1, 5)!;
    expect(a.closed && b.closed).toBe(true);
    expect(a.nodes.length).toBeGreaterThanOrEqual(3);
    expect(b.nodes.length).toBeGreaterThanOrEqual(3);
    expect(area(a) + area(b)).toBeCloseTo(area(p), -2);
    expect(area(a)).toBeGreaterThan(0.2 * area(p));
  });

  it('inserting nodes keeps the shape and reports where they went', () => {
    const p = disc(0, 0, 5);
    const before = flatten(p, 0.002).pts;
    const work = structuredClone(p);
    const [i, j] = insertAt(work, [{ seg: 5, t: 0.5 }, { seg: 1, t: 0.25 }]);
    expect(work.nodes).toHaveLength(10);
    expect(i).toBe(7);
    expect(j).toBe(2);
    const after = flatten(work, 0.002).pts;
    // every new sample lies on the old curve
    let worst = 0;
    for (let k = 0; k < after.length; k += 3) {
      let best = Infinity;
      for (let m = 0; m < before.length; m += 3) best = Math.min(best, Math.hypot(after[k] - before[m], after[k + 1] - before[m + 1], after[k + 2] - before[m + 2]));
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThan(0.002);
  });

  it('two inserts in one stretch both land where asked', () => {
    const p = line([0, 0], [20, 0]);
    const work = structuredClone(p);
    const [i, j] = insertAt(work, [{ seg: 0, t: 0.7 }, { seg: 0, t: 0.3 }]);
    expect([i, j]).toEqual([2, 1]);
    expect(pos(work.nodes[1].p)[0]).toBeCloseTo(6, 1);
    expect(pos(work.nodes[2].p)[0]).toBeCloseTo(14, 1);
  });
});

describe('joining', () => {
  const a = line([0, 0], [4, 2], [8, 0]);
  const b = line([8.05, 0], [12, 3], [16, 0]);

  it('welds ends that touch into one node', () => {
    const j = joinPaths(a, b, 0.5 * (Math.PI / 180));
    expect(j.nodes).toHaveLength(5);
    expect(j.nodes[2].p).toEqual(a.nodes[2].p);
    expect(j.nodes[2].hin).toEqual(a.nodes[2].hin);
    expect(j.closed).toBe(false);
  });

  it('bridges ends that are far apart, keeping every node', () => {
    const far = line([14, 0], [18, 3]);
    expect(joinPaths(a, far, 0.01 * (Math.PI / 180)).nodes).toHaveLength(5);
  });

  it('turns paths around so the nearest ends meet', () => {
    const rev = structuredClone(b);
    reversePath(rev);
    const o = orientForJoin(a, rev);
    expect(o.gap).toBeLessThan(0.002);
    expect(pos(o.first.nodes[0].p)[0]).toBe(0);
    expect(pos(o.second.nodes[2].p)[0]).toBe(16);
  });

  it('a path joined to the other side of itself comes out the right way round', () => {
    const left = line([-10, 0], [-5, 1], [-0.05, 0]);
    const o = orientForJoin(a, left);
    expect(pos(o.first.nodes[0].p)[0]).toBe(-10);
    expect(pos(o.second.nodes[0].p)[0]).toBe(0);
  });

  it('rivers keep their flow unless something else is much closer', () => {
    // b's end is slightly closer to a's end than b's start is, but joining it would reverse b
    const near = line([9, 0], [12, 3]);
    const upstream = line([8.4, 0.2], [8.2, 0.1]); // runs towards a's end
    expect(orientForJoin(a, near, true).second.nodes[0].p).toEqual(near.nodes[0].p);
    expect(orientForJoin(a, upstream, true).gap).toBeGreaterThan(0);
  });

  it('chains several paths into one, nearest first', () => {
    const c = line([16.05, 0], [20, 2]);
    const chain = chainJoin([a, c, b], 0.5 * (Math.PI / 180));
    expect(chain.nodes).toHaveLength(3 + 2 + 1); // a(3) + b(3-1 welded) + c(2-1 welded)
    expect(pos(chain.nodes[0].p)[0]).toBe(0);
    expect(pos(chain.nodes[chain.nodes.length - 1].p)[0]).toBe(20);
  });
});

describe('cutting across', () => {
  const across = (from: LonLat, to: LonLat, n = 40): Vec3[] => Array.from({ length: n + 1 }, (_, i) => fromLonLat([from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n]));

  it('finds where a stroke crosses a ring, in stroke order', () => {
    const ring = flatten(disc(0, 0, 5), 0.002);
    const hits = crossings(ring.pts, true, across([-8, 0.3], [8, 0.3]));
    expect(hits).toHaveLength(2);
    expect(hits[0].stroke).toBeLessThan(hits[1].stroke);
    expect(hits[0].stroke).toBeCloseTo(7.5, 0);
    expect(hits[1].stroke).toBeCloseTo(32.5, 0);
  });

  it('a stroke that misses finds nothing', () => {
    const ring = flatten(disc(0, 0, 5), 0.002);
    expect(crossings(ring.pts, true, across([-8, 9], [8, 9]))).toHaveLength(0);
  });

  it('locates a sample back on its stretch', () => {
    const p = disc(0, 0, 5);
    const base = flatten(p, 0.01);
    const loc = locateSample(p, base.seg, base.seg.indexOf(3) + 1.5);
    expect(loc.seg).toBe(3);
    expect(loc.t).toBeGreaterThan(0);
    expect(loc.t).toBeLessThan(1);
  });

  it('cuts an island in two with a stroke across it', () => {
    const p = disc(0, 0, 5);
    const pieces = cutPath(p, flatten(p, 0.002), across([-8, 0.3], [8, 0.3]))!;
    expect(pieces).toHaveLength(2);
    expect(pieces.every((q) => q.closed && q.nodes.length >= 3)).toBe(true);
    expect(area(pieces[0]) + area(pieces[1])).toBeCloseTo(area(p), -2);
    // the cut is just above the middle, so the pieces differ in size
    expect(Math.abs(area(pieces[0]) - area(pieces[1]))).toBeGreaterThan(0.02 * area(p));
  });

  it('cuts a river where the stroke crosses it', () => {
    const p = line([-10, 0], [-3, 2], [3, -2], [10, 0]);
    const pieces = cutPath(p, flatten(p, 0.002), across([0, -6], [0, 6]))!;
    expect(pieces).toHaveLength(2);
    expect(pieces.every((q) => !q.closed)).toBe(true);
    expect(pieces[0].nodes[pieces[0].nodes.length - 1].p).toEqual(pieces[1].nodes[0].p);
    expect(Math.abs(pos(pieces[0].nodes[pieces[0].nodes.length - 1].p)[0])).toBeLessThan(1.2);
  });

  it('returns null when the stroke only touches a loop once or misses', () => {
    const p = disc(0, 0, 5);
    expect(cutPath(p, flatten(p, 0.002), across([-8, 9], [8, 9]))).toBeNull();
    expect(cutPath(p, flatten(p, 0.002), across([0, 0], [8, 0]))).toBeNull();
  });
});

describe('union', () => {
  it('merges overlapping shapes into one outline', () => {
    const a = disc(0, 0, 5), b = disc(6, 0, 5);
    const u = unionOutline([flatten(a, 0.01).pts, flatten(b, 0.01).pts])!;
    expect(u).not.toBeNull();
    expect(u.holes).toBe(0);
    const flat = u.ring.flatMap((v) => v);
    expect(flatRingAreaKm2(flat, EARTH_RADIUS_KM)).toBeGreaterThan(area(a) * 1.4);
    expect(flatRingAreaKm2(flat, EARTH_RADIUS_KM)).toBeLessThan(area(a) + area(b));
  });

  it('refuses shapes that do not touch', () => {
    expect(unionOutline([flatten(disc(0, 0, 3), 0.01).pts, flatten(disc(30, 0, 3), 0.01).pts])).toBeNull();
  });
});

describe('mapping', () => {
  it('moves nodes and handles together', () => {
    const p = line([0, 0], [5, 3], [10, 0]);
    const q = structuredClone(p);
    mapPath(q, (v) => [v[0], v[1], v[2]]);
    expect(q).toEqual(p);
    mapPath(q, (v) => fromLonLat([pos(v)[0] + 1, pos(v)[1]]));
    expect(pos(q.nodes[1].p)[0]).toBeCloseTo(6, 3);
    expect(pos(q.nodes[1].hout!)[0]).toBeCloseTo(pos(p.nodes[1].hout!)[0] + 1, 3);
  });
});
