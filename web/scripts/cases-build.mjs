// Builds web/public/cases.json, the documented-shipments library the app and the assistant read, from oam/cases/
// (cases.csv, aggregates.csv, matches.json). usage: node scripts/cases-build.mjs
import fs from 'node:fs';
const ROOT = new URL('../../cases/', import.meta.url).pathname, OUT = new URL('../public/cases.json', import.meta.url).pathname;
function csv(text) {
  const rows = [], re = /("([^"]|"")*"|[^,\n\r]*)(,|\r?\n|$)/g;
  let row = [], m;
  text = text.replace(/^﻿/, '');
  while ((m = re.exec(text)) && m[0] !== '') { row.push(m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1]); if (m[3] !== ',') { rows.push(row); row = []; } }
  const [head, ...body] = rows.filter(r => r.length > 1 || r[0]);
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
const cases = csv(fs.readFileSync(ROOT + 'cases.csv', 'utf8')), aggregates = csv(fs.readFileSync(ROOT + 'aggregates.csv', 'utf8'));
const matches = fs.existsSync(ROOT + 'matches.json') ? JSON.parse(fs.readFileSync(ROOT + 'matches.json', 'utf8')) : { cases: {} };
const none = v => !v || /^not identified in reviewed source$/i.test(v) ? '' : v;
const out = {
  built_utc: new Date().toISOString().slice(0, 16) + 'Z',
  licence: 'CC BY 4.0. Facts, brief attributions and links compiled from published reporting and official statements; the claims are the sources\', not SADA findings.',
  method: 'https://github.com/rockbottombaby/SADA/blob/main/cases/README.md',
  matched_utc: matches.matched_utc || '',
  cases: cases.map(c => {
    const m = matches.cases[c.case_id];
    return {
      id: c.case_id, country: c.country, date: c.event_date, date_precision: c.date_precision, event_type: c.event_type, mode: c.mode,
      vehicle: c.vehicle_or_reference, operator: c.operator, origin: c.origin, transit: c.transit_points, destination: c.destination,
      cargo: c.reported_cargo, quantity: c.quantity, unit: c.unit, evidence_status: c.evidence_status, delivery_outcome: c.delivery_outcome,
      source: c.source_name, source_url: c.source_url, secondary_url: c.secondary_url, operator_response: none(c.operator_response), government_response: none(c.government_response),
      notes: c.notes, linked_case: c.linked_case,
      // what the SADA flight archive shows for this case
      sada: c.mode === 'air' ? { match: m?.match ?? 'none', note: m?.note ?? '', legs: m?.legs ?? [] } : { match: 'n/a', note: 'Not an air movement.', legs: [] },
    };
  }),
  aggregates: aggregates.map(a => ({ id: a.aggregate_id, country: a.country, period_start: a.period_start, period_end: a.period_end, scope: a.scope, metrics: a.metrics, source: a.source_name, source_url: a.source_url, note: a.note })),
};
fs.writeFileSync(OUT, JSON.stringify(out));
const n = out.cases.filter(c => c.sada.match !== 'none' && c.sada.match !== 'n/a').length;
console.log(`cases.json: ${out.cases.length} cases (${out.cases.filter(c => c.mode === 'air').length} air, ${n} corroborated in the archive), ${out.aggregates.length} aggregates, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
