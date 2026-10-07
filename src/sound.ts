// UI sound effects. Files live in src/assets/sounds; each name maps to one wav.
import click from './assets/sounds/click.wav?url';
import back from './assets/sounds/back.wav?url';
import craft from './assets/sounds/craft.wav?url';
import fail from './assets/sounds/fail.wav?url';
import hover from './assets/sounds/hover.wav?url';
import scroll from './assets/sounds/scroll.wav?url';

const URLS = { click, back, craft, fail, hover, scroll };
export type SoundId = keyof typeof URLS;

const VOLUME: Record<SoundId, number> = { click: 0.6, back: 0.6, craft: 0.7, fail: 0.6, hover: 0.25, scroll: 0.3 };
const MIN_GAP_MS = 40;
const audio = new Map<SoundId, HTMLAudioElement>();
const last = new Map<SoundId, number>();
let muted = false;
try {
  muted = localStorage.getItem('naucrafter-muted') === '1';
} catch {
  /* storage unavailable */
}

export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem('naucrafter-muted', m ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function isMuted(): boolean {
  return muted;
}

export function play(id: SoundId): void {
  if (muted) return;
  const now = performance.now();
  if (now - (last.get(id) ?? -1e9) < MIN_GAP_MS) return;
  last.set(id, now);
  let a = audio.get(id);
  if (!a) {
    a = new Audio(URLS[id]);
    a.volume = VOLUME[id];
    audio.set(id, a);
  }
  a.currentTime = 0;
  a.play().catch(() => {}); // blocked before the first user gesture
}

/** Hover / click / scroll sounds for every button, menu title and tool tile, by delegation. */
export function wireUiSounds(): void {
  const target = (e: Event) => (e.target as HTMLElement | null)?.closest?.('button, [data-tool], select, .menu-title') as HTMLElement | null;
  let hovered: HTMLElement | null = null;
  document.addEventListener('pointerover', (e) => {
    const t = target(e);
    if (t && t !== hovered && !(t as HTMLButtonElement).disabled) play('hover');
    hovered = t;
  });
  document.addEventListener(
    'click',
    (e) => {
      const t = target(e);
      if (!t || (t as HTMLButtonElement).disabled || t.tagName === 'SELECT') return;
      const v = (t as HTMLButtonElement).value;
      play(v === 'cancel' ? 'back' : 'click');
    },
    true,
  );
  document.addEventListener('change', (e) => {
    if ((e.target as HTMLElement).tagName === 'SELECT') play('click');
  });
  document.addEventListener(
    'wheel',
    (e) => {
      if ((e.target as HTMLElement).closest?.('#props, .menu, dialog')) play('scroll');
    },
    { passive: true },
  );
}
