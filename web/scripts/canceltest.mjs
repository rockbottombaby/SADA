// usage: DATA=url node canceltest.mjs — Stop must free the database: cancel a slow query, then the next one answers at once
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', protocolTimeout: 600000 });
const p = await b.newPage();
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(u => localStorage.setItem('oam.dataUrl', u), process.env.DATA); await p.reload({ waitUntil: 'domcontentloaded' });
const t0 = Date.now();
await p.waitForFunction(() => window.__oam?.ctx, { timeout: 120000 });
console.log('startup', ((Date.now() - t0) / 1000).toFixed(1), 's (all startup queries now streamed)');
const r = await p.evaluate(async () => {
  const { ctx, tools, cancelCurrent } = window.__oam, out = [];
  const run = n => tools.find(t => t.name === n).run;
  let t = performance.now();
  const d = await run('flight_dossier')(ctx, { leg_id: 'ae0377-1791273136' });
  out.push(`dossier: ${((performance.now() - t) / 1000).toFixed(1)} s, ${d.zones_crossed.length} crossings`);
  // a slow query (whole archive for one airport without the yearly index yet), cancelled after 3 s
  t = performance.now();
  const slow = run('airport_movements')(ctx, { airport: 'KDOV', direction: 'both', date_from: '2023-03-11', date_to: '2026-10-15' }).then(() => 'finished', e => `cancelled: ${String(e).slice(0, 60)}`);
  await new Promise(r => setTimeout(r, 3000));
  await cancelCurrent();
  const res = await Promise.race([slow, new Promise(r => setTimeout(() => r('still running after cancel'), 15000))]);
  out.push(`slow query → ${res} after ${((performance.now() - t) / 1000).toFixed(1)} s`);
  t = performance.now();
  const n = await ctx.query('SELECT count(*) AS n FROM airports');
  out.push(`next query answered in ${((performance.now() - t) / 1000).toFixed(2)} s (${n[0].n} airports)`);
  return out;
});
console.log(r.join('\n')); await b.close();
