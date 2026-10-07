import type { MapStyle } from '../render/styles';
import { stylePalette, type RGBA } from './palette';

// Your pixel art lives in src/assets/icons (see the README there). New files are picked up
// automatically by the dev server.
const TOOL_FILES = import.meta.glob('../assets/icons/tools/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const SYMBOL_FILES = import.meta.glob('../assets/icons/symbols/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.png$/i, '');
const toolUrls = new Map(Object.entries(TOOL_FILES).map(([p, url]) => [baseName(p), url]));
const symbolUrls = new Map(Object.entries(SYMBOL_FILES).map(([p, url]) => [baseName(p), url]));
const images = new Map<string, HTMLImageElement>();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${url}`));
    img.src = url;
  });
}

/** Load every icon file once at startup. Broken files are skipped (and reported in the console). */
export async function loadIcons(): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const [kind, urls] of [['tool', toolUrls], ['symbol', symbolUrls]] as const) {
    for (const [name, url] of urls) {
      jobs.push(loadImage(url).then((img) => void images.set(`${kind}:${name}`, img), (e) => console.warn(e.message)));
    }
  }
  await Promise.all(jobs);
}

export function userSymbolNames(): string[] {
  return [...symbolUrls.keys()].filter((n) => images.has(`symbol:${n}`)).sort();
}

export const prettyName = (name: string) => name.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Key colours in your pixel art: pure black = ink, pure white = paper, #808080 = shade. */
const KEYS = { ink: 0x000000, paper: 0xffffff, shade: 0x808080 };

function recolor(img: HTMLImageElement, colors: { ink: RGBA; paper: RGBA; shade: RGBA }): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const d = data.data;
  const swap = new Map<number, RGBA>([[KEYS.ink, colors.ink], [KEYS.paper, colors.paper], [KEYS.shade, colors.shade]]);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const to = swap.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    if (to) {
      d[i] = to[0];
      d[i + 1] = to[1];
      d[i + 2] = to[2];
    }
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

const recolored = new Map<string, HTMLCanvasElement>();

export function userSymbolCanvas(name: string, style: MapStyle): HTMLCanvasElement | null {
  const img = images.get(`symbol:${name}`);
  if (!img) return null;
  const key = `${name}|${style.id}`;
  let c = recolored.get(key);
  if (!c) {
    const [, ink, paper, shade] = stylePalette(style);
    recolored.set(key, (c = recolor(img, { ink, paper, shade })));
  }
  return c;
}

/** A tool icon recoloured for the UI (normal or inverted for the active tool). */
export function toolIcon(name: string, colors: { ink: RGBA; paper: RGBA; shade: RGBA }): HTMLCanvasElement | null {
  const img = images.get(`tool:${name}`);
  return img ? recolor(img, colors) : null;
}
