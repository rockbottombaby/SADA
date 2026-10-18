// usage: DATA=url node memorial.mjs outdir — the memorial on open (desktop and phone), then the app behind it
import puppeteer from 'puppeteer-core';
const [out] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const [name, vp] of [['desktop', { width: 1440, height: 900, deviceScaleFactor: 2 }], ['phone', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true }]]) {
  const p = await b.newPage(); await p.setViewport(vp);
  p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
  await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(u => localStorage.setItem('oam.dataUrl', u), process.env.DATA); await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.card h2'); await new Promise(r => setTimeout(r, 1600));
  await p.screenshot({ path: `${out}/m_${name}.png` });
  if (name === 'desktop') {
    await p.waitForFunction(() => !document.querySelector('.splash'), { timeout: 90000 });
    await p.click('.card button'); await new Promise(r => setTimeout(r, 600));
    console.log('closed:', !(await p.$('.card')));
    await p.screenshot({ path: `${out}/m_after.png`, clip: { x: 0, y: 0, width: 700, height: 60 } });
    await p.click('.brand'); await new Promise(r => setTimeout(r, 400)); console.log('reopens from logo:', !!(await p.$('.card')));
  }
  await p.close();
}
await b.close();
