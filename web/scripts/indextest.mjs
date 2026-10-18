// usage: DATA=… node indextest.mjs — times find_flights over a long 2023 period (uses the route / airspace index when present)
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const p = await b.newPage();
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(u => localStorage.setItem('oam.dataUrl', u), process.env.DATA);
await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForSelector('.home', { timeout: 60000 });
const cases = [
  ['US → Israel, Mar–Dec 2023 (route index)', { origin: 'US', destination: 'IL', date_from: '2023-03-10', date_to: '2023-12-31' }],
  ['KDOV → anywhere, Mar–Dec 2023 (route index + airport country)', { origin: 'KDOV', date_from: '2023-03-10', date_to: '2023-12-31' }],
  ["Iceland's airspace, Apr–Jun 2023 (airspace index)", { through_zone: 'sov:ISL', date_from: '2023-04-01', date_to: '2023-06-30' }],
];
for (const [label, args] of cases) {
  const r = await p.evaluate(async a => {
    const o = window.__oam;
    const t = performance.now(); const x = await o.tools.find(t => t.name === 'find_flights').run(o.ctx, a);
    return { s: ((performance.now() - t) / 1000).toFixed(1), flights: x.totals.flights, idx: x.used_index, top: x.top_routes.slice(0, 2).map(r => r.value + ' ' + r.flights).join(', ') };
  }, args).catch(e => ({ error: String(e).slice(0, 200) }));
  console.log(label.padEnd(64), JSON.stringify(r));
}
await b.close();
