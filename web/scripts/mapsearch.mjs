// usage: DATA=url node mapsearch.mjs out.png — map_show_flights in search mode: every military flight through the Reykjavik FIR
import puppeteer from 'puppeteer-core';
const [out] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', protocolTimeout: 900000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(u => localStorage.setItem('oam.dataUrl', u), process.env.DATA); await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__oam?.ctx && !document.querySelector('.splash'), { timeout: 120000 });
await p.evaluate(() => (window.__oam.app.memorialOpen = false));
const r = await p.evaluate(async () => {
  const { ctx } = window.__oam; const { UI_TOOLS } = await import('/src/lib/uiTools.ts');
  const t = performance.now();
  const x = await UI_TOOLS.find(t => t.name === 'map_show_flights').run(ctx, { search: { zone_id: 'fir:BIRD', military_only: true, date_from: '2023-03-11', date_to: '2026-10-15' }, label: 'Military flights through the Reykjavik FIR' });
  return { s: ((performance.now() - t) / 1000).toFixed(1), ...x };
});
await new Promise(r => setTimeout(r, 4000));
const drawn = await p.evaluate(() => window.__map.querySourceFeatures('flows').length);
console.log(JSON.stringify(r), '| map features:', drawn);
await p.screenshot({ path: out }); await b.close();
