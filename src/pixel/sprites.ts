import { hashString } from '../core/rng';
import type { MapStyle } from '../render/styles';
import { colorize, hillSprite, mountainSprite, treeSprite, type IndexSprite } from './procedural';
import { stylePalette } from './palette';
import { prettyName, userSymbolCanvas, userSymbolNames } from './icons';

/**
 * Single procedural symbols, kept so older maps with stamped mountains/trees still draw. New maps
 * use forest and mountain regions instead. `heightFactor` turns half-width into height.
 */
const PROCEDURAL: Record<string, { name: string; heightFactor: number; make: (h: number, variant: number) => IndexSprite }> = {
  mountain: { name: 'Mountain', heightFactor: 1.15, make: mountainSprite },
  hill: { name: 'Hill', heightFactor: 0.7, make: hillSprite },
  tree: { name: 'Tree', heightFactor: 1.5, make: treeSprite },
};

const VARIANTS = 16;

/** Each placed symbol gets a stable variant, so a forest isn't a field of clones. */
export const variantOf = (id: string) => hashString(id) % VARIANTS;

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** Screen px per sprite pixel. */
  scale: number;
}

const cache = new Map<string, HTMLCanvasElement>();

/** Colour an index sprite with a map style's ink, paper and shade. */
export function indexSpriteCanvas(s: IndexSprite, style: MapStyle): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = s.w;
  c.height = s.h;
  c.getContext('2d')!.putImageData(new ImageData(colorize(s, stylePalette(style)), s.w, s.h), 0, 0);
  return c;
}

/**
 * The sprite for a symbol of `sizePx` (half-width on screen). Procedural symbols are generated at
 * exactly that size on the shared pixel grid; your own PNGs are scaled by whole numbers only.
 */
export function symbolSprite(kind: string, sizePx: number, pixelScale: number, variant: number, style: MapStyle): Sprite | null {
  const proc = PROCEDURAL[kind];
  if (proc) {
    const h = Math.max(2, Math.min(96, Math.round((sizePx * proc.heightFactor) / pixelScale)));
    const key = `${kind}|${h}|${variant}|${style.id}`;
    let c = cache.get(key);
    if (!c) {
      if (cache.size > 4000) cache.clear();
      cache.set(key, (c = indexSpriteCanvas(proc.make(h, variant), style)));
    }
    return { canvas: c, scale: pixelScale };
  }
  const c = userSymbolCanvas(kind, style);
  if (!c) return null;
  const k = Math.max(1, Math.round((sizePx * 2) / (c.width * pixelScale)));
  return { canvas: c, scale: k * pixelScale };
}

/** [id, display name] for every symbol the stamp can place: your PNG symbols. */
export function symbolChoices(): [string, string][] {
  return userSymbolNames().filter((n) => !PROCEDURAL[n]).map((n): [string, string] => [n, prettyName(n)]);
}
