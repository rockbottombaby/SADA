// External public-data sources as tools (bring-your-own keys). Shared by the browser chat and the MCP server.
// Keys come from ctx.keys(): browser settings (localStorage) or the MCP server's environment.
// Keys are never put into tool results; cited URLs are rebuilt without them.
import type { Ctx, ToolDef } from './tools';
import { lit, coverage, T, L, keyedSrc } from './tools';

export interface SourceKeys { census?: string; openskyId?: string; openskySecret?: string; openskyBase?: string; proxyBase?: string }
const keys = (ctx: Ctx): SourceKeys => ctx.keys?.() ?? {};

// ---------- US Census Bureau, International Trade API ----------
const CENSUS = 'https://api.census.gov/data/timeseries/intltrade/exports';
const MONTH = /^\d{4}-\d\d$/;

async function census(path: 'hs' | 'porths', params: Record<string, string>, key: string) {
  const q = new URLSearchParams({ ...params, key });
  const r = await fetch(`${CENSUS}/${path}?${q}`);
  if (r.status === 204) return [];                        // no rows for this filter
  if (!r.ok) throw new Error(`Census API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows: string[][] = await r.json();
  return rows.slice(1).map(v => Object.fromEntries(rows[0].map((h, i) => [h, v[i]])));
}

// Census filters by country NAME stopped matching (Oct 2026); filtering by Census country CODE works. Resolve names via
// Census's own country list once per session (e.g. ISRAEL -> 5081).
let ctyCodes: Promise<Map<string, string>> | null = null;
async function countryCode(name: string, key: string) {
  if (/^\d{4}$/.test(name)) return name;
  ctyCodes ??= census('hs', { get: 'CTY_CODE,CTY_NAME,ALL_VAL_MO', time: '2025-06' }, key)
    .then(rows => new Map(rows.map((r: any) => [String(r.CTY_NAME).toUpperCase(), String(r.CTY_CODE)])))
    .catch(e => { ctyCodes = null; throw e; });
  const m = await ctyCodes, n = name.toUpperCase().trim();
  const code = m.get(n) ?? [...m.entries()].find(([k]) => k.startsWith(n) || k.includes(n))?.[1];
  if (!code) throw new Error(`Unknown Census country "${name}". Use the Census spelling, e.g. ISRAEL, UKRAINE, UNITED ARAB EMIRATES, or the 4-digit Census code.`);
  return code;
}

// ---------- OpenSky Network REST API ----------
let osToken: { v: string; exp: number } | null = null;
async function opensky(ctx: Ctx, path: string, params: Record<string, string | number>) {
  const k = keys(ctx);
  if (!k.openskyId || !k.openskySecret) throw new Error('No OpenSky API client configured. Add the OpenSky client id and secret in Settings (free account at opensky-network.org).');
  if (!osToken || Date.now() > osToken.exp) {
    // through the proxy when there is one (the token endpoint may also refuse other browser origins)
    const authUrl = k.openskyBase ? k.openskyBase.replace(/\/opensky\/?$/, '/opensky-auth') : 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
    const r = await fetch(authUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: k.openskyId, client_secret: k.openskySecret }),
    });
    if (!r.ok) throw new Error(`OpenSky login failed (${r.status}). Check the client id and secret.`);
    const j = await r.json();
    osToken = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  }
  const base = (k.openskyBase || 'https://opensky-network.org/api').replace(/\/$/, '');
  const q = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([a, b]) => [a, String(b)])));
  let r: Response;
  try { r = await fetch(`${base}${path}?${q}`, { headers: { Authorization: `Bearer ${osToken.v}` } }); }
  catch (e) {
    throw new Error(`OpenSky could not be reached (${String(e)}). OpenSky blocks direct browser requests; check the live-data proxy URL under Settings → Advanced, or use the MCP server.`);
  }
  if (r.status === 404) return [];                         // OpenSky: no flights in this interval
  if (r.status === 429) throw new Error('OpenSky daily credit limit reached (4000 credits/day). Try again tomorrow or use a shorter interval.');
  if (!r.ok) throw new Error(`OpenSky ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
// OpenSky rejects queries spanning more than 2 day-partitions, so ranges are fetched one UTC day per request.
async function openskyDays(ctx: Ctx, path: string, params: Record<string, string>, begin: number, end: number) {
  const out: any[] = [];
  for (let t = begin; t < end; t += 86400) out.push(...(await opensky(ctx, path, { ...params, begin: t, end: Math.min(t + 86400 - 1, end) }) as any[]));
  return out;
}
const epochDay = (d: string, end = false) => Math.floor(Date.parse(d + 'T00:00:00Z') / 1000) + (end ? 86400 : 0);
const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : null);
const osFlight = (f: any) => ({
  icao24: f.icao24, callsign: (f.callsign || '').trim() || null,
  from: f.estDepartureAirport, to: f.estArrivalAirport, first_seen_utc: iso(f.firstSeen), last_seen_utc: iso(f.lastSeen),
});

// US Census customs ports -> airports and military airfields in the port area (curated). The port is where the export was
// declared, not necessarily where the aircraft departed: these are candidates to check, not a mapping of fact.
export const PORT_AIRPORTS: Record<string, string[]> = {
  '0417': ['KBOS'], '1001': ['KJFK', 'KLGA', 'KEWR', 'KSWF'], '1003': ['KEWR'], '1012': ['KJFK'], '1081': ['KMMU'],
  '1101': ['KPHL'], '1103': ['KDOV', 'KILG'], '1104': ['KPIT'], '1303': ['KBWI', 'KADW'], '1305': ['KBWI'],
  '1401': ['KORF', 'KNGU', 'KLFI'], '1501': ['KILM'], '1601': ['KCHS'], '1704': ['KATL'], '1808': ['KMCO'], '2002': ['KMSY'],
  '2006': ['KMEM'], '2501': ['KSAN', 'KNZY'], '2605': ['KPHX', 'KLUF'], '2704': ['KLAX'], '2720': ['KLAX'],
  '2801': ['KSFO', 'KSUU'], '2835': ['KSMF', 'KSUU', 'KMCC'], '3001': ['KSEA', 'KTCM'], '3029': ['KSEA', 'KTCM'],
  '3126': ['PANC', 'PAED'], '3303': ['KSLC'], '3307': ['KDEN'], '3807': ['KDTW'], '3901': ['KORD'], '4101': ['KCLE'],
  '4104': ['KDAY', 'KFFO'], '4115': ['KSDF'], '4504': ['KICT', 'KIAB'], '5206': ['KMIA'], '5301': ['KIAH', 'KEFD'],
  '5309': ['KIAH'], '5401': ['KIAD', 'KDCA', 'KADW'], '5501': ['KDFW'], '5504': ['KOKC', 'KTIK'], '5583': ['KAFW'],
};

// ---------- ADSB.lol live API (through the SADA proxy: no CORS on their API) ----------
async function liveFetch(ctx: Ctx, path: string) {
  const base = (keys(ctx).proxyBase || '').replace(/\/$/, '');
  if (!base) throw new Error('Live data needs the live-data proxy URL (Settings → Advanced, or OAM_PROXY_BASE for the MCP server).');
  const r = await fetch(`${base}/live/${path}`);
  if (r.status === 404) throw new Error(`live lookup not allowed: ${path}`);
  if (!r.ok) throw new Error(r.status === 429 ? 'ADSB.lol is busy; try again in a few seconds' : `live data unavailable (${r.status})`);
  return ((await r.json()).ac ?? []) as any[];
}
const NM = 1.852;
const distNm = (la1: number, lo1: number, la2: number, lo2: number) => {
  const p = Math.PI / 180, a = Math.sin((la2 - la1) * p / 2) ** 2 + Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin((lo2 - lo1) * p / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a)) / NM;
};

export const SOURCE_TOOLS: ToolDef[] = [
  {
    name: 'live_aircraft',
    description: `Aircraft in the air RIGHT NOW (ADSB.lol live API, positions from the last ~minute; refreshed every 15 s). Use for "what is flying now", following a flight in progress, or checking whether a known aircraft is airborne. Ask for one of:
- military: true → every aircraft flagged military worldwide (optionally narrowed by type, e.g. "C17", "C5M", "K35R", "B744", or a box: near + radius)
- aircraft: ICAO hex(es) "ae1234" or "ae1234,ae5678" (up to 50), or a registration "4X-ICA"
- callsign: exact callsign "RCH123"
- type: ICAO type code "C17" (all aircraft of that type, military or not)
- near: { lat, lon, radius_nm ≤ 250 } (all aircraft around a point, e.g. Keflavík 63.98,-22.6)
Returns callsign, registration, type, operator, position, altitude (ft), speed (kt), heading, seconds since last position. Not in the result = not received right now (coverage gap or not flying); history is in the flight database (aircraft_history, aircraft_profile) from yesterday back.`,
    input_schema: {
      type: 'object',
      properties: {
        military: { type: 'boolean' }, aircraft: { type: 'string' }, callsign: { type: 'string' }, type: { type: 'string' },
        near: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' }, radius_nm: { type: 'number' } } },
        limit: { type: 'integer', description: 'max aircraft listed (default 60)' },
      },
    },
    async run(ctx, a) {
      const up = (x: unknown) => String(x ?? '').trim().toUpperCase();
      let path: string, source: string;
      const ac = String(a.aircraft ?? '').trim();
      if (ac) {
        const hexes = ac.toLowerCase().split(/[\s,]+/).filter(h => /^[0-9a-f]{6}$/.test(h));
        if (hexes.length) { path = hexes.length === 1 ? `hex/${hexes[0]}` : `icao/${hexes.slice(0, 50).join(',')}`; source = 'by ICAO address'; }
        else { path = `reg/${up(ac)}`; source = 'by registration'; }
      } else if (a.callsign) { path = `callsign/${up(a.callsign)}`; source = 'by callsign'; }
      else if (a.military || (!a.type && !a.near)) { path = 'mil'; source = 'all military-flagged aircraft worldwide'; }
      else if (a.type && !a.near) { path = `type/${up(a.type)}`; source = `all aircraft of type ${up(a.type)}`; }
      else { const n = a.near; path = `lat/${Number(n.lat).toFixed(1)}/lon/${Number(n.lon).toFixed(1)}/dist/${Math.min(250, Math.max(1, Math.round(n.radius_nm ?? 250)))}`; source = 'around a point'; }
      let rows = await liveFetch(ctx, path);
      // narrow the worldwide military list by type and/or area
      if (path === 'mil' && a.type) rows = rows.filter(r => up(r.t) === up(a.type));
      if (path === 'mil' && a.near) rows = rows.filter(r => r.lat != null && distNm(a.near.lat, a.near.lon, r.lat, r.lon) <= (a.near.radius_nm ?? 250));
      const out = rows.filter(r => r.lat != null).map(r => ({
        hex: String(r.hex).replace(/^~/, ''), callsign: String(r.flight ?? '').trim() || null, reg: r.r ?? null, type: r.t ?? null, desc: r.desc ?? null,
        operator: r.ownOp ?? null, military: !!((r.dbFlags ?? 0) & 1), lat: Math.round(r.lat * 1000) / 1000, lon: Math.round(r.lon * 1000) / 1000,
        alt_ft: r.alt_baro ?? null, speed_kt: r.gs != null ? Math.round(r.gs) : null, heading: r.track != null ? Math.round(r.track) : null,
        squawk: r.squawk ?? null, seen_s: Math.round(r.seen_pos ?? r.seen ?? 0),
      }));
      const lim = Number(a.limit) > 0 ? Number(a.limit) : 60;
      return { source: `ADSB.lol live API (ODbL), ${source}`, as_of_utc: new Date().toISOString().slice(0, 19) + 'Z', total: out.length, shown: Math.min(lim, out.length),
        aircraft: out.slice(0, lim), note: 'Positions received in roughly the last minute by volunteer receivers. Absent = not received now, which is not proof the aircraft is not flying.' };
    },
  },
  {
    name: 'us_exports',
    description: `Official US export statistics (US Census Bureau International Trade API) by destination country and HS commodity code, per month, optionally split by US customs port (e.g. port 1103 Wilmington DE, which covers Dover AFB; 1012 JFK).
Gives declared export VALUE (USD) and air-shipping weight; it does NOT identify flights, shippers or recipients. Monthly data, published with ~2 months delay.
Useful HS codes: 93 arms & ammunition; 9301 military weapons; 9305 parts of arms; 9306 bombs, missiles, ammunition; 8710 tanks/armoured vehicles; 8802 aircraft; 8807 aircraft/UAV parts; 8526 radar.
Needs a free Census API key in Settings.`,
    input_schema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Destination country as the Census writes it (e.g. ISRAEL, UKRAINE, UNITED ARAB EMIRATES) or its 4-digit Census code (Israel 5081). Default ISRAEL.' },
        hs_code: { type: 'string', description: 'HS code with 2, 4 or 6 digits, e.g. "9306". Default 93.' },
        month_from: { type: 'string', description: 'YYYY-MM' },
        month_to: { type: 'string', description: 'YYYY-MM' },
        by_port: { type: 'boolean', description: 'Split each month by US customs port (default false = country totals per month).' },
      },
      required: ['month_from', 'month_to'],
    },
    async run(ctx, a) {
      const key = keys(ctx).census;
      if (!key) throw new Error('No Census API key configured. Add one in Settings (free, instant: https://api.census.gov/data/key_signup.html).');
      if (!MONTH.test(a.month_from) || !MONTH.test(a.month_to)) throw new Error('month_from and month_to must be YYYY-MM');
      const hs = String(a.hs_code || '93').replace(/\D/g, '');
      if (![2, 4, 6].includes(hs.length)) throw new Error('hs_code must have 2, 4 or 6 digits');
      const country = String(a.country || 'ISRAEL').toUpperCase();
      const path = a.by_port ? 'porths' : 'hs';
      const fields = a.by_port ? 'PORT,PORT_NAME,AIR_VAL_MO,AIR_WGT_MO,VES_VAL_MO,ALL_VAL_MO' : 'E_COMMODITY_LDESC,AIR_VAL_MO,AIR_WGT_MO,VES_VAL_MO,ALL_VAL_MO';
      const params = { get: fields, CTY_CODE: await countryCode(country, key), E_COMMODITY: hs, COMM_LVL: `HS${hs.length}`, time: `from ${a.month_from} to ${a.month_to}` };
      const raw = await census(path, params, key);
      const rows = raw.map((r: any) => ({
        month: r.time, ...(a.by_port ? { port: r.PORT, port_name: r.PORT_NAME } : { description: r.E_COMMODITY_LDESC }),
        air_value_usd: Number(r.AIR_VAL_MO), air_weight_kg: Number(r.AIR_WGT_MO), vessel_value_usd: Number(r.VES_VAL_MO), total_value_usd: Number(r.ALL_VAL_MO),
      })).sort((x: any, y: any) => (x.month + (x.port ?? '')).localeCompare(y.month + (y.port ?? '')));
      const sum = (k: string) => rows.reduce((s: number, r: any) => s + (r[k] || 0), 0);
      return {
        country, hs_code: hs, months: `${a.month_from}..${a.month_to}`,
        totals: { total_value_usd: sum('total_value_usd'), air_value_usd: sum('air_value_usd'), air_weight_kg: sum('air_weight_kg') },
        latest_month_returned: rows.length ? rows[rows.length - 1].month : null,
        note: rows.length ? 'Values are declared export values (USD), not shipments or flights.' : 'No rows: no exports recorded, months not published yet (~2 months delay), or the Census API returned nothing (it is sometimes slow or flaky; retry later). Do not read this as zero exports.',
        rows,
        source: { title: 'US Census Bureau, International Trade API (exports)', url: `${CENSUS}/${path}?${new URLSearchParams(params)}` },
      };
    },
  },
  {
    name: 'opensky_airport_flights',
    description: `Flights arriving at or departing from one airport, from the OpenSky Network (independent ADS-B network; complements ADSB.lol and covers dates outside this dataset).
Worldwide receiver coverage, so it often has what this archive lacks. Max 7 days per call (one request per day). Airports are OpenSky's estimates. Needs an OpenSky API client in Settings.`,
    input_schema: {
      type: 'object',
      properties: {
        airport: { type: 'string', description: 'ICAO code, e.g. KDOV, LLBG, BIKF' },
        direction: { type: 'string', enum: ['arrival', 'departure'] },
        date_from: { type: 'string', description: 'YYYY-MM-DD' },
        date_to: { type: 'string', description: 'YYYY-MM-DD (inclusive, max 7 days after date_from)' },
      },
      required: ['airport', 'direction', 'date_from', 'date_to'],
    },
    async run(ctx, a) {
      const begin = epochDay(a.date_from), end = epochDay(a.date_to, true);
      if (!(end > begin) || end - begin > 7 * 86400) throw new Error('date range must be 1-7 days');
      const r = await openskyDays(ctx, `/flights/${a.direction === 'departure' ? 'departure' : 'arrival'}`, { airport: String(a.airport).toUpperCase() }, begin, end);
      return { airport: a.airport, direction: a.direction, flights: (r as any[]).map(osFlight), source: { title: 'OpenSky Network REST API', url: 'https://opensky-network.org' } };
    },
  },
  {
    name: 'opensky_aircraft_flights',
    description: 'All flights of one aircraft (ICAO 24-bit hex, e.g. 738c0b) in a date range from the OpenSky Network. Worldwide receiver coverage: use it for any dated question about an aircraft, alongside the archive, and for every leg whose origin or destination the archive could not record. Max 14 days per call (one request per day). Needs an OpenSky API client in Settings.',
    input_schema: {
      type: 'object',
      properties: {
        icao24: { type: 'string', description: 'hex address, lower case' },
        date_from: { type: 'string', description: 'YYYY-MM-DD' },
        date_to: { type: 'string', description: 'YYYY-MM-DD (inclusive, max 14 days after date_from)' },
      },
      required: ['icao24', 'date_from', 'date_to'],
    },
    async run(ctx, a) {
      const begin = epochDay(a.date_from), end = epochDay(a.date_to, true);
      if (!(end > begin) || end - begin > 14 * 86400) throw new Error('date range must be 1-14 days');
      const r = await openskyDays(ctx, '/flights/aircraft', { icao24: String(a.icao24).toLowerCase() }, begin, end);
      return { icao24: a.icao24, flights: (r as any[]).map(osFlight), source: { title: 'OpenSky Network REST API', url: 'https://opensky-network.org' } };
    },
  },
  {
    name: 'us_contracts',
    description: `US federal contract awards to a company (USAspending.gov, no key needed). Default: Department of Defense awards, which show
military airlift work such as USTRANSCOM "Civil Reserve Air Fleet (CRAF) - air transportation services" contracts held by cargo airlines.
Search by company name as registered with the US government (e.g. "Atlas Air", "Kalitta", "National Air Cargo", "Western Global").
Foreign airlines rarely hold US contracts directly: an empty result is common and is not evidence of no military work (they may be
subcontractors, or contracted by their own government).`,
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string' },
        date_from: { type: 'string', description: 'YYYY-MM-DD, default 2023-01-01' }, date_to: { type: 'string', description: 'YYYY-MM-DD, default today' },
        all_agencies: { type: 'boolean', description: 'include all federal agencies, not only the Department of Defense' },
        limit: { type: 'integer' },
      },
      required: ['company'],
    },
    async run(_ctx, a) {
      const filters: any = {
        recipient_search_text: [String(a.company)], award_type_codes: ['A', 'B', 'C', 'D'],
        time_period: [{ start_date: a.date_from || '2023-01-01', end_date: a.date_to || new Date().toISOString().slice(0, 10) }],
      };
      if (!a.all_agencies) filters.agencies = [{ type: 'awarding', tier: 'toptier', name: 'Department of Defense' }];
      const body = { filters, fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Awarding Sub Agency', 'Start Date', 'End Date', 'Description', 'generated_internal_id'],
        sort: 'Award Amount', order: 'desc', limit: Math.min(Number(a.limit) || 15, 50) };
      const r = await fetch('https://api.usaspending.gov/api/v2/search/spending_by_award/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`USAspending ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const rows = ((await r.json()).results ?? []).map((x: any) => ({
        award_id: x['Award ID'], recipient: x['Recipient Name'], amount_usd: x['Award Amount'], agency: x['Awarding Agency'], sub_agency: x['Awarding Sub Agency'],
        start: x['Start Date'], end: x['End Date'], description: x['Description'],
        url: x.generated_internal_id ? `https://www.usaspending.gov/award/${x.generated_internal_id}` : undefined,
      }));
      return {
        company: a.company, scope: a.all_agencies ? 'all federal agencies' : 'Department of Defense', awards_shown: rows.length,
        total_shown_usd: rows.reduce((t: number, x: any) => t + (Number(x.amount_usd) || 0), 0), awards: rows,
        note: 'Award amounts are obligations over the award period, not payments per flight. CRAF / USTRANSCOM air transportation awards mean the airline flies military airlift under contract; they do not identify individual flights or cargo.',
        source: { title: 'USAspending.gov award search', url: 'https://www.usaspending.gov/search' },
      };
    },
  },
  {
    name: 'export_flight_crosscheck',
    description: `Cross-reference US exports with flights. For a destination country and HS code: US Census export values per month and customs port (air shipments), and, for the busiest ports, the flights in the flight database that left the airports and military airfields of that port area in the same month: flights to the destination country, flights with unknown/uncertain destinations, and the top international destinations (transit routes via third countries).
The result is correlation material, not proof: say so. Needs the Census key; flight data only for months in the dataset.`,
    input_schema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Census country name, e.g. ISRAEL, UKRAINE' },
        country_iso2: { type: 'string', description: 'ISO2 code of the same country for the flight database, e.g. IL, UA' },
        hs_code: { type: 'string', description: 'HS code, default 93 (arms and ammunition); 9306 = bombs, missiles, ammunition' },
        month_from: { type: 'string', description: 'YYYY-MM' }, month_to: { type: 'string', description: 'YYYY-MM' },
        top_ports: { type: 'integer', description: 'how many ports (by air export value) to check against flights, default 3' },
      },
      required: ['country', 'country_iso2', 'month_from', 'month_to'],
    },
    async run(ctx, a) {
      ctx.progress?.('Fetching US export statistics by customs port (Census)');
      const ex: any = await SOURCE_TOOLS.find(t => t.name === 'us_exports')!.run(ctx, { country: a.country, hs_code: a.hs_code || '93', month_from: a.month_from, month_to: a.month_to, by_port: true });
      const byPort = new Map<string, { port: string; name: string; air: number; kg: number; months: Map<string, any> }>();
      for (const r of ex.rows) {
        if (!r.port || r.port === '-' || !r.air_value_usd) continue;
        const p = byPort.get(r.port) ?? { port: r.port, name: r.port_name, air: 0, kg: 0, months: new Map() };
        p.air += r.air_value_usd; p.kg += r.air_weight_kg; p.months.set(r.month, r); byPort.set(r.port, p);
      }
      const ports = [...byPort.values()].sort((x, y) => y.air - x.air).slice(0, Math.max(1, Math.min(Number(a.top_ports) || 3, 6)));
      const dbMonths = new Set(ctx.manifest.dates.map(d => d.slice(0, 7)));
      const iso = String(a.country_iso2).toUpperCase();
      // The airport-sorted copies hold only these airports' rows in a few row groups per file, so the whole period is read
      // ONCE into a small temp table (one read per yearly index file) and every month is then a filter on it. Reading per
      // month re-scanned the same yearly files dozens of times (a 42-month check took ~8 minutes).
      const allMonths = [...new Set(ports.flatMap(p => [...p.months.keys()]))].filter(m => dbMonths.has(m)).sort();
      const allAirports = [...new Set(ports.flatMap(p => PORT_AIRPORTS[p.port] ?? []))];
      const perMonth = new Map<string, { t0: number; t1: number; days: number }>();
      for (const m of allMonths) {
        const c = coverage(ctx, `${m}-01`, `${m}-31`);
        if (!c.covered_dates.length) continue;
        perMonth.set(m, { t0: Date.parse(c.covered_dates[0] + 'T00:00:00Z') / 1000, t1: Date.parse(c.covered_dates[c.covered_dates.length - 1] + 'T00:00:00Z') / 1000 + 86400, days: c.covered_dates.length });
      }
      const tmp = `xc_${Math.random().toString(36).slice(2, 9)}`;
      const cols = 'leg_id, callsigns, reg, type, operator, mil, from_code, to_code, to_cert, to_country, date, t0, from_lat, from_lon, to_lat, to_lon';
      const keyed = (t0: number, t1: number) => {
        const parts: string[] = [];
        for (const b of new Set(allAirports.map(a => a.slice(0, 2)))) {
          const ks = keyedSrc(ctx, 'airport', b, t0, t1);
          if (!ks) return null;
          if (ks !== '(empty)') parts.push(`SELECT ${cols} FROM ${ks} WHERE role = 'dep' AND code IN (${allAirports.filter(a => a.startsWith(b)).map(lit).join(',')}) AND t0 >= ${t0} AND t0 < ${t1}`);
        }
        return parts.length ? parts.join(' UNION ALL ') : `SELECT ${cols} FROM (SELECT NULL) WHERE false`;
      };
      let created = false;
      try {
        if (allAirports.length && perMonth.size) {
          const spans = [...perMonth.values()], T0 = Math.min(...spans.map(x => x.t0)), T1 = Math.max(...spans.map(x => x.t1));
          ctx.progress?.(`Reading departures from ${allAirports.length} airports near ${ports.length} US export ports, ${allMonths[0]} … ${allMonths.at(-1)}`);
          const whole = keyed(T0, T1);
          if (whole) { await ctx.query(`CREATE TEMP TABLE ${tmp} AS ${whole}`); created = true; }
          else {   // no sorted copies for part of the period: month by month from the flight tables
            await ctx.query(`CREATE TEMP TABLE ${tmp} AS SELECT ${cols} FROM (SELECT NULL) WHERE false`); created = true;
            for (const [m, w] of perMonth) {
              ctx.progress?.(`Reading departures ${m} (flight tables)`);
              await ctx.query(`INSERT INTO ${tmp} ${keyed(w.t0, w.t1) ?? `SELECT ${cols} FROM ${T(ctx, 'legs', w.t0, w.t1)} WHERE from_code IN (${allAirports.map(lit).join(',')}) AND t0 >= ${w.t0} AND t0 < ${w.t1}`}`);
            }
          }
          let k = 0;
          for (const [m, w] of perMonth) {
            k++;
            const win = `t0 >= ${w.t0} AND t0 < ${w.t1}`;
            const [cnt] = await ctx.query(`SELECT count(*) AS n, count(*) FILTER (WHERE to_country = ${lit(iso)}) AS dest FROM ${tmp} WHERE ${win}`);
            const found = Number(cnt.dest) ? await ctx.query(`SELECT leg_id, from_lat, from_lon, to_lat, to_lon, mil FROM ${tmp} WHERE ${win} AND to_country = ${lit(iso)} LIMIT 100`) : [];
            ctx.progress?.(`Month ${k} of ${perMonth.size} · ${m}: ${Number(cnt.n).toLocaleString()} departures from the export airports, ${Number(cnt.dest)} to ${iso}`, { legs: found });
          }
        }
        const out = [];
        for (const p of ports) {
          const airports = PORT_AIRPORTS[p.port] ?? [];
          const months = [];
          for (const [m, r] of [...p.months.entries()].sort()) {
            const row: any = { month: m, air_value_usd: r.air_value_usd, air_weight_kg: r.air_weight_kg, in_flight_database: dbMonths.has(m) };
            const pm = perMonth.get(m);
            if (airports.length && pm && created) {
              const base = `FROM ${tmp} WHERE t0 >= ${pm.t0} AND t0 < ${pm.t1} AND from_code IN (${airports.map(lit).join(',')})`;
              row.days_in_database = pm.days;
              row.flights_to_country = await ctx.query(`SELECT leg_id, callsigns, reg, type, operator, from_code, to_code, to_cert, date ${base} AND to_country = ${lit(iso)} ORDER BY t0 LIMIT 25`);
              const [u] = await ctx.query(`SELECT count(*) AS n ${base} AND to_cert <> 'recorded' AND coalesce(to_country, '') <> 'US'`);
              row.departures_with_uncertain_non_us_destination = Number(u.n);
              row.top_international_destinations = await ctx.query(`SELECT to_country AS country, count(*) AS flights, count(*) FILTER (WHERE mil = 1) AS military_aircraft ${base} AND to_country IS NOT NULL AND to_country <> '' AND to_country <> 'US' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`);
            }
            months.push(row);
          }
          out.push({ port: p.port, port_name: p.name, air_value_usd: p.air, air_weight_kg: p.kg,
            candidate_airports: airports.length ? airports : 'no airport mapping for this port: use airport_movements / route_search with a nearby airport', months });
        }
        return {
          country: a.country, hs_code: a.hs_code || '93', months: `${a.month_from}..${a.month_to}`, census_totals: ex.totals, ports: out,
          note: 'Census gives declared export value and weight by port and month; it names no flights, shippers or recipients. Flights from the port-area airports in the same month are candidates for further checks (aircraft_profile, route_search, web research), not evidence of carrying the exports.',
          source: ex.source,
        };
      } finally {
        if (created) await ctx.query(`DROP TABLE IF EXISTS ${tmp}`).catch(() => {});
      }
    },
  },
];

// Which external sources are usable right now (for the app-state block in the system prompt).
export function sourceStatus(ctx: Ctx) {
  const k = keys(ctx);
  return {
    census: !!k.census,
    opensky: !!(k.openskyId && k.openskySecret),
    openskyRoute: !!k.openskyBase,      // the proxy relays OpenSky (browsers cannot call it directly)
  };
}
