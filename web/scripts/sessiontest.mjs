// usage: node scripts/sessiontest.mjs outdir — the Session menu and About dialog (screenshots) and a save/load round trip
// of the session file through the app's own functions; no model calls (dev server on :5181)
import puppeteer from 'puppeteer-core';
const out = process.argv[2] ?? '.';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 1000 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.setItem('oam.apiKey', 'sk-ant-test'); sessionStorage.setItem('oam.memorialSeen', '1'); });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__oam?.ctx && !document.querySelector('.splash'), { timeout: 90000 });
await p.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 500));
// a fake answered chat with a trail, then save → wipe → load
const r = await p.evaluate(() => {
  const S = window.__oam.sessionApi, T = window.__oam.trailApi;
  const before = S.buildSession();
  const chat = { id: 'sess-test', title: 'Session test', turns: [{ role: 'user', text: 'q', cards: [] }, { role: 'assistant', text: 'a [E1]', cards: [] }], history: [], usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0, calls: 0, usd: 0.1 }, created: Date.now(), case: { items: [{ id: 1, kind: 'finding', text: 'f', status: 'done', at: 'x' }] } };
  T.trailStart('sess-test', 'q'); T.trailCall('sess-test', 'zone_overview', 'Summarising Iceland', { zone_id: 'sov:ISL' }); T.trailEnd();
  S.applySession({ sada_session: 1, saved_at: '', app: '', chats: [chat], activeId: 'sess-test', trails: T.trail.byChat });
  const file = S.buildSession();
  S.applySession({ sada_session: 1, saved_at: '', app: '', chats: [], activeId: '', trails: {} });
  const wiped = S.buildSession();
  S.applySession(file);
  const after = S.buildSession();
  return { beforeChats: before.chats.length, fileChats: file.chats.length, fileTrails: Object.keys(file.trails), wipedChats: wiped.chats.length, wipedTitle: wiped.chats[0]?.title,
    afterTitle: after.chats[0]?.title, afterTurns: after.chats[0]?.turns.length, afterCase: after.chats[0]?.case?.items.length, afterTrailSteps: after.trails['sess-test']?.steps.length, tab: document.querySelector('.tabs, .tab')?.textContent?.trim().slice(0, 40) };
});
console.log(JSON.stringify(r));
await p.click('nav.menu .mi'); await new Promise(r => setTimeout(r, 300));
await p.screenshot({ path: `${out}/menu.png`, clip: { x: 0, y: 0, width: 700, height: 260 } });
await p.keyboard.press('Escape'); await p.evaluate(() => document.body.click());
await p.evaluate(() => (window.__oam.app.aboutOpen = true)); await new Promise(r => setTimeout(r, 600));
await p.screenshot({ path: `${out}/about.png` });
await p.evaluate(() => document.querySelector('.page nav button:nth-child(4)').click()); await new Promise(r => setTimeout(r, 900));
await p.screenshot({ path: `${out}/about-arch.png` });
// the top-bar coffee button opens About at Support (no support URL configured in dev); Back returns to the session intact
await p.evaluate(() => document.querySelector('.page .back').click()); await new Promise(r => setTimeout(r, 300));
await p.evaluate(() => [...document.querySelectorAll('nav.menu .mi')].find(b => /coffee/i.test(b.textContent)).click()); await new Promise(r => setTimeout(r, 900));
await p.screenshot({ path: `${out}/about-support.png` });
console.log('session intact after About:', await p.evaluate(() => { document.querySelector('.page .back').click(); return window.__oam.sessionApi.buildSession().chats[0]?.title; }));
await b.close();
