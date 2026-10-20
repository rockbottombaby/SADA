// What the assistant is doing right now, in plain words, plus what to show on the globe while it works
// (the airspace it checks lights up, the airport pulses, the countries involved are tinted). Cleared when the answer ends.
import { app, zoneName, countryName } from './state.svelte';

export interface Activity { text: string; zone?: string; airport?: string; countries?: string[]; seq: number }

const period = (a: any) => (a.date_from || a.date_to ? ` · ${a.date_from ?? '…'} → ${a.date_to ?? '…'}` : '');
const place = (v: unknown) => { const s = String(v ?? '').trim(); return s.length === 2 ? countryName(s.toUpperCase()) || s : s; };

export function describeCall(name: string, a: any): Omit<Activity, 'seq'> {
  const z = a.zone_id || a.through_zone;
  const iso2 = [a.origin, a.destination, a.from_country, a.to_country, a.either_end_country].map(x => String(x ?? '').trim().toUpperCase()).filter(x => x.length === 2);
  const apt = [a.airport, a.origin, a.destination].map(x => String(x ?? '').trim()).find(x => /^[A-Z0-9]{3,4}$/i.test(x) && x.length === 4);
  const base = { zone: z || undefined, airport: apt, countries: iso2.length ? iso2 : undefined };
  switch (name) {
    case 'zone_coverage': return { ...base, text: `Checking receiver coverage over ${zoneName(z)}${period(a)}` };
    case 'zone_overview': return { ...base, text: `Summarising flights through ${zoneName(z)}${period(a)}` };
    case 'flights_through_zone': return { ...base, text: `Listing flights through ${zoneName(z)}${period(a)}` };
    case 'find_flights': {
      const parts = [a.origin && `from ${place(a.origin)}`, a.destination && `to ${place(a.destination)}`, z && `through ${zoneName(z)}`,
        a.aircraft && `by ${a.aircraft}`, a.company && `by ${a.company}`, a.callsign && `callsign ${a.callsign}`].filter(Boolean);
      return { ...base, text: `Searching flights ${parts.join(' ')}${period(a)}` };
    }
    case 'route_search': return { ...base, text: `Searching the route ${place(a.origin) || 'anywhere'} → ${place(a.destination) || 'anywhere'}${period(a)}` };
    case 'airport_movements': return { ...base, airport: String(a.airport), text: `Looking at ${a.direction === 'arrivals' ? 'arrivals at' : a.direction === 'departures' ? 'departures from' : 'traffic at'} ${a.airport}${period(a)}` };
    case 'aircraft_profile': case 'aircraft_history': return { ...base, text: `Profiling aircraft ${a.aircraft}${period(a)}` };
    case 'aircraft_registry': return { ...base, text: a.company ? `Looking up the fleet of ${a.company}` : `Looking up the owner of ${a.aircraft}` };
    case 'flight_dossier': case 'get_track': return { ...base, text: `Reading flight ${a.leg_id}` };
    case 'search_flights': return { ...base, text: `Searching for “${a.text}”${period(a)}` };
    case 'flights_through_area': return { ...base, text: `Searching a map area${period(a)}` };
    case 'us_exports': return { ...base, text: `Fetching US export statistics (${a.country ?? 'ISRAEL'}, HS ${a.hs_code ?? '93'})` };
    case 'export_flight_crosscheck': return { ...base, text: `Cross-checking US exports to ${a.country} with flights` };
    case 'us_contracts': return { ...base, text: `Checking US government contracts of ${a.company}` };
    case 'opensky_airport_flights': case 'opensky_aircraft_flights': return { ...base, text: 'Asking OpenSky' };
    case 'live_aircraft': return { ...base, text: a.aircraft || a.callsign ? `Checking if ${a.aircraft || a.callsign} is in the air now` : a.type ? `Finding ${String(a.type).toUpperCase()} aircraft in the air now` : 'Looking at what is in the air right now' };
    case 'case_file': return { ...base, text: a.action === 'add' ? `Adding to the case file: ${a.kind}` : 'Reading the case file' };
    case 'dataset_info': return { ...base, text: 'Checking what the data covers' };
    case 'known_cases': return { ...base, text: `Checking the documented-shipment library${a.aircraft || a.operator || a.q ? ` for ${a.aircraft || a.operator || a.q}` : ''}` };
    case 'pinned_flights': return { ...base, text: 'Reading the pinned flights' };
    case 'list_zones': return { ...base, text: 'Looking up airspace names' };
    case 'run_sql': return { ...base, text: 'Running a custom database query' };
    default: return { ...base, text: name.startsWith('map_') ? 'Updating the map' : name.replace(/_/g, ' ') };
  }
}

export function setActivity(x: Omit<Activity, 'seq'> | null) {
  app.map.activity = x ? { ...x, seq: (app.map.activity?.seq ?? 0) + 1 } : null;
}
