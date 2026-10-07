// Frame-time check: drives the real UI (pan, zoom, edits, drawing) on the sample map and on a
// generated heavy map, records every frame interval and reports the worst. Goal: no frame
// slower than 33 ms (30 fps). Needs `npm run dev` running; `WB_URL` if it isn't on port 5173.
//   node scripts/perf.mjs [--map sample|heavy|both] [--only name,name] [--profile] [--gpu]
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const URL = process.env.WB_URL ?? 'http://localhost:5173/Naucrafter/';
const MAPS = opt('map', 'both') === 'both' ? ['sample', 'heavy'] : [opt('map')];
const ONLY = opt('only', '') ? String(opt('only')).split(',') : null;
const PROFILE = !!opt('profile', false);
const BUDGET = 33.4;
const W = Number(opt('width', 1600)), H = Number(opt('height', 900)), DPR = Number(opt('dpr', 1));

// ---------------------------------------------------------------- a heavy, deterministic map

function heavyDoc() {
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const blob = (lon, lat, r, n, closed = true) => {
    const nodes = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rr = r * (0.7 + 0.5 * rnd());
      nodes.push({ p: [lon + (rr * Math.cos(a)) / Math.cos((lat * Math.PI) / 180), lat + rr * Math.sin(a) * 0.8], hin: null, hout: null });
    }
    return { closed, nodes };
  };
  const line = (lon, lat, dLon, dLat, n) => {
    const nodes = [];
    for (let k = 0; k < n; k++) nodes.push({ p: [lon + (dLon * k) / (n - 1) + (rnd() - 0.5) * 2, lat + (dLat * k) / (n - 1) + (rnd() - 0.5) * 2], hin: null, hout: null });
    return { closed: false, nodes };
  };
  const items = [];
  let id = 0;
  const add = (x) => items.push({ id: `h${id++}`, ...x });
  const continents = [[-10, 25, 22], [60, 35, 26], [120, -10, 20], [-80, 10, 24], [20, -35, 16], [-140, 45, 14]];
  for (const [lon, lat, r] of continents) add({ kind: 'land', op: 'add', rough: 0.8, path: blob(lon, lat, r, 16) });
  for (let k = 0; k < 12; k++) add({ kind: 'land', op: 'add', rough: 1, path: blob(-180 + rnd() * 360, -50 + rnd() * 100, 2 + rnd() * 4, 8) });
  for (let k = 0; k < 5; k++) {
    const [lon, lat, r] = continents[k];
    add({ kind: 'land', op: 'cut', rough: 0.5, path: blob(lon + r * 0.3, lat - r * 0.2, 2 + rnd() * 2, 8) });
    add({ kind: 'land', op: 'add', rough: 0.6, color: ['#c9b38a', '#b7c49a', '#d8b9a0', '#a9b98f', '#cfc29a'][k], path: blob(lon - r * 0.3, lat + r * 0.1, r * 0.35, 10) });
  }
  const look = { scale: 1, height: 1, ruggedness: 0.5, snow: 0.22, density: 1, foothills: true, rough: 0.4 };
  const kinds = ['broadleaf', 'conifer', 'mixed', 'jungle', 'shrubs', 'grass'];
  for (let k = 0; k < 6; k++) {
    const [lon, lat, r] = continents[k];
    add({ kind: 'mountains', ...look, path: blob(lon + r * 0.25, lat + r * 0.35, r * 0.18, 9) });
    add({ kind: 'mountains', ...look, ruggedness: 0.8, path: blob(lon - r * 0.4, lat - r * 0.3, r * 0.14, 8) });
    for (let f = 0; f < 3; f++) {
      add({ kind: 'forest', vegetation: kinds[(k + f) % 6], scale: 1, height: 1, density: 1, variety: 0.3, rough: 0.4, path: blob(lon + (rnd() - 0.5) * r, lat + (rnd() - 0.5) * r * 0.8, r * (0.12 + rnd() * 0.12), 9) });
    }
    add({ kind: 'relief', amount: 0.5, width: 1.5, rough: 0.4, path: blob(lon + r * 0.1, lat - r * 0.4, r * 0.15, 7) });
    add({ kind: 'relief', amount: -0.6, width: 1, rough: 0.4, path: line(lon - r * 0.5, lat + r * 0.1, r * 0.5, 0, 4) });
    for (let rv = 0; rv < 2; rv++) {
      const sx = lon + (rnd() - 0.5) * r * 0.6, sy = lat + (rnd() - 0.5) * r * 0.5;
      const a = rnd() * Math.PI * 2;
      add({ kind: 'river', width: 0.3, rough: 0.6, path: line(sx, sy, Math.cos(a) * r * 1.3, Math.sin(a) * r * 1.0, 6) });
    }
    add({ kind: 'border', line: 'national', path: line(lon - r * 0.6, lat - r * 0.5, r * 1.2, r, 5) });
  }
  const symbols = ['city', 'town', 'mountain', 'hill', 'tree'];
  for (let k = 0; k < 60; k++) {
    const [lon, lat, r] = continents[k % 6];
    add({ kind: 'symbol', symbol: symbols[k % 5], at: [lon + (rnd() - 0.5) * r, lat + (rnd() - 0.5) * r * 0.8], size: 0.4 + rnd() * 0.6 });
  }
  const names = ['Westmarch', 'Aurel', 'Kesh', 'Drowned Isles', 'Varn', 'Holloway', 'Old Ferrow', 'Sunreach', 'Thale', 'Morrow Deep'];
  for (let k = 0; k < 24; k++) {
    const [lon, lat, r] = continents[k % 6];
    const style = ['region', 'place', 'water'][k % 3];
    add({ kind: 'label', text: names[k % names.length], style, size: style === 'region' ? 2.2 : 1.2, at: [lon + (rnd() - 0.5) * r, lat + (rnd() - 0.5) * r * 0.8], path: k % 5 === 0 ? line(lon - 6, lat - r * 0.9, 12, -3, 3) : null });
  }
  return JSON.stringify({ format: 'naucrafter-map', version: 1, seed: 'atlas', planet: { radiusKm: 6371 }, palette: {}, items });
}

// ---------------------------------------------------------------- browser

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: [`--window-size=${W},${H}`, ...(opt('gpu', false) ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu-rasterization'] : [])],
  defaultViewport: { width: W, height: H, deviceScaleFactor: DPR },
  protocolTimeout: 600000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];

for (const map of MAPS) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${map}: pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${map}: console: ${m.text()}`));
  page.on('dialog', (d) => d.accept());
  const doc = map === 'heavy' ? heavyDoc() : null;
  await page.evaluateOnNewDocument((doc) => {
    if (doc) localStorage.setItem('naucrafter.autosave', doc);
    else localStorage.removeItem('naucrafter.autosave');
    const P = (window.__perf = { frames: [], longest: [] });
    let last = 0;
    const loop = (t) => {
      if (last) P.frames.push([t, t - last]);
      last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, doc);
  const cdp = await page.createCDPSession();
  if (PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  }
  const t0 = Date.now();
  await page.goto(URL + (map === 'sample' ? '?sample=1&rotate=0,20&zoom=2.2' : '?rotate=10,20&zoom=1.6'), { waitUntil: 'networkidle0' });
  const box = await page.$eval('.map-overlay', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const m = page.mouse;
  const now = () => page.evaluate(() => performance.now());
  const settle = async (max = 20000) => {
    const end = Date.now() + max;
    while (Date.now() < end) {
      if (await page.evaluate(() => window.__wb?.terrainLayerForChecks.isRefined)) return true;
      await sleep(50);
    }
    return false;
  };
  const toScreen = (lonLat) => page.evaluate((g) => window.__wb.view.projection(g), lonLat);
  const itemPoint = (kind, extra = '') =>
    page.evaluate((kind, extra) => {
      const app = window.__wb;
      const it = app.doc.items.find((i) => i.kind === kind && (!extra || new Function('i', `return ${extra}`)(i)));
      if (!it) return null;
      const v = it.path ? it.path.nodes[0].p : it.at;
      const g = [Math.atan2(v[0], v[2]) * 180 / Math.PI, Math.asin(v[1]) * 180 / Math.PI];
      return { s: app.view.projection(g), id: it.id };
    }, kind, extra);

  const setView = (lon, lat, zoom, proj = 'orthographic') =>
    page.evaluate((lon, lat, zoom, proj) => {
      const v = window.__wb.view;
      if (v.projectionId !== proj) document.querySelector(`[data-cmd="proj:${proj}"]`).click();
      v.projection.rotate([-lon, proj === 'orthographic' ? -lat : 0]);
      v.setZoom(zoom);
      v.requestRender();
    }, lon, lat, zoom, proj);
  const home = map === 'sample' ? [0, 20, 2.2] : [10, 20, 1.6];
  const scenario = async (name, fn, view = home) => {
    if (ONLY && !ONLY.includes(name)) return;
    await setView(...view);
    await settle();
    await sleep(150);
    if (PROFILE) await cdp.send('Profiler.start');
    const a = await now();
    const wall = Date.now();
    await fn();
    const b = await now();
    // Let the view settle and refine after the interaction: that is part of the experience too.
    const refined = await settle();
    await sleep(100);
    const c = await now();
    const profile = PROFILE ? (await cdp.send('Profiler.stop')).profile : null;
    const frames = await page.evaluate((a, c) => window.__perf.frames.filter(([t]) => t > a && t <= c), a, c);
    const during = frames.filter(([t]) => t <= b).map((f) => f[1]);
    const after = frames.filter(([t]) => t > b).map((f) => f[1]);
    const stat = (v) => {
      const s = v.slice().sort((x, y) => x - y);
      return { n: s.length, max: s.length ? s[s.length - 1] : 0, p95: s.length ? s[Math.floor(s.length * 0.95)] : 0, slow: s.filter((x) => x > BUDGET).length };
    };
    const r = { map, name, during: stat(during), after: stat(after), refined, ms: Date.now() - wall, worst: frames.slice().sort((x, y) => y[1] - x[1]).slice(0, 4).map(([t, d]) => `${d.toFixed(0)}@${(t - a).toFixed(0)}`) };
    results.push(r);
    console.log(`${map.padEnd(6)} ${name.padEnd(14)} during: n=${String(r.during.n).padStart(4)} max=${r.during.max.toFixed(1).padStart(6)} p95=${r.during.p95.toFixed(1).padStart(5)} slow=${r.during.slow}` +
      ` | after: max=${r.after.max.toFixed(1).padStart(6)} slow=${r.after.slow}${refined ? '' : ' (not refined)'} | worst ${r.worst.join(' ')}`);
    if (profile) printProfile(profile);
  };

  // Load: from navigation until the first full-detail view.
  {
    await settle(30000);
    const frames = await page.evaluate(() => window.__perf.frames.map((f) => f[1]));
    const slow = frames.filter((d) => d > BUDGET);
    console.log(`${map.padEnd(6)} ${'load'.padEnd(14)} ${frames.length} frames, ${slow.length} slow, max ${Math.max(0, ...frames).toFixed(1)} ms, refined after ${Date.now() - t0} ms; slow: ${slow.slice(0, 8).map((d) => d.toFixed(0)).join(' ')}`);
    results.push({ map, name: 'load', during: { max: Math.max(0, ...frames), slow: slow.length }, after: { max: 0, slow: 0 } });
  }

  await scenario('pan-globe', async () => {
    await m.move(cx - 300, cy);
    await m.down({ button: 'right' });
    await m.move(cx + 300, cy + 80, { steps: 90 });
    await m.move(cx - 200, cy - 60, { steps: 90 });
    await m.up({ button: 'right' });
  });
  await scenario('zoom-in', async () => {
    await m.move(cx + 40, cy - 30);
    for (let k = 0; k < 45; k++) {
      await m.wheel({ deltaY: -100 });
      await sleep(16);
    }
  });
  await scenario('pan-deep', async () => {
    await m.move(cx - 250, cy);
    await m.down({ button: 'right' });
    await m.move(cx + 250, cy + 100, { steps: 90 });
    await m.up({ button: 'right' });
  }, [-8, 44, 300]);
  await scenario('zoom-out', async () => {
    for (let k = 0; k < 45; k++) {
      await m.wheel({ deltaY: 100 });
      await sleep(16);
    }
  }, [-8, 44, 600]);
  await scenario('select-drag', async () => {
    await page.keyboard.press('v');
    const it = await itemPoint('mountains');
    if (!it?.s) return;
    await page.evaluate((id) => window.__wb.select({ id, node: null }), it.id);
    await sleep(100);
    const [x, y] = [box.x + it.s[0], box.y + it.s[1]];
    // Grab the first node and drag it around.
    await m.move(x, y);
    await m.down();
    await m.move(x + 60, y + 40, { steps: 40 });
    await m.move(x - 30, y + 70, { steps: 40 });
    await m.up();
  });
  await scenario('land-node', async () => {
    const it = await itemPoint('land', "i.op === 'add'");
    if (!it?.s) return;
    await page.evaluate((id) => window.__wb.select({ id, node: null }), it.id);
    await sleep(100);
    const [x, y] = [box.x + it.s[0], box.y + it.s[1]];
    await m.move(x, y);
    await m.down();
    await m.move(x + 50, y - 40, { steps: 40 });
    await m.move(x - 20, y + 30, { steps: 40 });
    await m.up();
  });
  await scenario('move-forest', async () => {
    const it = await page.evaluate(() => {
      const app = window.__wb;
      const f = app.doc.items.find((i) => i.kind === 'forest');
      if (!f) return null;
      app.select({ id: f.id, node: null });
      // A point inside the forest: the mean of its nodes.
      let x = 0, y = 0, z = 0;
      for (const n of f.path.nodes) { x += n.p[0]; y += n.p[1]; z += n.p[2]; }
      const l = Math.hypot(x, y, z);
      return app.view.projection([Math.atan2(x / l, z / l) * 180 / Math.PI, Math.asin(y / l) * 180 / Math.PI]);
    });
    if (!it) return;
    const [x, y] = [box.x + it[0], box.y + it[1]];
    await m.move(x, y);
    await m.down();
    await m.move(x + 80, y + 30, { steps: 50 });
    await m.up();
  });
  await scenario('pencil-land', async () => {
    await page.keyboard.press('l');
    await m.move(cx - 120, cy + 120);
    await m.down();
    for (let k = 0; k <= 80; k++) {
      const a = (k / 80) * Math.PI * 2;
      await m.move(cx - 120 + 90 * Math.cos(a) - 90, cy + 120 + 60 * Math.sin(a));
    }
    await m.up();
    await page.keyboard.press('v');
  });
  await scenario('pencil-forest', async () => {
    await page.keyboard.press('f');
    await m.move(cx + 100, cy - 60);
    await m.down();
    for (let k = 0; k <= 60; k++) {
      const a = (k / 60) * Math.PI * 2;
      await m.move(cx + 100 + 70 * Math.cos(a) - 70, cy - 60 + 50 * Math.sin(a));
    }
    await m.up();
    await page.keyboard.press('v');
  });
  await scenario('undo-redo', async () => {
    for (let k = 0; k < 4; k++) {
      await page.keyboard.down('Control');
      await page.keyboard.press('z');
      await page.keyboard.up('Control');
      await sleep(250);
    }
    for (let k = 0; k < 4; k++) {
      await page.keyboard.down('Control');
      await page.keyboard.press('y');
      await page.keyboard.up('Control');
      await sleep(250);
    }
  });
  await scenario('flat-map', async () => {
    await page.evaluate(() => document.querySelector('[data-cmd="proj:equalEarth"]').click());
    await sleep(400);
    await m.move(cx - 250, cy);
    await m.down({ button: 'right' });
    await m.move(cx + 250, cy + 60, { steps: 90 });
    await m.up({ button: 'right' });
    for (let k = 0; k < 20; k++) {
      await m.wheel({ deltaY: -100 });
      await sleep(16);
    }
  });
  await scenario('style-switch', async () => {
    for (const s of ['atlas', 'ink', 'parchment']) {
      await page.evaluate((s) => document.querySelector(`[data-cmd="style:${s}"]`)?.click(), s);
      await sleep(500);
    }
    await page.evaluate(() => document.querySelector('[data-cmd="proj:orthographic"]').click());
  });
  await scenario('river-spring', async () => {
    const ok = await page.evaluate(() => {
      const app = window.__wb;
      const land = app.doc.items.find((i) => i.kind === 'mountains');
      if (!land || !app.generateRiver) return false;
      const v = land.path.nodes[0].p;
      app.generateRiver([Math.atan2(v[0], v[2]) * 180 / Math.PI, Math.asin(v[1]) * 180 / Math.PI]);
      return true;
    });
    if (!ok) console.log('  (no river generator)');
  });
  await page.close();
}

const bad = results.filter((r) => r.during.max > BUDGET || r.after.max > BUDGET);
console.log(`\n${bad.length ? `${bad.length} scenario(s) dropped below 30 fps: ${bad.map((r) => `${r.map}/${r.name}`).join(', ')}` : 'All scenarios stayed at or above 30 fps.'}`);
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
process.exitCode = bad.length ? 1 : 0;

/** Top self-time functions of a CPU profile. */
function printProfile(profile) {
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas;
  const time = new Map();
  profile.samples.forEach((id, i) => time.set(id, (time.get(id) ?? 0) + (dt[i] ?? 0)));
  for (const [id, us] of time) {
    const n = byId.get(id);
    const f = n.callFrame;
    const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()?.split('?')[0]}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + us);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  for (const [k, us] of top) console.log(`      ${(us / 1000).toFixed(0).padStart(6)} ms ${((us / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
}
