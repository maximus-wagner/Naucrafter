# Pixel-art icons

Drop PNGs into these folders. The dev server picks up new files on reload.

## `tools/` — the tool palette

- **16 × 16 px**, transparent background. Shown at exactly 2×.
- File names (one per tool): `select`, `hand`, `land`, `cut` (water), `river`, `border`,
  `forest` (vegetation), `mountains`, `stamp`, `text` — e.g. `tools/river.png`.
- A missing file shows the tool's letter instead.

## `symbols/` — things you stamp on the map

- **Any size** (8–24 px tall works well), transparent background.
- The **centre** of the image sits on the spot you click.
- The file name becomes the symbol's name in the Stamp list: `castle.png` → "Castle",
  `ruined-tower.png` → "Ruined tower".
- Symbols are only ever scaled by whole numbers, so pixels stay square.

## Key colours (both folders)

These exact colours are swapped for the current map style's colours (and inverted for the
active tool), so one icon works in every style:

| Colour in your PNG | Becomes |
| --- | --- |
| `#000000` black | ink |
| `#FFFFFF` white | paper |
| `#808080` grey | shade |

Any other colour is drawn exactly as you painted it.

## Not icons: mountains and plants

Mountain ranges and vegetation (forests, jungle, shrubland, grassland) are drawn as outlines with
the Mountains and Vegetation tools and filled procedurally, at whatever pixel size the zoom needs.
Their look is set with the sliders in the properties panel, not with image files.

## Placeholders

`node scripts/make-placeholder-icons.mjs` writes simple placeholders for any missing file. It never
overwrites an existing icon.
