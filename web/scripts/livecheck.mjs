// usage: node scripts/livecheck.mjs outdir — screenshots the empty dock, switches the live view on and reports its status bar (dev server on :5181, no model calls)
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 1000 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
p.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) console.log('[console]', m.text().slice(0, 300)); });
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.setItem('oam.apiKey', 'sk-ant-test'); sessionStorage.setItem('oam.memorialSeen', '1'); });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => (window).__oam, { timeout: 60000 });
await new Promise(r => setTimeout(r, 4000)); await p.keyboard.press('Escape');
await p.screenshot({ path: (process.argv[2] ?? '.') + '/empty.png' });
const live = await p.$$('.toolbar button'); for (const el of live) { const t = await el.evaluate(e => e.textContent); if (/LIVE/i.test(t)) { await el.click(); break; } }
await new Promise(r => setTimeout(r, 12000));
console.log('trails with ≥2 points:', await p.evaluate(() => { const T = (window).__oam.liveApi; return T.live.aircraft.filter(a => T.trailOf(a.hex).length > 1).length + ' of ' + T.live.aircraft.length; }));
console.log(await p.evaluate(() => document.querySelector('.livebar')?.textContent?.trim().slice(0, 200) ?? document.body.innerText.match(/.{0,60}aircraft live.{0,80}/)?.[0]));
await p.screenshot({ path: (process.argv[2] ?? '.') + '/live.png' });
// zoom into the busiest region (wheel over the US east coast) to see the trails
await p.mouse.move(470, 470); for (let i = 0; i < 6; i++) { await p.mouse.wheel({ deltaY: -400 }); await new Promise(r => setTimeout(r, 250)); }
await new Promise(r => setTimeout(r, 2500));
await p.screenshot({ path: (process.argv[2] ?? '.') + '/live-zoom.png' });
await b.close();
