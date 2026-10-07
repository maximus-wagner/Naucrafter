import type { MapView } from './render/mapView';
import { GeometryCache } from './doc/cache';
import { cloneItems } from './doc/io';
import { MOUNTAIN_DEFAULTS, VEGETATION_DEFAULTS, emptyDoc, type Item, type LabelStyle, type MapDoc, type MountainLook, type PaletteKey, type RiverSection, type SymbolKind, type VegetationLook } from './doc/model';
import { drawMap } from './render/drawMap';
import { TerrainLayer } from './render/terrain';
import { RAD } from './doc/geometry';
import { effectiveStyle, type StyleId } from './render/styles';

export interface Selection {
  id: string;
  /** Selected node of the item's path, if any. */
  node: number | null;
}

/** Settings new items are created with (the tool options). */
export interface Defaults {
  rough: number;
  /** Sizes for new items are in screen px at the zoom they are placed at (stored in degrees). */
  riverPx: number;
  border: 'national' | 'regional';
  symbol: SymbolKind;
  symbolPx: number;
  scatter: boolean;
  labelStyle: LabelStyle;
  labelPx: number;
  vegetation: VegetationLook;
  mountains: MountainLook;
  riverSection: RiverSection;
  relief: { amount: number; shape: 'area' | 'line'; widthPx: number };
}

let revCounter = 1;

interface Snapshot {
  items: Item[];
  seed: string;
  planet: MapDoc['planet'];
  palette: MapDoc['palette'];
}

/** Document, history, selection and rendering. Tools and the UI talk to the map through this. */
export class App {
  doc: MapDoc = emptyDoc();
  cache = new GeometryCache();
  styleId: StyleId = 'parchment';
  graticule = true;
  /** Screen px per pixel-art pixel, shared by all symbols so they sit on one pixel grid. */
  pixelScale = 2;
  selection: Selection | null = null;
  defaults: Defaults = {
    rough: 0.6,
    riverPx: 3,
    border: 'national',
    symbol: 'town',
    symbolPx: 13,
    scatter: false,
    labelStyle: 'place',
    labelPx: 15,
    vegetation: { ...VEGETATION_DEFAULTS },
    mountains: { ...MOUNTAIN_DEFAULTS },
    riverSection: 'meander',
    relief: { amount: 0.5, shape: 'area', widthPx: 24 },
  };
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private listeners: (() => void)[] = [];

  constructor(readonly view: MapView) {
    this.terrain = new TerrainLayer(() => view.requestRender());
    view.onRender = (p) => drawMap(p, this.doc, this.cache, this.style, this.drawOptions());
  }

  get style() {
    return effectiveStyle(this.styleId, this.doc.palette);
  }

  /** Change one map colour (null = back to the style's). Call checkpoint() first for undo. */
  setPaletteColor(key: PaletteKey, value: string | null): void {
    const palette = { ...(this.doc.palette ?? {}) };
    if (value) palette[key] = value;
    else delete palette[key];
    this.doc.palette = palette;
    this.view.requestRender();
  }

  scaleBar = true;

  private terrain: TerrainLayer;

  /** The screen terrain layer (read-only use: status and automated checks). */
  get terrainLayerForChecks(): TerrainLayer {
    return this.terrain;
  }

  /** Options for drawing on screen; exports pass `screen = false` to render everything fresh. */
  drawOptions(screen = true) {
    return { graticule: this.graticule, scaleBar: this.scaleBar, pixelScale: this.pixelScale, onTable: screen, terrain: screen ? this.terrain : undefined, terrainSource: this.terrain };
  }

  /** Screen pixels per degree of arc at the current zoom. */
  ppd(): number {
    return this.view.projection.scale() * RAD;
  }

  /** Subscribe to document, selection and history changes (for the panels). */
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  item(id: string): Item | undefined {
    return this.doc.items.find((i) => i.id === id);
  }

  selected(): Item | null {
    return (this.selection && this.item(this.selection.id)) ?? null;
  }

  select(sel: Selection | null): void {
    this.selection = sel;
    this.view.requestOverlay();
    this.emit();
  }

  /** Call before changing the document so the change can be undone. */
  checkpoint(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Call after mutating an item in place. Revisions are never reused, so caches stay valid across undo. */
  touch(item: Item): void {
    item.rev = revCounter++;
    this.view.requestRender();
  }

  /** Add an item; it becomes the selection unless `select` is false (e.g. while scattering). */
  add(item: Item, select = true): void {
    item.rev = revCounter++;
    this.doc.items.push(item);
    this.view.requestRender();
    if (select) this.select({ id: item.id, node: null });
  }

  remove(...ids: string[]): void {
    const gone = new Set(ids);
    this.doc.items = this.doc.items.filter((i) => !gone.has(i.id));
    this.cache.prune(this.doc.items);
    if (this.selection && gone.has(this.selection.id)) this.selection = null;
    this.view.requestRender();
    this.emit();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    this.step(this.undoStack, this.redoStack);
  }

  redo(): void {
    this.step(this.redoStack, this.undoStack);
  }

  private snapshot(): Snapshot {
    return { items: cloneItems(this.doc.items), seed: this.doc.seed, planet: { ...this.doc.planet }, palette: { ...(this.doc.palette ?? {}) } };
  }

  private step(from: Snapshot[], to: Snapshot[]): void {
    const s = from.pop();
    if (!s) return;
    to.push(this.snapshot());
    this.doc.items = s.items;
    this.doc.seed = s.seed;
    this.doc.planet = s.planet;
    this.doc.palette = s.palette;
    if (this.selection && !this.item(this.selection.id)) this.selection = null;
    this.view.requestRender();
    this.emit();
  }

  setDoc(doc: MapDoc): void {
    for (const it of doc.items) it.rev = revCounter++;
    this.doc = doc;
    this.cache = new GeometryCache();
    this.selection = null;
    this.undoStack.length = this.redoStack.length = 0;
    this.view.requestRender();
    this.emit();
  }

  setPlanetRadius(radiusKm: number): void {
    this.checkpoint();
    this.doc.planet = { radiusKm };
    this.view.requestRender();
    this.emit();
  }

  setSeed(seed: string): void {
    this.checkpoint();
    this.doc.seed = seed;
    this.view.requestRender();
    this.emit();
  }
}
