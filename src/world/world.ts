import { buildSphereMesh, type SphereMesh } from './sphereMesh';
import { generatePlates, plateCentroids, randomPlate, type Plate, type PlateParams, type PlateState } from './plates';
import { computeBoundaries, type Boundaries } from './tectonics';
import { generateTerrain, type TerrainParams } from './terrain';
import { rngFor } from '../core/rng';
import type { Vec3 } from '../core/math';

export interface WorldParams extends PlateParams, TerrainParams {
  seed: string;
  cells: number;
  /** Bumped by "re-roll plates" so plates change without changing the rest of the world. */
  plateVariant: number;
  seaLevel: number;
}

export const DEFAULT_PARAMS: WorldParams = {
  seed: 'atlas',
  cells: 40000,
  plateVariant: 0,
  plateCount: 14,
  continentFraction: 0.35,
  borderNoise: 0.8,
  mountainScale: 1,
  noiseAmount: 1,
  seaLevel: 0,
};

/** The user-editable state of a world (everything else is derived). */
export interface WorldSnapshot {
  plates: Plate[];
  plateOf: Uint16Array;
  crust: Uint8Array;
  sculpt: Float32Array;
}

/**
 * Pipeline: mesh → plates (+crust) → boundaries → terrain → elevation (= terrain + sculpt).
 * Each stage's recompute method rebuilds it and everything downstream.
 */
export class World {
  mesh!: SphereMesh;
  plates!: PlateState;
  centroids!: Float32Array;
  boundaries!: Boundaries;
  /** Generated elevation (m). */
  terrain!: Float32Array;
  /** Hand-sculpted offsets (m), kept across terrain regeneration. */
  sculpt!: Float32Array;
  /** terrain + sculpt. */
  elevation!: Float32Array;

  constructor(readonly params: WorldParams) {
    this.mesh = buildSphereMesh(params.cells, rngFor(params.seed, 'mesh'));
    this.sculpt = new Float32Array(this.mesh.n);
    this.regeneratePlates();
  }

  regeneratePlates(): void {
    this.plates = generatePlates(this.mesh, `${this.params.seed}#${this.params.plateVariant}`, this.params);
    this.recomputeTectonics();
  }

  recomputeTectonics(): void {
    this.centroids = plateCentroids(this.mesh, this.plates);
    this.boundaries = computeBoundaries(this.mesh, this.plates);
    this.recomputeTerrain();
  }

  recomputeTerrain(): void {
    this.terrain = generateTerrain(this.mesh, this.plates, this.boundaries, this.params.seed, this.params);
    this.elevation = new Float32Array(this.mesh.n);
    for (let i = 0; i < this.mesh.n; i++) this.elevation[i] = this.terrain[i] + this.sculpt[i];
  }

  /** Re-derive elevation for cells whose sculpt changed. */
  updateElevation(cells: number[]): void {
    for (const c of cells) this.elevation[c] = this.terrain[c] + this.sculpt[c];
  }

  addPlate(): number {
    const index = this.plates.plates.length;
    this.plates.plates.push(randomPlate(rngFor(this.params.seed, `added-plate-${index}`), index));
    return index;
  }

  centroid(plate: number): Vec3 {
    const c = this.centroids;
    return [c[plate * 3], c[plate * 3 + 1], c[plate * 3 + 2]];
  }

  snapshot(): WorldSnapshot {
    return {
      plates: this.plates.plates.map((p) => ({ ...p, axis: [...p.axis], color: [...p.color] })),
      plateOf: this.plates.plateOf.slice(),
      crust: this.plates.crust.slice(),
      sculpt: this.sculpt.slice(),
    };
  }

  restore(s: WorldSnapshot): void {
    if (s.plateOf.length !== this.mesh.n) throw new Error('Snapshot does not match this world\'s resolution');
    this.plates = { plates: s.plates, plateOf: s.plateOf, crust: s.crust };
    this.sculpt = s.sculpt;
    this.recomputeTectonics();
  }
}
