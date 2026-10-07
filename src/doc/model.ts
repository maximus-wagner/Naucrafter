import type { Vec3 } from '../core/math';

/**
 * A node on a path drawn on the unit sphere. Handles are absolute positions (unit vectors);
 * null means the node has no handle on that side (a corner).
 */
export interface PathNode {
  p: Vec3;
  hin: Vec3 | null;
  hout: Vec3 | null;
  /** Handles move independently (a sharp corner with curves on both sides). */
  corner?: boolean;
  /** Rivers: what the stretch from this node to the next looks like. */
  section?: RiverSection;
}

/** Kinds of river stretch. */
export type RiverSection = 'plain' | 'meander' | 'oxbow' | 'chute' | 'braided' | 'rapids';

export interface VPath {
  nodes: PathNode[];
  closed: boolean;
}

interface ItemBase {
  id: string;
  /** Bumped on every edit; geometry caches key on it. */
  rev: number;
  /**
   * Colour override (CSS colour): land fill, water fill, river, border or text colour, or the ink
   * of symbols, vegetation and mountains. Unset = the map palette.
   */
  color?: string;
}

/** A closed shape that adds land, or cuts water (lakes, bays) out of it. */
export interface LandShape extends ItemBase {
  kind: 'land';
  op: 'add' | 'cut';
  path: VPath;
  /** Coastline roughening, 0 = exactly as drawn. */
  rough: number;
  /** Land shapes: raise (+) or lower (−) the whole shape's terrain, −1…1. */
  elevation?: number;
}

/**
 * Hand-shaped terrain: a closed area raises or lowers the land inside it (hills, plateaus,
 * lowlands, basins); an open line makes a ridge or a valley along it.
 */
export interface ReliefShape extends ItemBase {
  kind: 'relief';
  path: VPath;
  /** −1 (deep valley / basin) … +1 (high ridge / plateau). */
  amount: number;
  /** Lines: half-width; areas: how soft the edge is. Degrees of arc. */
  width: number;
  rough: number;
}

export interface RiverShape extends ItemBase {
  kind: 'river';
  /** Drawn from source to mouth. */
  path: VPath;
  /** Width at the mouth, degrees of arc. */
  width: number;
  rough: number;
}

export type VegetationKind = 'broadleaf' | 'conifer' | 'mixed' | 'jungle' | 'shrubs' | 'grass';

/** Look of a vegetation area (also the defaults the Vegetation tool draws with). */
export interface VegetationLook {
  vegetation: VegetationKind;
  /** Plant size multiplier. */
  scale: number;
  /** Vertical stretch of each plant (tall jungle trees, squat shrubs). */
  height: number;
  /** How tightly plants pack (higher = more, closer). */
  density: number;
  /** How much plant sizes vary, 0–1. */
  variety: number;
  /** Edge roughening. */
  rough: number;
}

/** Look of a mountain range (also the defaults the Mountains tool draws with). */
export interface MountainLook {
  /** Footprint size multiplier. */
  scale: number;
  /** Peak height multiplier (steepness). */
  height: number;
  /** Jagged ridgelines, 0–1. */
  ruggedness: number;
  /** Snow-capped fraction of each peak, 0–0.6. */
  snow: number;
  /** How tightly peaks pack. */
  density: number;
  /** Hills along the edge of the range. */
  foothills: boolean;
  rough: number;
}

export const VEGETATION_DEFAULTS: VegetationLook = { vegetation: 'mixed', scale: 1, height: 1, density: 1, variety: 0.3, rough: 0.4 };
export const MOUNTAIN_DEFAULTS: MountainLook = { scale: 1, height: 1, ruggedness: 0.5, snow: 0.22, density: 1, foothills: true, rough: 0.4 };

/** A drawn vegetation outline; the inside fills with procedural pixel-art plants. */
export interface ForestShape extends ItemBase, VegetationLook {
  kind: 'forest';
  path: VPath;
}

/** A drawn mountain-range outline; the inside fills with procedural peaks. */
export interface MountainShape extends ItemBase, MountainLook {
  kind: 'mountains';
  path: VPath;
}

export interface BorderShape extends ItemBase {
  kind: 'border';
  path: VPath;
  line: 'national' | 'regional';
}

/** 'mountain', 'hill' and 'tree' are procedural; any other name is a PNG in src/assets/icons/symbols. */
export type SymbolKind = string;

export interface SymbolMark extends ItemBase {
  kind: 'symbol';
  symbol: SymbolKind;
  at: Vec3;
  /** Half-width, degrees of arc. */
  size: number;
}

export type LabelStyle = 'region' | 'place' | 'water';

export interface Label extends ItemBase {
  kind: 'label';
  text: string;
  at: Vec3;
  /** Text height, degrees of arc. */
  size: number;
  style: LabelStyle;
  /** When set, the text follows this curve instead of sitting level at `at`. */
  path: VPath | null;
}

export type PathItem = LandShape | RiverShape | BorderShape | ForestShape | MountainShape | ReliefShape;
export type AreaItem = LandShape | ForestShape | MountainShape;
export type Item = PathItem | SymbolMark | Label;

/** Map-wide colours that override the chosen style's. */
export type PaletteKey = 'desk' | 'sea' | 'land' | 'ink' | 'river' | 'border' | 'label' | 'waterLabel' | 'symbolInk' | 'symbolPaper';
export type Palette = Partial<Record<PaletteKey, string>>;

export interface MapDoc {
  version: 1;
  palette?: Palette;
  /** Seed for procedural detail (roughening, scatter). */
  seed: string;
  /** The world's radius; gives the map real distances (scale bar). */
  planet: { radiusKm: number };
  items: Item[];
}

export const EARTH_RADIUS_KM = 6371;

export function emptyDoc(radiusKm = EARTH_RADIUS_KM): MapDoc {
  return { version: 1, seed: 'atlas', planet: { radiusKm }, items: [] };
}

let idCounter = 0;
export function newId(): string {
  idCounter++;
  return `${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function isPathItem(item: Item): item is PathItem {
  return item.kind === 'land' || item.kind === 'river' || item.kind === 'border' || item.kind === 'forest' || item.kind === 'mountains' || item.kind === 'relief';
}

/** The editable path of an item, if it has one. */
export function pathOf(item: Item): VPath | null {
  if (isPathItem(item)) return item.path;
  if (item.kind === 'label') return item.path;
  return null;
}
