// Looks every air case in oam/cases/cases.csv up in the SADA archive (queries from oam/cases/queries.json) through the
// dev server on :5181, and writes oam/cases/matches.json: the matching flights (leg ids, callsigns, registrations, legs)
// and how well the archive corroborates each report. Re-run after a data rebuild or when cases are added.
// usage: node scripts/cases-match.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const ROOT = new URL('../../cases/', import.meta.url).pathname;
const queries = JSON.parse(fs.readFileSync(ROOT + 'queries.json', 'utf8'));
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.setItem('oam.provider', 'openrouter'); localStorage.setItem('oam.openrouterKey', 'sk-or-v1-x'); });
await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForFunction(() => window.__oam?.ctx && !document.querySelector('.splash'), { timeout: 120000 });
await p.evaluate(() => (window.__oam.app.memorialOpen = false));
const out = {};
for (const [id, q] of Object.entries(queries)) {
  if (id.startsWith('_')) continue;
  const r = await p.evaluate(a => window.__oam.stateApi.tool('find_flights', { ...a, limit: 40 }).then(x => (x.flights || []).map(l => ({ leg_id: l.leg_id, hex: l.hex, callsign: String(l.callsigns || '').split(' ')[0], reg: l.reg || '', type: l.type || '', from: l.from_code || '', to: l.to_code || '', date: l.date, evidence: l.evidence || '' }))).catch(e => ({ err: String(e).slice(0, 160) })), q.args);
  if (r.err) { console.log(id, 'ERR', r.err); out[id] = { match: 'none', legs: [], error: r.err }; continue; }
  const legs = (q.keep ? r.filter(l => q.keep.includes(l.callsign)) : r).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);
  out[id] = { match: legs.length ? q.match : 'none', note: q.note || '', legs };
  console.log(id, out[id].match, legs.map(l => `${l.callsign} ${l.reg} ${l.from || '?'}→${l.to || '?'} ${l.date}`).join(' | ') || '(none)');
}
fs.writeFileSync(ROOT + 'matches.json', JSON.stringify({ matched_utc: new Date().toISOString().slice(0, 16) + 'Z', cases: out }, null, 1) + '\n');
await b.close();
console.log('wrote', ROOT + 'matches.json');
