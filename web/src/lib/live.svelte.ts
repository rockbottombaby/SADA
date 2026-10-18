// Live aircraft from the ADSB.lol live API, through our proxy (their API sends no CORS headers and refuses Cloudflare's
// servers). The proxy caches each answer 15 s for all viewers, so polling more often gains nothing.
// "Live" = positions received in the last minute or so, and only where volunteer receivers are; gaps are coverage, not absence.
import { settings } from './prefs.svelte';

export interface LiveAc {
  hex: string; callsign: string; reg: string; type: string; desc: string; operator: string; mil: boolean;
  lat: number; lon: number; alt: number | 'ground' | null; speed: number | null; heading: number | null;
  squawk: string; seen: number;   // seconds since the last position
}

export type LiveFilter = 'military' | 'transport' | 'cargo' | 'all';
export const FILTERS: { id: LiveFilter; label: string; title: string }[] = [
  { id: 'military', label: 'Military', title: 'Every aircraft flagged military, worldwide' },
  { id: 'transport', label: 'Transports', title: 'Military airlifters and tankers worldwide (C-17, C-5, C-130, A400M, KC-135, KC-46 …)' },
  { id: 'cargo', label: 'Cargo', title: 'Military transports worldwide, plus cargo airlines in the area you are looking at' },
  { id: 'all', label: 'All traffic', title: 'Everything in the area you are looking at, plus military worldwide' },
];
// military airlift and tanker types (ICAO type designators)
const TRANSPORT = new Set(['C17', 'C5', 'C5M', 'C130', 'C30J', 'A400', 'K35R', 'K35E', 'KC10', 'K46', 'KC46', 'A332', 'A339', 'C2', 'IL76', 'AN12', 'AN24', 'AN26', 'AN124', 'A124', 'B742', 'B744', 'B748', 'B763', 'B77L', 'C160', 'CN35', 'C295', 'C27J', 'Y20', 'KC39', 'E390']);
// cargo airlines by ICAO callsign prefix (incl. the main carriers on US/Europe–Israel cargo routes)
const CARGO = new Set(['FDX', 'UPS', 'GTI', 'CKS', 'CLX', 'ICV', 'ABW', 'BOX', 'GEC', 'DHK', 'BCS', 'DAE', 'DHX', 'MPH', 'NCR', 'WGN', 'SOO', 'ATN', 'ABX', 'KYE',
  'PAC', 'SWN', 'TAY', 'ABR', 'CTJ', 'AJT', 'AZG', 'ICL', 'CHG', 'CAO', 'CKK', 'CSS', 'MSX', 'SQC', 'ADB', 'VDA', 'RCH']);   // freight-only operators; RCH = US Air Mobility Command
const isTransport = (a: LiveAc) => a.mil && TRANSPORT.has(a.type.toUpperCase());
const isCargo = (a: LiveAc) => CARGO.has(a.callsign.slice(0, 3).toUpperCase());
// colour group on the map
export const kindOf = (a: LiveAc): 'mil' | 'cargo' | 'other' => (a.mil ? 'mil' : isCargo(a) ? 'cargo' : 'other');
const needsView = (f: LiveFilter) => f === 'cargo' || f === 'all';

export const live = $state({
  on: false,
  filter: 'military' as LiveFilter,
  trails: true,
  view: null as null | { lat: number; lon: number; nm: number },   // the map's centre and how far it reaches (set by the map)
  trailVersion: 0,
  aircraft: [] as LiveAc[],
  at: 0,                      // when the last answer arrived (ms)
  error: '',
  loading: false,
  watch: [] as string[],      // aircraft addresses followed live, besides all military aircraft (kept in this browser)
  extra: [] as string[],      // aircraft the assistant just looked up (this session only)
  selected: null as LiveAc | null,
});

export const liveBase = () => (settings.proxyBase || '').replace(/\/$/, '');

function shape(a: any): LiveAc | null {
  if (a.lat == null || a.lon == null) return null;
  return {
    hex: String(a.hex || '').replace(/^~/, ''), callsign: String(a.flight || '').trim(), reg: a.r || '', type: a.t || '', desc: a.desc || '',
    operator: a.ownOp || '', mil: !!((a.dbFlags ?? 0) & 1), lat: a.lat, lon: a.lon,
    alt: a.alt_baro === 'ground' ? 'ground' : Number.isFinite(a.alt_baro) ? a.alt_baro : null,
    speed: Number.isFinite(a.gs) ? Math.round(a.gs) : null, heading: Number.isFinite(a.track) ? a.track : Number.isFinite(a.true_heading) ? a.true_heading : null,
    squawk: a.squawk || '', seen: Number(a.seen_pos ?? a.seen ?? 0),
  };
}

// one ADSB.lol v2 endpoint: mil · hex/<hex> · icao/<hex,hex> · callsign/<CS> · reg/<REG> · type/<TYPE> · lat/<la>/lon/<lo>/dist/<nm>
export async function fetchLive(path: string, signal?: AbortSignal): Promise<LiveAc[]> {
  const base = liveBase();
  if (!base) throw new Error('Live data needs the SADA proxy (Settings → Proxy URL).');
  const r = await fetch(`${base}/live/${path}`, { signal });
  if (r.status === 404) throw new Error(`Live lookup not allowed or not found: ${path}`);
  if (!r.ok) throw new Error(r.status === 429 ? 'ADSB.lol is busy; try again in a few seconds.' : `Live data unavailable (${r.status}).`);
  const d = await r.json();
  return (d.ac ?? []).map(shape).filter(Boolean) as LiveAc[];
}

// canonical spellings (the proxy only accepts these, and equal requests then share its cache)
export const livePath = {
  hex: (hexes: string[]) => (hexes.length === 1 ? `hex/${hexes[0].toLowerCase()}` : `icao/${hexes.slice(0, 50).map(h => h.toLowerCase()).join(',')}`),
  callsign: (c: string) => `callsign/${c.trim().toUpperCase()}`,
  reg: (r: string) => `reg/${r.trim().toUpperCase()}`,
  type: (t: string) => `type/${t.trim().toUpperCase()}`,
  near: (lat: number, lon: number, nm: number) => `lat/${lat.toFixed(1)}/lon/${lon.toFixed(1)}/dist/${Math.min(250, Math.max(1, Math.round(nm)))}`,
};

async function refresh() {
  live.loading = true;
  try {
    const follow = [...new Set([...live.watch, ...live.extra])];
    const v = live.view, area = needsView(live.filter) && v && v.nm <= 250;
    const [mil, watched, near] = await Promise.all([fetchLive('mil'), follow.length ? fetchLive(livePath.hex(follow)) : Promise.resolve([]),
      area ? fetchLive(livePath.near(v!.lat, v!.lon, v!.nm)) : Promise.resolve([])]);
    const byHex = new Map<string, LiveAc>();
    for (const a of [...near, ...mil, ...watched]) byHex.set(a.hex, a);
    live.aircraft = [...byHex.values()];
    addTrails(live.aircraft);
    live.at = Date.now(); live.error = '';
    if (live.selected) live.selected = byHex.get(live.selected.hex) ?? live.selected;
    if (live.trails) loadTraces();
  } catch (e) { live.error = String((e as Error).message ?? e); }
  live.loading = false;
}

// what the map shows: the chosen filter, plus followed aircraft and the assistant's finds always
export function shown(): LiveAc[] {
  const keep = new Set([...live.watch, ...live.extra]);
  const f = live.filter;
  return live.aircraft.filter(a => keep.has(a.hex) || (f === 'all') || (f === 'military' && a.mil) || (f === 'transport' && isTransport(a))
    || (f === 'cargo' && (isTransport(a) || isCargo(a))));
}
// why "All traffic" / "Cargo" may look empty: ADSB.lol serves everything only within 250 nm of a point
export const viewNote = () => (needsView(live.filter) && (!live.view || live.view.nm > 250)
  ? 'Zoom in to see all traffic here: ADSB.lol serves it within 250 nm of a point. Military is shown worldwide.' : '');

// trails (last hour): the aircraft's recent track from ADSB.lol's trace file the moment it is shown (through the proxy,
// which caches it 30 s), then extended by the 15 s live updates
const TRAIL_MS = 3600e3;
const trails = new Map<string, [number, number, number][]>();   // hex -> [lon, lat, t]
function addTrails(list: LiveAc[]) {
  const now = Date.now();
  for (const a of list) {
    const t = trails.get(a.hex) ?? [];
    const last = t[t.length - 1];
    if (!last || last[0] !== a.lon || last[1] !== a.lat) t.push([a.lon, a.lat, now]);
    trails.set(a.hex, t.filter(p => now - p[2] < TRAIL_MS));
  }
  for (const [h, t] of trails) if (!t.length || now - t[t.length - 1][2] > 600e3) trails.delete(h);
  live.trailVersion++;
}
export const trailOf = (hex: string) => trails.get(hex) ?? [];

// one aircraft's recent track (tar1090 trace: base timestamp + [seconds, lat, lon, …] rows); [] when there is none
const traced = new Map<string, number>();   // hex -> when its trace was loaded (not asked again for 20 min)
let tracing = false;
async function fetchTrace(hex: string, signal?: AbortSignal): Promise<[number, number, number][]> {
  const r = await fetch(`${liveBase()}/live/trace/${hex}`, { signal });
  if (!r.ok) return [];
  const d = await r.json().catch(() => null);
  const t0 = Number(d?.timestamp) * 1000;
  if (!Array.isArray(d?.trace) || !Number.isFinite(t0)) return [];
  const floor = Date.now() - TRAIL_MS;
  return d.trace.map((row: any[]) => [Number(row[2]), Number(row[1]), t0 + Number(row[0]) * 1000] as [number, number, number])
    .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[2] >= floor);
}
// traces for what is on the map: followed and selected aircraft first, then those nearest the view, up to 60 per refresh,
// six at a time (each is one small cached file on the proxy)
export async function loadTraces() {
  if (tracing || !live.on) return;
  tracing = true;
  try {
    const now = Date.now(), v = live.view, first = new Set([...live.watch, ...live.extra, live.selected?.hex ?? '']);
    const dist = (a: LiveAc) => (v ? Math.hypot(a.lat - v.lat, (a.lon - v.lon) * Math.cos((v.lat * Math.PI) / 180)) : 0);
    const todo = shown().filter(a => /^[0-9a-f]{6}$/.test(a.hex) && now - (traced.get(a.hex) ?? 0) > 1200e3)
      .sort((a, b) => Number(first.has(b.hex)) - Number(first.has(a.hex)) || dist(a) - dist(b)).slice(0, 60);
    let i = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (i < todo.length && live.on) {
        const a = todo[i++];
        traced.set(a.hex, now);
        const pts = await fetchTrace(a.hex).catch(() => [] as [number, number, number][]);
        if (!pts.length || !live.on) continue;
        // merge with what the live updates gathered, oldest first, one point per second
        const seen = new Set<number>(), merged: [number, number, number][] = [];
        for (const p of [...pts, ...(trails.get(a.hex) ?? [])].sort((x, y) => x[2] - y[2])) {
          const k = Math.round(p[2] / 1000);
          if (!seen.has(k)) { seen.add(k); merged.push(p); }
        }
        trails.set(a.hex, merged);
        live.trailVersion++;
      }
    }));
  } finally { tracing = false; }
}
export function setFilter(f: LiveFilter) { live.filter = f; if (live.on) refresh(); }
let viewTimer: ReturnType<typeof setTimeout> | null = null;
export function setView(v: { lat: number; lon: number; nm: number }) {
  const prev = live.view;
  live.view = v;
  // refetch when the area matters and moved noticeably (debounced; the proxy caches per 0.1° anyway)
  if (live.on && needsView(live.filter) && (!prev || Math.abs(prev.lat - v.lat) > 0.3 || Math.abs(prev.lon - v.lon) > 0.3 || Math.abs(prev.nm - v.nm) > 20)) {
    if (viewTimer) clearTimeout(viewTimer);
    viewTimer = setTimeout(refresh, 600);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function setLive(on: boolean) {
  live.on = on;
  if (timer) { clearInterval(timer); timer = null; }
  if (!on) { live.aircraft = []; live.selected = null; trails.clear(); traced.clear(); live.trailVersion++; return; }
  refresh();
  // only while the tab is visible: a background tab should not keep asking
  timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 15_000);
}
// the assistant found these in the air: show them on the live map (and the layer on)
export function showLive(hexes: string[]) {
  live.extra = [...new Set([...live.extra, ...hexes])].slice(-50);
  if (!live.on) setLive(true); else refresh();
}
export function toggleWatch(hex: string) {
  live.watch = live.watch.includes(hex) ? live.watch.filter(h => h !== hex) : [...live.watch, hex];
  try { localStorage.setItem('sada.liveWatch', JSON.stringify(live.watch)); } catch { /* storage unavailable */ }
  if (live.on) refresh();
}
try { live.watch = JSON.parse(localStorage.getItem('sada.liveWatch') || '[]'); } catch { /* storage unavailable */ }
