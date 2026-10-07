// Opens the paper colour card, drags in it, and checks the colour reaches the map palette. Needs `npm run dev`.
import puppeteer from 'puppeteer-core';

const URL = process.env.WB_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--window-size=1300,800'] });
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 800 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${URL}/?sample=1`, { waitUntil: 'networkidle0' });
await page.click('.well');
const sv = await (await page.$('.cp-sv')).boundingBox();
await page.mouse.move(sv.x + sv.width * 0.8, sv.y + sv.height * 0.3);
await page.mouse.down();
await page.mouse.move(sv.x + sv.width * 0.6, sv.y + sv.height * 0.5, { steps: 4 });
await page.mouse.up();
await page.screenshot({ path: process.env.SHOT ?? 'colorpicker.png' });
const hex = await page.$eval('.cp-row input', (i) => i.value);
await page.keyboard.press('Escape');
const open = await page.$('.cp-pop');
const pal = await page.evaluate(() => window.__wb.doc.palette);
console.log('hex after drag:', hex, '| card closed on Esc:', !open, '| palette:', JSON.stringify(pal));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
