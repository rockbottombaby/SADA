// usage: DATA=url node brand.mjs outdir — splash (with the eye) and the header logo, at 2x like a retina screen
import puppeteer from 'puppeteer-core';
const [out] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(u => localStorage.setItem('oam.dataUrl', u), process.env.DATA); await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.splash .eye'); await new Promise(r => setTimeout(r, 400));
await p.screenshot({ path: `${out}/b0_splash.png`, clip: { x: 400, y: 200, width: 400, height: 400 } });
await p.waitForSelector('.brand .logo'); await p.waitForFunction(() => !document.querySelector('.splash'), { timeout: 90000 });
await p.screenshot({ path: `${out}/b1_header.png`, clip: { x: 0, y: 0, width: 600, height: 60 } });
console.log('favicon links:', await p.$$eval('link[rel*=icon]', ls => ls.map(l => l.href.split('/').pop()).join(', ')));
await b.close();
