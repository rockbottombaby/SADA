// What the MODEL sees from a tool result. The UI always receives the full result; the model gets totals, the first
// rows with short fields, and an explicit note of what was left out. Small, predictable inputs are the main cost
// lever and make weaker models more reliable (less to read, less to misread).

const legRow = (r: any) => ({
  leg_id: r.leg_id,
  callsign: String(r.callsigns || '').split(' ').slice(0, 2).join(' ') || undefined,
  reg: r.reg || undefined, type: r.type || undefined, operator: r.operator || undefined, mil: r.mil ? 1 : undefined,
  from: [r.from_code, r.from_country].filter(Boolean).join(' ') || r.from_name, from_cert: r.from_cert !== 'recorded' ? r.from_cert : undefined,
  to: [r.to_code, r.to_country].filter(Boolean).join(' ') || r.to_name, to_cert: r.to_cert !== 'recorded' ? r.to_cert : undefined,
  dep: r.departed_utc, arr: r.arrived_utc,
  zone_evidence: r.evidence, zone_in: r.zone_in_utc,
});

function tally(rows: any[], key: (r: any) => unknown, n = 8) {
  const m = new Map<string, number>();
  for (const r of rows) { const k = String(key(r) ?? ''); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));
}

export function compactForModel(name: string, result: any, maxRows: number): unknown {
  if ((name === 'find_flights' || name === 'airport_movements') && Array.isArray(result?.flights)) {
    const { flights, ...rest } = result;
    return { ...rest, flights_shown: Math.min(maxRows, flights.length), flights_total: result.totals?.flights ?? result.total,
      note: `${result.note ?? ''} Only the first ${Math.min(maxRows, flights.length)} flights are shown here; the user sees the full list. Use the totals and top lists for counts.`,
      flights: flights.slice(0, maxRows).map(legRow) };
  }
  if (Array.isArray(result) && (result.length === 0 || result[0]?.leg_id)) {
    const rows = result.map(legRow);
    return {
      total_rows: result.length,   // the count that answers "how many"
      count_note: 'total_rows is the complete count for the query as asked; any breakdown below is secondary.',
      rows_shown: Math.min(maxRows, rows.length),
      ...(result.length > maxRows ? {
        note: `Only the first ${maxRows} of ${result.length} rows are shown here (the full list is already displayed to the user). Use the summaries below for counts, or narrow the query with filters; do not guess about unseen rows.`,
        summary: {
          evidence: tally(result, r => r.evidence), military: result.filter(r => r.mil).length,
          top_destinations: tally(result, r => r.to_code || r.to_name), top_origins: tally(result, r => r.from_code || r.from_name),
          top_operators: tally(result, r => r.operator), top_types: tally(result, r => r.type),
          by_departure_date: tally(result, r => r.date, 31),   // departure date of the leg, can differ from the zone-entry date
        },
      } : {}),
      rows: rows.slice(0, maxRows),
    };
  }
  if (name === 'get_track' && result?.points) {
    const P = result.points;
    const step = Math.max(1, Math.ceil(P.length / 24));
    return { positions_total: P.length, coverage_gaps: result.coverage_gaps,
      sample_every_n: step, sample: P.filter((_: any, i: number) => i % step === 0).map((p: any) => [new Date(p.t * 1000).toISOString().slice(11, 16), p.lat?.toFixed?.(2), p.lon?.toFixed?.(2), p.alt]),
      note: 'Sampled positions [UTC time, lat, lon, alt ft]. The full track is drawn on the user\'s map.' };
  }
  if (name === 'flight_dossier' && result?.leg) {
    return { leg: legRow(result.leg), aircraft: result.aircraft,
      zones_crossed: result.zones_crossed.map((z: any) => ({ zone: z.zone_id, name: z.zone_name, evidence: z.evidence, in: z.in_utc, out: z.out_utc })),
      same_aircraft_nearby: result.same_aircraft_nearby.map(legRow), sources: result.sources };
  }
  if (Array.isArray(result) && result.length > maxRows) return { total_rows: result.length, rows: result.slice(0, maxRows), note: `first ${maxRows} rows only` };
  return result;
}
