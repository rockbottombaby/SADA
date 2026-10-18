// usage: DATA=https://…/v1 node loadtime.mjs   — times each loading step of the app in a real browser (cold cache)
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
let req = 0; p.on('request', r => { if (r.url().includes('workers.dev')) req++; });
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(u => localStorage.setItem('oam.dataUrl', u), process.env.DATA);
const t0 = Date.now(); let last = '', lastT = t0;
await p.reload({ waitUntil: 'domcontentloaded' });
while (Date.now() - t0 < 180000) {
  const st = await p.evaluate(() => document.querySelector('.splash .step')?.textContent ?? (document.querySelector('.home') ? 'DONE' : '…')).catch(() => '…');
  if (st !== last) { if (last) console.log(`${last.padEnd(32)} ${((Date.now() - lastT) / 1000).toFixed(1)} s`); last = st; lastT = Date.now(); }
  if (st === 'DONE') break;
  await new Promise(r => setTimeout(r, 100));
}
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)} s, ${req} requests to the data Worker`);
await p.evaluate(() => localStorage.removeItem('oam.dataUrl'));
await b.close();
