// Run with the dev server up: `npm run dev`, then `npm run ui-check`.
// Drives the Naucrafter UI with real mouse/keyboard input and reports what happened.
import puppeteer from 'puppeteer-core';

const OUT = process.argv[2] ?? (await import('node:os')).tmpdir();
const URL = process.env.WB_URL ?? 'http://localhost:5173/';
const log = (...a) => console.log(...a);
const errors = [];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--window-size=1400,850'],
  defaultViewport: { width: 1400, height: 850 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
page.on('dialog', (d) => d.accept());

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.goto(URL, { waitUntil: 'networkidle0' });

const state = () =>
  page.evaluate(() => {
    const app = window.__wb;
    return {
      items: app.doc.items.map((i) => ({ kind: i.kind, op: i.op, nodes: i.path?.nodes.length, text: i.text, symbol: i.symbol })),
      selection: app.selection,
      undo: app.canUndo(),
    };
  });
const box = await page.$eval('.map-overlay', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
const m = page.mouse;
const click = async (x, y) => { await m.click(x, y); await new Promise((r) => setTimeout(r, 40)); };
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

// 1. New map via the File menu: the setup dialog picks the planet size first.
await page.click('.menu-title');
await page.click('[data-cmd="new"]');
await page.select('#nm-preset', '3390');
await page.click('#new-map button[value="create"]');
await new Promise((r) => setTimeout(r, 100));
log('after New:', (await state()).items.length, 'items, planet radius', await page.evaluate(() => window.__wb.doc.planet.radiusKm), 'km');

// 2. Land pen: five clicks, one of them dragged into a curve, then close on the first node.
await page.keyboard.press('l');
const pts = [[-180, -120], [60, -170], [200, -20], [120, 150], [-150, 130]].map(([dx, dy]) => [cx + dx, cy + dy]);
for (const [i, [x, y]] of pts.entries()) {
  if (i === 2) {
    await m.move(x, y); await m.down(); await m.move(x + 40, y + 50, { steps: 5 }); await m.up();
  } else await click(x, y);
}
await click(...pts[0]);
let s = await state();
log('after land pen:', JSON.stringify(s.items), 'selected:', !!s.selection);

// 3. Water pen: a lake inside.
await page.keyboard.press('w');
for (const [dx, dy] of [[-40, -30], [30, -40], [20, 30]]) await click(cx + dx, cy + dy);
await page.keyboard.press('Enter');
log('after water pen:', (await state()).items.map((i) => `${i.kind}/${i.op}`).join(', '));

// 4. River pen: inland to beyond the coast, finish with double-click.
await page.keyboard.press('r');
await click(cx + 90, cy - 80);
await click(cx + 160, cy + 10);
await m.click(cx + 260, cy + 60, { count: 2 });
log('after river:', (await state()).items.map((i) => `${i.kind}:${i.nodes ?? ''}`).join(', '));

// 5. Stamp three symbols (the stamp places your PNG symbols; towns by default).
await page.keyboard.press('s');
for (const dx of [-100, -70, -40]) await click(cx + dx, cy + 80);
log('symbols:', (await state()).items.filter((i) => i.kind === 'symbol').length);

// 6. Text label.
await page.keyboard.press('t');
await click(cx - 60, cy - 90);
await page.keyboard.type('Testland');
await page.keyboard.press('Enter');
log('labels:', (await state()).items.filter((i) => i.kind === 'label').map((i) => i.text));
await shot('e2e-1-drawn');

// 7. Select tool: select the land shape by clicking inside, then drag its first node.
await page.keyboard.press('v');
await click(cx - 120, cy - 20);
s = await state();
log('selected after clicking land:', s.selection && s.items[s.items.length ? 0 : 0].kind, JSON.stringify(s.selection));
const before = await page.evaluate(() => window.__wb.doc.items[0].path.nodes[0].p.slice());
await m.move(...pts[0]); await m.down(); await m.move(pts[0][0] - 60, pts[0][1] - 40, { steps: 6 }); await m.up();
const after = await page.evaluate(() => window.__wb.doc.items[0].path.nodes[0].p.slice());
log('node moved:', JSON.stringify(before) !== JSON.stringify(after));
await shot('e2e-2-node-dragged');

// 8. Undo restores the node.
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
const undone = await page.evaluate(() => window.__wb.doc.items[0].path.nodes[0].p.slice());
log('undo restored node:', JSON.stringify(undone) === JSON.stringify(before));

// 9. Double-click the coastline between two nodes to insert a node.
const n0 = (await state()).items[0].nodes;
const mid = [(pts[3][0] + pts[4][0]) / 2, (pts[3][1] + pts[4][1]) / 2];
const onLine = await page.evaluate(([x, y]) => {
  // Find the nearest point on the drawn path to the midpoint between two nodes, in screen space.
  const app = window.__wb, it = app.doc.items[0];
  const pts = app.cache.base(it.id, it.rev, it.path).pts;
  const proj = app.view.projection;
  let best = null, bd = Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const lon = Math.atan2(pts[i], pts[i + 2]) * 180 / Math.PI, lat = Math.asin(pts[i + 1]) * 180 / Math.PI;
    const s = proj([lon, lat]);
    const d = Math.hypot(s[0] - x, s[1] - y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}, [mid[0] - box.x, mid[1] - box.y]);
await click(cx - 120, cy - 20); // make sure it's selected
await m.click(onLine[0] + box.x, onLine[1] + box.y, { count: 2 });
log('nodes before/after double-click on line:', n0, (await state()).items[0].nodes);

// 10. Click a stamped symbol and delete it.
const symCount = (await state()).items.filter((i) => i.kind === 'symbol').length;
await click(cx - 70, cy + 76);
s = await state();
log('selected kind:', s.selection && (await page.evaluate(() => window.__wb.selected()?.kind)));
await page.keyboard.press('Delete');
log('symbols before/after delete:', symCount, (await state()).items.filter((i) => i.kind === 'symbol').length);

// 11. Pan (right-drag) and zoom (wheel).
const rot0 = await page.evaluate(() => window.__wb.view.projection.rotate());
await m.move(cx, cy); await m.down({ button: 'right' }); await m.move(cx + 120, cy + 30, { steps: 5 }); await m.up({ button: 'right' });
const rot1 = await page.evaluate(() => window.__wb.view.projection.rotate());
log('pan changed rotation:', JSON.stringify(rot0) !== JSON.stringify(rot1));
const z0 = await page.evaluate(() => window.__wb.view.zoom());
await m.wheel({ deltaY: -400 });
await new Promise((r) => setTimeout(r, 100));
log('zoom before/after wheel:', z0.toFixed(2), (await page.evaluate(() => window.__wb.view.zoom())).toFixed(2));

// 12. Projection switch through the View menu, and an SVG export round trip in-page.
await page.click('.menu:nth-of-type(3) .menu-title');
await page.click('[data-cmd="proj:equalEarth"]');
log('projection now:', await page.evaluate(() => window.__wb.view.projectionId));
await new Promise((r) => setTimeout(r, 200));
await shot('e2e-3-equal-earth');

// 13. Freehand: draw a rough loop with the land pencil, then vegetation and a mountain range inside it.
await page.click('.menu-title');
await page.click('[data-cmd="new"]');
await page.click('#new-map button[value="create"]');
await new Promise((r) => setTimeout(r, 100));
const loop = async (key, r, wobble) => {
  await page.keyboard.press(key);
  const pts = Array.from({ length: 90 }, (_, i) => {
    const a = (i / 90) * Math.PI * 2;
    const rr = r * (1 + wobble * Math.sin(a * 5));
    return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.75];
  });
  await m.move(...pts[0]);
  await m.down();
  for (const pt of pts.slice(1)) await m.move(...pt);
  await m.up();
  await new Promise((r) => setTimeout(r, 100));
};
await loop('l', 230, 0.12);
await loop('f', 110, 0.05);
await loop('m', 60, 0.05);
const drawn = await page.evaluate(() => window.__wb.doc.items.map((i) => ({ kind: i.kind, closed: i.path?.closed, nodes: i.path?.nodes.length })));
log('freehand items:', JSON.stringify(drawn));
await page.keyboard.press('v');
await m.click(cx + 80, cy - 40); // inside the vegetation ring, outside the mountains
await page.select('#props select:has(option[value="jungle"])', 'jungle');
log('vegetation type from panel:', await page.evaluate(() => window.__wb.doc.items.find((i) => i.kind === 'forest')?.vegetation ?? '(mountains selected)'));
await shot('e2e-6-freehand');

log('errors:', errors.length ? errors : 'none');
await browser.close();
