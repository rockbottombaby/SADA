// usage: DATA=url node skeleton.mjs outdir — open a flight from a cold start and capture the overlay as its parts trickle in
import puppeteer from 'puppeteer-core';
const [out] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
if (process.env.DATA) { await p.evaluate(u => localStorage.setItem('oam.dataUrl', u), process.env.DATA); await p.reload({ waitUntil: 'domcontentloaded' }); }
await p.waitForFunction(() => window.__oam?.ctx, { timeout: 90000 });
const id = await p.evaluate(async () => {
  const { ctx, tools } = window.__oam;
  const r = await tools.find(t => t.name === 'find_flights').run(ctx, { origin: 'US', destination: 'IL', date_from: '2025-03-01', date_to: '2025-03-10' });
  const f = (r.flights ?? r)[0]; return f.leg_id;
});
console.log('leg', id);
// a list click passes the row; here the id alone (map click): the header then waits for the first query
await p.evaluate(id => { window.__oam.selectLeg(id); }, id);
const t = Date.now();
for (const ms of [60, 400, 1500, 4000, 8000, 15000, 30000]) {
  await new Promise(r => setTimeout(r, Math.max(0, ms - (Date.now() - t))));
  const s = await p.evaluate(() => ({ sk: document.querySelectorAll('.sheet .sk').length, parts: Object.keys(window.__oam.app.inspectorDraft ?? {}).join(','), open: window.__oam.app.inspectorOpen, err: window.__oam.app.inspectorDraft?.error }));
  console.log(`${ms} ms`, JSON.stringify(s));
  await p.screenshot({ path: `${out}/sk_${ms}.png` });
}
await b.close();
