import { describe, expect, it } from 'vitest';
import { buildSphereMesh, cellsInBrush, nearestCell } from '../src/world/sphereMesh';
import { mulberry32 } from '../src/core/rng';
import { World, DEFAULT_PARAMS } from '../src/world/world';
import { BOUNDARY } from '../src/world/tectonics';
import { plateVelocity, setPlateMotionFromDrag, randomPlate } from '../src/world/plates';
import { normalize } from '../src/core/math';

describe('sphere mesh', () => {
  const mesh = buildSphereMesh(5000, mulberry32(1));

  it('is a closed triangulation (Euler: T = 2n − 4)', () => {
    expect(mesh.triangles.length / 3).toBe(2 * mesh.n - 4);
  });

  it('has symmetric adjacency with sane degrees', () => {
    for (let i = 0; i < mesh.n; i++) {
      const deg = mesh.adjOffset[i + 1] - mesh.adjOffset[i];
      expect(deg).toBeGreaterThanOrEqual(3);
      expect(deg).toBeLessThanOrEqual(12);
      for (let k = mesh.adjOffset[i]; k < mesh.adjOffset[i + 1]; k++) {
        const j = mesh.adj[k];
        const back = Array.from(mesh.adj.subarray(mesh.adjOffset[j], mesh.adjOffset[j + 1]));
        expect(back).toContain(i);
      }
    }
  });

  it('nearestCell agrees with brute force', () => {
    const rng = mulberry32(7);
    for (let t = 0; t < 200; t++) {
      const p = normalize([rng() - 0.5, rng() - 0.5, rng() - 0.5]);
      let best = -1, bestD = -2;
      for (let i = 0; i < mesh.n; i++) {
        const d = mesh.xyz[i * 3] * p[0] + mesh.xyz[i * 3 + 1] * p[1] + mesh.xyz[i * 3 + 2] * p[2];
        if (d > bestD) { bestD = d; best = i; }
      }
      expect(nearestCell(mesh, p[0], p[1], p[2], t * 13)).toBe(best);
    }
  });

  it('brush returns cells within radius', () => {
    const point = normalize([0.3, 0.5, 0.8]);
    const cell = nearestCell(mesh, ...point);
    const { cells } = cellsInBrush(mesh, { cell, point }, 0.2);
    expect(cells.length).toBeGreaterThan(30);
    for (const c of cells) {
      const d = mesh.xyz[c * 3] * point[0] + mesh.xyz[c * 3 + 1] * point[1] + mesh.xyz[c * 3 + 2] * point[2];
      expect(Math.acos(Math.min(1, d))).toBeLessThanOrEqual(0.2 + 1e-6);
    }
  });
});

describe('plates', () => {
  it('drag sets velocity at the centre toward the target', () => {
    const plate = randomPlate(mulberry32(3), 0);
    const c = normalize([0.2, 0.9, 0.1]);
    const target = normalize([0.3, 0.85, 0.2]);
    setPlateMotionFromDrag(plate, c, target);
    const v = plateVelocity(plate, ...c);
    const dir = [target[0] - c[0], target[1] - c[1], target[2] - c[2]];
    expect(v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]).toBeGreaterThan(0);
  });
});

describe('world generation', () => {
  const world = new World({ ...DEFAULT_PARAMS, cells: 8000 });

  it('assigns every cell to a valid plate', () => {
    for (let i = 0; i < world.mesh.n; i++) expect(world.plates.plateOf[i]).toBeLessThan(world.plates.plates.length);
  });

  it('hits the target continental fraction', () => {
    const land = world.plates.crust.reduce((a, b) => a + b, 0) / world.mesh.n;
    expect(land).toBeGreaterThan(DEFAULT_PARAMS.continentFraction - 0.02);
    expect(land).toBeLessThan(DEFAULT_PARAMS.continentFraction + 0.02);
  });

  it('produces convergent and divergent boundaries', () => {
    const types = new Set(world.boundaries.type);
    expect(types.has(BOUNDARY.CONVERGENT)).toBe(true);
    expect(types.has(BOUNDARY.DIVERGENT)).toBe(true);
  });

  it('produces plausible, finite elevations', () => {
    let min = Infinity, max = -Infinity, above = 0;
    for (const e of world.elevation) {
      expect(Number.isFinite(e)).toBe(true);
      min = Math.min(min, e);
      max = Math.max(max, e);
      if (e > 0) above++;
    }
    expect(min).toBeLessThan(-3000);
    expect(max).toBeGreaterThan(2000);
    const frac = above / world.mesh.n;
    expect(frac).toBeGreaterThan(0.15);
    expect(frac).toBeLessThan(0.6);
  });

  it('is deterministic for a seed', () => {
    const again = new World({ ...DEFAULT_PARAMS, cells: 8000 });
    expect(Array.from(again.elevation.subarray(0, 100))).toEqual(Array.from(world.elevation.subarray(0, 100)));
  });

  it('snapshot/restore round-trips and keeps sculpt', () => {
    const snap = world.snapshot();
    world.sculpt[5] += 1000;
    world.recomputeTerrain();
    expect(world.elevation[5]).toBeCloseTo(world.terrain[5] + 1000);
    world.restore(snap);
    expect(world.sculpt[5]).toBe(snap.sculpt[5]);
  });
});
