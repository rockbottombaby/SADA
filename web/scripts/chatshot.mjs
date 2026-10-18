// usage: node scripts/chatshot.mjs outdir — the chat column with an injected two-question conversation (no model calls)
import puppeteer from 'puppeteer-core';
const out = process.argv[2] ?? '.';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.setItem('oam.apiKey', 'sk-ant-test'); sessionStorage.setItem('oam.memorialSeen', '1'); });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__oam?.ctx && !document.querySelector('.splash'), { timeout: 90000 });
await p.keyboard.press('Escape');
await p.screenshot({ path: `${out}/chat-empty.png`, clip: { x: 1200, y: 58, width: 400, height: 942 } });
// a starter fills the box with its first placeholder selected; Enter on an unfilled placeholder does not send
await p.click('.sug:nth-child(2)'); await new Promise(r => setTimeout(r, 300));
await p.keyboard.type('Poland'); await p.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 300));
console.log('composer:', await p.$eval('.composer textarea', el => [el.value.slice(0, 70), el.value.slice(el.selectionStart, el.selectionEnd)]), 'turns:', await p.$$eval('.user', e => e.length));
await p.screenshot({ path: `${out}/chat-starter.png`, clip: { x: 1200, y: 58, width: 400, height: 942 } });
await p.evaluate(() => {
  const turns = [
    { role: 'user', text: 'Which military flights crossed Iceland\'s sovereign airspace to or from Israel since October 2023?', cards: [] },
    { role: 'assistant', profile: 'deep', usd: 0.41, text: 'One: **RCH256**, a US Air Force KC-135R tanker, crossed on 2026-10-06 between 14:15 and 14:28 UTC, flying from Israel towards the US [E3]. It was observed, not inferred [E1].\n\nThree Israel Cargo Airlines 747 freighters also crossed, all westbound [E6, E7].', cards: [{ kind: 'chip', text: 'Investigate airspace claim' }, { kind: 'chip', text: 'Reading flight RCH256' }] },
    { role: 'user', text: 'Did any of them fly eastbound later?', cards: [] },
    { role: 'assistant', profile: 'deep', usd: 0.12, text: 'No eastbound crossing of Iceland\'s sovereign airspace by these aircraft is in the data [E9].', cards: [{ kind: 'chip', text: 'Listing flights through Iceland' }] },
  ];
  window.__oam.sessionApi.applySession({ sada_session: 1, saved_at: '', app: '', chats: [{ id: 'shot', title: 'Iceland', turns, history: [], usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0, calls: 0, usd: 0.53 }, created: Date.now() }], activeId: 'shot', trails: {} });
});
await new Promise(r => setTimeout(r, 800));
await p.screenshot({ path: `${out}/chat.png`, clip: { x: 1200, y: 58, width: 400, height: 942 } });
await b.close();
