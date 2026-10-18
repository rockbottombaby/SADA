// Trajectory eval: runs the questions in oam/eval/questions.json through the real app (one chat per question), records the
// path (tools, durations, cost, verification) and grades deterministic expectations; optionally an LLM judge with a rubric.
// usage: KEY=… DATA=… [PROFILE=fast|balanced] [CENSUS=…] [ONLY=id,id] [JUDGE=1] node eval.mjs
// Writes oam/eval/results/<utc>-<profile>.json and prints a table. Each run costs real money (about $0.05–0.30 per question).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const ROOT = new URL('../../', import.meta.url).pathname;
const qs = JSON.parse(fs.readFileSync(`${ROOT}eval/questions.json`, 'utf8')).filter(q => !process.env.ONLY || process.env.ONLY.split(',').includes(q.id));
const profile = process.env.PROFILE || 'fast';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', protocolTimeout: 1_800_000, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [];
for (const q of qs) {
  try {
  const p = await b.newPage(); await p.setViewport({ width: 1400, height: 900 });
  await p.goto('http://localhost:5181/', { waitUntil: 'domcontentloaded' });
  // every question starts from a blank browser state: the profile persists chats, and a new question would otherwise
  // continue the previous chat and inherit its answers as context
  await p.evaluate(async () => { localStorage.clear(); sessionStorage.clear(); for (const d of await indexedDB.databases()) if (d.name) indexedDB.deleteDatabase(d.name); });
  await p.evaluate((k, c, prof, data) => { localStorage.setItem('oam.apiKey', k); if (c) localStorage.setItem('oam.censusKey', c); localStorage.setItem('oam.profile', prof); localStorage.setItem('oam.dataUrl', data); }, process.env.KEY, process.env.CENSUS || '', profile, process.env.DATA);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__oam?.ctx && !document.querySelector('.splash'), { timeout: 120000 });
  await p.evaluate(() => (window.__oam.app.memorialOpen = false));
  await p.$eval('.composer textarea', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, q.q);
  const t0 = Date.now(); await p.click('.composer .send');
  await p.waitForSelector('.composer .send.stop', { timeout: 10000 }).catch(() => {});
  await p.waitForFunction(() => !document.querySelector('.composer .send.stop'), { timeout: 1_500_000 }).catch(() => {});
  const r = await p.evaluate(() => {
    const { app } = window.__oam; const trail = Object.values(app.__trail ?? {})[0];
    const txt = [...document.querySelectorAll('.asst .md')].map(e => e.innerText).join('\n');
    const meta = [...document.querySelectorAll('.meta')].map(e => e.innerText).join(' / ');
    return { answer: txt, meta };
  });
  const steps = await p.evaluate(() => { const m = window.__oam.trailSteps?.(); return m ?? []; }).catch(() => []);
  const secs = (Date.now() - t0) / 1000;
  const cost = Number((r.meta.match(/\$([\d.]+)/) || [])[1] ?? 0);
  const tools = steps.map(s => s.tool), e = q.expect || {};
  const checks = {
    tools_any: e.tools_any ? e.tools_any.some(t => tools.includes(t)) : true,
    coverage: e.coverage ? tools.some(t => ['zone_coverage', 'investigate_airspace_claim'].includes(t)) || /coverage|receiver/i.test(r.answer) : true,
    no_run_sql_long: e.no_run_sql_long ? !steps.some(s => s.tool === 'run_sql' && s.ms > 40000) : true,
    numbers_verified: e.numbers_verified ? !/figures not in evidence/.test(r.meta) : true,
    facts_verified: !/not found in the data/.test(r.meta),
    mentions_any: e.mentions_any ? e.mentions_any.some(w => r.answer.toLowerCase().includes(w.toLowerCase())) : true,
    max_calls: e.max_calls ? steps.length <= e.max_calls : true,
    answered: r.answer.trim().length > 200,
    under_5_min: secs < 300,
  };
  const score = Object.values(checks).filter(Boolean).length / Object.keys(checks).length;
  results.push({ id: q.id, tier: q.tier, profile, secs: Math.round(secs), cost, steps: steps.map(s => ({ tool: s.tool, ms: s.ms })), checks, score, failed: Object.entries(checks).filter(([, v]) => !v).map(([k]) => k), verification: r.meta, answer: r.answer.slice(0, 4000) });
  console.log(`${q.id.padEnd(18)} ${String(Math.round(secs)).padStart(4)} s  $${cost.toFixed(3)}  ${steps.length} steps  score ${(score * 100).toFixed(0)}%  ${results.at(-1).failed.join(',') || 'all checks pass'}`);
  await p.close();
  } catch (e) {   // a crashed question is a failed question, not a dead run
    results.push({ id: q.id, tier: q.tier, profile, secs: 0, cost: 0, steps: [], checks: {}, score: 0, failed: ['harness: ' + String(e).slice(0, 80)], answer: '' });
    console.log(`${q.id.padEnd(18)} CRASHED ${String(e).slice(0, 100)}`);
  }
}
await b.close();
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
fs.writeFileSync(`${ROOT}eval/results/${stamp}-${profile}.json`, JSON.stringify({ profile, when: new Date().toISOString(), results }, null, 1));
const avg = results.reduce((a, r) => a + r.score, 0) / results.length, cost = results.reduce((a, r) => a + r.cost, 0), secs = results.reduce((a, r) => a + r.secs, 0);
console.log(`\n${profile}: ${results.length} questions, mean score ${(avg * 100).toFixed(0)}%, total ${Math.round(secs)} s, $${cost.toFixed(2)} → eval/results/${stamp}-${profile}.json`);
