import './style.css';
import { App } from './app';
import { MapView, PROJECTIONS, type ProjectionId } from './render/mapView';
import { STYLES, type StyleId } from './render/styles';
import { CanvasPainter, SvgPainter } from './render/painter';
import { drawMap } from './render/drawMap';
import { parseDoc, sampleDoc, serializeDoc } from './doc/io';
import { EARTH_RADIUS_KM, emptyDoc, isPathItem, pathOf, type Item, type Label, type LabelStyle, type MountainLook, type PaletteKey, type RiverSection, type RiverShape, type VegetationKind, type VegetationLook, type VPath } from './doc/model';
import { RIVER_SECTIONS } from './doc/river';
import { setSmooth } from './doc/geometry';
import { fromLonLat, toLonLat } from './vector/geo';
import { HandTool, PenTool, SelectTool, StampTool, TextTool } from './tools/tools';
import { MeasureTool } from './tools/measure';
import { TRAVEL, compass, flatRingAreaKm2, formatArea, formatDays, formatDistance, lineLengthKm } from './doc/measure';
import { type Tool, type ToolEvent, type ToolHost, type ToolId } from './tools/base';
import { loadIcons } from './pixel/icons';
import { symbolChoices } from './pixel/sprites';
import { colorWell } from './colorPicker';
import { buildTableTools } from './tableTools';
import { labelSpan } from './render/labels';
import { wireUiSounds, play } from './sound';

wireUiSounds();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const AUTOSAVE_KEY = 'naucrafter.autosave';
const LEGACY_AUTOSAVE_KEY = 'worldbuilder.autosave';

const view = new MapView($('viewport'));
const app = new App(view);

// ---------------------------------------------------------------- tools

function editText(initial: string, x: number, y: number, done: (text: string | null) => void): void {
  const input = $<HTMLInputElement>('text-editor');
  input.value = initial;
  input.style.left = `${x}px`;
  input.style.top = `${y}px`;
  input.classList.remove('hidden');
  // Focus after the current pointer event, or the browser's own focus handling takes it away.
  setTimeout(() => {
    input.focus();
    input.select();
  });
  let finished = false;
  const finish = (value: string | null) => {
    if (finished) return;
    finished = true;
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', onBlur);
    input.classList.add('hidden');
    done(value === null ? null : value.trim());
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(input.value);
    else if (e.key === 'Escape') finish(null);
  };
  const onBlur = () => finish(input.value);
  input.addEventListener('keydown', onKey);
  setTimeout(() => input.addEventListener('blur', onBlur));
}

let hintTimer = 0;
function notify(message: string): void {
  $('hint').textContent = message;
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => ($('hint').textContent = tool.hint), 4000);
}

const host: ToolHost = {
  app,
  editText,
  notify,
  refresh: () => renderProps(),
  setCursor: (c) => {
    if (!pan && !spaceHeld) view.overlay.style.cursor = c ?? tool.cursor;
  },
};
const measure = new MeasureTool(host);
const tools: Record<ToolId, Tool> = {
  select: new SelectTool(host),
  hand: new HandTool(),
  measure,
  land: new PenTool(host, 'land'),
  cut: new PenTool(host, 'cut'),
  river: new PenTool(host, 'river'),
  border: new PenTool(host, 'border'),
  forest: new PenTool(host, 'forest'),
  mountains: new PenTool(host, 'mountains'),
  relief: new PenTool(host, 'relief'),
  stamp: new StampTool(host),
  text: new TextTool(host),
};
const SHORTCUTS: Record<string, ToolId> = { v: 'select', h: 'hand', d: 'measure', l: 'land', w: 'cut', r: 'river', b: 'border', f: 'forest', m: 'mountains', e: 'relief', s: 'stamp', t: 'text' };
let tool: Tool = tools.select;

function setTool(id: ToolId): void {
  if (tool.id !== id) tool.deactivate?.();
  tool = tools[id];
  for (const b of document.querySelectorAll<HTMLElement>('[data-tool]')) b.classList.toggle('active', b.dataset.tool === id);
  view.overlay.style.cursor = tool.cursor;
  $('hint').textContent = tool.hint;
  view.requestOverlay();
  renderProps();
}
buildTableTools($('tabletools'));
for (const b of document.querySelectorAll<HTMLElement>('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool as ToolId));

function setDesk(): void {
  $('viewport').style.setProperty('--desk', app.style.desk);
}

view.onOverlay = (p) => tool.overlay?.(p);

// ---------------------------------------------------------------- pointer & keys

let pan: { x: number; y: number } | null = null;
let spaceHeld = false;

function toolEvent(e: MouseEvent): ToolEvent {
  const [x, y] = view.eventPos(e);
  const geo = view.toGeo(x, y);
  return { x, y, geo, v: geo && fromLonLat(geo), shift: e.shiftKey, alt: e.altKey, buttons: e.buttons };
}

function showCoords(e: MouseEvent | null): void {
  const geo = e && view.toGeo(...view.eventPos(e));
  const fmt = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2).padStart(6, ' ')}° ${v >= 0 ? pos : neg}`;
  $('coords').textContent = geo ? `${fmt(geo[1], 'N', 'S')}  ${fmt(geo[0], 'E', 'W')}` : '';
}

let propsTimer = 0;
view.onViewChange = () => {
  $('zoom').textContent = `×${view.zoom().toFixed(1)}`;
  // Sizes in the panel are shown at the current zoom, so refresh it once the view settles.
  clearTimeout(propsTimer);
  propsTimer = window.setTimeout(renderProps, 200);
};

const overlay = view.overlay;
overlay.addEventListener('pointerdown', (e) => {
  closeMenus();
  overlay.setPointerCapture(e.pointerId);
  if (e.button === 1 || e.button === 2 || (e.button === 0 && (tool.id === 'hand' || spaceHeld))) {
    pan = { x: e.clientX, y: e.clientY };
    overlay.style.cursor = 'grabbing';
    return;
  }
  if (e.button === 0) tool.down?.(toolEvent(e));
});
overlay.addEventListener('pointermove', (e) => {
  showCoords(e);
  if (pan) {
    view.panBy(e.clientX - pan.x, e.clientY - pan.y);
    pan = { x: e.clientX, y: e.clientY };
    return;
  }
  tool.move?.(toolEvent(e));
});
const endPointer = (e: PointerEvent) => {
  if (pan) {
    pan = null;
    overlay.style.cursor = spaceHeld ? 'grab' : tool.cursor;
    return;
  }
  tool.up?.(toolEvent(e));
};
overlay.addEventListener('pointerup', endPointer);
overlay.addEventListener('pointercancel', endPointer);
overlay.addEventListener('pointerleave', () => showCoords(null));
overlay.addEventListener('dblclick', (e) => tool.dblclick?.(toolEvent(e)));

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement && t.type === 'text') return;
  if (t instanceof HTMLSelectElement) return;
  const key = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    const cmd = { z: e.shiftKey ? 'redo' : 'undo', y: 'redo', s: 'save', o: 'open' }[key];
    if (cmd) {
      e.preventDefault();
      run(cmd);
    }
    return;
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (!spaceHeld) {
      spaceHeld = true;
      overlay.style.cursor = 'grab';
    }
    return;
  }
  if (tool.key?.(e)) {
    e.preventDefault();
    return;
  }
  if (!e.altKey && SHORTCUTS[key]) setTool(SHORTCUTS[key]);
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceHeld = false;
    if (!pan) overlay.style.cursor = tool.cursor;
  }
});

// ---------------------------------------------------------------- menus & commands

function closeMenus(): void {
  for (const m of document.querySelectorAll('.menu.open')) m.classList.remove('open');
}

for (const menu of document.querySelectorAll<HTMLElement>('.menu')) {
  const title = menu.querySelector<HTMLElement>('.menu-title')!;
  title.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.classList.contains('open');
    closeMenus();
    if (!open) {
      refreshMenus();
      menu.classList.add('open');
    }
  });
  title.addEventListener('mouseenter', () => {
    if (document.querySelector('.menu.open') && !menu.classList.contains('open')) {
      closeMenus();
      refreshMenus();
      menu.classList.add('open');
    }
  });
}
document.addEventListener('click', closeMenus);
for (const b of document.querySelectorAll<HTMLElement>('[data-cmd]')) {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenus();
    run(b.dataset.cmd!);
  });
}

function refreshMenus(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cmd]')) {
    const cmd = b.dataset.cmd!;
    if (cmd.startsWith('proj:')) b.classList.toggle('checked', view.projectionId === cmd.slice(5));
    if (cmd.startsWith('style:')) b.classList.toggle('checked', app.styleId === cmd.slice(6));
    if (cmd === 'graticule') b.classList.toggle('checked', app.graticule);
    if (cmd === 'scalebar') b.classList.toggle('checked', app.scaleBar);
    if (cmd === 'undo') b.disabled = !app.canUndo();
    if (cmd === 'redo') b.disabled = !app.canRedo();
    if (cmd === 'delete') b.disabled = !app.selection;
  }
}

function download(data: Blob, filename: string): void {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function deleteSelection(): void {
  const sel = app.selected();
  if (!sel) return;
  app.checkpoint();
  app.remove(sel.id);
}

function run(cmd: string): void {
  if (cmd.startsWith('proj:')) {
    view.setProjection(cmd.slice(5) as ProjectionId);
    renderProps();
    return;
  }
  if (cmd.startsWith('style:')) {
    setStyle(cmd.slice(6) as StyleId);
    return;
  }
  switch (cmd) {
    case 'new':
      openNewMapDialog();
      break;
    case 'open':
      $('file-input').click();
      break;
    case 'sample':
      if (app.doc.items.length && !confirm('Open the sample map? Anything unsaved will be lost.')) return;
      app.setDoc(sampleDoc());
      break;
    case 'save':
      download(new Blob([serializeDoc(app.doc)], { type: 'application/json' }), 'map.worldmap.json');
      break;
    case 'export-svg': {
      const p = new SvgPainter(view.projection, view.width, view.height);
      drawMap(p, app.doc, app.cache, app.style, app.drawOptions(false));
      download(new Blob([p.toString()], { type: 'image/svg+xml' }), 'map.svg');
      break;
    }
    case 'export-png': {
      const scale = 3;
      const canvas = document.createElement('canvas');
      canvas.width = view.width * scale;
      canvas.height = view.height * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(scale, scale);
      drawMap(new CanvasPainter(view.projection, ctx, view.width, view.height), app.doc, app.cache, app.style, app.drawOptions(false));
      canvas.toBlob((b) => b && download(b, 'map.png'));
      break;
    }
    case 'undo':
      app.undo();
      break;
    case 'redo':
      app.redo();
      break;
    case 'delete':
      deleteSelection();
      break;
    case 'scalebar':
      app.scaleBar = !app.scaleBar;
      view.requestRender();
      break;
    case 'graticule':
      app.graticule = !app.graticule;
      view.requestRender();
      renderProps();
      break;
    case 'reset-view':
      view.resetView();
      break;
  }
}

$('file-input').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    app.setDoc(parseDoc(await file.text()));
  } catch (err) {
    play('fail');
    alert(`Could not open that file: ${err instanceof Error ? err.message : err}`);
  }
});

function setStyle(id: StyleId): void {
  app.styleId = id;
  setDesk();
  view.requestRender();
  renderProps();
}

// ---------------------------------------------------------------- new map dialog

const PLANETS: [string, number][] = [
  ['Moon-sized', 1737],
  ['Mars-sized', 3390],
  ['Earth-sized', EARTH_RADIUS_KM],
  ['Super-Earth', 9500],
  ['Custom', 0],
];

function describePlanet(radiusKm: number): string {
  const equator = Math.round(2 * Math.PI * radiusKm).toLocaleString('en');
  const area = ((4 * Math.PI * radiusKm * radiusKm) / 1e6).toLocaleString('en', { maximumFractionDigits: 1 });
  return `Equator ${equator} km · surface ${area} million km² (Earth: 40,030 km · 510)`;
}

function openNewMapDialog(): void {
  const dialog = $<HTMLDialogElement>('new-map');
  const preset = $<HTMLSelectElement>('nm-preset');
  const radius = $<HTMLInputElement>('nm-radius');
  const info = $('nm-info');
  preset.replaceChildren(...PLANETS.map(([name, r]) => el('option', { value: String(r) }, r ? `${name} (${r.toLocaleString('en')} km)` : name)));
  preset.value = String(EARTH_RADIUS_KM);
  radius.value = String(EARTH_RADIUS_KM);
  const update = () => (info.textContent = Number(radius.value) >= 100 ? describePlanet(Number(radius.value)) : 'Radius must be at least 100 km.');
  preset.onchange = () => {
    if (Number(preset.value)) radius.value = preset.value;
    update();
  };
  radius.oninput = () => {
    preset.value = PLANETS.some(([, r]) => r === Number(radius.value)) ? radius.value : '0';
    update();
  };
  update();
  dialog.onclose = () => {
    if (dialog.returnValue !== 'create') return;
    const r = Number(radius.value);
    if (!(r >= 100)) return;
    app.setDoc(emptyDoc(r));
    view.resetView();
  };
  dialog.returnValue = '';
  dialog.showModal();
}

// ---------------------------------------------------------------- properties panel

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function section(title: string, ...children: Node[]): HTMLElement {
  return el('div', { className: 'section' }, el('h3', {}, title), ...children);
}

function row(label: string, control: Node): HTMLElement {
  return el('div', { className: 'row' }, el('span', {}, label), control);
}

/** A slider; `set` runs live while dragging. With `undoable`, one undo step covers the whole drag. */
function slider(min: number, max: number, step: number, value: number, set: (v: number) => void, format: (v: number) => string, undoable = false): HTMLElement {
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = el('output', {}, format(value));
  let pending = false;
  input.addEventListener('input', () => {
    if (undoable && !pending) {
      app.checkpoint();
      pending = true;
    }
    set(Number(input.value));
    out.textContent = format(Number(input.value));
  });
  input.addEventListener('change', () => (pending = false));
  return el('div', { className: 'slider' }, input, out);
}

function segmented<T extends string>(options: [T, string][], value: T, set: (v: T) => void): HTMLElement {
  const wrap = el('div', { className: 'seg' });
  for (const [v, label] of options) {
    const b = el('button', { className: v === value ? 'on' : '' }, label);
    b.addEventListener('click', () => set(v));
    wrap.append(b);
  }
  return wrap;
}

function select<T extends string>(options: [T, string][], value: T, set: (v: T) => void): HTMLElement {
  const s = el('select');
  for (const [v, label] of options) s.append(el('option', { value: v, selected: v === value }, label));
  s.addEventListener('change', () => set(s.value as T));
  return s;
}

function button(label: string, onClick: () => void): HTMLElement {
  const b = el('button', { className: 'btn' }, label);
  b.addEventListener('click', onClick);
  return b;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const px = (v: number) => `${Math.round(v)} px`;
const times = (v: number) => `${v.toFixed(2)}×`;
const signedPct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
const LABEL_PX: Record<LabelStyle, number> = { region: 22, place: 15, water: 18 };
const LABEL_STYLES: [LabelStyle, string][] = [['region', 'Region'], ['place', 'Place'], ['water', 'Water']];

/** Where look changes go: the tool's defaults (no undo) or a selected area (undoable, redraws). */
interface LookTarget {
  undoable: boolean;
  changed: () => void;
}

const VEGETATION_TYPES: [VegetationKind, string][] = [
  ['broadleaf', 'Broadleaf forest'],
  ['conifer', 'Conifer forest'],
  ['mixed', 'Mixed forest'],
  ['jungle', 'Jungle'],
  ['shrubs', 'Shrubland'],
  ['grass', 'Grassland'],
];

function lookSlider<T>(look: T, key: keyof T & string, min: number, max: number, format: (v: number) => string, t: LookTarget): HTMLElement {
  return slider(min, max, 0.05, look[key] as number, (v) => {
    (look[key] as number) = v;
    t.changed();
  }, format, t.undoable);
}

function lookChoice(t: LookTarget, apply: () => void): void {
  if (t.undoable) app.checkpoint();
  apply();
  t.changed();
  renderProps();
}

function vegetationRows(look: VegetationLook, t: LookTarget): HTMLElement[] {
  return [
    row('Type', select(VEGETATION_TYPES, look.vegetation, (v) => lookChoice(t, () => (look.vegetation = v)))),
    row('Size', lookSlider(look, 'scale', 0.4, 3, times, t)),
    row('Height', lookSlider(look, 'height', 0.4, 2.5, times, t)),
    row('Density', lookSlider(look, 'density', 0.4, 2.5, times, t)),
    row('Variety', lookSlider(look, 'variety', 0, 1, pct, t)),
    row('Edge', lookSlider(look, 'rough', 0, 2, pct, t)),
  ];
}

function mountainRows(look: MountainLook, t: LookTarget): HTMLElement[] {
  const foothills = el('input', { type: 'checkbox', checked: look.foothills });
  foothills.addEventListener('change', () => lookChoice(t, () => (look.foothills = foothills.checked)));
  return [
    row('Size', lookSlider(look, 'scale', 0.4, 3, times, t)),
    row('Height', lookSlider(look, 'height', 0.4, 2.5, times, t)),
    row('Ruggedness', lookSlider(look, 'ruggedness', 0, 1, pct, t)),
    row('Snow', lookSlider(look, 'snow', 0, 0.6, pct, t)),
    row('Density', lookSlider(look, 'density', 0.4, 2.5, times, t)),
    row('Foothills', foothills),
    row('Edge', lookSlider(look, 'rough', 0, 2, pct, t)),
  ];
}

/** Edit a property of the selected item: one undo step, then re-render. */
function editItem<T extends Item>(item: T, fn: (item: T) => void): void {
  app.checkpoint();
  fn(item);
  app.touch(item);
  renderProps();
}

function measureSection(): HTMLElement {
  const r = measure.readout();
  const u = measure.units;
  const units = row('Units', segmented<'km' | 'mi'>([['km', 'Kilometres'], ['mi', 'Miles']], u, (v) => (measure.setUnits(v), renderProps())));
  if (!r.points) {
    return section('Measure', units, el('p', { className: 'note' }, `Click points across the map to measure along the way. Distances are real ones for this planet (radius ${app.doc.planet.radiusKm.toLocaleString('en')} km) and follow the curve of the world. Points snap to towns and path nodes.`));
  }
  const out = (text: string) => el('output', {}, text);
  const rows: HTMLElement[] = [units];
  if (r.legsKm.length) {
    rows.push(row(r.closed ? 'Perimeter' : 'Distance', out(formatDistance(r.totalKm, u))));
    if (r.legsKm.length > 1) {
      r.legsKm.slice(0, 8).forEach((km, i) => rows.push(row(`Leg ${i + 1}`, out(formatDistance(km, u)))));
      if (r.legsKm.length > 8) rows.push(row('…', out(`${r.legsKm.length - 8} more`)));
    }
    if (r.bearing !== null) rows.push(row('Heading', out(`${compass(r.bearing)} · ${Math.round(r.bearing)}°`)));
    if (r.areaKm2 !== null) rows.push(row('Area', out(formatArea(r.areaKm2, u))));
    for (const t of TRAVEL) rows.push(row(t.label, out(formatDays(r.totalKm / t.kmPerDay))));
  }
  rows.push(
    el('p', { className: 'note' }, r.legsKm.length ? 'Travel times are rough, straight along the line at 30, 60 and 150 km a day. Drag a point to adjust it.' : 'Click again, or drag, to measure to a second point.'),
    el('div', { className: 'buttons' }, button('Clear', () => measure.clear())),
  );
  return section('Measure', ...rows);
}

function toolSection(): HTMLElement | null {
  const d = app.defaults;
  switch (tool.id) {
    case 'measure':
      return measureSection();
    case 'land':
    case 'cut':
      return section('New shapes', row('Roughness', slider(0, 2, 0.05, d.rough, (v) => (d.rough = v), pct)));
    case 'river':
      return section(
        'New rivers',
        row('Mode', segmented([['draw', 'Draw'], ['spring', 'Spring']], d.riverMode, (v) => ((d.riverMode = v), ($('hint').textContent = tool.hint), renderProps()))),
        row('Mouth width', slider(1, 16, 0.5, d.riverPx, (v) => (d.riverPx = v), px)),
        ...(d.riverMode === 'draw' ? [row('Stretches', select(RIVER_SECTIONS, d.riverSection, (v) => (d.riverSection = v)))] : []),
        row('Wobble', slider(0, 2, 0.05, d.rough, (v) => (d.rough = v), pct)),
        el('p', { className: 'note' }, d.riverMode === 'spring' ? 'Click land to place a spring. The river finds its own way down: it never climbs a ridge, leaves a basin by its lowest pass, runs fast and straight through steep country, bends and leaves oxbows on the flats, and joins a river it meets. Stretches are set from the slope.' : 'Draw a river by hand from source to mouth, or switch to Spring to have one generated from a point.'),
      );
    case 'forest':
      return section('New vegetation', ...vegetationRows(d.vegetation, { undoable: false, changed: () => {} }));
    case 'mountains':
      return section('New mountain ranges', ...mountainRows(d.mountains, { undoable: false, changed: () => {} }));
    case 'relief':
      return section(
        'Elevation',
        row('Shape', segmented([['area', 'Area'], ['line', 'Ridge / valley'], ], d.relief.shape, (v) => ((d.relief.shape = v), renderProps()))),
        row('Lower · raise', slider(-1, 1, 0.05, d.relief.amount, (v) => (d.relief.amount = v), signedPct)),
        row(d.relief.shape === 'area' ? 'Soft edge' : 'Width', slider(4, 120, 1, d.relief.widthPx, (v) => (d.relief.widthPx = v), px)),
        el('p', { className: 'note' }, 'Draw an area to raise hills and plateaus or lower basins and lowlands, or a line for a ridge or a valley. Negative values lower the land.'),
      );
    case 'border':
      return section('New borders', row('Line', segmented([['national', 'National'], ['regional', 'Regional']], d.border, (v) => ((d.border = v), renderProps()))));
    case 'stamp': {
      const scatter = el('input', { type: 'checkbox', checked: d.scatter });
      scatter.addEventListener('change', () => (d.scatter = scatter.checked));
      return section(
        'Stamp',
        row('Symbol', select(symbolChoices(), d.symbol, (v) => ((d.symbol = v), view.requestOverlay()))),
        row('Size', slider(4, 60, 1, d.symbolPx, (v) => ((d.symbolPx = v), view.requestOverlay()), px)),
        row('Scatter', scatter),
        el('p', { className: 'note' }, 'Scatter paints a loose cluster as you drag. Alt-drag erases.'),
      );
    }
    case 'text':
      return section(
        'New labels',
        row('Style', segmented(LABEL_STYLES, d.labelStyle, (v) => ((d.labelStyle = v), (d.labelPx = LABEL_PX[v]), renderProps()))),
        row('Size', slider(6, 80, 1, d.labelPx, (v) => (d.labelPx = v), px)),
        el('p', { className: 'note' }, 'Sizes are as they look at the current zoom; labels and symbols scale with the map.'),
      );
    default:
      return null;
  }
}

/** Replace a river's course with the way water would really flow from its source. */
function rerouteDownhill(river: RiverShape): void {
  const geo = toLonLat(...river.path.nodes[0].p);
  if (!app.generateRiver(geo, river)) notify('This river starts in the water, so it has no downhill course to follow.');
  else renderProps();
}

/** Give a straight label a gentle curve the user can then bend with the Select tool. */
function curveLabel(label: Label): void {
  const { start, mid, end } = labelSpan(label, app.style);
  const path: VPath = { closed: false, nodes: [start, mid, end].map((p) => ({ p, hin: null, hout: null })) };
  for (let i = 0; i < 3; i++) setSmooth(path, i, true);
  editItem(label, (l) => (l.path = path));
}

function selectionSection(item: Item): HTMLElement {
  const del = button('Delete', deleteSelection);
  const live = (fn: () => void) => () => {
    fn();
    app.touch(item);
  };
  switch (item.kind) {
    case 'land':
      return section(
        item.op === 'add' ? 'Land shape' : 'Water shape',
        row('Kind', segmented([['add', 'Land'], ['cut', 'Water']], item.op, (v) => editItem(item, (i) => (i.op = v)))),
        row('Roughness', slider(0, 2, 0.05, item.rough, (v) => live(() => (item.rough = v))(), pct, true)),
        ...(item.op === 'add' ? [row('Elevation', slider(-1, 1, 0.05, item.elevation ?? 0, (v) => live(() => (item.elevation = v))(), signedPct, true))] : []),
        itemColor(item, item.op === 'add' ? 'Fill' : 'Water', item.op === 'add' ? app.style.land : app.style.sea),
        el('p', { className: 'note' }, `${item.path.nodes.length} nodes. Roughening adds coastline detail without moving your nodes.`),
        el('div', { className: 'buttons' }, del),
      );
    case 'river': {
      const node = app.selection?.node ?? null;
      const stretchCount = item.path.nodes.length - 1;
      const kinds = new Set(item.path.nodes.slice(0, stretchCount).map((n) => n.section ?? 'plain'));
      const stretch =
        node !== null && node < stretchCount
          ? row(`Stretch ${node + 1}`, select(RIVER_SECTIONS, item.path.nodes[node].section ?? 'plain', (v) => editItem(item, (i) => (i.path.nodes[node].section = v))))
          : row('All stretches', select(kinds.size === 1 ? RIVER_SECTIONS : [['mixed' as RiverSection, 'Mixed'], ...RIVER_SECTIONS], kinds.size === 1 ? [...kinds][0] : ('mixed' as RiverSection), (v) => {
              if ((v as string) !== 'mixed') editItem(item, (i) => i.path.nodes.forEach((n) => (n.section = v)));
            }));
      return section(
        'River',
        row('Mouth width', slider(0.5, 20, 0.5, item.width * app.ppd(), (v) => live(() => (item.width = v / app.ppd()))(), px, true)),
        stretch,
        row('Wobble', slider(0, 2, 0.05, item.rough, (v) => live(() => (item.rough = v))(), pct, true)),
        itemColor(item, 'Colour', app.style.river),
        el('p', { className: 'note' }, node !== null && node < stretchCount ? 'Sets the stretch from this node to the next.' : 'Click a node of the river to set the stretch that starts there. Rivers run straight with rapids through mountains, and carve valleys and clearings.'),
        el('div', { className: 'buttons' }, button('Reverse direction', () => editItem(item, (i) => reversePath(i.path))), button('Flow downhill from source', () => rerouteDownhill(item)), del),
      );
    }
    case 'border':
      return section(
        'Border',
        row('Line', segmented([['national', 'National'], ['regional', 'Regional']], item.line, (v) => editItem(item, (i) => (i.line = v)))),
        itemColor(item, 'Colour', app.style.border),
        el('div', { className: 'buttons' }, del),
      );
    case 'forest':
      return section(
        'Vegetation',
        ...vegetationRows(item, { undoable: true, changed: () => app.touch(item) }),
        itemColor(item, 'Canopy', '#7f9f62'),
        el('p', { className: 'note' }, 'Plants fill the outline on land, below the tree line and away from rivers.'),
        el('div', { className: 'buttons' }, del),
      );
    case 'mountains':
      return section(
        'Mountain range',
        ...mountainRows(item, { undoable: true, changed: () => app.touch(item) }),
        el('p', { className: 'note' }, 'Shaded relief, highest in the middle of the range; rivers carve valleys through it.'),
        el('div', { className: 'buttons' }, del),
      );
    case 'relief':
      return section(
        item.path.closed ? (item.amount >= 0 ? 'Raised area' : 'Lowered area') : item.amount >= 0 ? 'Ridge' : 'Valley',
        row('Lower · raise', slider(-1, 1, 0.05, item.amount, (v) => live(() => (item.amount = v))(), signedPct, true)),
        row(item.path.closed ? 'Soft edge' : 'Width', slider(2, 160, 1, item.width * app.ppd(), (v) => live(() => (item.width = v / app.ppd()))(), px, true)),
        row('Wobble', slider(0, 2, 0.05, item.rough, (v) => live(() => (item.rough = v))(), pct, true)),
        el('p', { className: 'note' }, 'Shapes the relief only: it is not drawn as a line on the map.'),
        el('div', { className: 'buttons' }, del),
      );
    case 'symbol':
      return section(
        'Symbol',
        row('Symbol', select(symbolChoices(), item.symbol, (v) => editItem(item, (i) => (i.symbol = v)))),
        row('Size', slider(3, 80, 1, item.size * app.ppd(), (v) => live(() => (item.size = v / app.ppd()))(), px, true)),
        itemColor(item, 'Ink', app.style.symbolInk),
        el('div', { className: 'buttons' }, del),
      );
    case 'label': {
      const text = el('input', { type: 'text', value: item.text });
      text.addEventListener('change', () => editItem(item, (i) => (i.text = text.value.trim() || i.text)));
      return section(
        'Label',
        row('Text', text),
        row('Style', segmented(LABEL_STYLES, item.style, (v) => editItem(item, (i) => (i.style = v)))),
        row('Size', slider(5, 120, 1, item.size * app.ppd(), (v) => live(() => (item.size = v / app.ppd()))(), px, true)),
        itemColor(item, 'Text colour', item.style === 'water' ? app.style.waterLabel : app.style.label),
        el(
          'div',
          { className: 'buttons' },
          item.path ? button('Straighten', () => editItem(item, (i) => (i.path = null))) : button('Curve along a path', () => curveLabel(item)),
          del,
        ),
        el('p', { className: 'note' }, item.path ? 'Bend the curve by dragging its nodes and handles.' : 'Drag to move. Double-click to change the words.'),
      );
    }
  }
}

function reversePath(path: VPath): void {
  path.nodes.reverse();
  for (const n of path.nodes) [n.hin, n.hout] = [n.hout, n.hin];
}

function mapSection(): HTMLElement {
  const seed = el('input', { type: 'text', value: app.doc.seed, spellcheck: false });
  seed.addEventListener('change', () => app.setSeed(seed.value.trim() || 'atlas'));
  const radius = el('input', { type: 'number', min: '100', max: '200000', step: '1', value: String(app.doc.planet.radiusKm) });
  radius.addEventListener('change', () => {
    const r = Number(radius.value);
    if (r >= 100) app.setPlanetRadius(r);
  });
  const graticule = el('input', { type: 'checkbox', checked: app.graticule });
  graticule.addEventListener('change', () => run('graticule'));
  return section(
    'Map',
    row('Style', select((Object.keys(STYLES) as StyleId[]).map((id): [StyleId, string] => [id, STYLES[id].name]), app.styleId, setStyle)),
    row('Projection', select(Object.entries(PROJECTIONS).map(([id, p]): [ProjectionId, string] => [id as ProjectionId, p.name]), view.projectionId, (v) => run(`proj:${v}`))),
    row('Graticule', graticule),
    row('Pixel size', segmented([['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']], String(app.pixelScale), (v) => {
      app.pixelScale = Number(v);
      view.requestRender();
      renderProps();
    })),
    row('Planet radius', radius),
    row('Detail seed', seed),
    el('p', { className: 'note' }, 'The seed shapes all procedural detail: coastlines, relief, rivers and vegetation.'),
  );
}

const PALETTE_ROWS: [PaletteKey, string][] = [
  ['sea', 'Water'],
  ['land', 'Land'],
  ['ink', 'Coast & ink'],
  ['river', 'Rivers'],
  ['border', 'Borders'],
  ['label', 'Labels'],
  ['waterLabel', 'Sea labels'],
  ['symbolInk', 'Symbols'],
  ['desk', 'Table'],
];

function colorsSection(): HTMLElement {
  const palette = app.doc.palette ?? {};
  const base = STYLES[app.styleId];
  const reset = button('Reset to style', () => {
    app.checkpoint();
    for (const [k] of PALETTE_ROWS) app.setPaletteColor(k, null);
    setDesk();
    renderProps();
  });
  return section(
    'Colours',
    ...PALETTE_ROWS.map(([key, label]) =>
      colorRow(label, palette[key], base[key] as string, (v) => {
        app.setPaletteColor(key, v);
        if (key === 'desk') setDesk();
      }),
    ),
    el('div', { className: 'buttons' }, reset),
    el('p', { className: 'note' }, 'Map colours are saved with the map. Selected shapes, rivers, borders, labels and symbols can also have their own.'),
  );
}

const toHex = (c: string) => (/^#[0-9a-f]{3}$/i.test(c) ? '#' + c.slice(1).replace(/./g, (x) => x + x) : c);

/** A colour swatch with a "Default" button; one undo step per pick. `set(null)` = back to default. */
function colorRow(label: string, value: string | undefined, fallback: string, set: (v: string | null) => void): HTMLElement {
  let pending = false;
  const input = colorWell(toHex(value ?? fallback), {
    input: (v) => {
      if (!pending) app.checkpoint();
      pending = true;
      set(v);
    },
    change: () => {
      pending = false;
      renderProps();
    },
  });
  const reset = el('button', { className: 'btn small', title: 'Back to the map colour', disabled: !value }, 'Default');
  reset.addEventListener('click', () => {
    app.checkpoint();
    set(null);
    renderProps();
  });
  return row(label, el('span', { className: 'inline' }, input, reset));
}

function itemColor(item: Item, label: string, fallback: string): HTMLElement {
  return colorRow(label, item.color, fallback, (v) => {
    if (v) item.color = v;
    else delete item.color;
    app.touch(item);
  });
}

/** Real-world size of the selected line or area, as the map draws it. */
function sizeRows(item: Item): HTMLElement[] {
  if (!isPathItem(item)) return [];
  const radius = app.doc.planet.radiusKm, u = measure.units;
  const pts = app.cache.shape(item, app.doc.seed);
  const out = (text: string) => el('output', {}, text);
  if (!item.path.closed) return [row('Length', out(formatDistance(lineLengthKm(pts, radius), u)))];
  return [
    row('Area', out(formatArea(flatRingAreaKm2(pts, radius), u))),
    row('Perimeter', out(formatDistance(lineLengthKm(pts.concat(pts.slice(0, 3)), radius), u))),
  ];
}

function renderProps(): void {
  const props = $('props');
  // Don't rebuild while the user is typing in the panel.
  if (props.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text') return;
  const sel = app.selected();
  const selected = sel && selectionSection(sel);
  if (sel && selected) selected.querySelector('h3')?.after(...sizeRows(sel));
  props.replaceChildren(...[toolSection(), selected, mapSection(), colorsSection()].filter((s): s is HTMLElement => !!s));
  if (!app.doc.items.length) {
    props.prepend(section('Empty map', el('p', { className: 'note' }, 'Pick the Land pen (L) and click around to draw a coastline — click the first node to close it. Or open the sample map from the File menu.')));
  }
}

app.onChange(renderProps);

// ---------------------------------------------------------------- persistence & boot

let lastSaved = '';
setInterval(() => {
  try {
    const s = serializeDoc(app.doc);
    if (s !== lastSaved) {
      localStorage.setItem(AUTOSAVE_KEY, s);
      lastSaved = s;
    }
  } catch {
    // Storage unavailable (private mode, quota): autosave is a convenience only.
  }
}, 2000);

function initialDoc() {
  const q = new URLSearchParams(location.search);
  if (q.has('sample')) return sampleDoc();
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY) ?? localStorage.getItem(LEGACY_AUTOSAVE_KEY);
    if (saved) return parseDoc(saved);
  } catch {
    // Fall through to the sample.
  }
  return sampleDoc();
}

// ---------------------------------------------------------------- pixel-art tool icons

await loadIcons();

const query = new URLSearchParams(location.search);
app.setDoc(initialDoc());
setStyle((query.get('style') as StyleId) in STYLES ? (query.get('style') as StyleId) : 'parchment');
const proj = query.get('proj') as ProjectionId | null;
view.setProjection(proj && proj in PROJECTIONS ? proj : 'orthographic');
if (query.has('rotate')) {
  const [lon, lat] = query.get('rotate')!.split(',').map(Number);
  view.projection.rotate([-lon, -(lat || 0)]);
}
if (query.has("zoom")) view.setZoom(Number(query.get("zoom")));
setTool((query.get('tool') as ToolId) in tools ? (query.get('tool') as ToolId) : 'select');
if (query.has('select')) {
  const item = app.doc.items[Number(query.get('select'))];
  if (item) app.select({ id: item.id, node: pathOf(item) ? 0 : null });
}
view.onViewChange();

// Dev builds expose the app for debugging and automated UI checks.
if (import.meta.env.DEV) (window as unknown as { __wb: App }).__wb = app;
