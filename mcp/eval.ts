// Accuracy & cost evaluation of the agent harness across model profiles.
// Gold answers are computed from the data with SQL, so the eval stays correct when the data is rebuilt.
// Usage: ANTHROPIC_API_KEY=... OAM_DATA_URL=http://127.0.0.1:8790 npx tsx eval.ts fast[,balanced,deep] [maxQuestions]
import { writeFileSync, mkdirSync } from 'node:fs';
import { makeCtx } from './ctx.ts';
import { runAgent, systemPrompt } from '../web/src/lib/agent.ts';
import { profileById } from '../web/src/lib/models.ts';
import type { Ctx } from '../web/src/lib/tools.ts';

type Q = { id: string; q: string; gold: (c: Ctx) => Promise<string>; kind: 'number' | 'text' | 'contains' };
const one = async (c: Ctx, sql: string) => Object.values((await c.query(sql))[0] ?? {})[0];
const day = (d: string) => `t_in >= epoch(TIMESTAMP '${d}') AND t_in < epoch(TIMESTAMP '${d}') + 86400`;

const QUESTIONS: Q[] = [
  { id: 'isl_obs_day', kind: 'number', q: 'How many flights were observed (not inferred) in Iceland\'s sovereign airspace on 2026-04-08?',
    gold: async c => String(await one(c, `SELECT count(*) FROM leg_zones WHERE zone_id='sov:ISL' AND evidence='observed' AND ${day('2026-04-08')}`)) },
  { id: 'loy026_reg', kind: 'text', q: 'Which aircraft registration flew callsign LOY026?',
    gold: async c => String(await one(c, `SELECT reg FROM legs WHERE callsigns LIKE '%LOY026%' LIMIT 1`)) },
  { id: 'loy026_date', kind: 'text', q: 'On which date (YYYY-MM-DD) did the LOY026 flight from Dover (KDOV) to Ben Gurion (LLBG) depart?',
    gold: async c => String(await one(c, `SELECT date FROM legs WHERE callsigns LIKE '%LOY026%' AND from_code='KDOV' AND to_code='LLBG'`)) },
  { id: 'loy025_sov', kind: 'text', q: 'Did the LOY025 flight that departed Dover (KDOV) enter Iceland\'s sovereign airspace? Answer yes or no.',
    gold: async c => (Number(await one(c, `SELECT count(*) FROM leg_zones z JOIN legs l USING (leg_id) WHERE l.callsigns LIKE '%LOY025%' AND l.from_code='KDOV' AND z.zone_id='sov:ISL'`)) > 0 ? 'yes' : 'no') },
  { id: 'bird_mil', kind: 'number', q: 'How many military flights crossed the Reykjavík FIR (fir:BIRD) in the whole dataset?',
    gold: async c => String(await one(c, `SELECT count(*) FROM leg_zones z JOIN legs l USING (leg_id) WHERE z.zone_id='fir:BIRD' AND l.mil=1`)) },
  { id: 'kdov_deps', kind: 'number', q: 'How many flight legs departed Dover Air Force Base (KDOV) in the dataset?',
    gold: async c => String(await one(c, `SELECT count(*) FROM legs WHERE from_code='KDOV'`)) },
  { id: 'bird_top_dest', kind: 'text', q: 'What is the most common destination country (ISO2 code) of flights through the Reykjavík FIR (fir:BIRD)?',
    gold: async c => String(await one(c, `SELECT l.to_country FROM leg_zones z JOIN legs l USING (leg_id) WHERE z.zone_id='fir:BIRD' AND l.to_country<>'' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)) },
  { id: 'out_of_coverage', kind: 'contains', q: 'How many flights crossed Iceland\'s sovereign airspace on 2026-03-01?',
    gold: async () => 'not in dataset' },
  { id: 'isr_reg_bird', kind: 'number', q: 'How many distinct Israeli-registered aircraft (4X- registrations) crossed the Reykjavík FIR (fir:BIRD)?',
    gold: async c => String(await one(c, `SELECT count(DISTINCT l.hex) FROM leg_zones z JOIN legs l USING (leg_id) WHERE z.zone_id='fir:BIRD' AND l.reg LIKE '4X-%'`)) },
  { id: 'ica_leg', kind: 'text', q: 'Give the leg_id of 4X-ICA\'s flight from KDOV to LLBG.',
    gold: async c => String(await one(c, `SELECT leg_id FROM legs WHERE reg='4X-ICA' AND from_code='KDOV' AND to_code='LLBG' LIMIT 1`)) },
  { id: 'irl_obs_day', kind: 'number', q: 'How many flights were observed in Ireland\'s sovereign airspace on 2026-04-10?',
    gold: async c => String(await one(c, `SELECT count(*) FROM leg_zones WHERE zone_id='sov:IRL' AND evidence='observed' AND ${day('2026-04-10')}`)) },
  { id: 'ick_0406_origin', kind: 'text', q: 'From which airport (ICAO code) did 4X-ICK depart on 2026-04-06 as LOY025?',
    gold: async c => String(await one(c, `SELECT from_code FROM legs WHERE reg='4X-ICK' AND callsigns LIKE '%LOY025%' AND date='2026-04-06' LIMIT 1`)) },
  // ---- harder: multi-step, ordering, combined filters, abstention ----
  { id: 'ica_0408_cs_bird', kind: 'text', q: 'Which callsign did 4X-ICA use on its flight that arrived at Ben Gurion (LLBG) on 2026-04-08, and was that flight observed in the Reykjavík FIR? Answer as "<CALLSIGN> yes" or "<CALLSIGN> no".',
    gold: async c => {
      const r: any = (await c.query(`SELECT l.callsigns, (SELECT count(*) FROM leg_zones z WHERE z.leg_id=l.leg_id AND z.zone_id='fir:BIRD' AND z.evidence='observed') n
        FROM legs l WHERE reg='4X-ICA' AND to_code='LLBG' AND strftime(arr_utc, '%Y-%m-%d')='2026-04-08' LIMIT 1`))[0];
      return `${String(r.callsigns).split(' ').find((x: string) => x.startsWith('LOY')) ?? String(r.callsigns).split(' ')[0]} ${Number(r.n) > 0 ? 'yes' : 'no'}`; } },
  { id: 'loy_distinct', kind: 'number', q: 'How many different callsigns starting with "LOY" appear in the dataset?',
    gold: async c => String(await one(c, `SELECT count(DISTINCT cs) FROM (SELECT unnest(string_split(callsigns, ' ')) cs FROM legs) WHERE cs LIKE 'LOY%'`)) },
  { id: 'loy026_cargo', kind: 'contains', q: 'What cargo was carried on the LOY026 flight from Dover to Ben Gurion? If the data does not show it, answer "unknown".',
    gold: async () => 'unknown' },
  { id: 'loy026_first_after_us', kind: 'text', q: 'On the LOY026 flight from KDOV to LLBG, which country\'s sovereign airspace did the aircraft enter first after leaving the United States? Answer with the ISO3 country code.',
    gold: async c => String(await one(c, `SELECT replace(zone_id, 'sov:', '') FROM leg_zones z JOIN legs l USING (leg_id)
      WHERE l.callsigns LIKE '%LOY026%' AND l.from_code='KDOV' AND l.to_code='LLBG' AND zone_id LIKE 'sov:%' AND zone_id <> 'sov:USA' ORDER BY t_in LIMIT 1`)) },
  { id: 'kdov_to_il', kind: 'number', q: 'How many flights departed Dover (KDOV) and had a recorded landing in Israel?',
    gold: async c => String(await one(c, `SELECT count(*) FROM legs WHERE from_code='KDOV' AND to_country='IL' AND to_cert='recorded'`)) },
  { id: 'bird_obs_0407', kind: 'number', q: 'How many flights were observed (not inferred) in the Reykjavík FIR on 2026-04-07 (by time of entering the FIR)?',
    gold: async c => String(await one(c, `SELECT count(*) FROM leg_zones WHERE zone_id='fir:BIRD' AND evidence='observed' AND ${day('2026-04-07')}`)) },
  { id: 'isl_top_type', kind: 'text', q: 'Which aircraft type (ICAO type code) flew the most flights through Iceland\'s sovereign airspace in the dataset?',
    gold: async c => String(await one(c, `SELECT l.type FROM leg_zones z JOIN legs l USING (leg_id) WHERE z.zone_id='sov:ISL' AND l.type IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)) },
  { id: 'ick_llnv', kind: 'text', q: 'Did 4X-ICK land at Nevatim air base (LLNV) at any time in the dataset? Answer yes or no.',
    gold: async c => (Number(await one(c, `SELECT count(*) FROM legs WHERE reg='4X-ICK' AND to_code='LLNV'`)) > 0 ? 'yes' : 'no') },
];

const INSTR = '\n\nEnd your reply with one line exactly in the form "FINAL: <answer>" (a number, a short code/id, yes/no, "not in dataset", or "unknown").';

function grade(kind: Q['kind'], gold: string, text: string) {
  const m = text.match(/FINAL:\s*(.+)\s*$/im);
  const got = (m ? m[1] : '').trim().replace(/[*`".]/g, '');
  if (kind === 'number') return { got, ok: (got.match(/-?\d[\d,]*/)?.[0] ?? '').replace(/,/g, '') === gold };
  if (kind === 'contains') return { got, ok: got.toLowerCase().includes(gold) };
  return { got, ok: got.toLowerCase() === gold.toLowerCase() };
}

const [profilesArg = 'fast', maxQ = String(QUESTIONS.length), only = ''] = process.argv.slice(2);
const ctx = await makeCtx();
const apiKey = process.env.ANTHROPIC_API_KEY!;
const rows: any[] = [];
for (const pid of profilesArg.split(',')) {
  const profile = profileById(pid);
  let usd = 0, correct = 0;
  for (const q of QUESTIONS.slice(0, Number(maxQ)).filter(q => !only || only.split(',').includes(q.id))) {
    const gold = await q.gold(ctx);
    const t = Date.now();
    let out: any, err = '';
    try {
      out = await runAgent({ apiKey, profile, ctx, system: systemPrompt(ctx), messages: [{ role: 'user', content: q.q + INSTR }], onEvent: () => {}, maxTurns: 12 });
    } catch (e) { err = String(e).slice(0, 200); }
    const g = out ? grade(q.kind, gold, out.text) : { got: '', ok: false };
    usd += out?.usage.usd ?? 0; correct += g.ok ? 1 : 0;
    const r = { profile: pid, id: q.id, gold, got: g.got, ok: g.ok, usd: +(out?.usage.usd ?? 0).toFixed(5), calls: out?.usage.calls ?? 0,
      cache_read: out?.usage.cacheRead ?? 0, input: out?.usage.input ?? 0, verified: out?.report?.ok ?? null, secs: Math.round((Date.now() - t) / 1000), err };
    rows.push(r);
    console.log(`${r.ok ? '✓' : '✗'} [${pid}] ${q.id}: gold=${gold} got=${g.got} $${r.usd} ${r.secs}s${r.verified === false ? ' (claim-check flagged)' : ''}${err ? ' ERR ' + err : ''}`);
  }
  console.log(`== ${pid}: ${correct}/${Math.min(Number(maxQ), QUESTIONS.length)} correct, $${usd.toFixed(4)} total, $${(usd / Math.max(correct, 1)).toFixed(4)} per correct answer\n`);
}
mkdirSync('eval_results', { recursive: true });
const f = `eval_results/eval_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(f, JSON.stringify(rows, null, 1));
console.log('saved', f);
