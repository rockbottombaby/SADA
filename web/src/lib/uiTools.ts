// Front-end tools: let the assistant drive the map. They run in the browser, change app state only, and return a short
// confirmation. Not exposed over MCP (there is no map there).
// Each call REPLACES the map's scene (no leftovers from earlier answers or other chat tabs) unless keep_current is set,
// which adds to the scene the assistant drew in this chat tab.
import type { ToolDef } from './tools';
import { lit, idT0, T, TOOLS } from './tools';
import { app, selectLeg, setScene, clearScene, flyTo, zoneName, type Leg } from './state.svelte';

const KEEP = { keep_current: { type: 'boolean', description: 'add to the scene you already drew in this answer instead of replacing the map (default false)' } };
// keep only when the current scene is this tab's assistant scene; never build on the user's or another tab's drawing
const keep = (a: any) => !!a.keep_current && app.map.scene?.by === 'assistant' && app.map.scene?.chat === app.map.activeChat;
const meta = (title: string) => ({ title, by: 'assistant' as const, chat: app.map.activeChat });

export const UI_TOOLS: ToolDef[] = [
  {
    name: 'map_focus_zone',
    description: 'Show a zone (country sovereign airspace "sov:ISO3" or FIR "fir:CODE") on the user\'s map: outline, fill and zoom to it. Use list_zones first if unsure of the id.',
    input_schema: { type: 'object', properties: { zone_id: { type: 'string' }, ...KEEP }, required: ['zone_id'] },
    async run(_ctx, a) {
      if (!app.zones.some(z => z.id === a.zone_id)) throw new Error(`unknown zone ${a.zone_id}`);
      setScene({ zone: a.zone_id }, meta(zoneName(a.zone_id)), keep(a));
      return { shown: zoneName(a.zone_id), map: keep(a) ? 'added to your scene' : 'replaced the map' };
    },
  },
  {
    name: 'map_show_flights',
    description: 'Draw flights as arcs on the user\'s map, up to 5,000. Three ways: (1) search: the filters themselves, and the app fetches and draws EVERY match (best for "show all of them": no IDs needed) — through an airspace {zone_id, from_country/to_country/either_end_country, military_only}, from/to places {origin, destination}, or a base {airport, direction}, always with date_from/date_to; (2) last_result: true draws your most recent flight-list result; (3) leg_ids for a few specific flights (max 500). Give a short label.',
    input_schema: { type: 'object', properties: {
      search: { type: 'object', properties: { zone_id: { type: 'string' }, origin: { type: 'string' }, destination: { type: 'string' }, airport: { type: 'string' },
        direction: { type: 'string', enum: ['departures', 'arrivals', 'both'] }, from_country: { type: 'string' }, to_country: { type: 'string' },
        either_end_country: { type: 'string' }, military_only: { type: 'boolean' }, date_from: { type: 'string' }, date_to: { type: 'string' } } },
      leg_ids: { type: 'array', items: { type: 'string' } }, last_result: { type: 'boolean' }, label: { type: 'string' }, ...KEEP } },
    async run(ctx, a) {
      if (a.search) {   // fetch every match here: the model never has to page through IDs
        const q = { ...a.search, limit: 5000 }, t = (n: string) => TOOLS.find(x => x.name === n)!.run;
        const r: any = q.zone_id ? await t('flights_through_zone')(ctx, q)
          : q.airport ? await t('airport_movements')(ctx, { ...q, direction: q.direction ?? 'both' })
          : await t('route_search')(ctx, q);
        const rows = (Array.isArray(r) ? r : r.flights ?? []) as Leg[];
        const label = a.label || `${rows.length.toLocaleString()} flights`;
        setScene({ flows: rows, flowsLabel: label, ...(q.zone_id ? { zone: q.zone_id } : {}) }, meta(label), keep(a));
        app.lastLegs = { title: label, legs: rows };
        return { shown: rows.length, capped: rows.length >= 5000, total_matching: Array.isArray(r) ? undefined : r.total };
      }
      if (a.last_result) {
        const L = app.lastLegs;
        if (!L.legs.length) throw new Error('there is no flight-list result to draw yet');
        const label = a.label || L.title;
        setScene({ flows: L.legs, flowsLabel: label }, meta(label), keep(a));
        return { shown: L.legs.length, of: L.title };
      }
      const ids = ((a.leg_ids ?? []) as string[]).slice(0, 500);
      if (!ids.length) return { shown: 0 };
      // the departure time is part of the id: read each flight from its own month with a one-second window, so only the
      // row group holding it is fetched. One query over the span of all ids would scan every month table in between
      // (flights a year apart = gigabytes) and never finish in a browser.
      const rows: Record<string, unknown>[] = [];
      for (const id of ids) {
        const t = idT0(id);
        const [r] = await ctx.query(`SELECT * FROM ${T(ctx, 'legs', t - 1, t + 1)} WHERE t0 BETWEEN ${t - 1} AND ${t + 1} AND leg_id = ${lit(id)}`);
        if (r) rows.push(r);
      }
      const label = a.label || `${rows.length} flights`;
      setScene({ flows: rows as Leg[], flowsLabel: label }, meta(label), keep(a));
      return { shown: rows.length, missing: ids.length - rows.length };
    },
  },
  {
    name: 'map_show_track',
    description: 'Draw one flight (leg_id) on the map: its full track (solid = seen by receivers, dashed = coverage gap) with its airports. It does not open the details panel; the user opens that by clicking the flight.',
    input_schema: { type: 'object', properties: { leg_id: { type: 'string' }, ...KEEP }, required: ['leg_id'] },
    async run(_ctx, a) {
      await selectLeg(a.leg_id, false, { ...meta(`Track of ${a.leg_id}`), add: keep(a) });
      return { shown: a.leg_id, note: 'track drawn on the map; the user can click the flight to open its details' };
    },
  },
  {
    name: 'map_fly_to',
    description: 'Move the map camera to a point of interest (does not change what is drawn). zoom: 2 = continent, 4 = country, 7 = region, 10 = airport.',
    input_schema: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' }, zoom: { type: 'number' } }, required: ['lat', 'lon'] },
    async run(_ctx, a) { flyTo(a.lat, a.lon, a.zoom ?? 5); return { flew_to: [a.lat, a.lon, a.zoom ?? 5] }; },
  },
  {
    name: 'map_country_labels',
    description: 'Highlight countries on the map by ISO3 code (filled and always named), e.g. the countries a route passes. Replaces the map unless keep_current. Country names are otherwise shown automatically by zoom level.',
    input_schema: { type: 'object', properties: { highlight_iso3: { type: 'array', items: { type: 'string' } }, ...KEEP }, required: ['highlight_iso3'] },
    async run(_ctx, a) {
      const hl = (a.highlight_iso3 as string[]).map(s => s.toUpperCase());
      setScene({ highlight: hl }, meta(`Countries: ${hl.join(', ')}`), keep(a));
      return { highlighted: hl };
    },
  },
  {
    name: 'map_reset',
    description: 'Clear the map and return to the world view.',
    input_schema: { type: 'object', properties: {} },
    async run() { clearScene(); return { reset: true }; },
  },
];
