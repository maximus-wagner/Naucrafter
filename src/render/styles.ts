import type { Palette } from '../doc/model';

export type StyleId = 'parchment' | 'atlas' | 'ink';

export interface MapStyle {
  /** Preset id, plus a suffix when colours are overridden (caches key on it). */
  id: string;
  name: string;
  /** Around the sheet (outside the world outline). */
  desk: string;
  sea: string;
  land: string;
  ink: string;
  coastWidth: number;
  /** Lines echoing the coast out to sea, offset in px. */
  ripples: { offset: number; opacity: number }[];
  river: string;
  border: string;
  graticule: { color: string; opacity: number; dash: number[] } | null;
  grain: number;
  symbolInk: string;
  symbolPaper: string;
  font: string;
  label: string;
  waterLabel: string;
}


/** A preset with the map's own colours on top. */
export function effectiveStyle(id: StyleId, palette: Palette | undefined): MapStyle {
  const base = STYLES[id];
  const entries = Object.entries(palette ?? {}).filter(([, v]) => !!v);
  if (!entries.length) return base;
  const style: MapStyle = { ...base, ...Object.fromEntries(entries), id: `${base.id}~${entries.map(([k, v]) => k + v).join('')}` };
  // Symbol paper follows the land unless set separately.
  if (palette?.land && !palette.symbolPaper) style.symbolPaper = palette.land;
  return style;
}

/** Same style with a different ink (for an item with its own colour). */
export function withInk(style: MapStyle, color: string | undefined): MapStyle {
  return color ? { ...style, symbolInk: color, id: `${style.id}|${color}` } : style;
}

const SERIF = '"Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif';

export const STYLES: Record<StyleId, MapStyle> = {
  parchment: {
    id: 'parchment',
    name: 'Parchment',
    desk: '#2c2c2e',
    sea: '#d8c9a3',
    land: '#eee2c2',
    ink: '#3b2a1a',
    coastWidth: 1.5,
    ripples: [
      { offset: 13, opacity: 0.12 },
      { offset: 8.5, opacity: 0.2 },
      { offset: 4.5, opacity: 0.32 },
    ],
    river: '#3b2a1a',
    border: '#8a3220',
    graticule: { color: '#3b2a1a', opacity: 0.2, dash: [1, 3] },
    grain: 0.55,
    symbolInk: '#3b2a1a',
    symbolPaper: '#eee2c2',
    font: SERIF,
    label: '#3b2a1a',
    waterLabel: '#5b4a35',
  },
  atlas: {
    id: 'atlas',
    name: 'Atlas',
    desk: '#2b2e31',
    sea: '#bcd3dc',
    land: '#f3eedd',
    ink: '#34414b',
    coastWidth: 1,
    ripples: [
      { offset: 6, opacity: 0.18 },
      { offset: 3, opacity: 0.3 },
    ],
    river: '#4a7fa0',
    border: '#9b4130',
    graticule: { color: '#ffffff', opacity: 0.55, dash: [] },
    grain: 0,
    symbolInk: '#3d4650',
    symbolPaper: '#f3eedd',
    font: SERIF,
    label: '#2d3640',
    waterLabel: '#3f6e8c',
  },
  ink: {
    id: 'ink',
    name: 'Pen & ink',
    desk: '#2a2a28',
    sea: '#faf8f2',
    land: '#faf8f2',
    ink: '#1c1b19',
    coastWidth: 1.7,
    ripples: [
      { offset: 15, opacity: 0.16 },
      { offset: 10, opacity: 0.26 },
      { offset: 5, opacity: 0.42 },
    ],
    river: '#1c1b19',
    border: '#1c1b19',
    graticule: null,
    grain: 0.2,
    symbolInk: '#1c1b19',
    symbolPaper: '#faf8f2',
    font: SERIF,
    label: '#1c1b19',
    waterLabel: '#1c1b19',
  },
};
