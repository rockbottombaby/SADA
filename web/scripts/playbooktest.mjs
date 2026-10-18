// usage: DATA=url node playbooktest.mjs — run both playbooks over the whole archive and time them
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', protocolTimeout: 900000 });
const p = await b.newPage();
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(u => localStorage.setItem('oam.dataUrl', u), process.env.DATA); await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__oam?.ctx, { timeout: 120000 });
const r = await p.evaluate(async () => {
  const { ctx } = window.__oam; const { PLAYBOOKS } = await import('/src/lib/playbooks.ts'); const out = [];
  const run = async (name, args) => { const t = performance.now(); try { const x = await PLAYBOOKS.find(t => t.name === name).run(ctx, args); return [((performance.now() - t) / 1000).toFixed(1), x]; } catch (e) { return [((performance.now() - t) / 1000).toFixed(1), { error: String(e).slice(0, 200) }]; } };
  let [s, x] = await run('investigate_airspace_claim', { zone_id: 'sov:ISL', country: 'IL' });
  out.push(`airspace claim sov:ISL/IL whole archive: ${s} s`, x.error ?? `  totals ${JSON.stringify(x.totals_linked_to_country)} · military ${x.military_flights?.length} · cargo ${JSON.stringify(x.cargo_operators?.totals)} · coverage ${x.coverage?.days_with_receiver_coverage}/${x.coverage?.days_in_period} · validation ${x.coverage?.validation_of_inferred_crossings?.inferred_crossings_confirmed ?? '-'} · leads ${x.leads?.length}`);
  out.push('  leads: ' + (x.leads ?? []).map(l => l.lead).join(' | '));
  [s, x] = await run('investigate_airlift_base', { airport: 'KDOV', country: 'IL', date_from: '2026-01-01', date_to: '2026-10-15' });
  out.push(`airlift base KDOV→IL 2026: ${s} s`, x.error ?? `  departures ${x.departures_total}, to IL ${x.to_country?.total} · by prefix ${JSON.stringify(x.to_country?.by_callsign_prefix?.slice(0, 4))} · by month ${JSON.stringify(x.to_country?.by_month)}`);
  return out;
});
console.log(r.join('\n')); await b.close();
