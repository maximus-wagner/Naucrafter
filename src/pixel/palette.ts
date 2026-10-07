import type { MapStyle } from '../render/styles';

export type RGBA = [number, number, number, number];

export function hexToRgba(hex: string): RGBA {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return [0, 1, 2, 3].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGBA;
}

/** Colours for palette indices EMPTY, INK, PAPER, SHADE, SNOW (see procedural.ts). */
export function stylePalette(style: MapStyle): RGBA[] {
  const ink = hexToRgba(style.symbolInk), paper = hexToRgba(style.symbolPaper);
  return [[0, 0, 0, 0], ink, paper, mix(paper, ink, 0.38), mix(paper, [255, 255, 255, 255], 0.65)];
}
