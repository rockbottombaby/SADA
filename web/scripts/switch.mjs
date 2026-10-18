// usage: KEY=... node switch.mjs   asks with Fast (Haiku), then follows up in the same chat with Balanced (Sonnet)
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 1000 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(k => { localStorage.setItem('oam.apiKey', k); localStorage.setItem('oam.profile', 'fast'); }, process.env.KEY);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.composer textarea', { timeout: 60000 });
async function ask(q) {
  await p.type('.composer textarea', q); await p.click('.composer .send');
  await p.waitForSelector('.composer .send.stop', { timeout: 10000 }).catch(() => {});
  await p.waitForFunction(() => !document.querySelector('.composer .send.stop'), { timeout: 240000 });
  const t = await p.$$eval('.asst', els => els[els.length - 1].innerText);
  console.log('---', q, '\n', t.slice(-300).replace(/\s+/g, ' '));
}
await ask('How many flights by 4X-ICA are in the data? One sentence.');
await p.select('.composer select.pill', 'balanced');
await ask('And which airports did they use? One sentence.');
await b.close();
