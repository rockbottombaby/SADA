// usage: DATA=url node livefilters.mjs outdir — live filters at world view and zoomed in, and trails after two updates
import puppeteer from 'puppeteer-core';
const [out] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(u => { localStorage.setItem('oam.dataUrl', u); localStorage.removeItem('oam.proxyBase'); }, process.env.DATA); await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__oam?.ctx && !document.querySelector('.splash'), { timeout: 90000 });
await p.evaluate(() => (window.__oam.app.memorialOpen = false));
await p.click('.livebtn'); await p.waitForSelector('.livestat b', { timeout: 30000 });
const stat = () => p.$eval('.livestat', e => e.innerText.replace(/\s+/g, ' '));
const pick = async label => { await p.evaluate(l => [...document.querySelectorAll('.livestat .lf button')].find(b => b.textContent === l).click(), label); await new Promise(r => setTimeout(r, 2500)); };
for (const f of ['Military', 'Transports', 'Cargo', 'All traffic']) { await pick(f); console.log('world ·', f.padEnd(11), '→', await stat()); }
await p.evaluate(() => window.__map.jumpTo({ center: [8, 50.5], zoom: 5.6 })); await new Promise(r => setTimeout(r, 3500));
for (const f of ['All traffic', 'Cargo']) { await pick(f); console.log('Europe ·', f.padEnd(11), '→', await stat()); }
await pick('All traffic');
console.log('waiting for two updates (trails)…'); await new Promise(r => setTimeout(r, 18000));
console.log('trail lines drawn:', await p.evaluate(() => window.__map.querySourceFeatures('live-trail').length));
await p.screenshot({ path: `${out}/f_europe_all.png` });
await b.close();
