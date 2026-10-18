// Shared tool layer: used by the UI, the in-browser chat/agents, and the MCP server.
// Environment-agnostic: callers provide `query` (DuckDB-WASM in the browser, DuckDB in Node),
// the manifest, the zone list and an H3 polygon->cells function.

export type Row = Record<string, unknown>;
export type QueryFn = (sql: string) => Promise<Row[]>;
export interface Manifest {
  base: string; dates: string[]; legs: number; leg_zones?: number; h3_resolution: number; attribution: string[];
  files: Record<string, string>; built_utc: string;
  months?: string[];   // v2 (R2): flight tables are split per month; files.legs etc. contain {month}
  index?: { routes?: Record<string, { months: string[]; to: string[]; from: string[] }>; zones?: Record<string, { months: string[]; zone: string[] }>;
    hex?: Record<string, { months: string[]; keys: string[] }>; airport?: Record<string, { months: string[]; keys: string[] }> };   // search index catalog
  lookups?: string[];   // months with point-lookup copies (by_airport, by_hex, zones_by_leg)
}
export interface ZoneMeta { id: string; name: string; kind: string; iso: string; country: string; source: string }
export interface Ctx {
  query: QueryFn;
  queryWithin?: (sql: string, ms: number) => Promise<Row[]>;   // time-limited query (browser); run_sql uses it
  progress?: (text: string, data?: { legs?: Row[] }) => void;   // a long tool says what it is doing (and what it found so far)
  validation?: Record<string, any>;   // v1/meta/validation/*.json: how our inferred crossings compared with another network (per zone)
  manifest: Manifest;
  zones: ZoneMeta[];
  cellsForPolygon: (ring: [number, number][], res: number) => string[];
  keys?: () => { census?: string; openskyId?: string; openskySecret?: string; openskyBase?: string; proxyBase?: string };   // external-source keys (BYO)
  defaultPeriod?: () => [string, string] | null;   // the user's selected period (browser); tools use it when no dates are given
}
export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  run: (ctx: Ctx, args: any) => Promise<unknown>;
}

// ---------- helpers ----------
export const lit = (s: unknown) => `'${String(s ?? '').replace(/'/g, "''")}'`;
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const epoch = (d: string) => Math.floor(Date.parse(d + 'T00:00:00Z') / 1000);
const url = (ctx: Ctx, f: string) => `${ctx.manifest.base}/${f}`;
const LEG_COLS = `leg_id, hex, reg, type, operator, mil, callsigns, date, t0, t1, from_code, from_name, from_country, from_cert, from_mil,
  to_code, to_name, to_country, to_cert, to_mil, maxlat, from_lat, from_lon, to_lat, to_lon, days`;

// Compact description of a sorted date list: "2023-03-10..2023-04-02, 2023-04-04..2026-10-13 (1,306 days)".
export function dateRanges(ds: string[], max = 12) {
  const out: string[] = [];
  let a = ds[0], prev = ds[0];
  const next = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  for (const d of ds.slice(1).concat([''])) {
    if (d && d === next(prev)) { prev = d; continue; }
    if (a) out.push(a === prev ? a : `${a}..${prev}`);
    a = prev = d;
  }
  const s = out.length > max ? out.slice(0, max).join(', ') + `, … (${out.length - max} more ranges)` : out.join(', ');
  return `${s} (${ds.length.toLocaleString('en')} days)`;
}

// The dataset covers only the days listed in the manifest (not every day between first and last).
export function coverage(ctx: Ctx, from?: string, to?: string) {
  const ds = ctx.manifest.dates;
  const f = from || ds[0], t = to || ds[ds.length - 1];
  const covered = ds.filter(d => d >= f && d <= t);
  return { from: f, to: t, covered_dates: covered, all_dates: ds };
}
// Without dates a tool searches the user's selected period, else the last 30 days of data. (Defaulting to the whole archive
// made "departures from Keflavik" read every monthly file in the browser: minutes.) Long periods must be asked for explicitly.
export const DEFAULT_DAYS = 30;
function defaultDates(ctx: Ctx): [string, string] {
  const p = ctx.defaultPeriod?.();
  if (p && p[0] && p[1]) return p;
  const ds = ctx.manifest.dates, last = ds[ds.length - 1];
  return [new Date(Date.parse(last + 'T00:00:00Z') - (DEFAULT_DAYS - 1) * 86400000).toISOString().slice(0, 10), last];
}
function range(ctx: Ctx, a: any) {
  if (!a.date_from && !a.date_to) [a.date_from, a.date_to] = defaultDates(ctx);
  else if (!a.date_from) a.date_from = ctx.manifest.dates[0];
  else if (!a.date_to) a.date_to = ctx.manifest.dates[ctx.manifest.dates.length - 1];
  const c = coverage(ctx, a.date_from, a.date_to);
  if (!c.covered_dates.length)
    throw new Error(`No data for ${c.from}..${c.to}. The dataset only covers: ${dateRanges(c.all_dates)}. An empty result for other dates means "not in the dataset", not "no flights".`);
  return { from: c.from, to: c.to, t0: epoch(c.from), t1: epoch(c.to) + 86400, covered: c.covered_dates };
}
function dayFiles(ctx: Ctx, tier: 'positions' | 'callsigns' | 'h3', from: string, to: string) {
  const fs = ctx.manifest.dates.filter(d => d >= from && d <= to).map(d => lit(url(ctx, ctx.manifest.files[tier].replace('{date}', d))));
  return fs.length ? `read_parquet([${fs.join(',')}])` : null;
}
// leg_id = "<hex>-<t0>": the departure time is in the id, which lets lookups skip all but one block of the sorted legs files
export const idT0 = (id: string) => Number(String(id).split('-').pop()) || 0;
export const byLegId = (id: string, col = 't0') => `leg_id = ${lit(id)} AND ${col} BETWEEN ${idT0(id) - 1} AND ${idT0(id) + 1}`;
const fmtTime = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
function shapeLeg(r: Row) {
  return { ...r, departed_utc: fmtTime(Number(r.t0)), arrived_utc: fmtTime(Number(r.t1)) };
}

// Read only the months a query needs. Monthly tables (v2) are partitioned by the month of the flight's departure
// (coverage: by date). T(ctx, 'legs', t0, t1) → read_parquet of the month files overlapping [t0, t1) epoch seconds,
// or the plain view for single-file datasets. Reading all months for every query would get slower each month.
// The dossier in stages; onPart gets each piece as soon as its query returns (the details overlay fills in as it loads)
export async function flightDossier(ctx: Ctx, id: string, onPart: (part: Record<string, unknown>) => void = () => {}) {
  const lt = idT0(id);
  const [leg] = await ctx.query(`SELECT * FROM ${T(ctx, 'legs', lt - 1, lt + 1)} WHERE ${byLegId(id)}`);
  if (!leg) throw new Error('unknown leg_id');
  onPart({ leg: shapeLeg(leg) });
  const [ac] = await ctx.query(`SELECT * FROM ${T(ctx, 'aircraft', lt - 1, lt + 1)} WHERE hex = ${lit(leg.hex)} LIMIT 1`);
  const registry = await registryOf(ctx, String(leg.hex));
  onPart({ aircraft: ac, registry });
  const t0 = Number(leg.t0);
  const nb = keyedSrc(ctx, 'hex', String(leg.hex).slice(0, 2), t0 - 3 * 86400, t0 + 3 * 86400 + 1);
  const nearby = nb === '(empty)' ? [] : await ctx.query(`SELECT ${LEG_COLS} FROM ${nb ?? L(ctx, 'by_hex', t0 - 3 * 86400, t0 + 3 * 86400 + 1) ?? T(ctx, 'legs', t0 - 3 * 86400, t0 + 3 * 86400 + 1)} WHERE hex = ${lit(leg.hex)} AND t0 BETWEEN ${t0 - 3 * 86400} AND ${t0 + 3 * 86400} ORDER BY t0`);
  onPart({ same_aircraft_nearby: nearby.map(shapeLeg) });
  // leg_zones is sorted by zone and time, so one flight's crossings need most of the month file: slowest part, last
  const zname = (z: string) => ctx.zones.find(x => x.id === z)?.name || z;
  const zones = await ctx.query(`SELECT zone_id, evidence, t_in, t_out, n_obs, n_inf FROM ${L(ctx, 'zones_by_leg', lt - 1, lt + 1) ?? T(ctx, 'leg_zones', lt - 1, lt + 1)} WHERE leg_id = ${lit(id)} AND t_in BETWEEN ${lt - 1} AND ${Number(leg.t1) + 1} ORDER BY t_in, zone_id`);
  const zones_crossed = zones.map(z => ({ ...z, zone_name: zname(String(z.zone_id)), in_utc: fmtTime(Number(z.t_in)), out_utc: fmtTime(Number(z.t_out)) }));
  onPart({ zones_crossed });
  const days = String(leg.days || leg.date).split(' ');
  const rest = {
    same_aircraft_nearby: nearby.map(shapeLeg),
    sources: [
      ...days.map(d => ({ kind: 'adsb', title: `ADSB.lol globe_history ${d} (ODbL)`, url: `https://github.com/adsblol/globe_history_${d.slice(0, 4)}/releases/tag/v${d.replaceAll('-', '.')}-planes-readsb-prod-0` })),
      { kind: 'zones', title: 'Zone boundaries', detail: [...new Set(zones.map(z => ctx.zones.find(x => x.id === z.zone_id)?.source).filter(Boolean))].join('; ') },
      { kind: 'airports', title: 'Airport names: OurAirports (public domain)', url: 'https://ourairports.com/data/' },
    ],
  };
  onPart(rest);
  return { leg: shapeLeg(leg), aircraft: ac, registry, zones_crossed, ...rest };
}

export function T(ctx: Ctx, table: 'legs' | 'leg_zones' | 'aircraft' | 'coverage', t0: number, t1: number) {
  const f = ctx.manifest.files[table];
  if (!f?.includes('{month}') || !ctx.manifest.months?.length) return table;
  const months = ctx.manifest.months.filter(m => {
    const [y, mo] = m.split('-').map(Number);
    return Date.UTC(y, mo - 1, 1) / 1000 < t1 && Date.UTC(y, mo, 1) / 1000 > t0;
  });
  // no month in range: an empty table with the right columns (from the first month file)
  if (!months.length) return `(SELECT * FROM read_parquet(${lit(url(ctx, f.replace('{month}', ctx.manifest.months[0])))}) WHERE false)`;
  return `read_parquet([${months.map(m => lit(url(ctx, f.replace('{month}', m)))).join(',')}])`;
}
// Point-lookup copies (build_index.py "lookups"): each month's flights re-sorted by airport (one row per end: code, role
// dep|arr) and by aircraft, and its airspace crossings by flight, in small row groups, so one airport / aircraft / flight
// reads a few row groups instead of a whole month. Null unless every month in the range has them (use the plain tables).
export function L(ctx: Ctx, kind: 'by_airport' | 'by_hex' | 'zones_by_leg', t0: number, t1: number): string | null {
  const f = ctx.manifest.files[kind], have = new Set(ctx.manifest.lookups ?? []);
  if (!f || !have.size) return null;
  const months = (ctx.manifest.months ?? []).filter(m => { const [y, mo] = m.split('-').map(Number); return Date.UTC(y, mo - 1, 1) / 1000 < t1 && Date.UTC(y, mo, 1) / 1000 > t0; });
  if (!months.length || months.some(m => !have.has(m))) return null;
  return `read_parquet([${months.map(m => lit(url(ctx, f.replace('{month}', m)))).join(',')}])`;
}
// One aircraft (kind 'hex', key = first two characters of the address) or one airport (kind 'airport', key = first two
// characters of the ICAO code), over any period: yearly per-key index files where a year has them, the monthly sorted
// copies for the other months. Null when some month has neither (the caller uses the plain tables); '(empty)' when the
// key has no rows in the period. Column sets are identical, so one read_parquet covers both kinds of file.
export function keyedSrc(ctx: Ctx, kind: 'hex' | 'airport', key: string, t0: number, t1: number): string | null {
  const months = (ctx.manifest.months ?? []).filter(m => { const [y, mo] = m.split('-').map(Number); return Date.UTC(y, mo - 1, 1) / 1000 < t1 && Date.UTC(y, mo, 1) / 1000 > t0; });
  if (!months.length) return null;
  const k = key.toLowerCase(), files: string[] = [], left = new Set(months);
  const yearly = ctx.manifest.index?.[kind], yf = ctx.manifest.files[`index_${kind}`];
  if (yearly && yf) for (const [year, v] of Object.entries(yearly)) {
    if (!v.months.some(m => left.has(m))) continue;
    for (const m of v.months) left.delete(m);
    if (v.keys.includes(k) || v.keys.includes(k.toUpperCase())) files.push(lit(url(ctx, yf.replace('{key}', v.keys.includes(k) ? k : k.toUpperCase()).replace('{period}', year))));
  }
  const mf = ctx.manifest.files[kind === 'hex' ? 'by_hex' : 'by_airport'], have = new Set(ctx.manifest.lookups ?? []);
  const monthly: string[] = [];
  for (const m of left) { if (!mf || !have.has(m)) return null; monthly.push(lit(url(ctx, mf.replace('{month}', m)))); }
  if (!files.length && !monthly.length) return '(empty)';
  // yearly files and monthly copies are read separately with the same explicit columns (a yearly file may carry an
  // extra partition column), then combined
  const cols = kind === 'hex' ? LEG_COLS : 'code, role, ' + LEG_COLS;
  const parts = [files, monthly].filter(f => f.length).map(f => `SELECT ${cols} FROM read_parquet([${f.join(',')}])`);
  return `(${parts.join(' UNION ALL ')})`;
}
// Warm DuckDB's metadata cache for the files most lookups touch first (the latest two months' flight tables and
// sorted copies): reading a footer takes a few HTTP requests, and the cache then makes the first real lookup fast.
// Runs after startup, one file at a time, and gives up quietly on any error.
export async function warmCache(ctx: Ctx) {
  const months = (ctx.manifest.months ?? []).slice(-2);
  const kinds = ['legs', 'by_hex', 'zones_by_leg', 'by_airport', 'leg_zones', 'aircraft'];
  for (const m of months.reverse()) for (const k of kinds) {
    const f = ctx.manifest.files[k];
    if (!f || (k.startsWith('by_') || k === 'zones_by_leg') && !ctx.manifest.lookups?.includes(m)) continue;
    try { await ctx.query(`SELECT 1 FROM read_parquet(${lit(url(ctx, f.replace('{month}', m)))}) WHERE false`); } catch { return; }
  }
}
// Search indexes (build_index.py): re-sorted copies for long periods. routes = flights sorted by country pair (per year),
// zones = airspace crossings with flight columns sorted by airspace (per quarter). Used only when they cover every month
// in the range; otherwise null and the caller uses the monthly files.
// side: 'to' / 'from' (routes, key = ISO2 country) or 'zone' (key = zone id). Returns read_parquet over the key's files for
// every period overlapping the range, '(empty)' when the key has no flights in those periods, or null when the index does
// not cover every month in the range (the caller then uses the monthly files).
export function indexSrc(ctx: Ctx, side: 'to' | 'from' | 'zone', key: string, t0: number, t1: number): string | null {
  const cat = side === 'zone' ? ctx.manifest.index?.zones : ctx.manifest.index?.routes;
  const f = ctx.manifest.files[`index_${side}`];
  if (!cat || !f || !ctx.manifest.months?.length) return null;
  const inRange = (m: string) => { const [y, mo] = m.split('-').map(Number); return Date.UTC(y, mo - 1, 1) / 1000 < t1 && Date.UTC(y, mo, 1) / 1000 > t0; };
  const need = ctx.manifest.months.filter(inRange);
  const periods = Object.entries(cat).filter(([, v]) => v.months.some(inRange));
  const covered = new Set(periods.flatMap(([, v]) => v.months));
  if (!need.length || need.some(m => !covered.has(m))) return null;
  const k = key || '_';
  const files = periods.filter(([, v]) => ((v as any)[side] as string[]).includes(k)).map(([p]) => p).sort()
    .map(p => lit(url(ctx, f.replace('{key}', k.replace(':', '_')).replace('{period}', p))));
  // by column name: index files of different builds may differ in column order or carry an extra partition column
  return files.length ? `read_parquet([${files.join(',')}], union_by_name = true)` : '(empty)';
}
const LONG = 62 * 86400;   // periods longer than this use the indexes
// Long periods without a fast index would read many monthly files in the browser (minutes). Fail fast with guidance instead.
function tooLong(r: { from: string; to: string }, what: string): never {
  throw new Error(`The period ${r.from} → ${r.to} is too long for ${what} in the browser without the search index (not built for this period yet). `
    + `Use find_flights (it uses the fast indexes where they exist), or split the question into periods of at most 2 months.`);
}

// Views over ALL months exist for run_sql only; creating them binds every month file, so it happens on first use.
export async function ensureAllViews(ctx: Ctx) {
  if ((ctx as any)._allViews) return;
  await createViews(ctx, ['legs', 'leg_zones', 'aircraft', 'coverage']);
  (ctx as any)._allViews = true;
}

export async function setupViews(ctx: Ctx) {
  // single-file datasets (local prototype): all views now; monthly datasets: only the small single-file tables
  const monthly = !!ctx.manifest.months?.length && ctx.manifest.files.legs.includes('{month}');
  await createViews(ctx, monthly ? ['airports', 'registry'] : ['legs', 'leg_zones', 'aircraft', 'airports', 'coverage', 'registry']);
  if (!monthly) (ctx as any)._allViews = true;
}

async function createViews(ctx: Ctx, which: string[]) {
  const f = ctx.manifest.files;
  // epoch seconds are kept; *_utc columns are plain TIMESTAMP (UTC, no time zone) so date functions work without extensions
  const extra: Record<string, string> = {
    legs: ', make_timestamp(t0 * 1000000) AS dep_utc, make_timestamp(t1 * 1000000) AS arr_utc',
    leg_zones: ', make_timestamp(t_in * 1000000) AS in_utc, make_timestamp(t_out * 1000000) AS out_utc',
  };
  // v2 manifests split flight tables per month: read the list of month files as one table. All months share one schema
  // (the builder enforces it), so no union_by_name: that would make the browser fetch every month's header at startup.
  const src = (file: string) => file.includes('{month}')
    ? `read_parquet([${(ctx.manifest.months ?? []).map(m => lit(url(ctx, file.replace('{month}', m)))).join(',')}])`
    : `read_parquet(${lit(url(ctx, file))})`;
  const registry = f.registry ?? (ctx.manifest.months ? 'meta/registry.parquet' : undefined);
  for (const [v, file] of [['legs', f.legs], ['leg_zones', f.leg_zones], ['aircraft', f.aircraft], ['airports', f.airports], ['coverage', f.coverage], ['registry', registry]]) {
    if (!which.includes(v)) continue;
    if (!file) continue;   // older datasets have no coverage / registry table
    // an aircraft appears in every month it flew: keep one row per hex
    const body = v === 'aircraft' && file.includes('{month}') ? `SELECT DISTINCT ON (hex) * FROM ${src(file)}` : `SELECT *${extra[v] || ''} FROM ${src(file)}`;
    await ctx.query(`CREATE OR REPLACE VIEW ${v} AS ${body}`);
  }
}

// Receiver coverage of a zone per day (v2 datasets): how many aircraft receivers saw inside the zone. 0 = no coverage.
// What an independent check found about our inferred crossings of this zone (validate_iceland.py): shown with coverage
// so "inferred" in a coverage gap is read as an estimate with a known error rate, not as a sighting.
function validationNote(ctx: Ctx, zone: string, from: string, to: string) {
  const v = ctx.validation?.[zone];
  if (!v?.overall || !v.days) return undefined;
  const days = Object.keys(v.days).sort();
  if (to < days[0] || from > days[days.length - 1]) return undefined;
  const o = v.overall;
  return { source: v.source, sample_days: o.days, period: [days[0], days[days.length - 1]],
    inferred_crossings_confirmed: `${Math.round((o.precision ?? 0) * 100)}% of our inferred crossings were confirmed by the other network's positions (${o.ours_confirmed} of ${o.ours_checked} checked)`,
    real_crossings_we_had: `${Math.round((o.recall ?? 0) * 100)}% of the real crossings on those days were in our data (${o.ours_confirmed} of ${o.true_crossings})`,
    how_to_read: 'In this coverage gap, an "inferred" crossing is an estimate with roughly these odds, not a sighting. Say so when citing one; a crossing confirmed by another network or a flight plan is the evidence.' };
}

async function zoneCoverage(ctx: Ctx, zone: string, r: { from: string; to: string; covered: string[] }) {
  if (!ctx.manifest.files.coverage) return { available: false, note: 'This dataset has no coverage table.' };
  const rows = await ctx.query(`SELECT date, aircraft, hours FROM ${T(ctx, 'coverage', epoch(r.from), epoch(r.to) + 86400)} WHERE zone_id = ${lit(zone)} AND date BETWEEN ${lit(r.from)} AND ${lit(r.to)} ORDER BY date`);
  const by = new Map(rows.map(x => [String(x.date), x]));
  const none = r.covered.filter(d => !by.has(d));
  const counts = r.covered.map(d => Number(by.get(d)?.aircraft ?? 0)).sort((a, b) => a - b);
  return {
    validation_of_inferred_crossings: validationNote(ctx, zone, r.from, r.to),
    days_in_period: r.covered.length, days_with_receiver_coverage: r.covered.length - none.length,
    days_without_any_aircraft_seen: none.length <= 20 ? none : dateRanges(none),
    median_aircraft_seen_per_day: counts.length ? counts[Math.floor(counts.length / 2)] : 0,
    note: 'Aircraft seen by receivers anywhere inside the zone per day. Days with 0 mean receivers did not cover the zone: missing flights there are expected, not evidence of absence.',
  };
}

// v2 datasets: find the months an aircraft appears in from the small per-month aircraft tables, then read only those
// months' legs. Returns a SQL source for legs (or the legs view when the dataset is not split by month).
// t0/t1 (epoch s): only months overlapping that period are looked at; without it, every month (a whole-history profile)
async function aircraftLegsSource(ctx: Ctx, q: string, t0?: number, t1?: number): Promise<{ src: string; months?: string[] }> {
  const f = ctx.manifest.files;
  if (!f.legs.includes('{month}') || !ctx.manifest.months?.length) return { src: 'legs' };
  const inRange = (m: string) => {
    if (t0 == null || t1 == null) return true;
    const a = Date.parse(m + '-01T00:00:00Z') / 1000, [y, mo] = m.split('-').map(Number);
    return a < t1 && Date.UTC(y, mo, 1) / 1000 > t0;
  };
  const cand = ctx.manifest.months.filter(inRange);
  if (!cand.length) return { src: `(SELECT * FROM ${T(ctx, 'legs', 0, 1)} WHERE false)`, months: [] };
  // the aircraft's address(es): given, or from the registry (local, instant), else from the months' small aircraft files
  let hexes = /^[0-9a-f]{6}$/i.test(q) ? [q.toLowerCase()] : [];
  if (!hexes.length) hexes = (await ctx.query(`SELECT DISTINCT hex FROM registry WHERE reg ILIKE ${lit(q)}`).catch(() => [])).map(r => String(r.hex).toLowerCase());
  let months = cand;
  if (!hexes.length) {
    const files = cand.map(m => lit(url(ctx, f.aircraft.replace('{month}', m))));
    const rows = await ctx.query(`SELECT DISTINCT filename, hex FROM read_parquet([${files.join(',')}], filename = true) WHERE reg ILIKE ${lit(q)} OR hex = ${lit(q.toLowerCase())}`);
    hexes = [...new Set(rows.map(r => String(r.hex).toLowerCase()))];
    months = [...new Set(rows.map(r => String(r.filename).match(/(\d{4}-\d{2})\.parquet/)?.[1]).filter(Boolean) as string[])];
    if (!hexes.length) return { src: `(SELECT * FROM ${T(ctx, 'legs', 0, 1)} WHERE false)`, months };
  }
  const lo = t0 ?? Date.parse(cand[0] + '-01T00:00:00Z') / 1000, hi = t1 ?? Date.parse(cand[cand.length - 1] + '-28T00:00:00Z') / 1000 + 4 * 86400;
  // per address bucket: yearly index files + monthly sorted copies (a few row groups each); else the sorted monthly copies; else the plain tables
  const parts: string[] = [];
  for (const b of new Set(hexes.map(h => h.slice(0, 2)))) {
    const ks = keyedSrc(ctx, 'hex', b, lo, hi) ?? L(ctx, 'by_hex', lo, hi);
    if (!ks) { parts.length = 0; break; }
    if (ks !== '(empty)') parts.push(`SELECT * FROM ${ks} WHERE hex IN (${hexes.filter(h => h.startsWith(b)).map(lit).join(',')})`);
  }
  if (parts.length) return { src: `(${parts.join(' UNION ALL ')})`, months };
  if (!parts.length && hexes.length && keyedSrc(ctx, 'hex', hexes[0].slice(0, 2), lo, hi) === '(empty)') return { src: `(SELECT * FROM ${T(ctx, 'legs', 0, 1)} WHERE false)`, months };
  return { src: `(SELECT * FROM read_parquet([${months.map(m => lit(url(ctx, f.legs.replace('{month}', m)))).join(',')}]) WHERE hex IN (${hexes.map(lit).join(',')}))`, months };
}

// Owner / operator of an aircraft from the registry table (OpenSky aircraft database); null when unknown or no table.
export async function registryOf(ctx: Ctx, hex: string) {
  try {
    const [r] = await ctx.query(`SELECT reg, type, manufacturer, model, owner, operator, operator_icao, operator_callsign, built FROM registry WHERE hex = ${lit(String(hex).toLowerCase())}`);
    return r ? { ...r, source: 'OpenSky Network aircraft database (snapshot Nov 2024)' } : null;
  } catch { return null; }
}

// "KDOV" (airport) or "IL" (country) -> SQL condition on one end of a leg
function endCond(side: 'from' | 'to', v: string) {
  const x = String(v).trim().toUpperCase();
  return x.length === 2 ? `${side}_country = ${lit(x)}` : `(${side}_code = ${lit(x)} OR ${side}_name ILIKE ${lit('%' + v.trim() + '%')})`;
}

// ---------- tools ----------
export const TOOLS: ToolDef[] = [
  {
    name: 'dataset_info',
    description: 'What the dataset covers: the exact list of days included (coverage is NOT continuous between first and last date), counts, sources and caveats. Call this first in a session; never treat an empty result for an uncovered day as "no flights".',
    input_schema: { type: 'object', properties: {} },
    async run(ctx) {
      const m = ctx.manifest;
      return { days_covered: dateRanges(m.dates, 40), n_days: m.dates.length, first_day: m.dates[0], last_day: m.dates[m.dates.length - 1], flights: m.legs, built_utc: m.built_utc, attribution: m.attribution,
        caveats: ['Only the listed days are in the data.',
          'Sovereign airspace = coastline + 12 nm (approximate), except Iceland (sov:ISL) = the official Coast Guard 12 nm line. FIRs mostly from a community dataset (approximate); Iceland BIRD is official.',
          '"observed" = receivers recorded the aircraft in the zone; "inferred" = path estimated across a coverage gap.',
          'Aircraft that do not broadcast positions are absent: absence of a flight is not evidence it did not happen.',
          'Operator names come from a registry and are often missing; do not guess the airline from the registration country.',
          'GPS-spoofed positions (e.g. fake Beirut/Amman fixes) are filtered, but leg ends marked probable/unrecorded are inferences.'],
        sql_notes: 'Times: epoch seconds (t0, t1, t_in, t_out) plus TIMESTAMP columns dep_utc, arr_utc, in_utc, out_utc (UTC). Countries are ISO2 (from_country, to_country).' };
    },
  },
  {
    name: 'list_zones',
    description: 'Find airspace zones by name, country or id. Zones are sovereign airspace (approximate: land + 12 nautical miles; Iceland official) for every country, and flight information regions (FIRs). Returns zone ids to use with other tools, e.g. "sov:ISL" (Iceland sovereign), "fir:BIRD" (Reykjavík FIR).',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Name, country, ISO3 code or FIR code' }, kind: { type: 'string', enum: ['sovereign', 'fir', 'cta', 'any'] } }, required: ['query'] },
    async run(ctx, a) {
      const q = String(a.query).toLowerCase();
      return ctx.zones.filter(z => (a.kind && a.kind !== 'any' ? z.kind === a.kind : true) &&
        (z.id.toLowerCase().includes(q) || z.name.toLowerCase().includes(q) || z.country.toLowerCase().includes(q) || z.iso.toLowerCase() === q))
        .slice(0, 25);
    },
  },
  {
    name: 'zone_overview',
    description: 'Overview of ALL flights that crossed a zone in a date range, with exact totals (no row cap): observed vs inferred, military share, aircraft, callsign prefixes (≈ operators), types, origins, destinations, and flights per day (per month for long periods). Filter by origin/destination country (ISO2) or either end, callsign prefixes (e.g. "ELY,CHG,ICL"), military, observed. Any period is fast (search index). Start here when focusing on a country; use flights_through_zone to list individual flights.',
    input_schema: { type: 'object', properties: {
      zone_id: { type: 'string' }, date_from: { type: 'string', description: 'YYYY-MM-DD' }, date_to: { type: 'string', description: 'YYYY-MM-DD' },
      origin_country: { type: 'string', description: 'ISO2, e.g. "US"' }, destination_country: { type: 'string', description: 'ISO2, e.g. "IL"' },
      either_end_country: { type: 'string', description: 'ISO2: flights starting OR ending there' },
      callsign_prefixes: { type: 'string', description: 'comma-separated, e.g. "ELY,CHG,ICL,RCH"' },
      observed_only: { type: 'boolean' }, inferred_only: { type: 'boolean' }, military_only: { type: 'boolean' } }, required: ['zone_id'] },
    async run(ctx, a) {
      const r = range(ctx, a);
      const iso = (v: unknown) => lit(String(v).trim().toUpperCase());
      const pref = String(a.callsign_prefixes ?? '').split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(x => /^[A-Z0-9]{2,4}$/.test(x));
      const where = `z.zone_id = ${lit(a.zone_id)} AND z.t_in >= ${r.t0} AND z.t_in < ${r.t1}` +
        (a.observed_only ? ` AND z.evidence = 'observed'` : '') + (a.inferred_only ? ` AND z.evidence = 'inferred'` : '') + (a.military_only ? ' AND l.mil = 1' : '') +
        (a.origin_country ? ` AND l.from_country = ${iso(a.origin_country)}` : '') + (a.destination_country ? ` AND l.to_country = ${iso(a.destination_country)}` : '') +
        (a.either_end_country ? ` AND (l.from_country = ${iso(a.either_end_country)} OR l.to_country = ${iso(a.either_end_country)})` : '') +
        (pref.length ? ` AND (${pref.map(p => `l.callsigns ILIKE ${lit(p + '%')} OR l.callsigns ILIKE ${lit('% ' + p + '%')}`).join(' OR ')})` : '');
      // a flight departs at most ~1 day before it enters a zone: bounding l.t0 lets the scan skip most of the legs files
      const tmp = `zo_${Math.random().toString(36).slice(2, 10)}`;
      // the airspace index (one small file per airspace and quarter) is faster than joining two monthly files, for any period
      const zIdx = indexSrc(ctx, 'zone', a.zone_id, r.t0 - 86400, r.t1);
      if (r.t1 - r.t0 > LONG && !zIdx) tooLong(r, 'an airspace overview');
      if (zIdx === '(empty)') await ctx.query(`CREATE TEMP TABLE ${tmp} AS SELECT z.evidence, z.t_in, l.* FROM ${T(ctx, 'leg_zones', 0, 1)} z, ${T(ctx, 'legs', 0, 1)} l WHERE false`);
      else if (zIdx) await ctx.query(`CREATE TEMP TABLE ${tmp} AS SELECT * FROM ${zIdx} l WHERE ${where.replaceAll('z.', 'l.')}`);
      else await ctx.query(`CREATE TEMP TABLE ${tmp} AS SELECT z.evidence, z.t_in, l.* FROM ${T(ctx, 'leg_zones', r.t0 - 86400, r.t1)} z JOIN ${T(ctx, 'legs', r.t0 - 86400, r.t1)} l USING (leg_id)
        WHERE ${where} AND l.t0 >= ${r.t0 - 86400} AND l.t0 < ${r.t1}`);
      const base = `FROM ${tmp} AS l WHERE true`;
      const top = (col: string, n = 10) => ctx.query(`SELECT ${col} AS value, count(*) AS flights ${base} AND ${col} IS NOT NULL AND ${col} <> '' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${n}`);
      const [tot] = await ctx.query(`SELECT count(*) AS flights, count(*) FILTER (WHERE l.evidence='observed') AS observed,
        count(*) FILTER (WHERE l.evidence='inferred') AS inferred, count(*) FILTER (WHERE l.mil=1) AS military,
        count(DISTINCT l.hex) AS aircraft ${base}`);
      const out = {
        zone: ctx.zones.find(z => z.id === a.zone_id), period: [r.from, r.to], days_covered_in_period: r.covered.length > 31 ? dateRanges(r.covered) : r.covered, totals: tot,
        receiver_coverage: await zoneCoverage(ctx, a.zone_id, r),
        top_operators: zIdx ? [] : await top('l.operator'), top_types: await top('l.type'),
        top_origins: await top(zIdx ? `l.from_code || ' (' || coalesce(l.from_country,'?') || ')'` : `l.from_name || ' (' || coalesce(l.from_country,'?') || ')'`),
        top_destinations: await top(zIdx ? `l.to_code || ' (' || coalesce(l.to_country,'?') || ')'` : `l.to_name || ' (' || coalesce(l.to_country,'?') || ')'`),
        top_origin_countries: await top('l.from_country'), top_destination_countries: await top('l.to_country'),
        top_callsign_prefixes: await top(`upper(left(l.callsigns, 3))`, 15),
        // per day for short periods; per month (observed / inferred) for long ones, which would otherwise be thousands of rows
        ...(r.t1 - r.t0 > LONG
          ? { by_month: await ctx.query(`SELECT strftime(make_timestamp(l.t_in * 1000000), '%Y-%m') AS month, count(*) AS flights,
                count(*) FILTER (WHERE l.evidence = 'observed') AS observed ${base} GROUP BY 1 ORDER BY 1`) }
          : { by_zone_entry_day: await ctx.query(`SELECT strftime(make_timestamp(l.t_in * 1000000), '%Y-%m-%d') AS day, count(*) AS flights ${base} GROUP BY 1 ORDER BY 1`) }),
        note: 'Sovereign zones are approximate (coastline + 12 nm; Iceland is the official 12 nm line). "inferred" = path estimated across a receiver coverage gap.',
      };
      await ctx.query(`DROP TABLE IF EXISTS ${tmp}`);
      return out;
    },
  },
  {
    name: 'zone_coverage',
    description: 'Receiver coverage of a zone per day: how many aircraft receivers saw inside it. Check this before concluding that flights did NOT happen: 0 aircraft on a day means no coverage there.',
    input_schema: { type: 'object', properties: { zone_id: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' } }, required: ['zone_id'] },
    async run(ctx, a) { const r = range(ctx, a); return { zone: a.zone_id, period: [r.from, r.to], ...(await zoneCoverage(ctx, a.zone_id, r)) }; },
  },
  {
    name: 'flights_through_zone',
    description: 'List flight legs that crossed a zone, with entry/exit times and evidence (observed by receivers vs inferred across a coverage gap). Filter by origin/destination country (ISO2, e.g. "IL", "US"), military, callsign prefix or registration prefix.',
    input_schema: { type: 'object', properties: {
      zone_id: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' }, observed_only: { type: 'boolean' },
      inferred_only: { type: 'boolean', description: 'only crossings estimated across a receiver gap (no position received inside the zone)' },
      military_only: { type: 'boolean' }, to_country: { type: 'string' }, from_country: { type: 'string' },
      either_end_country: { type: 'string', description: 'ISO2 country at either end of the leg' },
      callsign_prefix: { type: 'string' }, reg_prefix: { type: 'string' }, limit: { type: 'integer' } }, required: ['zone_id'] },
    async run(ctx, a) {
      const r = range(ctx, a);
      const w = [`z.zone_id = ${lit(a.zone_id)}`, `z.t_in >= ${r.t0}`, `z.t_in < ${r.t1}`];
      if (a.observed_only) w.push(`z.evidence = 'observed'`);
      if (a.inferred_only) w.push(`z.evidence = 'inferred'`);
      if (a.military_only) w.push('l.mil = 1');
      if (a.to_country) w.push(`l.to_country = ${lit(String(a.to_country).toUpperCase())}`);
      if (a.from_country) w.push(`l.from_country = ${lit(String(a.from_country).toUpperCase())}`);
      if (a.either_end_country) { const c = lit(String(a.either_end_country).toUpperCase()); w.push(`(l.to_country = ${c} OR l.from_country = ${c})`); }
      if (a.callsign_prefix) w.push(`list_has_any(string_split(l.callsigns, ' '), [${lit(a.callsign_prefix)}]) OR l.callsigns ILIKE ${lit(a.callsign_prefix + '%')} OR l.callsigns ILIKE ${lit('% ' + a.callsign_prefix + '%')}`);
      if (a.reg_prefix) w.push(`l.reg ILIKE ${lit(a.reg_prefix + '%')}`);
      const zIdx = indexSrc(ctx, 'zone', a.zone_id, r.t0 - 86400, r.t1);
      if (r.t1 - r.t0 > LONG && !zIdx) tooLong(r, 'an airspace flight list');
      if (zIdx === '(empty)') return [];
      if (zIdx) {
        const rows = await ctx.query(`SELECT * EXCLUDE (zone_id) FROM ${zIdx} l WHERE ${w.map(x => `(${x.replaceAll('z.', 'l.')})`).join(' AND ')} ORDER BY l.t_in, l.leg_id LIMIT ${Math.min(num(a.limit, 200), 5000)}`);
        return rows.map(x => ({ ...shapeLeg(x), zone_in_utc: fmtTime(Number(x.t_in)), zone_out_utc: fmtTime(Number(x.t_out)) }));
      }
      const rows = await ctx.query(`SELECT ${LEG_COLS.split(',').map(c => 'l.' + c.trim()).join(', ')}, z.evidence, z.t_in, z.t_out, z.n_obs
        FROM ${T(ctx, 'leg_zones', r.t0 - 86400, r.t1)} z JOIN ${T(ctx, 'legs', r.t0 - 86400, r.t1)} l USING (leg_id) WHERE ${w.map(x => `(${x})`).join(' AND ')} AND l.t0 >= ${r.t0 - 86400} AND l.t0 < ${r.t1} ORDER BY z.t_in, l.leg_id LIMIT ${Math.min(num(a.limit, 200), 2000)}`);
      return rows.map(x => ({ ...shapeLeg(x), zone_in_utc: fmtTime(Number(x.t_in)), zone_out_utc: fmtTime(Number(x.t_out)) }));
    },
  },
  {
    name: 'search_flights',
    description: 'Search flight legs by callsign, registration, ICAO hex, operator, or airport code/name (origin or destination).',
    input_schema: { type: 'object', properties: { text: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' }, limit: { type: 'integer' } }, required: ['text'] },
    async run(ctx, a) {
      const r = range(ctx, a);
      if (r.t1 - r.t0 > LONG && ctx.manifest.months?.length) tooLong(r, 'a free-text search');
      const t = String(a.text).trim();
      const like = lit('%' + t + '%');
      const rows = await ctx.query(`SELECT ${LEG_COLS} FROM ${T(ctx, 'legs', r.t0, r.t1)} WHERE t0 >= ${r.t0} AND t0 < ${r.t1} AND (
        callsigns ILIKE ${like} OR reg ILIKE ${like} OR hex = ${lit(t.toLowerCase())} OR operator ILIKE ${like}
        OR from_code ILIKE ${lit(t)} OR to_code ILIKE ${lit(t)} OR from_name ILIKE ${like} OR to_name ILIKE ${like})
        ORDER BY t0 LIMIT ${Math.min(num(a.limit, 200), 2000)}`);
      return rows.map(shapeLeg);
    },
  },
  {
    name: 'flight_dossier',
    description: 'Everything known about one flight leg: route and certainty of each end, aircraft, callsigns, every zone crossed (with observed/inferred evidence and times), the same aircraft\'s neighbouring legs, and the data sources behind it.',
    input_schema: { type: 'object', properties: { leg_id: { type: 'string' } }, required: ['leg_id'] },
    run: (ctx, a) => flightDossier(ctx, String(a.leg_id)),
  },
  {
    name: 'get_track',
    description: 'Positions (1-minute resolution) of a flight leg: time, lat, lon, altitude in feet (-1 = on ground). Gaps longer than 20 minutes are receiver coverage gaps. Use for mapping or checking exactly where a flight went.',
    input_schema: { type: 'object', properties: { leg_id: { type: 'string' }, max_points: { type: 'integer' } }, required: ['leg_id'] },
    async run(ctx, a) {
      const [leg] = await ctx.query(`SELECT hex, t0, t1, days, date FROM ${T(ctx, 'legs', idT0(a.leg_id) - 1, idT0(a.leg_id) + 1)} WHERE ${byLegId(a.leg_id)}`);
      if (!leg) throw new Error('unknown leg_id');
      const days = String(leg.days || leg.date).split(' ');
      const src = dayFiles(ctx, 'positions', days[0], days[days.length - 1]);
      if (!src) return { points: [] };
      const pts = await ctx.query(`SELECT t, lat, lon, alt FROM ${src} WHERE hex = ${lit(leg.hex)} AND t BETWEEN ${Number(leg.t0) - 900} AND ${Number(leg.t1) + 900} ORDER BY t`);
      const maxp = num(a.max_points, 5000), step = Math.max(1, Math.ceil(pts.length / maxp));
      const gaps = [];
      for (let i = 1; i < pts.length; i++) if (Number(pts[i].t) - Number(pts[i - 1].t) > 1200)
        gaps.push({ from_utc: fmtTime(Number(pts[i - 1].t)), to_utc: fmtTime(Number(pts[i].t)), minutes: Math.round((Number(pts[i].t) - Number(pts[i - 1].t)) / 60) });
      return { hex: leg.hex, points: pts.filter((_, i) => i % step === 0 || i === pts.length - 1), coverage_gaps: gaps };
    },
  },
  {
    name: 'aircraft_history',
    description: 'All flight legs of one aircraft (by registration like "4X-ICA" or ICAO hex like "738c06") in a date range.',
    input_schema: { type: 'object', properties: { aircraft: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' } }, required: ['aircraft'] },
    async run(ctx, a) {
      const r = range(ctx, a), q = String(a.aircraft).trim();
      const { src } = await aircraftLegsSource(ctx, q, r.t0, r.t1);
      const rows = await ctx.query(`SELECT ${LEG_COLS} FROM ${src} WHERE (reg ILIKE ${lit(q)} OR hex = ${lit(q.toLowerCase())}) AND t0 >= ${r.t0} AND t0 < ${r.t1} ORDER BY t0 LIMIT 1000`);
      return rows.map(shapeLeg);
    },
  },
  {
    name: 'airport_movements',
    description: 'Departures and/or arrivals at an airport or air base (ICAO code like "KDOV", or part of the name like "Dover", "Nevatim") in a date range (default: the user\'s selected period, else the last 30 days). Returns the total count and the newest flights. Arrivals include probable ones where coverage was lost while descending.',
    input_schema: { type: 'object', properties: { airport: { type: 'string' }, direction: { type: 'string', enum: ['departures', 'arrivals', 'both'] }, date_from: { type: 'string' }, date_to: { type: 'string' }, limit: { type: 'integer' } }, required: ['airport'] },
    async run(ctx, a) {
      const r = range(ctx, a), q = String(a.airport).trim(), dir = a.direction || 'both';
      const m = (p: string) => `(${p}_code ILIKE ${lit(q)} OR ${p}_name ILIKE ${lit('%' + q + '%')})`;
      const cond = dir === 'departures' ? m('from') : dir === 'arrivals' ? m('to') : `(${m('from')} OR ${m('to')})`;
      const lim = Math.min(num(a.limit, 300), 5000);
      // long periods: read the country index files (departures: index/from/<country>, arrivals: index/to/<country>)
      let src = T(ctx, 'legs', r.t0, r.t1), where = cond;
      const byAp = /^[A-Z0-9]{3,4}$/i.test(q) ? (keyedSrc(ctx, 'airport', q.slice(0, 2), r.t0, r.t1) ?? L(ctx, 'by_airport', r.t0, r.t1)) : null;
      if (byAp === '(empty)') { src = `(SELECT ${LEG_COLS} FROM ${T(ctx, 'legs', 0, 1)} WHERE false)`; where = 'true'; }
      else if (byAp) {   // sorted by airport: reads only that airport's row groups, any period
        const roles = dir === 'departures' ? `'dep'` : dir === 'arrivals' ? `'arr'` : `'dep','arr'`;
        src = `(SELECT DISTINCT ON (leg_id) ${LEG_COLS} FROM ${byAp} WHERE code = ${lit(q.toUpperCase())} AND role IN (${roles}))`; where = 'true';
      } else if (r.t1 - r.t0 > LONG && /^[A-Z0-9]{3,4}$/i.test(q)) {
        const [ap] = await ctx.query(`SELECT country FROM airports WHERE ident = ${lit(q.toUpperCase())} LIMIT 1`).catch(() => []);
        const c = ap?.country ? String(ap.country) : '';
        const f = c && dir !== 'arrivals' ? indexSrc(ctx, 'from', c, r.t0, r.t1) : null, t = c && dir !== 'departures' ? indexSrc(ctx, 'to', c, r.t0, r.t1) : null;
        const ok = (x: string | null) => x && !x.startsWith('(empty)');
        if ((dir === 'departures' && f) || (dir === 'arrivals' && t) || (dir === 'both' && f && t))
          src = dir === 'both' ? `(${[f, t].filter(ok).map(x => `SELECT ${LEG_COLS} FROM ${x}`).join(' UNION ')})` : (ok(f ?? t) ? (f ?? t)! : `(SELECT ${LEG_COLS} FROM ${T(ctx, 'legs', 0, 1)} WHERE false)`);
      }
      // read the matching flights once (a list and a count would read the files twice)
      const tmp = `am_${Math.random().toString(36).slice(2, 10)}`;
      await ctx.query(`CREATE TEMP TABLE ${tmp} AS SELECT ${LEG_COLS} FROM ${src} WHERE ${where} AND t0 >= ${r.t0} AND t0 < ${r.t1}`);
      const rows = await ctx.query(`SELECT * FROM ${tmp} ORDER BY t0 DESC LIMIT ${lim}`);
      const [n] = await ctx.query(`SELECT count(*) AS n FROM ${tmp}`);
      await ctx.query(`DROP TABLE IF EXISTS ${tmp}`);
      return { period: [r.from, r.to], total: Number(n.n), shown: rows.length, flights: rows.map(shapeLeg),
        note: rows.length < Number(n.n) ? `Newest ${rows.length} of ${n.n} shown; total covers the whole period.` : undefined };
    },
  },
  {
    name: 'flights_through_area',
    description: 'Flight legs that passed through an arbitrary area, given as a polygon ring of [lon, lat] pairs (or a bounding box [west, south, east, north]). Uses a coarse H3 index (cells ~60 km across), so results can include flights passing just outside the area; check with get_track when it matters.',
    input_schema: { type: 'object', properties: {
      polygon: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, bbox: { type: 'array', items: { type: 'number' } },
      date_from: { type: 'string' }, date_to: { type: 'string' }, limit: { type: 'integer' } } },
    async run(ctx, a) {
      const r = range(ctx, a);
      let ring: [number, number][] = a.polygon;
      if (!ring && a.bbox) { const [w, s, e, n] = a.bbox; ring = [[w, s], [e, s], [e, n], [w, n], [w, s]]; }
      if (!ring) throw new Error('give polygon or bbox');
      const cells = ctx.cellsForPolygon(ring, ctx.manifest.h3_resolution);
      if (!cells.length) return [];
      if (cells.length > 4000) throw new Error(`area too large (${cells.length} index cells); draw a smaller area`);
      const src = dayFiles(ctx, 'h3', r.from, r.to);
      if (!src) return [];
      const rows = await ctx.query(`WITH hits AS (SELECT hex, min(hour) AS h0, max(hour) AS h1 FROM ${src} WHERE cell IN (${cells.map(lit).join(',')}) GROUP BY hex, hour)
        SELECT DISTINCT ${LEG_COLS.split(',').map(c => 'l.' + c.trim()).join(', ')} FROM hits JOIN ${T(ctx, 'legs', r.t0 - 86400, r.t1)} l ON l.hex = hits.hex
        AND l.t0 < (hits.h1 + 1) * 3600 AND l.t1 >= hits.h0 * 3600 WHERE l.t0 >= ${r.t0 - 86400} AND l.t0 < ${r.t1}
        ORDER BY l.t0 LIMIT ${Math.min(num(a.limit, 300), 3000)}`);
      return rows.map(shapeLeg);
    },
  },
  {
    name: 'aircraft_profile',
    description: 'Profile of one aircraft (registration like "4X-ICA" or ICAO hex like "738c06") across the whole dataset (or a date range): first/last seen, number of flights, most frequent routes, countries and military airfields visited, callsigns used, operator/type, flights per month, and how certain the ends are. The starting point for investigating any aircraft or operator pattern.',
    input_schema: { type: 'object', properties: { aircraft: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' } }, required: ['aircraft'] },
    async run(ctx, a) {
      const q = String(a.aircraft).trim();
      const ds = ctx.manifest.dates;
      const r = range(ctx, { date_from: a.date_from || ds[0], date_to: a.date_to || ds[ds.length - 1] });
      const { src, months } = await aircraftLegsSource(ctx, q, r.t0, r.t1);
      const tmp = `ap_${Math.random().toString(36).slice(2, 10)}`;
      await ctx.query(`CREATE TEMP TABLE ${tmp} AS SELECT * FROM ${src} WHERE (reg ILIKE ${lit(q)} OR hex = ${lit(q.toLowerCase())}) AND t0 >= ${r.t0} AND t0 < ${r.t1}`);
      try {
        const [tot] = await ctx.query(`SELECT count(*) AS flights, min(date) AS first_seen, max(date) AS last_seen, count(DISTINCT date) AS active_days,
          any_value(reg) AS reg, any_value(hex) AS hex, any_value(type) AS type, any_value(operator) AS operator, max(mil) AS military_flag FROM ${tmp}`);
        if (!Number(tot.flights)) return { aircraft: q, flights: 0, months_searched: months, note: 'Not found in the flight database for this period. Try opensky_aircraft_flights or check the registration/hex.' };
        // the aircraft description lives in the small per-month aircraft files (the sorted flight copies leave it out)
        const af = (months ?? []).slice(-3).map(m => lit(url(ctx, ctx.manifest.files.aircraft.replace('{month}', m))));
        if (af.length) { const [d] = await ctx.query(`SELECT any_value("desc") AS d FROM read_parquet([${af.join(',')}]) WHERE hex = ${lit(String(tot.hex))}`).catch(() => [{ d: null }]); tot.aircraft = d?.d ?? null; }
        const end = (p: string) => `coalesce(${p}_code, CASE WHEN ${p}_cert = 'unknown' THEN '(coverage gap)' ELSE '?' END)`;
        return {
          aircraft: tot, registry: await registryOf(ctx, String(tot.hex)), period: [r.from, r.to],
          top_routes: await ctx.query(`SELECT ${end('from')} || ' -> ' || ${end('to')} AS route, count(*) AS flights, min(date) AS first, max(date) AS last FROM ${tmp} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`),
          countries: await ctx.query(`SELECT c AS country, count(*) AS flight_ends FROM (SELECT from_country AS c FROM ${tmp} UNION ALL SELECT to_country FROM ${tmp}) WHERE c IS NOT NULL AND c <> '' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 20`),
          military_airfields: await ctx.query(`SELECT code, name, count(*) AS visits FROM (SELECT from_code AS code, from_name AS name FROM ${tmp} WHERE from_mil = 1 UNION ALL SELECT to_code, to_name FROM ${tmp} WHERE to_mil = 1) GROUP BY 1, 2 ORDER BY 3 DESC, 1 LIMIT 15`),
          callsigns: await ctx.query(`SELECT cs AS callsign, count(*) AS flights FROM (SELECT unnest(string_split(callsigns, ' ')) AS cs FROM ${tmp}) WHERE cs <> '' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`),
          flights_per_month: await ctx.query(`SELECT left(date, 7) AS month, count(*) AS flights FROM ${tmp} GROUP BY 1 ORDER BY 1`),
          end_certainty: await ctx.query(`SELECT to_cert AS certainty, count(*) AS flights FROM ${tmp} GROUP BY 1 ORDER BY 2 DESC`),
          note: 'Use aircraft_history for the individual flights, route_search to see who else flies the same routes, export_flight_crosscheck for trade data in the active months, us_contracts for the owner/operator (US military airlift contracts), aircraft_registry for the operator\'s other aircraft.',
        };
      } finally { await ctx.query(`DROP TABLE IF EXISTS ${tmp}`); }
    },
  },
  {
    name: 'aircraft_registry',
    description: 'Look up owners and operators in the aircraft registry (OpenSky Network aircraft database, snapshot Nov 2024: owner for ~84% of aircraft). Give an aircraft (registration or ICAO hex) to get its owner/operator, or a company name (owner or operator, partial match) to list all its aircraft, e.g. to then check their flights with aircraft_profile.',
    input_schema: { type: 'object', properties: { aircraft: { type: 'string' }, company: { type: 'string' }, limit: { type: 'integer' } } },
    async run(ctx, a) {
      if (a.aircraft) {
        const q = String(a.aircraft).trim();
        const rows = await ctx.query(`SELECT * FROM registry WHERE hex = ${lit(q.toLowerCase())} OR reg ILIKE ${lit(q)} LIMIT 5`);
        return { query: q, aircraft: rows, note: rows.length ? 'Registry data can be outdated (Nov 2024 snapshot); owner is often a lessor, operator the airline.' : 'Not in the registry snapshot.' };
      }
      if (!a.company) throw new Error('give aircraft or company');
      const c = lit('%' + String(a.company).trim() + '%');
      const rows = await ctx.query(`SELECT hex, reg, type, model, owner, operator, operator_icao, built FROM registry
        WHERE owner ILIKE ${c} OR operator ILIKE ${c} OR operator_callsign ILIKE ${c} OR operator_icao = ${lit(String(a.company).trim().toUpperCase())}
        ORDER BY type, reg LIMIT ${Math.min(num(a.limit, 200), 1000)}`);
      return { company: a.company, aircraft_count: rows.length, aircraft: rows, source: 'OpenSky Network aircraft database (snapshot Nov 2024)' };
    },
  },
  {
    name: 'find_flights',
    description: `The main search: flights matching any combination of origin, destination, airspace crossed, aircraft, airline/company, callsign and period, with an overview (totals, flights per month, top routes, aircraft and companies) and the matching flights. origin/destination: airport ICAO code (e.g. "KDOV"), airport name, or ISO2 country (e.g. "US", "IL"); both_directions matches either way. through_zone: "sov:ISO3" or "fir:CODE". company: owner/operator name (via the aircraft registry) or a 3-letter airline code (e.g. "ELY"). Periods longer than a few months read many monthly files and can be slow: prefer a period.`,
    input_schema: { type: 'object', properties: {
      origin: { type: 'string' }, destination: { type: 'string' }, both_directions: { type: 'boolean' }, through_zone: { type: 'string' },
      aircraft: { type: 'string', description: 'registration (4X-ICA) or ICAO hex (738c06)' }, company: { type: 'string' }, callsign: { type: 'string' },
      date_from: { type: 'string' }, date_to: { type: 'string' }, military_only: { type: 'boolean' }, observed_only: { type: 'boolean' }, limit: { type: 'integer' } } },
    async run(ctx, a) {
      const r = range(ctx, a);
      const w: string[] = [`l.t0 >= ${r.t0 - (a.through_zone ? 86400 : 0)}`, `l.t0 < ${r.t1}`];
      const end = (side: 'from' | 'to', v: string) => endCond(side, v).replace(new RegExp(`\\b${side}_`, 'g'), `l.${side}_`);
      if (a.origin || a.destination) {
        const fwd = [a.origin && end('from', a.origin), a.destination && end('to', a.destination)].filter(Boolean).join(' AND ');
        const rev = [a.origin && end('to', a.origin), a.destination && end('from', a.destination)].filter(Boolean).join(' AND ');
        w.push(a.both_directions ? `((${fwd}) OR (${rev}))` : `(${fwd})`);
      }
      if (a.aircraft) { const q = String(a.aircraft).trim(); w.push(`(l.reg ILIKE ${lit(q)} OR l.hex = ${lit(q.toLowerCase())})`); }
      if (a.callsign) { const c = String(a.callsign).trim().toUpperCase(); w.push(`(l.callsigns ILIKE ${lit(c + '%')} OR l.callsigns ILIKE ${lit('% ' + c + '%')})`); }
      let companyNote: string | undefined;
      if (a.company) {
        const c = String(a.company).trim();
        const conds = [];
        if (/^[A-Za-z]{3}$/.test(c)) conds.push(`l.callsigns ILIKE ${lit(c.toUpperCase() + '%')} OR l.callsigns ILIKE ${lit('% ' + c.toUpperCase() + '%')}`);
        let hexes: string[] = [];
        try {
          // exact company name first (autocomplete passes one); partial match only when nothing matches exactly
          hexes = (await ctx.query(`SELECT hex FROM registry WHERE lower(owner) = lower(${lit(c)}) OR lower(operator) = lower(${lit(c)}) OR operator_icao = ${lit(c.toUpperCase())} LIMIT 3000`)).map(x => String(x.hex));
          if (!hexes.length) hexes = (await ctx.query(`SELECT hex FROM registry WHERE owner ILIKE ${lit('%' + c + '%')} OR operator ILIKE ${lit('%' + c + '%')} LIMIT 3000`)).map(x => String(x.hex));
        } catch { /* no registry table */ }
        if (hexes.length) conds.push(`l.hex IN (${hexes.map(lit).join(',')})`);
        conds.push(`l.operator ILIKE ${lit('%' + c + '%')}`);
        companyNote = `${hexes.length} aircraft of "${c}" in the registry${/^[A-Za-z]{3}$/.test(c) ? ', plus callsigns starting with ' + c.toUpperCase() : ''}`;
        w.push(`(${conds.join(' OR ')})`);
      }
      if (a.military_only) w.push('(l.mil = 1 OR l.from_mil = 1 OR l.to_mil = 1)');
      const zone = a.through_zone ? String(a.through_zone) : '';
      const long = r.t1 - r.t0 > LONG;
      const zIdx = zone ? indexSrc(ctx, 'zone', zone, r.t0 - 86400, r.t1) : null;
      // route index: by destination country if known (usually the smaller set), else by origin country
      let rIdx: string | null = null;
      if (!zone && long && !a.both_directions) {
        const country = async (v: unknown) => {
          const x = String(v ?? '').trim().toUpperCase();
          if (x.length === 2) return x;
          if (!x) return '';
          const [ap] = await ctx.query(`SELECT country FROM airports WHERE ident = ${lit(x)} LIMIT 1`).catch(() => []);
          return ap?.country ? String(ap.country) : '';
        };
        const tc = await country(a.destination), fc = await country(a.origin);
        rIdx = tc ? indexSrc(ctx, 'to', tc, r.t0, r.t1) : fc ? indexSrc(ctx, 'from', fc, r.t0, r.t1) : null;
      }
      let from: string, sel: string;
      if (zIdx) {           // one table: crossing + flight columns, sorted by airspace
        from = `${zIdx} l`; sel = 'l.*';
        w.push(`l.zone_id = ${lit(zone)}`, `l.t_in >= ${r.t0}`, `l.t_in < ${r.t1}`); if (a.observed_only) w.push(`l.evidence = 'observed'`);
      } else if (zone) {
        from = `${T(ctx, 'leg_zones', r.t0 - 86400, r.t1)} z JOIN ${T(ctx, 'legs', r.t0 - 86400, r.t1)} l USING (leg_id)`; sel = 'l.*, z.evidence, z.t_in, z.t_out';
        w.push(`z.zone_id = ${lit(zone)}`, `z.t_in >= ${r.t0}`, `z.t_in < ${r.t1}`); if (a.observed_only) w.push(`z.evidence = 'observed'`);
      } else {
        from = `${rIdx ?? T(ctx, 'legs', r.t0, r.t1)} l`; sel = 'l.*';
      }
      // the airspace index omits a few rarely used columns (names, operator, airfield flags)
      if (zIdx) for (let i = 0; i < w.length; i++) w[i] = w[i].replace(' OR l.from_mil = 1 OR l.to_mil = 1', '').replace(/ OR l\.operator ILIKE '[^']*'/, '');
      const tmp = `ff_${Math.random().toString(36).slice(2, 10)}`;
      if (from.startsWith('(empty)'))   // the index says: no flights for this country / airspace in the period
        return { period: [r.from, r.to], days_in_data: r.covered.length, totals: { flights: 0, aircraft: 0, military_aircraft: 0 }, used_index: zIdx ? 'airspace' : 'routes',
          per_month: [], top_routes: [], top_aircraft: [], top_companies: [], top_destination_countries: [], top_origin_countries: [], flights: [], note: 'No flights match.' };
      await ctx.query(`CREATE TEMP TABLE ${tmp} AS SELECT ${sel} FROM ${from} WHERE ${w.join(' AND ')}`);
      try {
        const [tot] = await ctx.query(`SELECT count(*) AS flights, count(DISTINCT hex) AS aircraft, count(*) FILTER (WHERE mil = 1) AS military_aircraft,
          ${zone ? `count(*) FILTER (WHERE evidence = 'observed') AS observed, count(*) FILTER (WHERE evidence = 'inferred') AS inferred,` : ''}
          min(date) AS first, max(date) AS last FROM ${tmp}`);
        const top = (expr: string, n = 8, extra = '') => ctx.query(`SELECT ${expr} AS value, count(*) AS flights ${extra} FROM ${tmp} WHERE ${expr} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${n}`);
        let companies: Row[] = [];
        try {
          companies = await ctx.query(`SELECT coalesce(g.operator, g.owner) AS value, count(*) AS flights FROM ${tmp} t JOIN registry g ON g.hex = t.hex
            WHERE coalesce(g.operator, g.owner) IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`);
        } catch { /* no registry */ }
        const rows = await ctx.query(`SELECT *${zIdx ? ' EXCLUDE (zone_id)' : ''} FROM ${tmp} ORDER BY t0 DESC LIMIT ${Math.min(num(a.limit, 2000), 5000)}`);
        return {
          period: [r.from, r.to], days_in_data: r.covered.length, totals: tot, company_match: companyNote, used_index: zIdx ? 'airspace' : rIdx ? 'routes' : 'none',
          per_month: await ctx.query(`SELECT left(date, 7) AS month, count(*) AS flights FROM ${tmp} GROUP BY 1 ORDER BY 1`),
          top_routes: await top(`coalesce(from_code, '?') || ' → ' || coalesce(to_code, '?')`),
          top_aircraft: await top(`reg`, 8, `, any_value(type) AS type, any_value(hex) AS hex`),
          top_companies: companies,
          top_destination_countries: await top('to_country', 8), top_origin_countries: await top('from_country', 8),
          flights: rows.map(x => ({ ...shapeLeg(x), ...(zone ? { zone_in_utc: fmtTime(Number(x.t_in)), zone_out_utc: fmtTime(Number(x.t_out)) } : {}) })),
          note: `Newest first; at most ${Math.min(num(a.limit, 2000), 5000)} flights listed, totals cover all matches.`,
        };
      } finally { await ctx.query(`DROP TABLE IF EXISTS ${tmp}`); }
    },
  },
  {
    name: 'route_search',
    description: 'Flights between an origin and a destination. Each end is an airport ICAO code (e.g. "KDOV"), part of an airport name, or an ISO2 country code (e.g. "US", "IL", "DE"); either end may be omitted. Includes uncertain ends ("probable", "unrecorded stop") unless recorded_only. Use to find who serves a route, rotations of the same aircraft, and transit routes via third countries.',
    input_schema: { type: 'object', properties: {
      origin: { type: 'string' }, destination: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' },
      military_only: { type: 'boolean' }, recorded_only: { type: 'boolean' }, limit: { type: 'integer' } } },
    async run(ctx, a) {
      if (!a.origin && !a.destination) throw new Error('give origin and/or destination');
      const r = range(ctx, a);
      const w = [`t0 >= ${r.t0}`, `t0 < ${r.t1}`];
      if (a.origin) w.push(endCond('from', a.origin));
      if (a.destination) w.push(endCond('to', a.destination));
      if (a.military_only) w.push('(mil = 1 OR from_mil = 1 OR to_mil = 1)');
      if (a.recorded_only) w.push(`from_cert = 'recorded' AND to_cert = 'recorded'`);
      let src = T(ctx, 'legs', r.t0, r.t1);
      if (r.t1 - r.t0 > LONG) {   // long periods: the destination (else origin) country's index files, or fail fast
        const country = async (v: unknown) => {
          const x = String(v ?? '').trim().toUpperCase();
          if (!x || x.length === 2) return x;
          const [ap] = await ctx.query(`SELECT country FROM airports WHERE ident = ${lit(x)} LIMIT 1`).catch(() => []);
          return ap?.country ? String(ap.country) : '';
        };
        const tc = await country(a.destination), fc = await country(a.origin);
        const idx = tc ? indexSrc(ctx, 'to', tc, r.t0, r.t1) : fc ? indexSrc(ctx, 'from', fc, r.t0, r.t1) : null;
        if (!idx) tooLong(r, 'a route search');
        if (idx === '(empty)') return [];
        src = idx;
      }
      const rows = await ctx.query(`SELECT ${LEG_COLS} FROM ${src} WHERE ${w.join(' AND ')} ORDER BY t0 LIMIT ${Math.min(num(a.limit, 500), 5000)}`);
      return rows.map(shapeLeg);
    },
  },
  {
    name: 'run_sql',
    description: 'LAST RESORT. Use flights_through_zone / zone_overview (observed_only, inferred_only, military_only), route_search, airport_movements or aircraft_profile first: they are indexed and fast; this scans whole month files and is stopped after 40 s. Read-only SQL (DuckDB dialect), as a standalone tool (it is not available inside any code/Python sandbox). Views: legs (dep_utc, arr_utc TIMESTAMP UTC; t0/t1 epoch s), leg_zones (in_utc, out_utc), aircraft, airports, coverage (zone_id, date, aircraft, hours; receiver coverage per zone and day), registry (hex, reg, owner, operator, operator_icao; OpenSky aircraft database). legs columns: leg_id, hex, reg, type, operator, mil, callsigns (space-separated), date, t0, t1, from_code, from_name, from_country, from_cert, from_mil, to_code, to_name, to_country, to_cert, to_mil, days. leg_zones columns: zone_id, leg_id, hex, t_in, t_out, n_obs, n_inf, evidence. Prefer the dedicated tools; use this only for what they cannot express. The views read every month in the browser: keep queries to ~2 months (a t0/date condition) or they are stopped after 40 s; airspace or route questions over long periods belong to flights_through_zone, zone_overview and route_search (index-backed, seconds for any period). Avoid reserved words as aliases (e.g. first, last). Results are capped at 500 rows.',
    input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    async run(ctx, a) {
      await ensureAllViews(ctx);   // all-month views are created on first use (slow to bind)
      const sql = String(a.sql).trim().replace(/;+\s*$/, '');
      if (!/^(select|with)\b/i.test(sql) || /;|\b(insert|update|delete|create|drop|alter|copy|attach|install|load|pragma|set|export)\b/i.test(sql))
        throw new Error('only a single read-only SELECT/WITH statement is allowed');
      try {
        return await (ctx.queryWithin ? ctx.queryWithin(`SELECT * FROM (${sql}) LIMIT 500`, 40_000) : ctx.query(`SELECT * FROM (${sql}) LIMIT 500`));
      } catch (e) {
        if ((e as Error)?.name !== 'QueryTimeout') throw e;
        throw new Error('This SQL scanned too much of the archive and was stopped after 40 s (the legs/leg_zones views hold every month, '
          + '120+ million flights, read in the browser). Use the index-backed tools instead, which answer any period in seconds: '
          + 'flights_through_zone / zone_overview (an airspace, any period, filter by origin/destination country), route_search '
          + '(country or airport to country or airport), airport_movements, aircraft_history. If SQL is really needed, restrict it '
          + 'to at most ~2 months with a t0 or date condition.');
      }
    },
  },
];

export const toolByName = (n: string) => TOOLS.find(t => t.name === n);
// MCP / Anthropic tool schemas (without the run functions)
export const toolSchemas = () => TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
