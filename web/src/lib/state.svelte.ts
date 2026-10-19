import type { Ctx, Row, ZoneMeta } from './tools';
import { TOOLS, flightDossier } from './tools';
import type { QuerySpec } from './query.svelte';

export type Leg = Row & { leg_id: string; hex: string; t0: number; t1: number; from_lat?: number; from_lon?: number; to_lat?: number; to_lon?: number };

// Explore panel (manual work) has its own view stack; the assistant never takes it over.
export type ExploreView =
  | { kind: 'home' }
  | { kind: 'query'; spec: QuerySpec }                // a "Find flights" search
  | { kind: 'area'; ring: [number, number][] }
  | { kind: 'list'; title: string; legs: Leg[] };   // "open in Explore" from a chat card

export const app = $state({
  ctx: null as Ctx | null,
  ready: false,
  status: 'Loading…',
  error: '',
  zones: [] as ZoneMeta[],
  zoneGeo: null as GeoJSON.FeatureCollection | null,
  dateFrom: '',
  dateTo: '',
  explore: { kind: 'home' } as ExploreView,
  // what the map shows
  map: {
    focusZone: null as string | null,
    flows: [] as Leg[],                 // flights drawn as arcs (from Explore or from a chat card)
    flowsLabel: '',
    highlight: [] as string[],          // ISO3 codes highlighted
    flyTo: null as null | { lat: number; lon: number; zoom: number; seq: number },
    resetSeq: 0,
    drawMode: false,
    area: null as [number, number][] | null,
    // scene: what is drawn as one unit, who drew it, and history for back/forward
    scene: null as SceneMeta | null,
    history: [] as Scene[],
    histIdx: -1,
    cameraSeq: 0,                       // bumped when the camera should frame the scene (or the selected track)
    activeChat: '' as string,           // chat tab whose assistant is drawing (for per-tab scenes)
    chatScenes: {} as Record<string, Scene>,
    activity: null as null | { text: string; zone?: string; airport?: string; countries?: string[]; seq: number },   // what the assistant is doing now
  },
  loading: { step: '', progress: 0 },  // splash screen
  chatDraft: '',
  composerFocus: 0,                   // bumped to put the cursor in the question box (e.g. after "Start asking")
  lastLegs: { title: '', legs: [] as Leg[] },  // the most recent flight list a chat answer produced (for "map all of these")                       // text handed to the chat input ("Ask the assistant about these")
  // floating inspector over the map
  selected: null as Leg | null,
  dossier: null as any,
  track: null as any,
  inspectorOpen: false,
  keySetupOpen: false,
  memorialOpen: true,                 // the memorial of Sha'ban al-Dalou, shown every time the app opens                // guided Anthropic key setup (KeySetup.svelte)
  // the details overlay while a flight loads: whatever has arrived so far (null when nothing is loading)
  inspectorDraft: null as null | ({ id: string; error?: string } & Record<string, any>),
  settingsOpen: false,
  aboutOpen: false,                   // the About page over the app (About.svelte); the session underneath is untouched
  coffeeOpen: false,                  // "Buy me a coffee": points to the fundraisers instead (Coffee.svelte)
  aboutSection: '',                   // section to scroll to when it opens (e.g. 'support')
  // phones: one panel at a time over the map, chosen with the bottom tab bar (App.svelte); set from a media query
  mobile: false,
  tab: 'map' as 'search' | 'map' | 'ask',
  chooser: null as null | string[],   // flights under a tap on the map when several overlap (mobile): leg ids to pick from
});

// ---------- map scenes ----------
// Everything drawn on the map belongs to one scene. Showing something new REPLACES the scene (no leftovers from earlier
// selections or other conversations) unless `add` is set. A selected track is part of the current scene.
export interface SceneMeta { title: string; by: 'you' | 'assistant'; chat?: string }
export interface Scene extends SceneMeta {
  zone: string | null; flows: Leg[]; flowsLabel: string; highlight: string[]; area: [number, number][] | null;
  selected: Leg | null; dossier: any; track: any;
}
const snapshot = (meta: SceneMeta): Scene => ({
  ...meta, zone: app.map.focusZone, flows: app.map.flows, flowsLabel: app.map.flowsLabel, highlight: app.map.highlight,
  area: app.map.area, selected: app.selected, dossier: app.dossier, track: app.track,
});
function apply(sc: Scene) {
  app.map.focusZone = sc.zone; app.map.flows = sc.flows; app.map.flowsLabel = sc.flowsLabel; app.map.highlight = sc.highlight;
  app.map.area = sc.area; app.selected = sc.selected; app.dossier = sc.dossier; app.track = sc.track;
  app.map.scene = { title: sc.title, by: sc.by, chat: sc.chat };
  app.inspectorOpen = false;
  app.map.cameraSeq++;
}
export interface SceneSpec { zone?: string | null; flows?: Leg[]; flowsLabel?: string; highlight?: string[]; area?: [number, number][] | null; track?: { selected: Leg; dossier: any; track: any } | null }
export function setScene(spec: SceneSpec, meta: SceneMeta, add = false) {
  const base: Scene = add && app.map.scene ? snapshot(app.map.scene)
    : { ...meta, zone: null, flows: [], flowsLabel: '', highlight: [], area: null, selected: null, dossier: null, track: null };
  const sc: Scene = { ...base, ...meta,
    ...(spec.zone !== undefined ? { zone: spec.zone } : {}), ...(spec.flows !== undefined ? { flows: spec.flows, flowsLabel: spec.flowsLabel ?? '' } : {}),
    ...(spec.highlight !== undefined ? { highlight: spec.highlight } : {}), ...(spec.area !== undefined ? { area: spec.area } : {}),
    ...(spec.track !== undefined ? (spec.track ? spec.track : { selected: null, dossier: null, track: null }) : {}) };
  apply(sc);
  // history: drop anything after the current position (like a browser), cap at 30 scenes
  app.map.history = [...app.map.history.slice(0, app.map.histIdx + 1), sc].slice(-30);
  app.map.histIdx = app.map.history.length - 1;
  if (meta.chat) app.map.chatScenes[meta.chat] = sc;
}
export function clearScene() {
  apply({ title: '', by: 'you', zone: null, flows: [], flowsLabel: '', highlight: [], area: null, selected: null, dossier: null, track: null });
  app.map.scene = null;
  app.map.resetSeq++;
}
export function sceneBack() { if (app.map.histIdx > 0) apply(app.map.history[--app.map.histIdx]); }
export function sceneForward() { if (app.map.histIdx < app.map.history.length - 1) apply(app.map.history[++app.map.histIdx]); }
export function restoreChatScene(chat: string) { const sc = app.map.chatScenes[chat]; if (sc) apply(sc); }
// one-line description of the map for the assistant's app state
export function describeScene() {
  const sc = app.map.scene;
  if (!sc) return 'empty world map';
  const parts = [app.map.focusZone && `zone ${app.map.focusZone}`, app.map.flows.length && `${app.map.flows.length} flight lines`,
    app.selected && `track of leg ${app.selected.leg_id}`, app.map.highlight.length && `highlighted ${app.map.highlight.join(', ')}`,
    app.map.area && 'a drawn area'].filter(Boolean);
  return `"${sc.title}" drawn by ${sc.by === 'you' ? 'the user' : sc.chat && sc.chat !== app.map.activeChat ? 'the assistant in another chat tab' : 'you (the assistant)'}: ${parts.join(', ') || 'nothing'}`;
}

// signal: aborting it skips the tool's queued database queries and stops the running one (a search the user has left)
export async function tool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const t = TOOLS.find(x => x.name === name)!;
  const ctx = signal ? { ...app.ctx!, query: (sql: string) => app.ctx!.query(sql, signal) } : app.ctx!;
  return t.run(ctx, args) as Promise<any>;
}

// Select a flight and draw its track. The details overlay opens only on a user action (open = true);
// the assistant's map tools select without opening it.
// From a list or the map (user), the track is added to the current scene; scene = { … } replaces it (assistant).
let selSeq = 0;
export async function selectLeg(leg: Leg | string, open = true, scene?: SceneMeta & { add?: boolean }) {
  const id = typeof leg === 'string' ? leg : leg.leg_id;
  const my = ++selSeq;
  app.status = 'Loading flight…';
  // a user click opens the overlay at once; the row they clicked fills the header, the rest trickles in
  const known = typeof leg === 'string' ? app.map.flows.find(l => l.leg_id === id) ?? app.lastLegs.legs.find(l => l.leg_id === id) : leg;
  if (open) { app.inspectorDraft = { id, ...(known ? { leg: known } : {}) }; app.inspectorOpen = true; }
  const part = (p: Record<string, unknown>) => { if (open && my === selSeq && app.inspectorDraft?.id === id) app.inspectorDraft = { ...app.inspectorDraft, ...p }; };
  try {
    const [d, tr] = await Promise.all([flightDossier(app.ctx!, id, part), tool('get_track', { leg_id: id, max_points: 4000 })]);
    if (my !== selSeq) return;   // a newer selection won
    const keepOpen = open && app.inspectorDraft?.id === id;   // not closed by the user while it loaded
    const track = { selected: d.leg, dossier: d, track: tr };
    const name = `${String(d.leg.callsigns || d.leg.reg || id).split(' ')[0]} · ${d.leg.from_code || '?'} → ${d.leg.to_code || '?'} · ${d.leg.date}`;
    if (scene) setScene({ track }, { ...scene, title: scene.title.startsWith('Track of') ? `Track ${name}` : scene.title }, scene.add);
    else if (app.map.scene) {
      app.selected = d.leg; app.dossier = d; app.track = tr; app.map.cameraSeq++;
      // keep the selection in this scene's history entry, so back/forward and chat tabs restore it
      const sc = snapshot(app.map.scene);
      if (app.map.histIdx >= 0) app.map.history[app.map.histIdx] = sc;
      if (sc.chat) app.map.chatScenes[sc.chat] = sc;
    }
    else setScene({ track }, { title: `Track ${name}`, by: 'you' });
    if (keepOpen) { app.inspectorOpen = true; history.replaceState(null, '', `#leg=${id}`); }
    app.inspectorDraft = null;
    app.status = '';
  } catch (e) {
    if (open && my === selSeq) part({ error: String(e) });
    app.status = String(e);
  }
}
// closing keeps the selected track on the map; Reset clears it
export function closeInspector() { app.inspectorOpen = false; app.inspectorDraft = null; history.replaceState(null, '', location.pathname); }
// user-initiated "show these flights" (Explore, chat-card buttons): a new scene
export function showFlows(legs: Leg[], label: string, extra: SceneSpec = {}) {
  if (!legs.length && !extra.zone && !extra.area) { clearScene(); return; }
  setScene({ flows: legs, flowsLabel: label, ...extra }, { title: label, by: 'you' });
}
export function flyTo(lat: number, lon: number, zoom = 4) { app.map.flyTo = { lat, lon, zoom, seq: (app.map.flyTo?.seq ?? 0) + 1 }; }

// tolerant of missing/invalid times (e.g. partial rows from run_sql): show '–' instead of throwing
const okT = (t: unknown) => t != null && t !== '' && Number.isFinite(Number(t));
export const fmt = (t: number) => (okT(t) ? new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 16) : '–');
export const hm = (t: number) => (okT(t) ? new Date(Number(t) * 1000).toISOString().slice(11, 16) : '–');
export const dur = (s: number) => `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`;
export const zoneName = (id: string) => app.zones.find(z => z.id === id)?.name || id;
// compact airport label for a leg end: code if recorded, "?" + code/area if uncertain
export const endLabel = (code: unknown, name: unknown, cert: unknown) => {
  const c = String(cert || '');
  if (c === 'recorded') return String(code || name || '?');
  if (code) return `${code}?`;
  return '?';
};
export const endTitle = (name: unknown, cert: unknown) => `${name ?? ''} (${cert ?? 'unknown'})`;
const REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });
export const countryName = (iso2: unknown) => {
  if (!iso2) return '';
  try { return REGIONS.of(String(iso2)) ?? String(iso2); } catch { return String(iso2); }
};
