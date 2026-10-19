// The documented-shipments library (public/cases.json, built by scripts/cases-build.mjs from oam/cases/): published
// reports and official statements about weapons movements, with what the SADA archive shows for each. Read by the
// Explore panel, the flight sheet and the assistant's known_cases tool. The claims are the sources', never SADA findings.
export interface CaseLeg { leg_id: string; hex: string; callsign: string; reg: string; type: string; from: string; to: string; date: string; evidence: string }
export interface ShipmentCase {
  id: string; country: string; date: string; date_precision: string; event_type: string; mode: string; vehicle: string; operator: string;
  origin: string; transit: string; destination: string; cargo: string; quantity: string; unit: string; evidence_status: string; delivery_outcome: string;
  source: string; source_url: string; secondary_url: string; operator_response: string; government_response: string; notes: string; linked_case: string;
  sada: { match: 'exact' | 'nearby' | 'dark' | 'none' | 'n/a'; note: string; legs: CaseLeg[] };
}
export interface CaseAggregate { id: string; country: string; period_start: string; period_end: string; scope: string; metrics: string; source: string; source_url: string; note: string }
export interface CaseLibrary { built_utc: string; licence: string; method: string; matched_utc: string; cases: ShipmentCase[]; aggregates: CaseAggregate[] }

export const CASES_URL = 'https://sadawatch.com/cases.json';
let cache: Promise<CaseLibrary> | null = null;
export function loadCases(url = typeof location !== 'undefined' ? '/cases.json' : CASES_URL): Promise<CaseLibrary> {
  if (!cache) cache = fetch(url).then(r => { if (!r.ok) throw new Error(`cases.json: ${r.status}`); return r.json(); }).catch(e => { cache = null; throw e; });
  return cache;
}

export const STATUS_LABEL: Record<string, string> = {
  official_confirmation: 'officially confirmed', records_supported: 'records cited', reported: 'reported', alleged: 'alleged', disputed: 'disputed',
};
export const OUTCOME_LABEL: Record<string, string> = {
  delivered_confirmed: 'delivery confirmed', delivered_reported: 'delivery reported', delivery_unverified: 'delivery unverified', transit_only: 'transit leg only', blocked: 'blocked', disputed_destination: 'destination disputed',
};
export const MATCH_LABEL: Record<string, string> = {
  exact: 'the reported flight is in the archive', nearby: 'the aircraft or operator is seen on the route that day', dark: 'seen leaving, destination lost (coverage gap)', none: 'not found in the archive', 'n/a': '',
};

export interface CaseQuery { q?: string; country?: string; mode?: string; aircraft?: string; callsign?: string; operator?: string; date_from?: string; date_to?: string; status?: string }
const norm = (s: unknown) => String(s ?? '').toLowerCase();
export function searchCases(lib: CaseLibrary, f: CaseQuery): ShipmentCase[] {
  const q = norm(f.q), ac = norm(f.aircraft).replace(/-/g, ''), cs = norm(f.callsign), op = norm(f.operator);
  return lib.cases.filter(c => {
    if (f.country && norm(c.country) !== norm(f.country)) return false;
    if (f.mode && c.mode !== f.mode) return false;
    if (f.status && c.evidence_status !== f.status) return false;
    if (f.date_from && c.date < f.date_from) return false;
    if (f.date_to && c.date > f.date_to) return false;
    if (op && !norm(c.operator).includes(op)) return false;
    if (ac && !(norm(c.vehicle).replace(/-/g, '').includes(ac) || c.sada.legs.some(l => norm(l.reg).replace(/-/g, '') === ac || norm(l.hex) === ac))) return false;
    if (cs && !(norm(c.vehicle).includes(cs) || c.sada.legs.some(l => norm(l.callsign).startsWith(cs)))) return false;
    if (q) { const hay = norm([c.vehicle, c.operator, c.origin, c.transit, c.destination, c.cargo, c.source, c.notes, c.country, ...c.sada.legs.map(l => l.callsign + ' ' + l.reg)].join(' ')); if (!q.split(/\s+/).every(w => hay.includes(w))) return false; }
    return true;
  });
}

// cases for one flight: the leg itself, else the same aircraft (hex or registration) within three days of the case date
export function casesForFlight(lib: CaseLibrary, leg: { leg_id?: string; hex?: string; reg?: string; date?: string }): ShipmentCase[] {
  const hex = norm(leg.hex), reg = norm(leg.reg).replace(/-/g, ''), t = leg.date ? Date.parse(leg.date) : NaN;
  return lib.cases.filter(c => {
    if (leg.leg_id && c.sada.legs.some(l => l.leg_id === leg.leg_id)) return true;
    const sameAc = (hex && c.sada.legs.some(l => norm(l.hex) === hex)) || (reg && (norm(c.vehicle).replace(/-/g, '').includes(reg) || c.sada.legs.some(l => norm(l.reg).replace(/-/g, '') === reg)));
    return !!sameAc && Number.isFinite(t) && Math.abs(Date.parse(c.date) - t) <= 3 * 86400e3;
  });
}
