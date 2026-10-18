// usage: DATA=url node livetest2.mjs outdir — Live layer: toggle, aircraft on the globe, click one, its past flights
import puppeteer from 'puppeteer-core';
const [out] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(u => { localStorage.setItem('oam.dataUrl', u); localStorage.removeItem('oam.proxyBase'); }, process.env.DATA); await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__oam?.ctx && !document.querySelector('.splash'), { timeout: 90000 });
await p.evaluate(() => (window.__oam.app.memorialOpen = false));
await p.click('.livebtn');
await p.waitForFunction(() => document.querySelector('.livestat b') || document.querySelector('.livestat .err'), { timeout: 30000 });
console.log('status:', await p.$eval('.livestat', e => e.innerText));
await new Promise(r => setTimeout(r, 1500));
await p.screenshot({ path: `${out}/l1_world.png` });
// click the first rendered aircraft
const pt = await p.evaluate(() => { const m = window.__map; const f = m.queryRenderedFeatures({ layers: ['live'] })[0]; if (!f) return null; const q = m.project(f.geometry.coordinates); return { x: q.x, y: q.y, hex: f.properties.hex }; });
console.log('first aircraft on screen:', JSON.stringify(pt));
if (pt) {
  const box = await p.$eval('.map', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  await p.mouse.click(box.x + pt.x, box.y + pt.y); await p.waitForSelector('.livecard', { timeout: 5000 });
  console.log('card:', (await p.$eval('.livecard', e => e.innerText)).replace(/\s+/g, ' ').slice(0, 200));
  await p.screenshot({ path: `${out}/l2_card.png` });
  await p.click('.livecard .primary'); await p.waitForFunction(() => !document.querySelector('.livecard .primary')?.disabled, { timeout: 240000 });
  console.log('past flights scene:', await p.$eval('.scene b', e => e.textContent).catch(() => '-'), '| flows:', await p.evaluate(() => window.__oam.app.map.flows.length), '| status:', await p.evaluate(() => window.__oam.app.status));
  await new Promise(r => setTimeout(r, 1500)); await p.screenshot({ path: `${out}/l3_past.png` });
}
await b.close();
