// Screenshot of the bottom-left dock with a research trail and a map scene both showing (no model calls).
// usage: node scripts/dockshot.mjs out-prefix   (dev server on :5181) → out-prefix-{normal,min,max-research,max-scene}.png
import puppeteer from 'puppeteer-core';
const out = process.argv[2] ?? 'dock';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 1000 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.setItem('oam.apiKey', 'sk-ant-test'); sessionStorage.setItem('oam.memorialSeen', '1'); });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => (window).__oam, { timeout: 60000 });
await new Promise(r => setTimeout(r, 4000));
await p.keyboard.press('Escape');
await p.evaluate(async () => {
  const T = (window).__oam.trailApi, S = (window).__oam.stateApi;
  const app = S.app, chat = app.map.activeChat || 'dock-test';
  app.map.activeChat = chat;
  const flows = Array.from({ length: 391 }, (_, i) => ({ leg_id: 'x' + i, hex: '4b' + i, t0: 1.7e9 + i * 3600, t1: 1.7e9 + i * 3600 + 9000, callsigns: 'ICE' + (100 + i), reg: 'TF-F' + i, type: 'B752',
    date: '2026-04-0' + (1 + i % 9), from_code: 'BIKF', to_code: 'LLBG', from_cert: 'recorded', to_cert: 'recorded', evidence: i % 3 ? 'observed' : 'inferred', from_lat: 64, from_lon: -22.6, to_lat: 32, to_lon: 34.9 }));
  S.setScene({ zone: 'sov_ISL', flows, flowsLabel: 'test' }, { title: 'All flights, Iceland sovereign airspace (391 flights)', by: 'assistant', chat });
  T.trailStart(chat, 'Is Iceland letting Israel-bound weapons flights through?');
  T.trailCall(chat, 'investigate_airspace_claim', 'Investigate airspace claim · Iceland', { zone_id: 'sov_ISL' });
  T.trailProgress(chat, 'investigate_airspace_claim', 'Reading airspace index sov_ISL · 2026-Q3');
  T.trailPhase('Reading the archive');
  return { scene: !!app.map.scene, steps: T.currentTrail()?.steps.length, same: S.app === (window).__oam.app, chat, dock: !!document.querySelector('.dock') };
}).then(r => console.log(r));
const modes = { normal: ['normal', 'normal'], min: ['min', 'min'], 'max-research': ['max', 'normal'], 'max-scene': ['normal', 'max'] };
for (const [name, [r, sc]] of Object.entries(modes)) {
  await p.evaluate((r, sc) => { const D = (window).__oam.dockApi; D.setWin('research', r); D.setWin('scene', sc); }, r, sc);
  await new Promise(res => setTimeout(res, 1200));
  await p.screenshot({ path: `${out}-${name}.png` });
}
await p.evaluate(() => { const D = (window).__oam.dockApi; D.setWin('research', 'normal'); D.setWin('scene', 'normal'); });
await b.close();
