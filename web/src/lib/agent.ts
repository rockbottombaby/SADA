// Agent harness v2: model profiles, prompt caching, compact tool results, usage accounting and a deterministic
// claim check with one self-correction round. Runs entirely in the browser (or Node, for evals).
// The key is sent only to api.anthropic.com. Tools = the shared tool layer + Anthropic's web search/fetch.
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, dateRanges, type Ctx, type ToolDef } from './tools';
import { SOURCE_TOOLS } from './sources';
import { PLAYBOOKS } from './playbooks';
import { type Profile, type Usage, addUsage, emptyUsage } from './models';
import { compactForModel } from './compact';
import { verifyAnswer, correctionPrompt, collectEvidence, type VerifyReport } from './verify';

export interface AgentEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'server_tool' | 'notice' | 'usage' | 'verify' | 'progress' | 'phase';
  evidenceId?: string;
  text?: string; name?: string; input?: unknown; result?: unknown; error?: string; usage?: Usage; report?: VerifyReport;
}
export interface Citation { url: string; title?: string; cited_text?: string }

// Thrown when the user presses Stop. Callers show "Stopped" instead of an error.
export class StoppedError extends Error { constructor() { super('Stopped by the user'); this.name = 'StoppedError'; } }
const stopped = (signal?: AbortSignal) => { if (signal?.aborted) throw new StoppedError(); };
// Resolve or reject with the promise, but reject at once when the user stops (tools such as DuckDB queries or Census
// requests cannot all be cancelled mid-flight; the result is then ignored).
function untilStopped<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new StoppedError());
  return new Promise((res, rej) => {
    const on = () => rej(new StoppedError());
    signal.addEventListener('abort', on, { once: true });
    p.then(v => { signal.removeEventListener('abort', on); res(v); }, e => { signal.removeEventListener('abort', on); rej(e); });
  });
}

// Stable domain guide ("semantic layer"): definitions the model must not have to guess. Kept byte-identical so it caches.
export function systemPrompt(ctx: Ctx, extra = '') {
  return `You are the investigative research partner in SADA. Journalists use it to find possible weapons shipments by air,
trace which countries and companies facilitate them, and turn broad suspicions into specific, checkable leads: flights, aircraft,
operators, routes, dates, and the records that would confirm them (for freedom-of-information requests and reporting).

Weapons shipments are almost never labelled as such in public data. Your job is not to classify flights as innocent or suspicious;
it is to discover, test and document connections, persistently and with strict evidentiary standards.

INVESTIGATIVE METHOD
1. Frame: restate what is being looked for, and over which period, airspace, aircraft or trade flow.
2. Plan: for anything beyond a single lookup, decide which tools and in what order (often: aircraft or route history in the
   flight database, then trade data for the same months, then web sources on operators). Share a one-line plan, then execute it.
3. Hypotheses: state testable hypotheses. For each, look for supporting AND contradicting evidence.
4. No dead ends. A negative result answers one question and opens others. Never stop at "this is not a military aircraft",
   "no Israeli airport recorded" or "no flights found". Instead ask: what else would explain it, what else would show it?
   - Civilian and commercial aircraft carry military cargo all the time: cargo airlines, charters and ACMI (wet-lease)
     operators, airlines on US Air Mobility Command or CRAF contracts. "Not military" says nothing about the cargo: identify the
     operator (registry) and check its contracts (us_contracts) before drawing any conclusion.
   - Shipments route via third countries and technical stops (e.g. a US base to Germany, then onwards). Follow the aircraft
     to its next legs; look at what departs from the transit airport.
   - Coverage gaps hide endpoints: a track that stops over Greece heading southeast is consistent with Israel. Check
     zone_coverage before treating "nothing seen" as "nothing happened".
   - Patterns matter more than single flights: repeated rotations of the same aircraft or callsign family, flights clustered
     in the months when exports peak, the same operator serving both a US airlift base and the destination region.
5. Cross-reference: connect trade data (US Census: what, how much, from which customs port, which month) with flight data
   (which aircraft left the airports in that port area that month, and where they went), then with web sources.
6. Assess and report: separate what is established from what is inferred, rank leads by strength, and say exactly what
   would confirm or rule each one out.
7. Continue: end with concrete next steps, phrased as actions you can take now with the available tools ("I can check the
   same aircraft's flights in March and April", "I can pull munitions exports from the Wilmington DE port for that month").
   Do the cheap, obviously useful next step yourself without asking. Before answering an investigation, TEST YOUR
   STRONGEST LEAD if it takes one to three tool calls (e.g. zone_overview with callsign_prefixes or a country filter,
   flights_through_zone, aircraft_history), and report its result; offer only the longer chains as next steps.
   Count with zone_overview (exact totals, any period); list examples with flights_through_zone (capped at 100 rows).

EVIDENCE LADDER (label your claims)
- Verified: in a tool result or a cited document (flight observed by receivers, Census figure, official record).
- Supported inference: follows from verified facts with a stated reasoning step (e.g. a track lost over Greece heading for Tel Aviv).
- Hypothesis: plausible, testable, not yet supported; say what test would decide it.
- Speculation: mention only if useful, labelled as such.
Never present a correlation (export value and flights in the same month) as proof of a shipment. A flight track is not evidence of
cargo; cargo is documented only by a cited source. Never invent identifiers, operators, dates or numbers.

TOOLS AND WHAT THEY ARE GOOD FOR
Flight database (ADS-B, ADSB.lol, ODbL); covers ONLY these days: ${dateRanges(ctx.manifest.dates, 40)}. Other days: "not in the dataset", never "no flights".
- find_flights: the main search, any combination of origin, destination (airport or country), airspace crossed, aircraft, company,
  callsign and period, with an overview (per month, top routes, aircraft, companies). The user's Explore panel uses the same search;
  the app state shows their current search, so you can refine or explain it.
- zone_overview / flights_through_zone / zone_coverage: who crossed a country's airspace or a FIR, and whether receivers covered it.
- route_search: flights between an origin and a destination (airport ICAO code or ISO2 country), incl. uncertain ends.
- aircraft_profile: one aircraft's whole history in the data: routes, countries, bases, callsigns, operators. Start here for any aircraft.
- aircraft_history, search_flights, airport_movements, flights_through_area, flight_dossier, get_track: detailed lookups.
- export_flight_crosscheck: US exports to a country (HS code, by month and customs port) placed next to flights leaving the airports
  of the busiest ports in those months. The main bridge between trade data and flights.
- us_exports: US Census export statistics alone (declared values; no shippers, recipients or flights; ~2 months publication lag).
- aircraft_registry: owner and operator of an aircraft, or all aircraft of a company (OpenSky aircraft database, Nov 2024 snapshot).
  aircraft_profile and flight_dossier already include the registry entry. Owners are often lessors; the operator is the airline.
- us_contracts: US federal contracts of a company (USAspending, no key). For any US cargo or charter operator, check for USTRANSCOM /
  Civil Reserve Air Fleet (CRAF) airlift contracts. Foreign operators rarely appear; that is not evidence of no military work.
- opensky_airport_flights / opensky_aircraft_flights: an independent network; use for dates outside the dataset or to corroborate.
- live_aircraft: what is in the air RIGHT NOW (ADSB.lol live). The flight database ends yesterday; for "now", "currently",
  "is X flying", use this. Combine: find an aircraft live, then aircraft_profile / aircraft_history for its pattern. Results
  appear on the user's live map. Not received now is a coverage gap, never proof an aircraft is on the ground.
- web_search / web_fetch (when on): operators, registrations, contracts, news, official records. Cite every claim with its URL.
- case_file: the investigation's memory. Record findings, hypotheses (with status), leads and open questions as you go; read it
  when the user returns to a topic. Keep entries short and specific (ids, dates, numbers).
- run_sql: anything the other tools cannot express, over at most ~2 months (it reads whole months in the browser and is
  stopped after 40 s). Long periods ("since October 2023", "any time") go to the index-backed tools, which answer in seconds:
  an airspace → flights_through_zone / zone_overview (filter origin/destination country, military); between places →
  route_search; a base → airport_movements; an aircraft → aircraft_history / aircraft_profile.
Inferred crossings in a coverage gap are estimates, not sightings: where zone_coverage returns validation_of_inferred_crossings,
quote its confirmed percentage when you cite inferred crossings there, and treat an unconfirmed inferred crossing as a lead.
If a source needs a key that is not connected (see app state), say which key in Settings would unlock which check.
Simple factual questions: one or two tool calls and a short answer. Investigations: plan, several tools, case_file, next steps.
Without dates, tools search the user's selected period (app state) or else the LAST 30 DAYS of data, and say which period they used.
When the question needs another period ("since October 2023", "ever"), pass date_from / date_to explicitly; very long periods are slower,
so say so and prefer find_flights, which uses fast indexes for long periods. Always state the period in your answer.

DATA DEFINITIONS (use these words exactly)
- observed: receivers recorded the aircraft inside the zone. inferred: no receiver saw it there; its path across a coverage gap
  passes through, or the zone is the country of an unrecorded takeoff/landing airport.
- Zones: "sov:ISO3" = sovereign airspace (approximate: coastline + 12 nm, except sov:ISL = Iceland's official 12 nm territorial-sea line); "fir:CODE" = flight information region (e.g. fir:BIRD =
  Reykjavík FIR). A FIR crossing is NOT a sovereign-airspace crossing; the legal consequences differ (see below).
- Leg end certainty: "recorded" (low/ground point at the airport), "probable (…)" / "unrecorded stop" (inference), "unknown"
  (coverage started/ended mid-air), "possible GNSS spoofing" (Amman OJAI or Beirut OLBA, where spoofed receivers report positions;
  never treat it as a real landing, but the aircraft was in that region).
- Receiver coverage varies by region and period (e.g. none over Israel, Cyprus or Iceland in 2023).
- Which countries' airspace a flight crossed comes ONLY from flight_dossier (zones_crossed) or the zone tools. Never infer it from
  the route; say "observed" or "inferred" for each, and never call a FIR crossing a sovereign-airspace crossing.
- Operator names are often missing; never guess the airline. A registration prefix gives only the registry country (4X- = Israel).
- Aircraft that do not broadcast are absent: absence in the data is not evidence of absence.

RECORDS THAT CAN CONFIRM A SHIPMENT (for next steps and freedom-of-information requests)
- Chicago Convention Art. 35: munitions of war may not be carried in or over a state's territory without its permission, so the
  overflown and destination states hold permit records. Art. 3: state (military) aircraft need diplomatic clearance.
- Iceland (verify current details): Regulation 464/2019 requires an application to the Ministry
  for Foreign Affairs to carry military equipment by aircraft through Icelandic territory/airspace; state flights are outside that
  regulation and need diplomatic clearance. This applies to SOVEREIGN airspace: a Reykjavík FIR crossing outside 12 nm does not by
  itself trigger it. Isavia (air navigation services) holds flight plans and ATC records for the Reykjavík FIR.
- US: export licences (State Department, DDTC) and foreign military sales (DSCA); Air Mobility Command / USTRANSCOM charter contracts.
- Good requests name exact dates (UTC), callsigns, registrations, ICAO hex codes, airports and the specific record type.
When a lead is strong enough, draft the request: agency, legal basis to cite if known, exact identifiers, period, records sought.

WORKING WITH THE APP
- To put many flights on the map ("show all of them"), call map_show_flights with search: {the same filters} — the app
  fetches and draws up to 5,000 itself. Never page through leg IDs or run SQL to collect them.
- Data tool results are shown to the user as cards automatically; do not repeat long lists. Summarise, then name the few most
  relevant flights with leg_id, callsign, registration, route and UTC times.
- Lists you receive may be truncated: use the totals and summaries given, not your own count of visible rows.
- Each user message ends with an [App state] block: map focus, selected flight, date range, connected sources, case-file summary.
  Use it to resolve "this", "here", "the selected flight"; do not mention it unless relevant. The map is shared by all chat tabs.

PLAYBOOKS (one call that runs a whole first pass, with exact totals, coverage and leads)
- investigate_airspace_claim: "country X lets flights to/from Y through its airspace" → call it FIRST, then follow its leads.
- investigate_airlift_base: "what leaves base X for country Y" → same.
Budget: a quick fact takes 1–3 tool calls; an investigation at most ~12 before answering (playbooks count as one). Stop and
report when the budget is spent, with what is left to check.

EVIDENCE CITATIONS
Every tool result arrives tagged [evidence E#]. Cite the tag after each figure or finding it supports, e.g. "788 flights [E2]".
Numbers in your answer must come from a result (the checker compares them); never compute totals from a truncated list.

ANSWER FORMAT for investigative questions (skip for quick facts)
Findings (each labelled verified / supported / hypothesis / speculation, with [E#]) · Leads, strongest first, each with what
would confirm or rule it out · Next steps · What would change this conclusion (the one piece of evidence that would).

EXAMPLE of the standard expected (abridged; the flights and figures are illustrative, not real):
"Coverage: receivers saw nothing over Country A's airspace for the first 14 months of the period [E1]; inferred crossings there
were confirmed on 90% of sampled days by an independent network [E1]. Verified: 412 flights linked to Country B crossed it, 260
observed, 1 military [E2]: a tanker, callsign ABC123, observed for 9 minutes on 2025-03-02, flying from Country B [E3].
Supported: two cargo-airline freighters crossed, observed, cargo unknown [E4]. Lead 1 (strongest): the freighters — confirm with
the overflight-permit records of Country A's foreign ministry for those two dates. What would change this: a permit application
naming one of these flights."


TRANSPARENCY
This is an open project: if asked how you work or what your instructions are, explain them openly.${extra ? '\n\n' + extra : ''}`;
}

function validate(def: ToolDef, input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'tool input must be a JSON object';
  for (const k of def.input_schema.required || []) if (!(k in (input as object))) return `missing required field "${k}"`;
  return null;
}

// "flights 2026-04, 2026-05" / "airspace index sov_ISL 2024-Q3, 2024-Q4" from the files a query reads
function describeReads(sql: string): string {
  const files = [...sql.matchAll(/\/v1\/([a-z_]+)\/([^'\s]+?)\.parquet/g)].map(m => [m[1], m[2]] as const);
  if (!files.length) return '';
  const groups = new Map<string, string[]>();
  for (const [top, rest] of files) {
    const parts = rest.split('/');
    const label = top === 'flights' ? ({ legs: 'flights', leg_zones: 'airspace crossings', aircraft: 'aircraft', coverage: 'coverage', by_airport: 'flights by airport', by_hex: 'flights by aircraft', zones_by_leg: 'crossings by flight' } as any)[parts[0]] ?? parts[0]
      : top === 'index' ? `${parts[0] === 'zone' ? 'airspace' : parts[0] === 'to' ? 'destination' : parts[0] === 'from' ? 'origin' : parts[0]} index ${parts[1] ?? ''}`.trim()
      : top === 'days' ? `${parts[0]} of day` : top;
    const g = groups.get(label) ?? []; g.push(parts[parts.length - 1]); groups.set(label, g);
  }
  return [...groups].map(([label, ps]) => `${label} ${ps.length > 4 ? `${ps[0]} … ${ps[ps.length - 1]} (${ps.length})` : ps.join(', ')}`).join('; ');
}

// Stop also cancels the database query in flight (otherwise it would keep the single connection busy)
let cancelDb: (() => Promise<void>) | null = null;
export function setDbCancel(f: () => Promise<void>) { cancelDb = f; }

export async function runAgent(opts: {
  apiKey: string; profile: Profile; ctx: Ctx; system: string; messages: Anthropic.Beta.BetaMessageParam[];
  web?: boolean; onEvent: (e: AgentEvent) => void; signal?: AbortSignal; maxTurns?: number; verify?: boolean;
  client?: Anthropic; extraTools?: ToolDef[];   // e.g. map-control tools in the browser
}): Promise<{ messages: Anthropic.Beta.BetaMessageParam[]; text: string; citations: Citation[]; usage: Usage; report?: VerifyReport }> {
  const p = opts.profile;
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });
  const allTools = [...PLAYBOOKS, ...TOOLS, ...SOURCE_TOOLS, ...(opts.extraTools ?? [])];
  const toolByName = (n: string) => allTools.find(t => t.name === n);
  const tools: Anthropic.Beta.BetaToolUnion[] = allTools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true }) as Anthropic.Beta.BetaToolUnion);
  // searches per model request: Deep researches the press and official record properly, Fast only looks things up
  if (opts.web) tools.push({ type: p.web.search, name: 'web_search', max_uses: p.webUses ?? 4 } as Anthropic.Beta.BetaToolUnion,
    { type: p.web.fetch, name: 'web_fetch', max_uses: p.webUses ?? 4 } as Anthropic.Beta.BetaToolUnion);
  // explicit cache breakpoint on the stable system prompt (tools render before it, so both are cached)
  const system = [{ type: 'text' as const, text: opts.system, cache_control: { type: 'ephemeral' as const } }];
  const onAbortDb = () => { cancelDb?.(); };
  opts.signal?.addEventListener('abort', onAbortDb, { once: true });
  const messages = [...opts.messages];
  const usage = emptyUsage();
  let evidence = collectEvidence(...opts.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
  let finalText = '', citations: Citation[] = [], jsonRetries = 0, stallRetries = 0, corrected = false, report: VerifyReport | undefined;
  let evidenceN = 0, fullEvidence = '';
  const STALL_MS = 240_000;
// tool budgets: the archive-wide readers (playbooks, the export cross-check, whole-archive lookups) legitimately run for
// minutes; everything else is seconds
const toolBudgetMs = (name: string) => (/^investigate_|crosscheck|run_sql|aircraft_legs|flight_dossier|airport_movements|route_search|flights_through_zone/.test(name) ? 900_000 : 180_000);
async function withBudget<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { cancelDb?.(); reject(new Error(`${name} did not finish within ${Math.round(ms / 1000)} s and was stopped`)); }, ms); });
  try { return await Promise.race([p, limit]); } finally { clearTimeout(timer); }
}

  for (let turn = 0; turn < (opts.maxTurns ?? 20); turn++) {
    stopped(opts.signal);
    const params: any = {
      model: p.model, max_tokens: 32000, system, messages, tools,
      thinking: { type: 'adaptive' }, output_config: { effort: p.effort },
      cache_control: { type: 'ephemeral' },   // automatic caching of the growing conversation tail
    };
    if (p.fallbacks) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
    // stall watchdog: a stream that sends nothing (not even a thinking delta) for 4 minutes is abandoned and the turn
    // retried once, with a notice, instead of hanging the answer for good; the user's Stop still wins
    const turnAbort = new AbortController();
    const onStop = () => turnAbort.abort();
    opts.signal?.addEventListener('abort', onStop, { once: true });
    let lastActivity = Date.now(), stalled = false;
    const watchdog = setInterval(() => { if (Date.now() - lastActivity > STALL_MS) { stalled = true; turnAbort.abort(); } }, 10_000);
    const stream = client.beta.messages.stream(params, { signal: turnAbort.signal });
    stream.on('streamEvent', () => { lastActivity = Date.now(); });
    stream.on('text', (d: string) => opts.onEvent({ type: 'text', text: d }));
    // what the model is doing right now, so a long think never looks like a stall (usage only arrives at the end)
    opts.onEvent({ type: 'phase', text: 'Thinking' });
    stream.on('streamEvent', (ev: any) => {
      if (ev.type !== 'content_block_start') return;
      const b = ev.content_block;
      const phase = b.type === 'thinking' || b.type === 'redacted_thinking' ? 'Thinking' : b.type === 'text' ? 'Writing'
        : b.type === 'server_tool_use' ? (b.name === 'web_fetch' ? 'Reading a web page' : 'Searching the web')
        : b.type === 'tool_use' ? `Preparing ${String(b.name).replace(/_/g, ' ')}` : '';
      if (phase) opts.onEvent({ type: 'phase', text: phase });
    });
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      clearInterval(watchdog); opts.signal?.removeEventListener('abort', onStop);
      stopped(opts.signal);   // an abort during streaming is a stop, never a malformed tool call to retry
      if (stalled) {
        if (stallRetries++ >= 1) throw new Error('The model stopped responding twice in a row (no data for 4 minutes). Try again, or a different model.');
        opts.onEvent({ type: 'notice', text: 'No response from the model for 4 minutes; retrying this step' });
        continue;
      }
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      opts.onEvent({ type: 'notice', text: 'a tool call arrived malformed; retrying the turn' });
      continue;
    }
    clearInterval(watchdog); opts.signal?.removeEventListener('abort', onStop);
    addUsage(usage, p, msg.usage);
    opts.onEvent({ type: 'usage', usage: { ...usage } });
    messages.push({ role: 'assistant', content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
    for (const b of msg.content as any[]) {
      if (b.type === 'server_tool_use') opts.onEvent({ type: 'server_tool', name: b.name, input: b.input });
      if (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') evidence += '\n' + JSON.stringify(b.content).slice(0, 200_000);
      if (b.type === 'text') for (const c of b.citations || []) if (c.url) citations.push({ url: c.url, title: c.title, cited_text: c.cited_text });
    }
    if (msg.stop_reason === 'refusal') { opts.onEvent({ type: 'notice', text: 'The model declined this request.' }); break; }
    if (msg.stop_reason === 'pause_turn') continue;            // server tool loop paused: re-send to resume
    if (msg.stop_reason !== 'tool_use') {
      // end_turn / max_tokens: finish (never run a possibly truncated tool call)
      finalText = msg.content.filter(b => b.type === 'text').map(b => (b as any).text).join('');
      if (!finalText.trim() && turn > 0 && !(opts as any)._nudged) {   // ended after tools without a word: ask once for the reply
        (opts as any)._nudged = true;
        messages.push({ role: 'user', content: 'Please reply to the user now, in text, based on the tool results above.' });
        continue;
      }
      if (opts.verify !== false) {
        report = verifyAnswer(finalText, evidence, opts.ctx.manifest.dates, opts.ctx.zones, fullEvidence);
        opts.onEvent({ type: 'verify', report });
        if (!report.ok && !corrected && msg.stop_reason === 'end_turn') {
          corrected = true;   // one self-correction round, then report whatever remains
          opts.onEvent({ type: 'notice', text: 'Checking unverified claims…' });
          messages.push({ role: 'user', content: correctionPrompt(report, opts.ctx.manifest.dates) });
          continue;
        }
      }
      break;
    }
    const uses = msg.content.filter(b => b.type === 'tool_use') as Anthropic.Beta.BetaToolUseBlock[];
    if (uses.length) opts.onEvent({ type: 'phase', text: `Running ${uses.map(u => u.name.replace(/_/g, ' ')).join(', ')}` });
    const results = await Promise.all(uses.map(async u => {
      const def = toolByName(u.name);
      if (import.meta.env.DEV) console.debug('[tool start]', u.name, JSON.stringify(u.input).slice(0, 300));   // test scripts read these
      opts.onEvent({ type: 'tool_call', name: u.name, input: u.input });
      const bad = def ? validate(def, u.input) : `unknown tool ${u.name}`;
      if (bad) return { type: 'tool_result' as const, tool_use_id: u.id, is_error: true, content: bad };
      try {
        // each call gets its own progress line (tools may run in parallel)
        const progress = (text: string, data?: any) => opts.onEvent({ type: 'progress', name: u.name, text, result: data });
        // every read is narrated from the SQL ("Reading flights 2026-04, 2026-05 · query 3"), so no tool is ever silent
        let nq = 0;
        const query = (sql: string) => { stopped(opts.signal); nq++; const what = describeReads(sql); if (what) progress(`Reading ${what}${nq > 1 ? ` · query ${nq}` : ''}`); return opts.ctx.query(sql); };
        const ctx = { ...opts.ctx, query, progress };
        // a tool that never returns would hang the turn for good (the stream watchdog only covers the model): each call
        // has a budget, generous for the long readers, and a call over it is reported to the model as an error
        const out = await untilStopped(withBudget(def!.run(ctx, u.input), toolBudgetMs(u.name), u.name), opts.signal);
        // every data result gets an evidence id the answer can cite ([E3]); the UI links it to the step on the map
        const evidenceId = u.name.startsWith('map_') || u.name === 'case_file' ? undefined : `E${++evidenceN}`;
        if (import.meta.env.DEV) console.debug('[tool end]', u.name);
        opts.onEvent({ type: 'tool_result', name: u.name, input: u.input, result: out, evidenceId });   // full result to the UI
        let forModel = JSON.stringify(compactForModel(u.name, out, p.rowsForModel));       // compact result to the model
        // an empty zone result gets the zone's receiver coverage attached: "no flights" must never be said where there were no receivers
        const inp: any = u.input;
        if (inp?.zone_id && (Array.isArray(out) ? out.length === 0 : out?.totals?.flights === 0) && u.name !== 'zone_coverage') {
          try { const cov = await untilStopped(toolByName('zone_coverage')!.run(ctx, { zone_id: inp.zone_id, date_from: inp.date_from, date_to: inp.date_to }), opts.signal);
            forModel += '\nRECEIVER COVERAGE of this zone in the period (attached automatically because no flights matched): ' + JSON.stringify(cov); } catch { /* coverage unavailable */ }
        }
        if (evidenceId) forModel = `[evidence ${evidenceId}] ` + forModel;
        evidence += '\n' + forModel;
        // the checker also sees the full result (the model sees a compacted one): per-port figures, long lists
        try { fullEvidence += '\n' + JSON.stringify(out).slice(0, 2_000_000); } catch { /* unserialisable result */ }
        return { type: 'tool_result' as const, tool_use_id: u.id, content: forModel };
      } catch (e) {
        if (e instanceof StoppedError) throw e;
        opts.onEvent({ type: 'tool_result', name: u.name, input: u.input, error: String(e) });
        return { type: 'tool_result' as const, tool_use_id: u.id, is_error: true, content: String(e) };
      }
    }));
    stopped(opts.signal);
    messages.push({ role: 'user', content: results });   // all results in one message
  }
  const seen = new Set<string>();
  citations = citations.filter(c => !seen.has(c.url) && seen.add(c.url));
  return { messages, text: finalText, citations, usage, report };
}

export const RESEARCH_BRIEF = `Research the flight in the dossier below as an investigative lead (web search and fetch; a handful of searches).
Look for: the operator and the aircraft's registration and ownership history (lessors, ACMI/charter arrangements); government
contracts (e.g. US Air Mobility Command, CRAF) or defence-logistics work by the operator; news, investigations or official records
mentioning this callsign, registration or route near this date; whether the airports are military bases or known airlift hubs;
documented cargo; sanctions or legal cases. A civilian operator is not a reason to stop: civilian cargo and charter carriers
often move military cargo.
Report: "What the flight data shows" (verified) · "What sources say" (each claim with its URL) · "Assessment" (supported inference
vs hypothesis, with what would confirm or rule it out) · "Next steps" (specific checks, incl. records to request and from whom).
Never present an inference as documented fact.`;
