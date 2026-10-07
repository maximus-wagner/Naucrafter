// Switches between the toolbox and tools-on-the-table, clicks a physical tool, screenshots both. Needs `npm run dev`.
import puppeteer from 'puppeteer-core';

const URL = process.env.WB_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.OUT ?? '.';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--window-size=1300,800'] });
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 800 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${URL}/?sample=1`, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.removeItem('wb-tools-on-table'));
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: `${OUT}/mode-toolbox.png` });

await page.click('#toolbox .modeswitch');
const onTable = await page.evaluate(() => document.body.classList.contains('table-tools'));
await page.click('.ptool[data-tool="river"]');
const active = await page.evaluate(() => [...document.querySelectorAll('[data-tool].active')].map((b) => b.className.split(' ')[0] + ':' + b.dataset.tool));
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${OUT}/mode-table.png` });

await page.click('#tabletools .modeswitch');
const back = await page.evaluate(() => !document.body.classList.contains('table-tools'));
console.log('table mode on:', onTable, '| active after clicking river:', active, '| back to toolbox:', back);
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
