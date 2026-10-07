// Panel interactions, scatter, exports and render timing on the sample map.
import puppeteer from 'puppeteer-core';

const OUT = process.argv[2] ?? (await import('node:os')).tmpdir();
const errors = [];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, defaultViewport: { width: 1400, height: 850 } });
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
page.on('dialog', (d) => d.accept());
await page.goto((process.env.WB_URL ?? 'http://localhost:5173/') + '?sample=1&rotate=0,20&zoom=2.2', { waitUntil: 'networkidle0' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const m = page.mouse;
const box = await page.$eval('.map-overlay', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top }; });
const screenOfItem = (index) =>
  page.evaluate((i) => {
    const app = window.__wb, it = app.doc.items[i];
    const v = it.at;
    const s = app.view.projection([Math.atan2(v[0], v[2]) * 180 / Math.PI, Math.asin(v[1]) * 180 / Math.PI]);
    return s;
  }, index);
const itemIndex = (pred) => page.evaluate((src) => window.__wb.doc.items.findIndex(new Function('i', `return ${src}`)), pred);

// Curve a label from the panel.
const li = await itemIndex("i.kind === 'label' && i.text === 'Westmarch'");
const [lx, ly] = await screenOfItem(li);
await m.click(box.x + lx, box.y + ly);
await sleep(50);
const buttons = await page.$$eval('#props .btn', (bs) => bs.map((b) => b.textContent));
console.log('panel buttons for label:', buttons);
for (const b of await page.$$('#props .btn')) if ((await b.evaluate((x) => x.textContent)) === 'Curve along a path') await b.click();
console.log('label curved:', await page.evaluate((i) => !!window.__wb.doc.items[i].path, li));
await sleep(100);
await page.screenshot({ path: `${OUT}/e2e-4-curved-label.png` });

// Symbol size slider: select the city, then drive the slider with the keyboard.
const mi = await itemIndex("i.kind === 'symbol' && i.symbol === 'city'");
const [mx, my] = await screenOfItem(mi);
await m.click(box.x + mx, box.y + my);
await sleep(50);
const size0 = await page.evaluate((i) => window.__wb.doc.items[i].size, mi);
const slider = await page.$('#props input[type=range]');
await slider.focus();
for (let k = 0; k < 8; k++) await page.keyboard.press('ArrowRight');
const size1 = await page.evaluate((i) => window.__wb.doc.items[i].size, mi);
console.log('symbol size via slider:', size0.toFixed(3), '->', size1.toFixed(3));
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await page.click('.map-overlay', { offset: { x: 5, y: 5 } }).catch(() => {});
console.log('undo restored size:', (await page.evaluate((i) => window.__wb.doc.items[i].size, mi)).toFixed(3));

// Scatter trees.
await page.keyboard.press('s');
await sleep(50);
await page.select('#props select', 'town');
await page.click('#props input[type=checkbox]');
const trees0 = await page.evaluate(() => window.__wb.doc.items.filter((i) => i.symbol === 'town').length);
await m.move(box.x + 300, box.y + 520); await m.down(); await m.move(box.x + 520, box.y + 560, { steps: 25 }); await m.up();
const trees1 = await page.evaluate(() => window.__wb.doc.items.filter((i) => i.symbol === 'town').length);
console.log('scatter towns:', trees0, '->', trees1);
await sleep(100);
await page.screenshot({ path: `${OUT}/e2e-5-scatter.png` });

// Render timing: cached geometry vs. after a land edit.
const timing = await page.evaluate(() => {
  const app = window.__wb, view = app.view;
  const draw = () => { const t = performance.now(); view.draw(view.base, view.onRender); return performance.now() - t; };
  const cached = [draw(), draw(), draw()];
  const land = app.doc.items.find((i) => i.kind === 'land');
  const edited = [];
  for (let k = 0; k < 3; k++) { app.touch(land); edited.push(draw()); }
  return { cached: cached.map((x) => x.toFixed(1)), afterLandEdit: edited.map((x) => x.toFixed(1)) };
});
console.log('render ms:', JSON.stringify(timing));

// Exports produce files (intercept the download link instead of saving).
const exports = await page.evaluate(async () => {
  const got = [];
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { got.push(this.download); };
  for (const cmd of ['export-svg', 'save']) document.querySelector(`[data-cmd="${cmd}"]`).click();
  await new Promise((r) => setTimeout(r, 300));
  HTMLAnchorElement.prototype.click = orig;
  return got;
});
console.log('downloads triggered:', exports);
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
