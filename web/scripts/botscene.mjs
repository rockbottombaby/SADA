// usage: KEY=... node botscene.mjs   — two assistant answers in a row: the second must replace the first's map
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 1000 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(k => { localStorage.setItem('oam.apiKey', k); localStorage.setItem('oam.profile', 'fast'); }, process.env.KEY);
await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForSelector('.composer textarea', { timeout: 60000 });
const scene = () => p.evaluate(() => ({ title: document.querySelector('.scene b')?.textContent, by: document.querySelector('.scene .label')?.textContent, items: document.querySelector('.scene .items')?.innerText.replace(/\s+/g, ' ') }));
async function ask(q) {
  await p.type('.composer textarea', q); await p.click('.composer .send');
  await p.waitForSelector('.composer .send.stop', { timeout: 10000 }).catch(() => {});
  await p.waitForFunction(() => !document.querySelector('.composer .send.stop'), { timeout: 180000 });
  await new Promise(r => setTimeout(r, 1000)); console.log(q, '\n  →', JSON.stringify(await scene()));
}
await ask('Show Iceland\'s sovereign airspace on the map. One sentence.');
await ask('Now show only the track of LOY026 on 8 April on the map. One sentence.');
await b.close();
