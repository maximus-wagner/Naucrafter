/** A paper colour card (pigment pans + saturation/value square + hue slider) that replaces the OS colour dialog. */

const PIGMENTS = [
  '#2a2219', '#5f5140', '#8a7a58', '#c8b88f', '#ebe3cf', '#ffffff',
  '#a23a22', '#c8623a', '#d9a441', '#c9b458', '#7a8c4a', '#4f6b3a',
  '#2f5a4a', '#3f7f8c', '#8fb4c4', '#3b5f8f', '#1f3a5f', '#6a4a7c',
  '#8a5a3c', '#b08d4a', '#d9c9a0', '#b9d0d6', '#555555', '#000000',
];

type HSV = [number, number, number];

function hexToHsv(hex: string): HSV {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max : 0, max];
}

function hsvToHex([h, s, v]: HSV): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return '#' + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const normHex = (s: string): string | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (x) => x + x) : m[1];
  return '#' + h.toLowerCase();
};

function div(className: string, ...kids: Node[]): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  d.append(...kids);
  return d;
}

let openClose: (() => void) | null = null;

/** A paint-pot style swatch button. `input` fires while picking; `change` once when the card closes. */
export function colorWell(value: string, on: { input(v: string): void; change(): void }): HTMLButtonElement {
  let hex = normHex(value) ?? '#000000';
  const swatch = div('well-swatch');
  const well = document.createElement('button');
  well.type = 'button';
  well.className = 'well';
  well.title = 'Pick a colour';
  well.append(swatch);
  const paint = () => (swatch.style.background = hex);
  paint();

  well.addEventListener('click', () => {
    openClose?.();
    let hsv = hexToHsv(hex);
    let dirty = false;

    const knob = div('cp-knob');
    const sv = div('cp-sv', knob);
    const hue = document.createElement('input');
    hue.type = 'range';
    hue.className = 'cp-hue';
    hue.min = '0';
    hue.max = '359';
    const preview = div('cp-preview');
    const text = document.createElement('input');
    text.type = 'text';
    text.spellcheck = false;
    text.maxLength = 7;

    const sync = (fire: boolean) => {
      hex = hsvToHex(hsv);
      sv.style.backgroundColor = hsvToHex([hsv[0], 1, 1]);
      knob.style.left = `${hsv[1] * 100}%`;
      knob.style.top = `${(1 - hsv[2]) * 100}%`;
      hue.value = String(Math.round(hsv[0]));
      preview.style.background = hex;
      if (document.activeElement !== text) text.value = hex;
      paint();
      if (fire) {
        dirty = true;
        on.input(hex);
      }
    };

    const dragSV = (e: PointerEvent) => {
      const r = sv.getBoundingClientRect();
      hsv = [hsv[0], Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
      sync(true);
    };
    sv.addEventListener('pointerdown', (e) => {
      sv.setPointerCapture(e.pointerId);
      dragSV(e);
    });
    sv.addEventListener('pointermove', (e) => {
      if (sv.hasPointerCapture(e.pointerId)) dragSV(e);
    });
    hue.addEventListener('input', () => {
      hsv = [Number(hue.value), hsv[1], hsv[2]];
      sync(true);
    });
    text.addEventListener('input', () => {
      const h = normHex(text.value);
      if (h) {
        hsv = hexToHsv(h);
        sync(true);
      }
    });
    text.addEventListener('blur', () => (text.value = hex));
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close();
    });

    const pans = div('cp-pigments');
    for (const p of PIGMENTS) {
      const pan = document.createElement('button');
      pan.type = 'button';
      pan.className = 'cp-pan';
      pan.title = p;
      pan.style.background = p;
      pan.addEventListener('click', () => {
        hsv = hexToHsv(p);
        sync(true);
      });
      pans.append(pan);
    }

    const pop = div('cp-pop', div('cp-title', document.createTextNode('Colour')), sv, hue, div('cp-row', preview, text), pans);
    document.body.append(pop);
    const wr = well.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    pop.style.left = `${Math.max(6, Math.min(innerWidth - pr.width - 6, wr.right - pr.width))}px`;
    pop.style.top = `${Math.max(6, Math.min(innerHeight - pr.height - 6, wr.bottom + 6))}px`;
    sync(false);

    const away = (e: PointerEvent) => {
      if (!pop.contains(e.target as Node) && !well.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    function close() {
      pop.remove();
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
      if (openClose === close) openClose = null;
      if (dirty) on.change();
    }
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    openClose = close;
  });

  return well;
}
