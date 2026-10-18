// usage: DATA=… [CENSUS=…] node scripts/replay.mjs — replays a recorded tool sequence (edit `steps`) without the model,
// logging every database query's start/end and every tool's duration (to find a call that never returns)
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', protocolTimeout: 1_200_000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 1000 });
const T0 = Date.now(), at = () => `${String(Math.round((Date.now() - T0) / 1000)).padStart(4)} s`;
p.on('pageerror', e => console.log(at(), '[pageerror]', String(e).slice(0, 300)));
p.on('console', m => { const t = m.text(); if (/^\[(q |step|tool)/.test(t)) console.log(at(), t); });
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate((d, c) => { localStorage.setItem('oam.apiKey', 'sk-ant-test'); localStorage.setItem('oam.dataUrl', d); if (c) localStorage.setItem('oam.censusKey', c); sessionStorage.setItem('oam.memorialSeen', '1'); }, process.env.DATA, process.env.CENSUS || '');
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__oam?.ctx && !document.querySelector('.splash'), { timeout: 90000 });
const steps = [
  [['investigate_airspace_claim', { zone_id: 'sov:ISL', country: 'IL', date_from: '2023-03-11', date_to: '2026-10-16' }]],
  [['flight_dossier', { leg_id: 'ae0377-1791273136' }], ['flight_dossier', { leg_id: '738c0b-1757628996' }], ['flight_dossier', { leg_id: '738c06-1763786452' }], ['flight_dossier', { leg_id: '738c0b-1782924728' }]],
  [['us_exports', { country: 'IL', hs: '93', date_from: '2023-03', date_to: '2026-10' }]],
  [['map_focus_zone', { zone_id: 'sov:ISL' }], ['map_show_flights', { search: { zone_id: 'sov:ISL', either_end_country: 'IL', date_from: '2023-03-11', date_to: '2026-10-16' }, label: 'x' }]],
];
for (const group of steps) {
  const r = await p.evaluate(async (group) => {
    const O = window.__oam;
    const keys = { census: localStorage.getItem('oam.censusKey') || '' };
    const ctx = { ...O.ctx, keys: () => keys, progress: () => {} };
    return Promise.all(group.map(async ([name, input]) => {
      const def = O.allTools.find(t => t.name === name); const t = Date.now();
      console.log('[step start]', name);
      const res = await Promise.race([def.run(ctx, input).then(() => 'ok', e => 'error: ' + String(e).slice(0, 160)), new Promise(r => setTimeout(() => r('STUCK > 240 s'), 240000))]);
      console.log('[step end]', name, res, Date.now() - t, 'ms');
      return [name, res];
    }));
  }, group);
  console.log(at(), JSON.stringify(r));
}
await b.close();
