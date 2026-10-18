// Playbooks: the recurring investigations as single tools. Each runs a fixed sequence of the data tools inside the browser
// (no model round trips in between) and returns one evidence pack with exact totals, the subsets that matter, coverage
// and its validation, and the leads to test. A cheap model then does the right multi-step thing by construction, and a
// question that took 6–12 model turns takes one. Shared by the browser assistant and the MCP server.
import type { Ctx, ToolDef } from './tools';
import { TOOLS } from './tools';

const run = (name: string) => TOOLS.find(t => t.name === name)!.run;
const iso = (v: unknown) => String(v ?? '').trim().toUpperCase();
// freight-only operators (ICAO callsign prefixes) incl. US Air Mobility Command (RCH) and the Israeli cargo carriers
// (not ELY: El Al's prefix is mostly passenger flights; its cargo arm flies as LOY/ELY cargo, visible via aircraft type)
const CARGO_PREFIXES = 'ICL,CHG,FDX,UPS,GTI,CKS,CLX,ICV,ABW,BOX,GEC,DHK,BCS,DAE,DHX,MPH,NCR,WGN,SOO,ATN,ABX,KYE,PAC,SWN,TAY,ABR,CTJ,AJT,AZG,CAO,CKK,CSS,MSX,SQC,ADB,VDA,RCH';
const dates = (ctx: Ctx, a: any) => ({ date_from: a.date_from || ctx.manifest.dates[0], date_to: a.date_to || ctx.manifest.dates[ctx.manifest.dates.length - 1] });

export const PLAYBOOKS: ToolDef[] = [
  {
    name: 'investigate_airspace_claim',
    description: `PLAYBOOK for claims like "country X lets flights to/from country Y carry weapons through its airspace". One call runs the whole first pass over any period (fast indexes): receiver coverage of the zone and the validation of inferred crossings; exact totals of flights linked to the country at either end (observed vs inferred, military, by month); the military subset (listed); the cargo-operator subset (freight callsign prefixes, listed); top origins, destinations and operators; and a ranked list of leads with what would confirm each. Use it FIRST for such questions, then follow the leads (flight_dossier, aircraft_profile, export_flight_crosscheck, web). zone_id like "sov:ISL" (sovereign airspace) or "fir:BIRD"; country ISO2 like "IL".`,
    input_schema: { type: 'object', properties: {
      zone_id: { type: 'string' }, country: { type: 'string', description: 'ISO2 of the country at either end of the flights, e.g. "IL"' },
      date_from: { type: 'string' }, date_to: { type: 'string' },
      cargo_prefixes: { type: 'string', description: 'override the freight callsign prefixes, comma-separated' } },
      required: ['zone_id', 'country'] },
    async run(ctx, a) {
      const d = dates(ctx, a), zone = String(a.zone_id), c = iso(a.country);
      const coverage: any = await run('zone_coverage')(ctx, { zone_id: zone, ...d });
      const all: any = await run('zone_overview')(ctx, { zone_id: zone, ...d, either_end_country: c });
      const mil: any[] = await run('flights_through_zone')(ctx, { zone_id: zone, ...d, either_end_country: c, military_only: true, limit: 50 });
      const cargo: any = await run('zone_overview')(ctx, { zone_id: zone, ...d, either_end_country: c, callsign_prefixes: a.cargo_prefixes || CARGO_PREFIXES });
      const t = all.totals ?? {};
      const blind = coverage.days_in_period ? coverage.days_in_period - coverage.days_with_receiver_coverage : 0;
      const leads: any[] = [];
      if (mil.length) leads.push({ rank: 1, lead: `${mil.length} military-flagged flight(s) linked to ${c} crossed the zone`, test: 'flight_dossier for each (zones crossed, observed vs inferred); diplomatic-clearance records from the overflown state', flights: mil.slice(0, 10).map(l => l.leg_id) });
      if (cargo.totals?.flights) leads.push({ rank: leads.length + 1, lead: `${cargo.totals.flights} flight(s) by freight operators (${(cargo.top_callsign_prefixes ?? []).slice(0, 5).map((x: any) => `${x.value} ${x.flights}`).join(', ')})`, test: 'aircraft_profile of the busiest aircraft; export_flight_crosscheck for their departure months; permit/manifest records (Chicago Convention Art. 35)' });
      if (blind) leads.push({ rank: leads.length + 1, lead: `${blind} of ${coverage.days_in_period} days had no receiver coverage in the zone`, test: 'crossings there are inferred: quote the validation odds; ask the ANSP for flight plans for those dates', validation: coverage.validation_of_inferred_crossings });
      leads.push({ rank: leads.length + 1, lead: 'scheduled passenger traffic dominates the totals', test: 'exclude airline prefixes before counting "weapons flights"; cargo is never visible in flight data' });
      return {
        playbook: 'investigate_airspace_claim', zone: all.zone, country: c, period: all.period,
        coverage: { days_in_period: coverage.days_in_period, days_with_receiver_coverage: coverage.days_with_receiver_coverage,
          days_without_any_aircraft_seen: coverage.days_without_any_aircraft_seen, validation_of_inferred_crossings: coverage.validation_of_inferred_crossings },
        totals_linked_to_country: t, by_month: all.by_month ?? all.by_zone_entry_day,
        top_callsign_prefixes: all.top_callsign_prefixes, top_types: all.top_types, top_origins: all.top_origins, top_destinations: all.top_destinations,
        military_flights: mil, cargo_operators: { totals: cargo.totals, top_callsign_prefixes: cargo.top_callsign_prefixes, top_types: cargo.top_types, by_month: cargo.by_month ?? cargo.by_zone_entry_day },
        leads,
        how_to_read: 'Flight data shows crossings, not cargo. Observed = seen by receivers; inferred = estimated across a coverage gap (see validation). A FIR crossing is not a sovereign-airspace crossing. Totals are exact for the period; lists are capped.',
      };
    },
  },
  {
    name: 'investigate_airlift_base',
    description: `PLAYBOOK for "what leaves base/airport X for country Y" (e.g. Dover AFB → Israel) over any period: exact departure totals, the departures to the country (listed, newest first), the operators and aircraft types behind them, how the destination certainty splits (recorded / probable / unrecorded stop), per-month counts, and leads (aircraft to profile, months to cross-check with export statistics). airport = ICAO code like "KDOV"; country = ISO2 like "IL".`,
    input_schema: { type: 'object', properties: { airport: { type: 'string' }, country: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' } }, required: ['airport', 'country'] },
    async run(ctx, a) {
      const d = dates(ctx, a), ap = iso(a.airport), c = iso(a.country);
      const mv: any = await run('airport_movements')(ctx, { airport: ap, direction: 'departures', ...d, limit: 2000 });
      const to = (mv.flights ?? []).filter((f: any) => iso(f.to_country) === c);
      const count = (key: (f: any) => string) => { const m = new Map<string, number>(); for (const f of to) { const k = key(f) || '?'; m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((x, y) => y[1] - x[1]).map(([value, flights]) => ({ value, flights })); };
      const byAircraft = count(f => `${f.reg ?? f.hex} (${f.type ?? '?'})`);
      const leads = [
        ...(to.length ? [{ rank: 1, lead: `${to.length} departure(s) from ${ap} to ${c}`, test: 'aircraft_profile on the busiest aircraft; export_flight_crosscheck for the busiest months (HS 93, 9306); AMC/CRAF contracts of the operators (us_contracts)' }] : []),
        { rank: 2, lead: 'departures with an uncertain non-US destination may also be bound for the country', test: 'flight_dossier on those with to_cert ≠ recorded in the same weeks' },
      ];
      return {
        playbook: 'investigate_airlift_base', airport: ap, country: c, period: mv.period, departures_total: mv.total, departures_shown: mv.shown,
        to_country: { total: to.length, flights: to.slice(0, 60), by_callsign_prefix: count(f => String(f.callsigns ?? '').slice(0, 3)), by_aircraft: byAircraft.slice(0, 15),
          by_type: count(f => f.type), by_destination: count(f => f.to_code), by_destination_certainty: count(f => f.to_cert), by_month: count(f => String(f.date).slice(0, 7)).sort((x, y) => x.value.localeCompare(y.value)) },
        note: mv.shown < mv.total ? `Only the newest ${mv.shown} of ${mv.total} departures were examined for the destination split; totals are exact.` : undefined,
        leads,
      };
    },
  },
];
