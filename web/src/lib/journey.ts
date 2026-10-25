// One aircraft's journey over a few days, as a single picture: every stop in order (with arrival and departure times) and
// every leg, drawn from the archive's positions where receivers saw the aircraft and from OpenSky where they did not.
// The archive alone can hide a stop (a refuelling stop under receiver cover of 1,500 ft becomes one long leg): OpenSky's
// flight list for the same days adds the stop and the leg the archive filed as a gap. Nothing here is a cargo or a passenger.
import type { Ctx } from './tools';
import { TOOLS, lit } from './tools';
import { SOURCE_TOOLS } from './sources';
import type { Leg } from './state.svelte';

export interface JourneyStop { code: string; name: string; lat: number; lon: number; arr?: number; dep?: number; source: 'archive' | 'opensky' | 'both'; cert: string }
export interface JourneySeg { kind: 'seen' | 'gap' | 'estimated'; coords: [number, number][]; t0: number; t1: number; leg_id?: string }
export interface Journey {
  title: string; aircraft: { hex: string; reg?: string; type?: string; operator?: string }; date_from: string; date_to: string;
  stops: JourneyStop[]; segs: JourneySeg[]; legs: Leg[]; notes: string[];
}

const R = Math.PI / 180;
export function greatCircle(a: [number, number], b: [number, number], n = 48): [number, number][] {
  const [lo1, la1] = [a[0] * R, a[1] * R], [lo2, la2] = [b[0] * R, b[1] * R];
  const p1 = [Math.cos(la1) * Math.cos(lo1), Math.cos(la1) * Math.sin(lo1), Math.sin(la1)];
  const p2 = [Math.cos(la2) * Math.cos(lo2), Math.cos(la2) * Math.sin(lo2), Math.sin(la2)];
  const om = Math.acos(Math.min(1, p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2]));
  if (om < 1e-6) return [a, b];
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, s1 = Math.sin((1 - f) * om) / Math.sin(om), s2 = Math.sin(f * om) / Math.sin(om);
    const x = s1 * p1[0] + s2 * p2[0], y = s1 * p1[1] + s2 * p2[1], z = s1 * p1[2] + s2 * p2[2];
    out.push([Math.atan2(y, x) / R, Math.atan2(z, Math.hypot(x, y)) / R]);
  }
  return out;
}

const GAP = 1200;   // s: a silence this long in a track is a coverage gap (same rule as get_track)
const run = (name: string) => (TOOLS.find(t => t.name === name) ?? SOURCE_TOOLS.find(t => t.name === name))!.run;
const osTime = (s: string | null) => (s ? Math.floor(Date.parse(s.replace(' ', 'T').replace('Z', ':00Z')) / 1000) : null);

interface Ev { code: string; t: number; kind: 'arr' | 'dep'; src: 'archive' | 'opensky'; cert: string }

export async function buildJourney(ctx: Ctx, a: { aircraft: string; date_from: string; date_to: string; opensky?: boolean; max_legs?: number }): Promise<Journey> {
  const notes: string[] = [];
  const legs = (await run('aircraft_history')(ctx, { aircraft: a.aircraft, date_from: a.date_from, date_to: a.date_to })) as Leg[];
  const q = String(a.aircraft).trim();
  const hex = (legs[0]?.hex ? String(legs[0].hex) : /^[0-9a-f]{6}$/i.test(q) ? q : '').toLowerCase();
  if (!legs.length && !hex) throw new Error(`no flights of ${q} in the archive for ${a.date_from} – ${a.date_to}; give the ICAO hex to draw it from OpenSky alone`);

  // OpenSky's flight list for the same days (a second network, airports are its estimates)
  let os: { from: string | null; to: string | null; t0: number; t1: number; callsign: string | null }[] = [];
  const k = ctx.keys?.() ?? {};
  const days = Math.round((Date.parse(a.date_to) - Date.parse(a.date_from)) / 86400000) + 1;
  if (a.opensky !== false && hex && k.openskyId && k.openskySecret && days <= 14) {
    try {
      const r: any = await run('opensky_aircraft_flights')(ctx, { icao24: hex, date_from: a.date_from, date_to: a.date_to });
      os = (r.flights as any[]).map(f => ({ from: f.from, to: f.to, t0: osTime(f.first_seen_utc)!, t1: osTime(f.last_seen_utc)!, callsign: f.callsign })).filter(f => f.t0 && f.t1);
      ctx.progress?.(`OpenSky: ${os.length} flights for ${hex}`);
    } catch (e) { notes.push(`OpenSky not used: ${String(e).replace(/^Error: /, '').slice(0, 120)}`); }
  } else if (a.opensky !== false && !(k.openskyId && k.openskySecret)) notes.push('OpenSky is not connected (Settings): legs the archive lost in coverage gaps are drawn as gaps only');
  else if (days > 14) notes.push('OpenSky covers at most 14 days per call; not used for this span');

  // stops: every departure and arrival both networks recorded, in time order, grouped by airport
  const evs: Ev[] = [];
  for (const l of legs) {
    if (l.from_code) evs.push({ code: String(l.from_code), t: Number(l.t0), kind: 'dep', src: 'archive', cert: String(l.from_cert ?? '') });
    if (l.to_code) evs.push({ code: String(l.to_code), t: Number(l.t1), kind: 'arr', src: 'archive', cert: String(l.to_cert ?? '') });
  }
  for (const f of os) {
    if (f.from) evs.push({ code: f.from, t: f.t0, kind: 'dep', src: 'opensky', cert: 'opensky' });
    if (f.to) evs.push({ code: f.to, t: f.t1, kind: 'arr', src: 'opensky', cert: 'opensky' });
  }
  evs.sort((x, y) => x.t - y.t);
  const codes = [...new Set(evs.map(e => e.code))];
  const ap = new Map<string, { name: string; lat: number; lon: number }>();
  if (codes.length) for (const r of await ctx.query(`SELECT ident, name, lat, lon FROM airports WHERE ident IN (${codes.map(lit).join(',')})`).catch(() => []))
    ap.set(String(r.ident), { name: String(r.name), lat: Number(r.lat), lon: Number(r.lon) });
  for (const l of legs) {   // the archive's own coordinates for ends the airports table lacks
    if (l.from_code && !ap.has(String(l.from_code)) && l.from_lat != null) ap.set(String(l.from_code), { name: String(l.from_name ?? l.from_code), lat: Number(l.from_lat), lon: Number(l.from_lon) });
    if (l.to_code && !ap.has(String(l.to_code)) && l.to_lat != null) ap.set(String(l.to_code), { name: String(l.to_name ?? l.to_code), lat: Number(l.to_lat), lon: Number(l.to_lon) });
  }
  const stops: JourneyStop[] = [];
  for (const e of evs) {
    const A = ap.get(e.code); if (!A) continue;
    const last = stops[stops.length - 1];
    // consecutive events at the same airport are one stop, however long the stay (arrival, then departure)
    if (last && last.code === e.code) {
      if (e.kind === 'arr') last.arr = last.arr == null ? e.t : Math.min(last.arr, e.t); else last.dep = last.dep == null ? e.t : Math.max(last.dep, e.t);
      if (last.source !== e.src) last.source = 'both';
      if (e.src === 'archive' && e.cert === 'recorded') last.cert = 'recorded';
    } else stops.push({ code: e.code, name: A.name, lat: A.lat, lon: A.lon, ...(e.kind === 'arr' ? { arr: e.t } : { dep: e.t }), source: e.src, cert: e.cert });
  }

  // legs: the archive's positions, split into seen stretches and coverage gaps; a gap that spans a stop is routed through it
  const segs: JourneySeg[] = [];
  const stopIn = (t0: number, t1: number) => stops.find(s => s.arr != null && s.dep != null && s.arr > t0 && s.dep < t1);
  for (const l of legs.slice(0, a.max_legs ?? 16)) {
    ctx.progress?.(`Reading the track of ${l.leg_id}`);
    const tr: any = await run('get_track')(ctx, { leg_id: l.leg_id, max_points: 1500 });
    const P = (tr.points ?? []) as { t: number; lat: number; lon: number }[];
    let cur: [number, number][] = [], ct0 = 0;
    const flush = (t1: number) => { if (cur.length > 1) segs.push({ kind: 'seen', coords: cur, t0: ct0, t1, leg_id: String(l.leg_id) }); cur = []; };
    for (let i = 0; i < P.length; i++) {
      const p = P[i], c: [number, number] = [Number(p.lon), Number(p.lat)];
      if (i > 0 && Number(p.t) - Number(P[i - 1].t) > GAP) {
        const prev = P[i - 1], from: [number, number] = [Number(prev.lon), Number(prev.lat)];
        flush(Number(prev.t));
        const s = stopIn(Number(prev.t), Number(p.t));
        if (s) { segs.push({ kind: 'gap', coords: greatCircle(from, [s.lon, s.lat]), t0: Number(prev.t), t1: s.arr! }); segs.push({ kind: 'gap', coords: greatCircle([s.lon, s.lat], c), t0: s.dep!, t1: Number(p.t) }); }
        else segs.push({ kind: 'gap', coords: greatCircle(from, c), t0: Number(prev.t), t1: Number(p.t) });
        cur = [c]; ct0 = Number(p.t); continue;
      }
      if (!cur.length) ct0 = Number(p.t);
      cur.push(c);
    }
    flush(Number(P[P.length - 1]?.t ?? l.t1));
    // the archive's own ends when the positions stop short of them (receivers lost the aircraft before the runway)
    const first = P[0], lastP = P[P.length - 1];
    if (first && l.from_lat != null && l.from_cert === 'recorded') { const d = Math.hypot(Number(first.lon) - Number(l.from_lon), Number(first.lat) - Number(l.from_lat)); if (d > 0.3) segs.push({ kind: 'gap', coords: greatCircle([Number(l.from_lon), Number(l.from_lat)], [Number(first.lon), Number(first.lat)]), t0: Number(l.t0), t1: Number(first.t) }); }
    if (lastP && l.to_lat != null && l.to_cert === 'recorded') { const d = Math.hypot(Number(lastP.lon) - Number(l.to_lon), Number(lastP.lat) - Number(l.to_lat)); if (d > 0.3) segs.push({ kind: 'gap', coords: greatCircle([Number(lastP.lon), Number(lastP.lat)], [Number(l.to_lon), Number(l.to_lat)]), t0: Number(lastP.t), t1: Number(l.t1) }); }
  }
  // OpenSky flights the archive has no leg for at all: estimated great circles between its airports
  for (const f of os) {
    const covered = legs.some(l => Math.min(Number(l.t1), f.t1) - Math.max(Number(l.t0), f.t0) > 0.5 * (f.t1 - f.t0));
    const A = f.from && ap.get(f.from), B = f.to && ap.get(f.to);
    if (!covered && A && B) segs.push({ kind: 'estimated', coords: greatCircle([A.lon, A.lat], [B.lon, B.lat]), t0: f.t0, t1: f.t1 });
  }
  if (!stops.length && !segs.length) throw new Error(`nothing to draw for ${q} in ${a.date_from} – ${a.date_to}`);

  const l0 = legs[0] ?? {} as Leg;
  const reg = (l0.reg as string) || (/^[0-9a-f]{6}$/i.test(q) ? '' : q.toUpperCase());
  const d = (s: string) => s.slice(8, 10).replace(/^0/, '') + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(s.slice(5, 7)) - 1];
  const when = a.date_from === a.date_to ? `${d(a.date_from)} ${a.date_from.slice(0, 4)}` : `${d(a.date_from)} – ${d(a.date_to)} ${a.date_to.slice(0, 4)}`;
  const title = `${reg || hex} · ${stops.map(s => s.code).join(' → ') || 'journey'} · ${when}`;
  return { title, aircraft: { hex, reg: reg || undefined, type: l0.type as string | undefined, operator: l0.operator as string | undefined }, date_from: a.date_from, date_to: a.date_to, stops, segs, legs, notes };
}

// what the model gets back: the stops with times and sources, no coordinates
export function journeySummary(j: Journey) {
  const hm = (t?: number) => (t == null ? null : new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ') + 'Z');
  return {
    drawn: j.title, aircraft: j.aircraft,
    stops: j.stops.map(s => ({ code: s.code, name: s.name, arrived_utc: hm(s.arr), departed_utc: hm(s.dep), source: s.source, certainty: s.source === 'opensky' ? 'OpenSky estimate' : s.cert })),
    legs_drawn: j.legs.length, seen_stretches: j.segs.filter(s => s.kind === 'seen').length, coverage_gaps: j.segs.filter(s => s.kind === 'gap').length, opensky_only_legs: j.segs.filter(s => s.kind === 'estimated').length,
    notes: j.notes.length ? j.notes : undefined, map: 'replaced the map with this journey: stops labelled, solid = seen by receivers, dashed = coverage gap, dotted = OpenSky only',
  };
}
