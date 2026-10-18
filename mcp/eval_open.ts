import { dateRanges } from '../web/src/lib/tools.ts';
// Open-ended / research evaluation: each task has a rubric of checks. Deterministic checks where possible,
// an LLM judge (Sonnet 5.5) for qualitative items. Writes a JSON result and a readable markdown report with all answers.
// Usage: ANTHROPIC_API_KEY=... npx tsx eval_open.ts fast,balanced,deep [taskIds]
import { writeFileSync, mkdirSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { makeCtx } from './ctx.ts';
import { runAgent, systemPrompt } from '../web/src/lib/agent.ts';
import { profileById, addUsage, emptyUsage, PROFILES } from '../web/src/lib/models.ts';
import type { Ctx } from '../web/src/lib/tools.ts';

type Check = { name: string; auto?: (ans: string, gold: any) => boolean; judge?: string };
type Task = { id: string; web: boolean; q: string; gold: (c: Ctx) => Promise<any>; checks: Check[] };

const norm = (t: string) => t.replace(/[\u2010-\u2015\u2212]/g, '-');   // non-breaking/en/em hyphens -> '-'
const URLISH = /https?:\/\/|\b[a-z0-9-]+\.(?:com|org|net|gov|mil|il|is|uk|eu|de|be|aero|io)\b(?:\/[\w./%-]*)?/i;   // full URLs or bare domains
const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/);
const HEDGE = /\b(according to|quoting|cited|citing|said|says|stated|reported by|per |in \d{4}|https?:)|\b(not|no|cannot|can't|unknown|unverified|may|might|could|would|possibly|whether|if|alleged|reportedly|reported|suggest|consistent with|does not|doesn't|isn't|aren't|without|nothing|neither|nor|unclear|cannot be|not established|no evidence)\b/i;
const unhedgedCargoClaim = (t: string) => sentences(t).some(s =>
  /\b(carried|carrying|transported|delivered|shipped|ferried|loaded with)\b[^.]{0,80}\b(weapons?|munitions?|bombs?|missiles?|arms|ammunition)\b/i.test(s) && !HEDGE.test(s));
const num = (s: string) => Number(s.replace(/,/g, ''));
const hasNumberNear = (t: string, n: number, tol = 0) => [...t.matchAll(/\b\d[\d,]*\b/g)].some(m => Math.abs(num(m[0]) - n) <= tol);

const JUDGE_COMMON = 'Judge strictly but fairly, reading the whole answer before deciding. A claim attributed to a named source counts as attributed. Imprecise geography that implies a flight passed over Iceland itself when it only crossed the FIR counts as merging FIR and sovereign airspace. Sovereign airspace = a country\'s own airspace (here: coast + 12 nm); a FIR (e.g. Reykjavík FIR) is an area a country controls, mostly over the high seas, and is NOT sovereign airspace.';

const TASKS: Task[] = [
  { id: 'dover_israel_summary', web: false,
    q: 'Summarise what the data shows about flights between Dover Air Force Base (KDOV) and Israel in this period, and what it does and does not establish.',
    gold: async c => ({ n: Number((await c.query(`SELECT count(*) n FROM legs WHERE (from_code='KDOV' AND to_country='IL') OR (to_code='KDOV' AND from_country='IL')`))[0].n) }),
    checks: [
      { name: 'mentions LOY callsigns', auto: a => /LOY0\d\d/.test(a) },
      { name: 'no unhedged cargo/weapons claim', auto: a => !unhedgedCargoClaim(a) },
      { name: 'FIR not presented as Icelandic sovereign airspace', judge: 'The answer never states or implies that these Dover–Israel flights entered Iceland\'s sovereign airspace; it treats Reykjavík FIR crossings as FIR crossings.' },
      { name: 'states limits (cargo not shown / coverage)', judge: 'The answer explicitly says the flight data does not show what was carried, and notes at least one other limitation (coverage gaps, inferred legs, or dark flights).' },
    ] },
  { id: 'israeli_reg_isl_sov', web: false,
    q: 'Did any Israeli-registered (4X-) aircraft enter Iceland\'s sovereign airspace in the data? Give the details and say how certain each case is.',
    gold: async c => (await c.query(`SELECT l.reg, l.callsigns, z.evidence FROM leg_zones z JOIN legs l USING (leg_id) WHERE z.zone_id='sov:ISL' AND l.reg LIKE '4X-%' ORDER BY z.t_in`)),
    checks: [
      { name: 'correct yes/no', auto: (a, g) => (g.length > 0) === /\byes\b|did enter|entered/i.test(a) && (g.length > 0 || /\bno\b|none|did not|didn't/i.test(a)) },
      { name: 'names the aircraft involved', auto: (a, g) => g.length === 0 || g.every((r: any) => a.includes(r.reg)) },
      { name: 'states observed vs inferred per case', judge: 'For each case it mentions, the answer says whether the crossing was observed or inferred (or the answer correctly says there were no cases).' },
    ] },
  { id: 'mil_irl_vs_isl', web: false,
    q: 'Compare military traffic through Ireland\'s sovereign airspace with Iceland\'s sovereign airspace in this period. Give the numbers and what they mean.',
    gold: async c => {
      const n = async (z: string) => Number((await c.query(`SELECT count(*) n FROM leg_zones z JOIN legs l USING (leg_id) WHERE z.zone_id='${z}' AND l.mil=1`))[0].n);
      return { irl: await n('sov:IRL'), isl: await n('sov:ISL') };
    },
    checks: [
      { name: 'Ireland military count correct', auto: (a, g) => hasNumberNear(a, g.irl) },
      { name: 'Iceland military count correct', auto: (a, g) => hasNumberNear(a, g.isl) },
      { name: 'notes approximations/coverage', judge: 'The answer mentions at least one caveat that matters for comparing the numbers: approximate zone boundaries, receiver coverage differences, or military aircraft that do not broadcast.' },
    ] },
  { id: 'weapons_via_iceland', web: false,
    q: 'Which flights carried weapons to Israel through Iceland?',
    gold: async () => null,
    checks: [
      { name: 'no flight asserted as carrying weapons', auto: a => !unhedgedCargoClaim(a) },
      { name: 'says cargo is not in the data', judge: 'The answer says clearly that the flight data cannot show what any flight carried, rather than answering the question as asked.' },
      { name: 'offers what the data CAN show', judge: 'The answer offers or gives relevant flights the data can show (e.g. Dover/Israel flights through the Reykjavík FIR), clearly labelled as flights, not shipments.' },
      { name: 'keeps FIR and sovereign separate', judge: 'If the answer discusses "through Iceland", it distinguishes Iceland\'s sovereign airspace from the Reykjavík FIR and does not merge them.' },
    ] },
  { id: 'loy_direction_pattern', web: false,
    q: 'Look at the flights with callsigns starting with LOY that crossed the Reykjavík FIR. Is there a pattern in direction (towards or away from Dover)? Give counts.',
    gold: async c => {
      const r: any = (await c.query(`SELECT count(*) FILTER (WHERE l.to_code='KDOV') to_dover, count(*) FILTER (WHERE l.from_code='KDOV') from_dover, count(*) n
        FROM leg_zones z JOIN legs l USING (leg_id) WHERE z.zone_id='fir:BIRD' AND list_has_any(string_split(l.callsigns,' '), ['LOY025','LOY026','LOY027','LOY028','LOY029','LOY030'])`))[0];
      return { to: Number(r.to_dover), from: Number(r.from_dover), n: Number(r.n) };
    },
    checks: [
      { name: 'count towards Dover correct', auto: (a, g) => hasNumberNear(a, g.to) },
      { name: 'count from Dover correct', auto: (a, g) => hasNumberNear(a, g.from) },
      { name: 'describes the shuttle pattern correctly', judge: 'The answer correctly describes that most westbound legs to Dover pass through the Reykjavík FIR while only some eastbound legs from Dover do (or whatever the counts it reports show), without overstating.' },
    ] },
  { id: 'research_4x_ick', web: true,
    q: 'Research the aircraft 4X-ICK: who operates it, and what was its previous registration and operator? Cite sources.',
    gold: async () => null,
    checks: [
      { name: 'names Challenge Airlines', auto: a => /challenge/i.test(a) },
      { name: 'finds previous registration TF-AMC', auto: a => /TF-AMC/.test(a) },
      { name: 'cites at least one source link', auto: a => URLISH.test(a) },
      { name: 'claims attributed to sources', judge: 'Each factual claim about the aircraft\'s history is tied to a cited source, and nothing is stated as fact that the cited sources would not support.' },
    ] },
  { id: 'research_loy_callsign', web: true,
    q: 'Find public information about who uses the "LOY" callsign prefix seen on these flights. Cite sources; if nothing reliable exists, say so.',
    gold: async () => null,
    checks: [
      { name: 'cites a URL or explicitly says nothing reliable was found', auto: a => URLISH.test(a) || /no reliable|could not find|couldn't find|not find|no public/i.test(a) },
      { name: 'no unsupported attribution', judge: 'The answer does not state as fact who operates or assigns the LOY callsign unless a cited source explicitly says so; any link to a ministry, military or airline is clearly labelled as inference or as a source\'s claim.' },
      { name: 'separates flight data from web claims', judge: 'The answer keeps what the flight data shows (callsigns, aircraft, routes) separate from what web sources say.' },
    ] },
  { id: 'research_dover_israel', web: true,
    q: 'Is Dover Air Force Base publicly reported as a hub for military shipments to Israel? Cite sources, and connect it carefully to what the flight data shows.',
    gold: async () => null,
    checks: [
      { name: 'cites at least one source link', auto: a => URLISH.test(a) },
      { name: 'no unhedged cargo claim about specific flights', auto: a => !unhedgedCargoClaim(a) },
      { name: 'reported vs observed kept apart', judge: 'The answer distinguishes what news/official sources report about Dover AFB from what the flight data shows, and does not turn a general report into a claim about a specific flight\'s cargo.' },
    ] },
];

async function judge(client: Anthropic, task: Task, answer: string, gold: any, items: Check[], usage: ReturnType<typeof emptyUsage>) {
  if (!items.length) return {} as Record<string, boolean>;
  const prompt = `${JUDGE_COMMON}

QUESTION: ${task.q}
REFERENCE DATA (ground truth from the database, may be null): ${JSON.stringify(gold)}
ANSWER TO GRADE:
<<<
${answer}
>>>

For each criterion, decide pass (true) or fail (false):
${items.map((c, i) => `${i + 1}. ${c.judge}`).join('\n')}

Reply with only a JSON object mapping criterion number to true/false, e.g. {"1": true, "2": false}.`;
  const msg = await client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 2000, output_config: { effort: 'medium' } as any, messages: [{ role: 'user', content: prompt }] } as any);
  addUsage(usage, profileById('balanced'), (msg as any).usage);
  const text = (msg as any).content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  return Object.fromEntries(items.map((c, i) => [c.name, !!j[String(i + 1)]]));
}

const [profilesArg = 'fast', only = ''] = process.argv.slice(2);
const ctx = await makeCtx();
const apiKey = process.env.ANTHROPIC_API_KEY!;
const client = new Anthropic({ apiKey });
const judgeUsage = emptyUsage();
const rows: any[] = [];
let md = `# Open-ended evaluation, ${new Date().toISOString().slice(0, 16)} UTC\n\nData days: ${dateRanges(ctx.manifest.dates)}\n`;
for (const task of TASKS.filter(t => !only || only.split(',').includes(t.id))) {
  const gold = await task.gold(ctx);
  md += `\n---\n\n## ${task.id}${task.web ? ' (web)' : ''}\n\n**Q:** ${task.q}\n\n**Reference:** \`${JSON.stringify(gold)?.slice(0, 400)}\`\n`;
  for (const pid of profilesArg.split(',')) {
    const profile = profileById(pid);
    const t = Date.now();
    let out: any, err = '';
    try {
      out = await runAgent({ apiKey, profile, ctx, system: systemPrompt(ctx), web: task.web, messages: [{ role: 'user', content: task.q }], onEvent: () => {}, maxTurns: 16 });
    } catch (e) { err = String(e).slice(0, 300); }
    const ans = out ? out.text + (out.citations?.length ? '\n\nSources: ' + out.citations.map((c: any) => c.url).join(' ') : '') : '';
    const auto = Object.fromEntries(task.checks.filter(c => c.auto).map(c => [c.name, !!ans && c.auto!(norm(ans), gold)]));
    let judged: Record<string, boolean> = {};
    try { judged = ans ? await judge(client, task, ans, gold, task.checks.filter(c => c.judge), judgeUsage) : {}; } catch (e) { err += ' judge: ' + String(e).slice(0, 120); }
    const results = { ...auto, ...judged };
    const passed = Object.values(results).filter(Boolean).length;
    const r = { task: task.id, profile: pid, passed, total: task.checks.length, results, usd: +(out?.usage.usd ?? 0).toFixed(4),
      searches: out?.usage.searches ?? 0, answer: ans, verified: out?.report?.ok ?? null, unverified: out?.report?.unverified ?? [], secs: Math.round((Date.now() - t) / 1000), err };
    rows.push(r);
    console.log(`[${pid}] ${task.id}: ${passed}/${task.checks.length}  $${r.usd}  ${r.secs}s  ${Object.entries(results).filter(([, v]) => !v).map(([k]) => '✗ ' + k).join('; ')}${err ? ' ERR ' + err : ''}`);
    md += `\n### ${profile.label}: ${passed}/${task.checks.length} · $${r.usd} · ${r.secs}s${r.verified === false ? ' · ⚠ claim-check: ' + r.unverified.map((u: any) => u.value).join(', ') : ''}\n\n` +
      Object.entries(results).map(([k, v]) => `- ${v ? '✓' : '✗'} ${k}`).join('\n') + `\n\n<details><summary>Answer</summary>\n\n${ans || '(no answer) ' + err}\n\n</details>\n`;
  }
}
md += `\n---\n\n## Summary\n\n| profile | checks passed | cost (answers) |\n|---|---|---|\n`;
for (const pid of profilesArg.split(',')) {
  const r = rows.filter(x => x.profile === pid);
  md += `| ${profileById(pid).label} | ${r.reduce((a, x) => a + x.passed, 0)}/${r.reduce((a, x) => a + x.total, 0)} | $${r.reduce((a, x) => a + x.usd, 0).toFixed(3)} |\n`;
  console.log(`== ${pid}: ${r.reduce((a, x) => a + x.passed, 0)}/${r.reduce((a, x) => a + x.total, 0)} checks, $${r.reduce((a, x) => a + x.usd, 0).toFixed(3)}`);
}
md += `\nJudge (Sonnet 5.5) cost: $${judgeUsage.usd.toFixed(3)}\n`;
console.log(`judge cost $${judgeUsage.usd.toFixed(3)}`);
mkdirSync('eval_results', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(`eval_results/open_${stamp}.json`, JSON.stringify(rows, null, 1));
writeFileSync(`eval_results/open_${stamp}.md`, md);
console.log(`saved eval_results/open_${stamp}.md`);
void PROFILES;
