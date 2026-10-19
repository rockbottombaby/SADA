// The research trail: every step the assistant takes, drawn on the map as it happens, so an investigation is visible
// (and fun to watch). Steps accumulate per answer; findings in the case file become pins that stay. One trail per chat tab.
import { dock, setWin } from './dock.svelte';
import { app, zoneName, countryName } from './state.svelte';
import { recordTiming } from './perf';

export type Pt = [number, number];   // [lon, lat]
export interface Viz {
  zones?: string[];                                   // airspaces this step looked at
  arcs?: { from: Pt; to: Pt; n?: number; label?: string }[];   // flows between countries/places
  legs?: { from: Pt; to: Pt; mil?: boolean; evidence?: string }[];   // individual flights
  track?: Pt[];                                       // one flight's path
  points?: { at: Pt; label?: string }[];              // places that pulse (ports, airports, live aircraft)
}
export interface Step { i: number; tool: string; label: string; detail?: string; progress?: string; status: 'running' | 'done' | 'error'; viz: Viz; at: number; ms?: number; evidenceId?: string }
export interface Pin { at: Pt; kind: string; text: string; step: number }
export interface Trail { question: string; steps: Step[]; pins: Pin[] }

export const trail = $state({
  byChat: {} as Record<string, Trail>,
  focus: null as number | null,     // a step the user clicked: only it is drawn bright and the camera frames it
  follow: true,                      // the camera follows each new step
  open: false,                       // the full step list is expanded
  busy: false,                       // an answer is being produced (also between tool calls, while the model thinks)
  phase: '',                         // what the model is doing when no tool runs: Thinking, Writing, Searching the web …
  phaseAt: 0,
  seq: 0,                            // bumps on every change (the map redraws)
});
export const currentTrail = (): Trail | null => (app.map.activeChat ? trail.byChat[app.map.activeChat] ?? null : null);

// ---------- places ----------
let centroids: Map<string, Pt> | null = null;   // ISO2 → label point (Natural Earth)
fetch('/country_labels.geojson').then(r => r.json()).then(g => {
  centroids = new Map(g.features.filter((f: any) => f.properties?.iso2).map((f: any) => [String(f.properties.iso2).toUpperCase(), f.geometry.coordinates as Pt]));
}).catch(() => {});
const byName = (name: string): Pt | null => {
  const n = name.trim().toUpperCase();
  if (n.length === 2) return centroids?.get(n) ?? null;
  for (const [iso, p] of centroids ?? []) if (countryName(iso).toUpperCase() === n) return p;
  return null;
};
export function zoneCenter(id: string): Pt | null {
  const f = app.zoneGeo?.features.find((x: any) => x.properties?.id === id);
  if (!f) return null;
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c: any) => { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
  walk((f.geometry as any).coordinates);
  return e - w > 180 ? null : [(w + e) / 2, (s + n) / 2];   // skip zones spanning the antimeridian
}
const legsOf = (rows: any[]): Viz['legs'] => (rows ?? []).filter(l => l?.from_lat != null && l?.to_lat != null).slice(0, 300)
  .map(l => ({ from: [Number(l.from_lon), Number(l.from_lat)] as Pt, to: [Number(l.to_lon), Number(l.to_lat)] as Pt, mil: !!Number(l.mil), evidence: l.evidence }));
const usd = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${Math.round(v / 1e6)}M` : `$${Math.round(v).toLocaleString()}`);

// ---------- what each tool looks like on the map ----------
function vizFor(name: string, a: any, r: any): { viz: Viz; detail?: string } {
  const z = a?.zone_id || a?.through_zone;
  switch (name) {
    case 'zone_coverage':
      return { viz: { zones: [z] }, detail: r?.days_in_period != null ? `${r.days_with_receiver_coverage} of ${r.days_in_period} days with receiver coverage` : undefined };
    case 'zone_overview': {
      const c = zoneCenter(z), arcs: Viz['arcs'] = [];
      if (c) {
        for (const o of r?.top_origin_countries ?? []) { const p = byName(o.value); if (p) arcs.push({ from: p, to: c, n: Number(o.flights), label: `${o.value} ${Number(o.flights).toLocaleString()}` }); }
        for (const d of r?.top_destination_countries ?? []) { const p = byName(d.value); if (p) arcs.push({ from: c, to: p, n: Number(d.flights), label: `${d.value} ${Number(d.flights).toLocaleString()}` }); }
      }
      const t = r?.totals;
      return { viz: { zones: [z], arcs: arcs.slice(0, 16) }, detail: t ? `${Number(t.flights).toLocaleString()} flights · ${Number(t.observed).toLocaleString()} observed · ${Number(t.military).toLocaleString()} military` : undefined };
    }
    case 'flights_through_zone': case 'find_flights': case 'route_search': case 'aircraft_history': case 'search_flights': case 'flights_through_area': case 'known_cases': case 'pinned_flights': {
      const rows = Array.isArray(r) ? r : r?.flights ?? [];
      return { viz: { zones: z ? [z] : undefined, legs: legsOf(rows) }, detail: `${(r?.totals?.flights ?? rows.length).toLocaleString?.() ?? rows.length} flights` };
    }
    case 'airport_movements':
      return { viz: { legs: legsOf(r?.flights) }, detail: r?.total != null ? `${Number(r.total).toLocaleString()} movements` : undefined };
    case 'flight_dossier': {
      const l = r?.leg, sov = (r?.zones_crossed ?? []).map((x: any) => String(x.zone_id)).filter((id: string) => id.startsWith('sov:'));
      return { viz: { zones: sov, legs: l ? legsOf([l]) : [] }, detail: l ? `${String(l.callsigns || l.reg || '').split(' ')[0]} · ${l.from_code ?? '?'} → ${l.to_code ?? '?'} · ${l.date}` : undefined };
    }
    case 'get_track':
      return { viz: { track: (r?.points ?? []).map((p: any) => [Number(p.lon), Number(p.lat)] as Pt) } };
    case 'us_exports': case 'export_flight_crosscheck': {
      const dest = byName(String(a?.country ?? r?.country ?? 'IL')) ?? byName('IL'), us = byName('US');
      const tot = r?.totals ?? r?.census_totals;
      const label = tot ? `${usd(Number(tot.air_value_usd))} by air` : 'US exports';
      return { viz: { arcs: us && dest ? [{ from: us, to: dest, label }] : [], points: [us, dest].filter(Boolean).map(p => ({ at: p as Pt })) },
        detail: tot ? `HS ${r.hs_code ?? a?.hs_code ?? '93'} · ${r.months ?? ''} · ${usd(Number(tot.total_value_usd))} total, ${label}` : undefined };
    }
    case 'live_aircraft':
      return { viz: { points: (r?.aircraft ?? []).slice(0, 60).map((x: any) => ({ at: [x.lon, x.lat] as Pt, label: x.callsign || x.reg })) }, detail: `${r?.total ?? 0} in the air` };
    default:
      return { viz: {} };
  }
}

// where a finding from this step is pinned: the place the step was about
function anchorOf(t: Trail): Pt | null {
  for (let i = t.steps.length - 1; i >= 0; i--) {
    const v = t.steps[i].viz;
    if (v.track?.length) return v.track[Math.floor(v.track.length / 2)];
    if (v.zones?.length) { const c = zoneCenter(v.zones[0]); if (c) return c; }
    if (v.legs?.length) return v.legs[0].to;
    if (v.points?.length) return v.points[v.points.length - 1].at;
    if (v.arcs?.length) return v.arcs[0].to;
  }
  return null;
}

// ---------- fed by the chat ----------
const SKIP = new Set(['case_file', 'dataset_info', 'list_zones']);
export function trailStart(chat: string, question: string) {
  trail.byChat[chat] = { question, steps: [], pins: [] }; trail.focus = null; trail.busy = true; trail.phase = 'Thinking'; trail.phaseAt = Date.now(); trail.seq++;
}
export function trailPhase(text: string) { if (text !== trail.phase) { trail.phase = text; trail.phaseAt = Date.now(); } }
export function trailEnd() { trail.busy = false; trail.phase = ''; trail.seq++; }
// what a step is about, drawn the moment it starts (before any result): its airspace, or the export route
function intentViz(name: string, a: any): Viz {
  const z = a?.zone_id || a?.through_zone;
  if (z) return { zones: [z] };
  if (name === 'us_exports' || name === 'export_flight_crosscheck') {
    const us = byName('US'), dest = byName(String(a?.country_iso2 ?? a?.country ?? 'IL'));
    return us && dest ? { arcs: [{ from: us, to: dest, label: 'checking…' }], points: [{ at: us }, { at: dest }] } : {};
  }
  return {};
}
export function trailCall(chat: string, name: string, label: string, input?: any) {
  const t = trail.byChat[chat];
  if (!t || name.startsWith('map_') || SKIP.has(name)) return;
  let viz: Viz = {};
  try { viz = intentViz(name, input); } catch { /* nothing to draw yet */ }
  t.steps.push({ i: t.steps.length, tool: name, label, status: 'running', viz, at: Date.now() }); trail.seq++;
}
export function trailWeb(chat: string, query: string) {
  const t = trail.byChat[chat];
  if (t) { t.steps.push({ i: t.steps.length, tool: 'web', label: `Web · ${query}`, status: 'done', viz: {}, at: Date.now() }); trail.seq++; }
}
export function trailResult(chat: string, name: string, input: any, result: any, error?: string, evidenceId?: string) {
  const t = trail.byChat[chat];
  if (!t) return;
  if (name === 'case_file' && input?.action === 'add' && !error) {
    const at = anchorOf(t);
    if (at) t.pins.push({ at, kind: String(input.kind ?? 'finding'), text: String(input.text ?? '').slice(0, 140), step: Math.max(0, t.steps.length - 1) });
    trail.seq++; return;
  }
  const s = [...t.steps].reverse().find(x => x.tool === name && x.status === 'running');
  if (!s) return;
  s.ms = Date.now() - s.at; s.progress = undefined; s.evidenceId = evidenceId; recordTiming(name, s.ms);
  if (error) { s.status = 'error'; s.detail = error.replace(/^Error: /, '').slice(0, 120); trail.seq++; return; }
  // keep what the step drew while running (e.g. flights the cross-check found month by month) unless the result redraws it
  try { const v = vizFor(name, input, result); s.viz = { ...s.viz, ...v.viz, legs: v.viz.legs?.length ? v.viz.legs : s.viz.legs }; s.detail = v.detail; } catch { /* a step that cannot be drawn still counts */ }
  s.status = 'done'; trail.seq++;
}
// a long tool reports what it is doing right now
export function trailProgress(chat: string, name: string, text: string, data?: { legs?: any[] }) {
  const s = [...(trail.byChat[chat]?.steps ?? [])].reverse().find(x => x.tool === name && x.status === 'running');
  if (!s) return;
  s.progress = text;
  if (data?.legs?.length) s.viz = { ...s.viz, legs: [...(s.viz.legs ?? []), ...(legsOf(data.legs) ?? [])].slice(0, 300) };   // flights found so far
  trail.seq++;
}
// focus the trail step behind an evidence id ("E3"), from a citation chip in the answer
export function focusEvidence(id: string) {
  const t = currentTrail(); const s = t?.steps.find(x => x.evidenceId === id);
  if (s) { trail.focus = s.i; if (dock.research === 'min') setWin('research', 'normal'); }   // the user asked to see it
}
export const stepZoneName = (id: string) => zoneName(id).replace(/: sovereign airspace \([^)]*\)/, '');
