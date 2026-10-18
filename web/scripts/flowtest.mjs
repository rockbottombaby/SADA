// usage: node flowtest.mjs outdir [DATA url]  — the journalist flow: pick From/To/airspace via autocomplete, period, find, refine, export
import puppeteer from 'puppeteer-core';
const [out] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 1000 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
if (process.env.DATA) { await p.evaluate(u => localStorage.setItem('oam.dataUrl', u), process.env.DATA); await p.reload({ waitUntil: 'domcontentloaded' }); }
await p.waitForSelector('.home .form', { timeout: 60000 });
await p.screenshot({ path: `${out}/f0_home.png` });
async function pick(label, text, want) {
  const inp = await p.evaluateHandle(l => [...document.querySelectorAll('.ef')].find(e => e.querySelector('.field > span')?.textContent === l).querySelector('input'), label);
  await inp.type(text); await p.waitForSelector('.drop button', { timeout: 15000 });
  const opts = await p.$$eval('.drop button', bs => bs.map(b => b.innerText.replace(/\s+/g, ' ')));
  const i = Math.max(0, opts.findIndex(o => o.toLowerCase().includes(want.toLowerCase())));
  console.log(`${label} "${text}" →`, opts.slice(0, 4).join(' | '), `→ picked #${i}`);
  await p.evaluate(i => document.querySelectorAll('.drop button')[i].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), i);
  await new Promise(r => setTimeout(r, 300));
}
await pick('From', 'United St', 'America');
await pick('To', 'Israel', 'country');
if (!process.env.NO_ZONE) await pick('Through airspace', 'Reykj', 'flight region');
// find without a period → asks for one
await p.click('.go'); console.log('without period:', await p.$eval('.period', e => e.innerText.includes('Choose a period')));
await p.evaluate(() => [...document.querySelectorAll('.chips button')].find(b => /Any time/i.test(b.innerText)).click());
await p.click('.go'); const t = Date.now();
await p.waitForSelector('.kpis, .err', { timeout: 180000 });
console.log('results in', ((Date.now() - t) / 1000).toFixed(1), 's:', await p.$eval('.bar .title', e => e.innerText), '|', await p.$eval('.kpis', e => e.innerText.replace(/\s+/g, ' ')).catch(() => p.$eval('.err', e => e.innerText)));
await new Promise(r => setTimeout(r, 1500)); await p.screenshot({ path: `${out}/f1_results.png` });
console.log('scene:', await p.$eval('.scene b', e => e.textContent).catch(() => '-'));
await b.close();
