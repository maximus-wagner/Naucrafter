/** The tools as physical objects lying on the table (the alternative to the left-hand button toolbox). */

const OUT = 'stroke="#2a2219" stroke-opacity=".75" stroke-width=".9" stroke-linejoin="round"';
/** Cylinder shading laid over a coloured shape: light on top, shadow underneath. */
const cyl = (shape: string) => shape + shape.replace(/fill="[^"]*"/, 'fill="url(#cyl)"').replace(/stroke="[^"]*"/, 'stroke="none"');

function pencil(body: string, lead: string): string {
  return `
    <rect x="2" y="14" width="7" height="12" rx="3" fill="#d98c8c" ${OUT}/>
    <rect x="8" y="13" width="9" height="14" fill="#b9b6ac" ${OUT}/><path d="M11 13v14M14 13v14" stroke="#6b685e" stroke-width=".7"/>
    ${cyl(`<rect x="17" y="13" width="75" height="14" fill="${body}" ${OUT}/>`)}
    ${cyl(`<path d="M92 13 112 20 92 27Z" fill="#e3c391" ${OUT}/>`)}
    <path d="M105 17.4 112 20 105 22.6Z" fill="${lead}" ${OUT}/>`;
}

const ART: Record<string, string> = {
  select: `
    ${cyl(`<path d="M4 16 92 18.6V21.4L4 24Z" fill="#7a5230" ${OUT}/>`)}
    <rect x="3" y="15" width="12" height="10" rx="4" fill="#3a2a1c" ${OUT}/>
    ${cyl(`<path d="M92 18.6 114 20 92 21.4Z" fill="#c9a24a" ${OUT}/>`)}`,
  hand: `
    <path d="M18 12C18 8 24 8 28 12L34 17V30C34 33 30 34 26 34 21 34 16 30 16 24Z" fill="#e6caa0" ${OUT}/>
    <rect x="34" y="10" width="40" height="22" rx="8" fill="#e6caa0" ${OUT}/>
    <rect x="62" y="9" width="40" height="5.5" rx="2.7" fill="#e6caa0" ${OUT}/>
    <rect x="66" y="15.5" width="46" height="5.5" rx="2.7" fill="#e6caa0" ${OUT}/>
    <rect x="64" y="22" width="44" height="5.5" rx="2.7" fill="#e6caa0" ${OUT}/>
    <rect x="58" y="28.4" width="34" height="5" rx="2.5" fill="#e6caa0" ${OUT}/>
    <path d="M34 10h30v22H34Z" fill="url(#cyl)"/>`,
  land: `
    ${cyl(`<path d="M4 16.5 78 18V22L4 23.5Z" fill="#2a2219" ${OUT}/>`)}
    ${cyl(`<rect x="76" y="16.6" width="14" height="6.8" fill="#c9a24a" ${OUT}/>`)}
    ${cyl(`<path d="M90 17.2 114 20 90 22.8Z" fill="#aeb2b4" ${OUT}/>`)}
    <path d="M96 20h14" stroke="#2a2219" stroke-width=".8"/><circle cx="97" cy="20" r="1.1" fill="#2a2219"/>`,
  cut: `
    ${cyl(`<path d="M4 17 70 15.4V24.6L4 23Z" fill="#6b4a2e" ${OUT}/>`)}
    <rect x="30" y="16" width="5" height="8" fill="#1f3a5f" opacity=".8"/>
    ${cyl(`<rect x="70" y="14.4" width="18" height="11.2" fill="#b9bcbd" ${OUT}/>`)}
    ${cyl(`<path d="M88 14.6C100 15 110 18 114 20 110 22 100 25 88 25.4Z" fill="#3b78a8" ${OUT}/>`)}
    <path d="M96 17c6 .5 10 1.7 14 3" stroke="#bfe0f2" stroke-width=".9" fill="none" opacity=".7"/>`,
  river: `
    ${cyl(`<path d="M4 17.2 80 18V22L4 22.8Z" fill="#e8e0c8" ${OUT}/>`)}
    ${cyl(`<rect x="22" y="17.4" width="8" height="5.2" fill="#3b78a8"/>`)}
    ${cyl(`<rect x="80" y="17.2" width="10" height="5.6" fill="#3b78a8" ${OUT}/>`)}
    ${cyl(`<path d="M90 18 114 20 90 22Z" fill="#cfd3d4" ${OUT}/>`)}`,
  border: pencil('#a23a22', '#a23a22'),
  forest: pencil('#4f6b3a', '#4f6b3a'),
  mountains: `
    ${cyl(`<path d="M8 22 14 12 30 9 58 10 84 8 104 14 112 22 96 30 60 31 26 30Z" fill="#2c2a28" ${OUT}/>`)}
    <path d="M30 12 44 11M62 13 78 12M24 24 52 26" stroke="#8a8782" stroke-width="1" opacity=".6" fill="none"/>
    <path d="M102 15 111 22" stroke="#555" stroke-width="1.2"/>`,
  relief: `
    ${cyl(`<path d="M3 20 12 14 94 13 106 17 114 20 106 23 94 27 12 26Z" fill="#d3c7a9" ${OUT}/>`)}
    <path d="M94 13 114 20 94 27Z" fill="#6f665a" opacity=".55"/>
    <path d="M22 14v12M28 14v12" stroke="#a89c7e" stroke-width=".7"/>`,
  stamp: `
    <rect x="46" y="4" width="26" height="9" rx="4.5" fill="#6b4a2e" ${OUT}/>
    ${cyl(`<rect x="52" y="12" width="14" height="10" fill="#7a5230" ${OUT}/>`)}
    ${cyl(`<rect x="22" y="21" width="76" height="7" rx="1.5" fill="#8a6a44" ${OUT}/>`)}
    <rect x="24" y="28" width="72" height="5" rx="1" fill="#a23a22" ${OUT}/>
    <path d="M30 30.5h60" stroke="#e8a090" stroke-width=".8" stroke-dasharray="3 2"/>`,
  text: `
    <ellipse cx="24" cy="30" rx="17" ry="5" fill="#000" opacity=".25"/>
    ${cyl(`<path d="M10 28C8 16 14 10 24 10S40 16 38 28C36 33 12 33 10 28Z" fill="#1c1a1a" ${OUT}/>`)}
    <ellipse cx="24" cy="10.5" rx="7" ry="2.6" fill="#0c0b0b" ${OUT}/><path d="M15 17c2-3 5-4 8-4" stroke="#fff" stroke-width="1.2" opacity=".35" fill="none"/>
    <path d="M26 9 112 5" stroke="#e8e2d0" stroke-width="1.4" ${OUT}/>
    <path d="M44 8.2C60 -.5 84 -1 108 5 92 11 62 14 44 8.2Z" fill="#f2ecdc" ${OUT}/>
    <path d="M50 8.5C66 5 86 3.6 104 5.6" stroke="#b8ad90" stroke-width=".7" fill="none"/>`,
};

interface Def { id: string; title: string; key: string; r: number }
const DEFS: Def[] = [
  { id: 'select', title: 'Select & edit (V)', key: 'V', r: -4 },
  { id: 'hand', title: 'Hand (H)', key: 'H', r: 5 },
  { id: 'land', title: 'Land pen (L)', key: 'L', r: -6 },
  { id: 'cut', title: 'Water pen: lakes and bays (W)', key: 'W', r: 3 },
  { id: 'river', title: 'River pen (R)', key: 'R', r: -3 },
  { id: 'border', title: 'Border pen (B)', key: 'B', r: 6 },
  { id: 'forest', title: 'Vegetation (F)', key: 'F', r: -5 },
  { id: 'mountains', title: 'Mountain range (M)', key: 'M', r: 2 },
  { id: 'relief', title: 'Elevation (E)', key: 'E', r: -2 },
  { id: 'stamp', title: 'Symbol stamp (S)', key: 'S', r: 4 },
  { id: 'text', title: 'Text (T)', key: 'T', r: -4 },
];

const NS = 'http://www.w3.org/2000/svg';

/** Fill `host` with the tools; each is a `[data-tool]` button, so the normal tool switching drives it. */
export function buildTableTools(host: HTMLElement): void {
  const defs = document.createElementNS(NS, 'svg');
  defs.setAttribute('width', '0');
  defs.setAttribute('height', '0');
  defs.setAttribute('aria-hidden', 'true');
  defs.style.position = 'absolute';
  defs.innerHTML = `<defs><linearGradient id="cyl" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/>
    <stop offset=".7" stop-color="#000" stop-opacity=".12"/><stop offset="1" stop-color="#000" stop-opacity=".4"/></linearGradient></defs>`;
  host.append(defs);
  for (const d of DEFS) {
    const b = document.createElement('button');
    b.className = 'ptool';
    b.dataset.tool = d.id;
    b.title = d.title;
    b.style.setProperty('--r', `${d.r}deg`);
    b.innerHTML = `<svg viewBox="0 0 120 40" aria-hidden="true">${ART[d.id]}</svg><kbd>${d.key}</kbd>`;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    host.append(b);
  }
  const sw = document.createElement('button');
  sw.className = 'modeswitch table-side';
  sw.dataset.cmd = 'tooltable';
  sw.title = 'Put the tools back in the toolbox';
  sw.textContent = 'Toolbox';
  host.append(sw);
}
