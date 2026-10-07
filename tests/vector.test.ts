import { describe, expect, it } from 'vitest';
import { geoArea, geoCircle, geoDistance, type GeoPermissibleObjects } from 'd3-geo';
import { World, DEFAULT_PARAMS } from '../src/world/world';
import { halfedgeEnd } from '../src/world/sphereMesh';
import { VectorData } from '../src/vector/extract';
import { catmullRom, controlPoints, toLonLat, type LonLat } from '../src/vector/geo';
import { borderEditRelabels, cellsInPolygon } from '../src/edit/cellEdits';
import { cross, normalize, type Vec3 } from '../src/core/math';

const world = new World({ ...DEFAULT_PARAMS, cells: 8000 });
const vectors = new VectorData(world);
const FULL = 4 * Math.PI;

/** Fraction of cells matching a predicate (cells have ~equal area on a Fibonacci sphere). */
const cellFraction = (pred: (i: number) => boolean) => {
  let k = 0;
  for (let i = 0; i < world.mesh.n; i++) if (pred(i)) k++;
  return k / world.mesh.n;
};
const areaOf = (g: GeoPermissibleObjects) => geoArea(g as Parameters<typeof geoArea>[0]) / FULL;

describe('mesh topology for vectors', () => {
  it('every half-edge has a reversed twin', () => {
    const { triangles: T, twin } = world.mesh;
    for (let h = 0; h < T.length; h++) {
      const g = twin[h];
      expect(g).toBeGreaterThanOrEqual(0);
      expect(twin[g]).toBe(h);
      expect(T[g]).toBe(halfedgeEnd(T, h));
    }
  });
});

describe('contours', () => {
  it('sea-level area matches the land fraction (orientation is right for d3)', () => {
    const land = cellFraction((i) => world.elevation[i] >= 0);
    expect(areaOf(vectors.contour(0).area)).toBeCloseTo(land, 1);
  });

  it('deep levels cover almost everything; empty levels cover nothing', () => {
    expect(areaOf(vectors.contour(-10500).area)).toBeGreaterThan(0.97);
    expect(vectors.contour(20000).rings.length).toBe(0);
  });
});

describe('border network', () => {
  it('plate regions tile the sphere and match their cell counts', () => {
    const { regions } = vectors.plates();
    let total = 0;
    for (const r of regions) {
      const a = areaOf(r.area);
      total += a;
      expect(a).toBeCloseTo(cellFraction((i) => world.plates.plateOf[i] === r.plate), 1);
    }
    expect(total).toBeCloseTo(1, 2);
  });

  it('crust regions are complementary', () => {
    const c = vectors.crust();
    expect(areaOf(c.continental) + areaOf(c.oceanic)).toBeCloseTo(1, 2);
    expect(areaOf(c.continental)).toBeCloseTo(cellFraction((i) => world.plates.crust[i] === 1), 1);
  });

  it('every chain separates two different labels', () => {
    for (const c of vectors.plates().network.chains) {
      expect(c.left).not.toBe(c.right);
      expect(c.segSource.length).toBe(c.xyz.length / 3 - (c.closed ? 0 : 1));
    }
  });

  it('borders are split by boundary type', () => {
    const counts = vectors.plates().bordersByType.map((m) => m.coordinates.length);
    expect(counts[1] + counts[2] + counts[3]).toBeGreaterThan(0);
  });
});

describe('editing geometry', () => {
  it('a spline through control points reproduces the chain', () => {
    const chain = vectors.plates().network.chains.find((c) => !c.closed && c.xyz.length > 60)!;
    const ctrl = controlPoints(chain.xyz, false, world.mesh.spacing * 0.9);
    expect(ctrl.length).toBeGreaterThanOrEqual(2);
    expect(ctrl.length).toBeLessThan(chain.xyz.length / 3);
    const { pts } = catmullRom(ctrl, false, world.mesh.spacing * 0.35);
    for (let c = 0; c < 3; c++) {
      expect(pts[0][c]).toBeCloseTo(ctrl[0][c], 6);
      expect(pts[pts.length - 1][c]).toBeCloseTo(ctrl[ctrl.length - 1][c], 6);
    }
  });

  it('dragging a control point moves cells between exactly the two plates', () => {
    const chain = vectors.plates().network.chains.find((c) => !c.closed && c.xyz.length > 90)!;
    const ctrl = controlPoints(chain.xyz, false, world.mesh.spacing * 0.9);
    const mid = Math.floor(ctrl.length / 2);
    const moved = ctrl.map((p) => [...p] as Vec3);
    // Push the middle point sideways by ~4 cells.
    const p = ctrl[mid], q = ctrl[mid + 1] ?? ctrl[mid - 1];
    const side = normalize(cross(p, [q[0] - p[0], q[1] - p[1], q[2] - p[2]]));
    moved[mid] = normalize([p[0] + side[0] * world.mesh.spacing * 4, p[1] + side[1] * world.mesh.spacing * 4, p[2] + side[2] * world.mesh.spacing * 4]);
    const step = world.mesh.spacing * 0.35;
    const relabels = borderEditRelabels(world.mesh, world.plates.plateOf, chain.left, chain.right, catmullRom(ctrl, false, step).pts, catmullRom(moved, false, step).pts, false);
    expect(relabels.length).toBeGreaterThan(3);
    for (const [cell, label] of relabels) {
      expect([chain.left, chain.right]).toContain(world.plates.plateOf[cell]);
      expect([chain.left, chain.right]).toContain(label);
    }
  });

  it('a drawn circle selects the cells inside it, whichever way it was drawn', () => {
    const circle = geoCircle().center([20, 10]).radius(15)().coordinates[0] as LonLat[];
    for (const ring of [circle, circle.slice().reverse()]) {
      const cells = cellsInPolygon(world.mesh, ring.slice(0, -1));
      const expected = cellFraction((i) => geoDistance(toLonLat(world.mesh.xyz[i * 3], world.mesh.xyz[i * 3 + 1], world.mesh.xyz[i * 3 + 2]), [20, 10]) < (15 * Math.PI) / 180);
      expect(cells.length / world.mesh.n).toBeCloseTo(expected, 2);
    }
  });

  it('relief marks exist for a world with mountains', () => {
    expect(vectors.relief().length).toBeGreaterThan(5);
  });
});
