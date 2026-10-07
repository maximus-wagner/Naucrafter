# WorldBuilder — Living Project Doc

> **Self-improving doc.** Any Claude session working in this folder must read this file first and
> follow the "Update protocol" at the bottom before finishing. Keep it short, true, and useful.

## Goal
A web-based fantasy world builder that feels like **crafting a map by hand**, with procedural help.
Inspirations: ByAtticus (world-building process), Exanima's terrain creator, Inkarnate/Wonderdraft.
Owner is a hobbyist game dev / modder; wants both nice maps and (later) game-engine data.

**Current focus (owner, 2026-10-06): get the drawing basics right first.** Macro systems
(tectonics, terrain, climate, rivers sim, civilizations) come later and should build on the drawing.

## Status
- [x] Drawing milestone 1 (2026-10-06) — vector map editor on the sphere:
      land pen + water (cut) pen with Bézier nodes, union/cut composition, non-destructive coastline
      roughening; river pen (tapered, clipped to land); border pen (dashed); symbol stamp + scatter
      (mountain, hill, tree, town, city); text labels (region/place/water) incl. text on a curve;
      select/edit tool (move items, drag nodes/handles, add node by double-click, smooth/corner,
      delete); projections (globe, Equal Earth, Natural Earth, equirectangular, Mercator);
      styles (Parchment, Atlas, Pen & ink); undo/redo; save/open JSON; autosave; SVG + PNG export.
      Verified: `npm test` (32 unit tests) and `npm run ui-check` (real mouse/keyboard via puppeteer).
- [x] Drawing milestone 2 (2026-10-06) — owner-driven features:
      pencil drawing curve-fitted into Bézier nodes (Schneider) for all path tools; pixel-art tool icons
      and stamp symbols loaded from `src/assets/icons` (owner draws them; see its README); planet size
      (New Map dialog) + scale bar; deep zoom (×5000, coastline detail levels up to ×~50); pixel-art
      terrain layer: relief + elevation colouring over all land, mountain ranges as shaded relief with
      1–20 massifs, vegetation masses (forest/jungle/shrub/grass) with edge trees and crown marks;
      river stretches (bends, oxbow lakes, chutes, braided, rapids); interactions (rivers carve
      valleys/clearings, ranges straighten rivers with rapids, forests stop at the tree line);
      map palette + per-item colours. Verified: `npm test` (64 tests), `npm run ui-check`, screenshots.
- [x] Drawing milestone 3 (2026-10-06): puffy canopy masses (sub-puff "cauliflower" detail up close,
      no edge tree sprites); Elevation tool (raise/lower areas, ridge/valley lines) + per-land-shape
      elevation; stylised rivers (double inked banks, current strokes, white-water rapids); cached
      terrain pipeline (per-item geographic fields → height-tile pyramid with LRU + bounds-based
      invalidation → cheap screen sampling; quick frames while moving, centre-first refinement when still).
- [ ] Drawing milestone 4 — polish: multi-select, copy/paste, layers/visibility, snapping, label
      collision avoidance, stray trees around forests, ink-style hatching for relief, coast detail
      beyond ×50 zoom, terrain work in a Web Worker, cheaper ripple rendering
- [ ] Later: procedural macro systems feeding off the drawn map (see Roadmap)

## Decisions (why things are the way they are)
- **Vite + TypeScript**, no framework. `npm run dev`.
- **Pixel art for procedural features** (owner): terrain, mountains and vegetation render as one
  pixel-art image per view on a shared pixel grid ("Pixel size" setting), styled after the owner's
  references (shaded relief map; MapEffects "Old Growth Forest"). Relief + elevation colour on ALL
  land (owner choice). Coastlines, rivers, borders and labels stay vector.
- **Finalise, don't regenerate** (owner): procedural layouts are cached until the item or a
  neighbour changes. Zooming never adds elements: it enlarges or simplifies them.
- **Terrain pipeline** (owner: "fast while moving, fix details when still, centre first; don't redo
  places you've been"): `TerrainFields` = per-item geographic distance fields (coast, ranges,
  elevation edits, rivers), rebuilt only when that item changes (deferred mid-edit) →
  `HeightTiles` = 64×64 equirectangular height tiles at zoom-matched levels, LRU-cached, invalidated
  only near changed items, coarser ancestor used until computed → `TerrainFrame` = screen-space
  sampling + shading + canopy, quick (coarser pixels, ≤4×) while moving, then full detail in
  centre-first time slices. All in `src/render/terrain.ts`.
- **Draw freely** (owner): pencil strokes are curve-fitted to editable Bézier nodes; clicks still place points.
- **Vector-first, drawn shapes are the source of truth** (owner chose pen & nodes). Items live in a
  `MapDoc` (`src/doc/model.ts`): land/water shapes, rivers, borders, symbols, labels.
- **Draw directly on the sphere** (owner choice). Positions are unit vectors (Vec3); Bézier curves are
  evaluated in 3D and normalised. Saved files use [lon, lat] degrees. d3-geo does projections and
  date-line clipping.
- **Land composition**: union of land shapes minus water shapes, done with `polygon-clipping` in an
  azimuthal-equidistant projection per cluster of overlapping shapes (`src/doc/land.ts`).
  Ring convention: area on the LEFT (CCW from outside); reverse for d3 (which wants clockwise).
- **Roughening is non-destructive**: fbm noise sampled at each point's position on the planet pushes
  the outline sideways, so detail is stable while editing (`roughen` in `src/doc/geometry.ts`).
- **Sizes**: stored in degrees (scale with the map); shown/entered in screen px at the current zoom.
- **Ripples** are drawn by stroke tricks (wide ink stroke, narrower sea stroke) — no offset geometry.
- One `Painter` interface renders to canvas and SVG, so exports match the screen.
- **UI look (owner)**: simple retro "cartographer's desk" — paper/ink palette, serif type, square
  corners, 1px rules, menu bar + tool palette + properties panel + status line. No rounded/glossy
  modern-UI tropes. Don't overdo the retro either. **Physical/paper feel (owner, 2026-10-06):** panels
  are paper sheets with grain + soft layered shadows over the dark map desk; tools are keys (active =
  pressed in); sliders have brass knobs; menus/dialogs lift with big shadows. Tokens in `:root` of `src/style.css`.
- Procedural macro code from the first session is **kept but dormant** (not wired into the UI):
  `src/world/*` (sphere mesh, plates, tectonics, terrain), `src/vector/{contours,borders,extract}.ts`,
  `src/edit/cellEdits.ts`, `src/render/{globe,flatMap,raster,colors}.ts`, `src/io.ts`. Their tests
  still run. Reuse them when the macro stage starts.

## Architecture
- `src/doc/` — model, geometry (Bézier on sphere, split, rotate, roughen), land composition,
  geometry cache (keyed by item `rev`; revs are globally unique so undo can't confuse caches), io
- `src/render/` — `painter` (canvas + SVG), `styles`, `drawMap` (render order), `mapView`
  (projection, pan/zoom, base + overlay canvases)
- `src/tools/` — `base` (tool interface, hit-testing, edit overlay), `tools` (select, pens, stamp, text, hand)
- `src/app.ts` — document, selection, undo/redo, defaults; `src/main.ts` — UI wiring (menus,
  palette, properties panel, keyboard, files, autosave)
- `src/doc/` also: `fit` (stroke → Bézier), `freehand`, `regionLayout` (1–20 elements, barriers),
  `river` (stretch kinds → channels/lakes/ticks); `src/render/terrain.ts` (heightfield, relief,
  vegetation masses, TerrainLayer cache); `src/render/labels.ts` (glyph layout on the sphere);
  `src/pixel/` (procedural sprites, icon loading + key-colour swap)
- `scripts/ui-*.mjs` — puppeteer UI checks (need `npm run dev` running; `WB_URL`, `CHROME` env vars)

## Roadmap (ordered; move items up/down as priorities change)
1. Owner tries milestone 2 and draws real icons; act on feedback (milestone 3 polish)
2. Terrain from the drawing: heights inferred from coastline distance + painted mountain ranges
3. Climate & biomes on the drawn world (reuse dormant sphere-mesh code)
4. Rivers suggested procedurally, editable as normal river paths
5. Civilizations: settlement suggestions, borders, names
6. Tectonics as an optional "start from a generated world" mode
7. Regional zoom + Exanima-style terrain export (16-bit heightmaps)

## Lessons learned
_(Add one line each time something bites: bug, gotcha, user preference. Delete when obsolete.)_
- Owner changes direction quickly and sends many mid-turn requests: ask before big builds, keep a
  queue, build in small verified steps, and show screenshots.
- Another session may edit files (e.g. `style.css`, this doc) concurrently: re-read before editing,
  prefer targeted edits/appends over rewrites.
- Long node scripts: write them to the scratchpad and run them — heredocs with backticks/quotes
  inside `bash -c` can fail to parse.
- Fit freehand strokes in an azimuthal-equidistant frame, not gnomonic (stretches big strokes 4×).
- Headless `chrome --screenshot` can fire before a slow first frame; puppeteer + a short wait is reliable.
- Headless Chrome rasterises canvas on the CPU: vector stroke costs (ripples ~8 ms) look worse than on a GPU.
- The dev server on 5179 kept getting stopped (likely another session); use a different port (5182) and
  pass `WB_URL` to the UI checks.
- Sizing anything off a power-of-two lattice: use the lattice's real step, not the requested spacing.
- Dijkstra `dist` arrays must be Float64 — Float32 rounding vs Float64 heap keys skips valid entries.
- Opening an <input> from a canvas pointerdown: focus it in a setTimeout, or the browser's own
  mousedown focus handling blurs it immediately.
- Puppeteer double-click: `mouse.click(x, y, { count: 2 })` — `clickCount` only sets event.detail.
- `polygon-clipping` ESM has only a default export; `import polygonClipping from` works (bundler
  resolution allows synthetic default) even though its .d.ts declares named exports.
- Visual check without a human: headless Chrome `--screenshot` with URL params
  (`?sample=1&proj=equalEarth&style=ink&rotate=lon,lat&zoom=2&tool=select&select=0`).
- Native <select>/number spinners ignore the paper look: keep `appearance:none` + custom arrow in style.css.
- Tool icons are ink-on-transparent: never put them straight on a dark surface; keep them on paper tiles.
- `npm run build` currently fails typecheck: `selectionSection` in main.ts has no `relief` case (not from the UI restyle).
- Screen map canvas is transparent outside the map (`onTable`); exports still paint the desk colour.
- Don't put a bare `cat > file` before a heredoc in Bash — it blocks on stdin.

## Open questions for the owner
- After trying the editor: which drawing tools feel wrong or missing?
- Exanima regional editor: which features matter most (brushes? texture painting? objects)?
- Target engines and heightmap sizes for export?

## Changelog
- 2026-10-06 — Milestone 3: puffy forests, elevation editing, stylised rivers, cached/progressive terrain.
- 2026-10-06 — Drawing milestone 2: pencil, pixel icons/symbols, planet size, deep zoom, pixel-art
  terrain/relief/vegetation, river stretches, feature interactions, colours.
- 2026-10-06 — Session 1. Started as procedural plates→terrain (Vite+TS, three.js globe).
  Owner then asked for a vector-based redesign, a retro "crafting" UI, and to focus on drawing
  basics before macro systems. Rebuilt as a vector map editor on the sphere (drawing milestone 1).
- 2026-10-06 — Paper/physical UI restyle (CSS only): grain, shadows, keycap buttons (solid edge, press 3px), brass sliders, custom select/number chrome.
- 2026-10-06 — Tool desk: leather toolbox with felt trays, tools are angled paper tiles (selected = dark tile lifted, brass glow). Brass scrollbars. Custom paper colour card (`src/colorPicker.ts`) replaces the OS colour dialog; `scripts/ui-colorpicker.mjs` checks it.
- 2026-10-06 — Table-top: wood-plank table behind the map (map canvas transparent on screen, drop shadow; desk colour tints it), and a toolbox/"tools on the table" switch (View menu or brass tag; `src/tableTools.ts`, remembered in localStorage). `scripts/ui-table.mjs` checks it.

---

## Update protocol (do this at the end of every session)
1. **Status:** tick/untick items to match reality. Never claim something works unless it was run.
2. **Changelog:** add one dated line describing what changed.
3. **Lessons learned:** add any new gotcha or owner preference; merge duplicates; remove stale ones.
4. **Roadmap:** re-rank based on what the owner asked for most recently.
5. **Open questions:** add anything blocking a decision; remove answered ones (record the answer under Decisions).
6. **Prune:** if this doc exceeds ~150 lines, condense — old changelog entries first.
7. **Improve the protocol itself:** if a step here was useless or something was missing, edit this section.
