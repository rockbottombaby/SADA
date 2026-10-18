// usage: DATA=url node dossier-timing.mjs LEG_ID — time each query behind the flight details overlay (cold, then warm)
import puppeteer from 'puppeteer-core';
const [id] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const p = await b.newPage();
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(u => localStorage.setItem('oam.dataUrl', u), process.env.DATA); await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__oam?.ctx, { timeout: 90000 });
for (const pass of ['cold', 'warm']) {
  const r = await p.evaluate(async id => {
    const { ctx, tools } = window.__oam; const out = [];
    const orig = ctx.query; ctx.query = async (sql) => { const t = performance.now(); const x = await orig.call(ctx, sql); out.push([Math.round(performance.now() - t), sql.replace(/\s+/g, ' ').slice(0, 150)]); return x; };
    const t = performance.now();
    await tools.find(x => x.name === 'flight_dossier').run(ctx, { leg_id: id });
    await tools.find(x => x.name === 'get_track').run(ctx, { leg_id: id, max_points: 4000 });
    ctx.query = orig; out.push([Math.round(performance.now() - t), 'TOTAL']); return out;
  }, id);
  console.log('--', pass); for (const [ms, q] of r) console.log(String(ms).padStart(7), 'ms ', q);
}
await b.close();
