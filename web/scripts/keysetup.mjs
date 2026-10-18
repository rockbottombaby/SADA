// usage: DATA=url node keysetup.mjs outdir — first-visit assistant setup: chat card, guide, a wrong key
import puppeteer from 'puppeteer-core';
const [out] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1400, height: 950 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(u => { localStorage.setItem('oam.dataUrl', u); localStorage.removeItem('oam.apiKey'); }, process.env.DATA); await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.keycard', { timeout: 90000 }); await new Promise(r => setTimeout(r, 1500));
await p.screenshot({ path: `${out}/k0_chat.png` });
await p.click('.keycard button'); await p.waitForSelector('.dialog .steps');
await p.screenshot({ path: `${out}/k1_guide.png` });
await p.type('.paste input', 'sk-ant-api03-this-is-not-a-real-key'); await p.click('.paste button');
await p.waitForSelector('.bad', { timeout: 20000 });
console.log('wrong key →', await p.$eval('.bad', e => e.textContent));
await p.screenshot({ path: `${out}/k2_bad.png` });
await b.close();
