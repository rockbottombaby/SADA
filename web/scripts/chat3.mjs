// usage: KEY=… DATA=… [CENSUS=…] [PROFILE=balanced] [OR_KEY=sk-or-… OR_MODEL=…: via OpenRouter] [HEADFUL=1: a visible window to watch] [SHOTS=dir: a screenshot every 20 s] node chat3.mjs "question" out.png — one chat question end to end,
// logging what the assistant is doing every 20 s (to see where it spends time or stalls), then the answer
import puppeteer from 'puppeteer-core';
const [q, out] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: process.env.HEADFUL ? false : 'new', defaultViewport: null, protocolTimeout: 1_500_000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });   // the default 180 s cut long answers off
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 1000 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 400)));
const T0 = Date.now(); p.on('console', m => { if (/^\[(tool |q )/.test(m.text())) console.log(`  ${Math.round((Date.now() - T0) / 1000)} s ${m.text()}`); });
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate((k, c, prof, data, ork, orm) => { localStorage.setItem('oam.apiKey', k || ''); if (c) localStorage.setItem('oam.censusKey', c); localStorage.setItem('oam.profile', prof); localStorage.setItem('oam.dataUrl', data);
  // OR_KEY=sk-or-… OR_MODEL=anthropic/claude-haiku-5.5 runs the question through OpenRouter instead
  if (ork) { localStorage.setItem('oam.provider', 'openrouter'); localStorage.setItem('oam.openrouterKey', ork); localStorage.setItem('oam.openrouterModel', orm || 'anthropic/claude-haiku-5.5'); } else localStorage.setItem('oam.provider', 'anthropic'); },
  process.env.KEY, process.env.CENSUS || '', process.env.PROFILE || 'balanced', process.env.DATA, process.env.OR_KEY || '', process.env.OR_MODEL || '');
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__oam?.ctx && !document.querySelector('.splash'), { timeout: 90000 });
await p.evaluate(() => (window.__oam.app.memorialOpen = false));
// paste the whole question at once (typing would press Enter at each line break and send it in pieces)
await p.$eval('.composer textarea', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, q);
await p.click('.composer .send');
const t = Date.now();
const iv = setInterval(async () => {
  const s = await p.evaluate(() => ({ act: window.__oam.app.map.activity?.text || '', steps: [...document.querySelectorAll('.steps .lbl, .pending .lbl, .chip')].map(e => e.innerText).slice(-1)[0] || '' })).catch(() => ({}));
  console.log(`  ${Math.round((Date.now() - t) / 1000)} s · ${s.act || s.steps || '(thinking)'}`);
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/t${String(Math.round((Date.now() - t) / 1000)).padStart(3, '0')}.png` }).catch(() => {});
}, 20000);
await p.waitForSelector('.composer .send.stop', { timeout: 10000 }).catch(() => {});
await p.waitForFunction(() => !document.querySelector('.composer .send.stop'), { timeout: 1200000 }).catch(() => console.log('[timeout 20 min]'));
clearInterval(iv);
console.log('ANSWER after', Math.round((Date.now() - t) / 1000), 's');
await p.evaluate(() => document.querySelectorAll('.steps .sh').forEach(b => b.click()));
console.log('tools used:', (await p.$$eval('.sl .st', els => els.map(e => e.innerText.replace(/\s+/g, ' ')))).join(' | '));
console.log('meta:', await p.$$eval('.meta', els => els.map(e => e.innerText).join(' / ')));
console.log('case file:', await p.$$eval('.case', els => els.map(e => e.innerText.replace(/\s+/g, ' ')).join(' ')));
console.log('TEXT:\n' + (await p.$$eval('.asst .md', els => els.map(e => e.innerText).join('\n'))));
await p.screenshot({ path: out });
// the research trail: steps, pins, and the map at a clicked step
console.log('trail:', await p.$$eval('.rp .tick', els => els.map(e => e.getAttribute('title'))).catch(() => []), '| panel:', await p.$eval('.rp .meta', e => e.innerText).catch(() => '-'));
if (process.env.SHOTS) {
  const chips = await p.$$('.rp .tick');
  if (chips.length) { await chips[0].click(); await new Promise(r => setTimeout(r, 2500)); await p.screenshot({ path: `${process.env.SHOTS}/step1.png` });
    console.log('step 1 detail:', await p.$eval('.rp .now', e => e.innerText.replace(/\s+/g, ' ')).catch(() => '-')); }
}
await b.close();
