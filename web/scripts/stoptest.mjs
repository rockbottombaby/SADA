// usage: KEY=... node stoptest.mjs   starts an investigation, presses Stop at several moments, then checks a follow-up works
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 1000 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate((k, c) => { localStorage.setItem('oam.apiKey', k); localStorage.setItem('oam.censusKey', c); localStorage.setItem('oam.profile', 'fast'); }, process.env.KEY, process.env.CENSUS);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.composer textarea', { timeout: 60000 });
const running = () => p.$('.composer .send.stop');
for (const delay of [2000, 9000]) {
  await p.type('.composer textarea', 'Investigate 4X-ICA in depth: profile, rotations, trade cross-check, and records to request.');
  await p.click('.composer .send');
  await new Promise(r => setTimeout(r, delay));
  const t = Date.now();
  const btn = await running();
  if (!btn) { console.log(`stop@${delay}ms: already finished`); continue; }
  await btn.click();
  await p.waitForFunction(() => !document.querySelector('.composer .send.stop'), { timeout: 30000 }).catch(() => console.log('  still running after 30 s!'));
  const steps = await p.$$eval('.steps .lbl', els => els.at(-1)?.innerText);
  await p.evaluate(() => document.querySelectorAll('.steps .sh').forEach(b => b.click()));
  const last = await p.$$eval('.sl', els => els.at(-1)?.innerText.split('\n').slice(-2).join(' | '));
  console.log(`stop@${delay}ms: stopped after ${(Date.now() - t)} ms; steps: ${steps}; last: ${last}`);
}
await p.type('.composer textarea', 'In one sentence: what is 4X-ICA?');
await p.click('.composer .send');
await p.waitForSelector('.composer .send.stop', { timeout: 10000 }).catch(() => {});
await p.waitForFunction(() => !document.querySelector('.composer .send.stop'), { timeout: 120000 });
console.log('follow-up:', (await p.$$eval('.asst', els => els.at(-1).innerText)).replace(/\s+/g, ' ').slice(-250));
await b.close();
