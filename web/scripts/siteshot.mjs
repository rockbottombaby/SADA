// usage: node scripts/siteshot.mjs outdir [base=https://sadawatch.com] — screenshots of the deployed info page and app
import puppeteer from 'puppeteer-core';
const [out, base = 'https://sadawatch.com'] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) console.log('[console]', m.text().slice(0, 300)); });
await p.goto(base + '/about/', { waitUntil: 'networkidle0' });
await p.screenshot({ path: `${out}/about.png`, fullPage: true });
await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.setItem('oam.apiKey', 'sk-ant-test'); sessionStorage.setItem('oam.memorialSeen', '1'); });
await p.reload({ waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 25000));
console.log('status bar:', (await p.$eval('header', e => e.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
await p.screenshot({ path: `${out}/app.png` });
await b.close();
