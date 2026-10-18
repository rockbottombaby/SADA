// usage: OAM_ACCESS_KEY=… OPENSKY_CLIENT_ID=… OPENSKY_CLIENT_SECRET=… node opensky-proxy-test.mjs
// Checks from a real browser page that OpenSky is blocked directly but works through the data Worker's proxy.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const p = await b.newPage();
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
const out = await p.evaluate(async (base, id, secret) => {
  const res = {};
  try { await fetch('https://opensky-network.org/api/flights/departure?airport=KDOV&begin=1760400000&end=1760486399'); res.direct = 'unexpectedly worked'; } catch (e) { res.direct = 'blocked (expected)'; }
  const t = await fetch(base.replace(/\/opensky$/, '/opensky-auth'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
  res.auth = t.status; const tok = (await t.json()).access_token;
  const r = await fetch(`${base}/flights/departure?airport=KDOV&begin=1760400000&end=1760486399`, { headers: { Authorization: 'Bearer ' + tok } });
  res.flights_status = r.status; const j = r.status === 200 ? await r.json() : await r.text();
  res.flights = Array.isArray(j) ? j.slice(0, 3).map(f => `${(f.callsign || '').trim()} ${f.estDepartureAirport}->${f.estArrivalAirport}`) : String(j).slice(0, 120);
  res.other_path_blocked = (await fetch(`${base}/states/own`)).status;
  return res;
}, `${process.env.DATA}`, process.env.OPENSKY_CLIENT_ID, process.env.OPENSKY_CLIENT_SECRET);
console.log(JSON.stringify(out, null, 1));
await b.close();
