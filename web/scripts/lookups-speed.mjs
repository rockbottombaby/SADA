// usage: DATA=url node lookups-speed.mjs — cold timings of point lookups (airport, aircraft, flight) with the lookup copies
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', protocolTimeout: 900000 });
const p = await b.newPage();
p.on('console', m => { if (m.text().startsWith('⏱')) console.log(m.text()); });
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(u => localStorage.setItem('oam.dataUrl', u), process.env.DATA); await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__oam?.ctx, { timeout: 90000 });
const r = await p.evaluate(async () => {
  const { ctx, tools } = window.__oam, run = n => tools.find(t => t.name === n).run, out = [`lookup months: ${(ctx.manifest.lookups ?? []).length}`];
  const time = async (label, f) => { const t = performance.now(); try { const x = await f(); const l = `⏱ ${label}: ${((performance.now() - t) / 1000).toFixed(1)} s · ${x}`; out.push(l); console.log(l); } catch (e) { const l = `⏱ ${label}: ERROR ${String(e).slice(0, 120)}`; out.push(l); console.log(l); } };
  await time('flight details (RCH256 dossier)', async () => { const d = await run('flight_dossier')(ctx, { leg_id: 'ae0377-1791273136' }); return `${d.zones_crossed.length} crossings, ${d.same_aircraft_nearby.length} nearby`; });
  await time('aircraft past 60 days (ae117b)', async () => (await run('aircraft_history')(ctx, { aircraft: 'ae117b', date_from: '2026-08-16', date_to: '2026-10-15' })).length + ' flights');
  await time('Dover departures, Apr 2026', async () => (await run('airport_movements')(ctx, { airport: 'KDOV', direction: 'departures', date_from: '2026-04-01', date_to: '2026-04-30' })).total + ' flights');
  await time('Dover departures, whole archive', async () => (await run('airport_movements')(ctx, { airport: 'KDOV', direction: 'departures', date_from: '2023-03-11', date_to: '2026-10-15' })).total + ' flights');
  await time('aircraft profile 4X-ICA (archive)', async () => { const x = await run('aircraft_profile')(ctx, { aircraft: '4X-ICA' }); return `${x.flights ?? x.totals?.flights ?? '?'} flights`; });
  return out;
});
console.log(r.join('\n')); await b.close();
