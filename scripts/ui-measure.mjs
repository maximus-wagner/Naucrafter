// Run with the dev server up: `npm run dev`, then `node scripts/ui-measure.mjs [outDir]`.
// Drives the Measure tool with real mouse/keyboard input and checks the numbers it shows.
import puppeteer from 'puppeteer-core';

const OUT = process.argv[2] ?? (await import('node:os')).tmpdir();
const URL = process.env.WB_URL ?? 'http://localhost:5173/Naucrafter/';
const errors = [];
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--window-size=1400,850'],
  defaultViewport: { width: 1400, height: 850 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.goto(`${URL}?sample=1&proj=equirectangular&tool=measure`, { waitUntil: 'networkidle0' });
await wait(300);

const box = await page.$eval('.map-overlay', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top }; });
const m = page.mouse;
const at = (x, y) => [box.x + x, box.y + y];
/** Screen position (page coords) of a symbol, by index among symbols. */
const symbolXY = (i) =>
  page.evaluate((i) => {
    const app = window.__wb;
    const s = app.doc.items.filter((it) => it.kind === 'symbol')[i];
    const [x, y, z] = s.at;
    const p = app.view.projection([(Math.atan2(x, z) * 180) / Math.PI, (Math.asin(y) * 180) / Math.PI]);
    return p;
  }, i);
const panel = () => page.$eval('#props', (p) => p.innerText);
const rowValue = async (label) => {
  const rows = await page.$$eval('#props .row', (rs) => rs.map((r) => [r.firstChild.textContent, r.querySelector('output')?.textContent ?? '']));
  return rows.find(([l]) => l === label)?.[1] ?? null;
};
const parseKm = (s) => Number(s.replace(/,/g, '').replace(/[^\d.]/g, ''));

check('Measure tool is on the table and active', await page.$eval('[data-tool="measure"]', (b) => b.classList.contains('active')));
check('status line explains it', (await page.$eval('#hint', (h) => h.textContent)).startsWith('Measure'));

// 1. Click on the city, then on the town (both snap): the distance is the great-circle one.
const [cx, cy] = await symbolXY(0);
const [tx, ty] = await symbolXY(1);
await m.click(...at(cx + 3, cy + 2));
await m.click(...at(tx - 2, ty + 3));
await wait(100);
const expectedKm = await page.evaluate(() => {
  const app = window.__wb;
  const [a, b] = app.doc.items.filter((it) => it.kind === 'symbol').map((s) => s.at);
  const d = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  return d * app.doc.planet.radiusKm;
});
const shown = await rowValue('Distance');
check('distance matches the great circle between the two towns', shown && Math.abs(parseKm(shown) - expectedKm) < 1, `${shown} vs ${expectedKm.toFixed(1)} km`);
check('heading is shown', !!(await rowValue('Heading')), await rowValue('Heading'));
check('travel times are shown', !!(await rowValue('On foot')) && !!(await rowValue('By ship')), `${await rowValue('On foot')} on foot`);
await page.screenshot({ path: `${OUT}/measure-1-two-points.png` });

// 2. Keep clicking: a third point makes two legs and a total.
await m.click(...at(tx + 120, ty + 90));
await wait(100);
check('two legs listed', (await rowValue('Leg 1')) !== null && (await rowValue('Leg 2')) !== null);
const total = parseKm((await rowValue('Distance')) ?? '0');
const legs = parseKm((await rowValue('Leg 1')) ?? '0') + parseKm((await rowValue('Leg 2')) ?? '0');
check('total ≈ leg 1 + leg 2', Math.abs(total - legs) <= 2, `${total} vs ${legs}`);

// 3. Units.
await page.evaluate(() => [...document.querySelectorAll('#props .seg button')].find((b) => b.textContent === 'Miles').click());
await wait(100);
check('switches to miles', (await rowValue('Distance'))?.endsWith('mi'), await rowValue('Distance'));
await page.evaluate(() => [...document.querySelectorAll('#props .seg button')].find((b) => b.textContent === 'Kilometres').click());

// 4. Backspace removes the last point; Escape clears everything.
await page.keyboard.press('Backspace');
await wait(100);
check('Backspace drops a leg', (await rowValue('Leg 2')) === null);
await page.keyboard.press('Escape');
await wait(100);
check('Escape clears', (await rowValue('Distance')) === null);

// 5. Press, drag, release measures a straight line without a second click.
await m.move(...at(300, 600));
await m.down();
await m.move(...at(420, 640), { steps: 6 });
await m.up();
await wait(100);
check('drag measures a line', (await rowValue('Distance')) !== null, await rowValue('Distance'));
await page.keyboard.press('Escape');

// 6. Closing a loop gives a perimeter and an area.
const loop = [[400, 250], [560, 250], [560, 400], [400, 400]];
for (const [x, y] of loop) await m.click(...at(x, y));
await m.click(...at(...loop[0]));
await wait(100);
const area = await rowValue('Area');
check('closed loop reports a perimeter and area', !!area && (await rowValue('Perimeter')) !== null, `${await rowValue('Perimeter')}, ${area}`);
await page.screenshot({ path: `${OUT}/measure-2-loop.png` });
check('the map is untouched', (await page.evaluate(() => window.__wb.canUndo())) === false);

// 7. After a loop is closed, the next click on empty map starts a fresh measurement.
await m.click(...at(120, 650));
await wait(100);
check('next click starts over', (await rowValue('Area')) === null && (await rowValue('Perimeter')) === null);

// 8. A selected river shows its length, a selected island its area and perimeter.
const sizes = await page.evaluate(() => {
  const app = window.__wb;
  const out = {};
  for (const kind of ['river', 'land']) {
    app.select({ id: app.doc.items.find((i) => i.kind === kind).id, node: null });
    out[kind] = Object.fromEntries([...document.querySelectorAll('#props .row')].map((r) => [r.firstChild.textContent, r.querySelector('output')?.textContent]));
  }
  return out;
});
check('selected river shows a length', /km$/.test(sizes.river.Length ?? ''), sizes.river.Length);
check('selected island shows area and perimeter', /km²$/.test(sizes.land.Area ?? '') && /km$/.test(sizes.land.Perimeter ?? ''), `${sizes.land.Area}, ${sizes.land.Perimeter}`);

console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(fails.length || errors.length ? 1 : 0);
