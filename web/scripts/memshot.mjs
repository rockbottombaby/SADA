// usage: node memshot.mjs out.png [width height] — the memorial alone, at 2x
import puppeteer from 'puppeteer-core';
const [out, w = 1440, h = 900] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const p = await b.newPage(); await p.setViewport({ width: +w, height: +h, deviceScaleFactor: 2 });
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.card h2'); await new Promise(r => setTimeout(r, 3000));
await p.screenshot({ path: out });
console.log(await p.evaluate(() => { const c = document.querySelector('.card').getBoundingClientRect(), i = document.querySelector('.portrait img').getBoundingClientRect(); return `card ${Math.round(c.width)}x${Math.round(c.height)} at y ${Math.round(c.y)} · img ${Math.round(i.width)}x${Math.round(i.height)} top ${Math.round(i.y)}`; }));
await b.close();
