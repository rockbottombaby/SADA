import { dateRanges } from './tools';
// Deterministic claim check, independent of which model answered: every identifier the answer mentions must appear
// in a tool result (or the user's own messages), and dates must fall inside the dataset coverage. Costs nothing.

const PATTERNS: [string, RegExp][] = [
  ['leg id', /\b[0-9a-f]{6}-\d{9,11}\b/g],
  ['registration', /\b(?:[A-Z]{1,2}\d?-[A-Z0-9]{2,5}|N\d{1,5}[A-Z]{0,2})\b/g],
  ['callsign', /\b[A-Z]{3}\d{1,4}[A-Z]{0,2}\b/g],
  ['ICAO airport', /\b(?:[A-Z]{4})\b/g],
];
// 4-letter words that are not airport codes, and zone-name tokens, to avoid false alarms
const IGNORE = new Set(['BIRD', 'NATO', 'ICAO', 'UTC', 'ADSB', 'FIR', 'CTA', 'NOTE', 'DATA', 'WITH', 'FROM', 'THAT', 'THIS', 'ONLY', 'JSON', 'NULL', 'TRUE', 'NONE', 'SOV', 'ISO2', 'ISO3', 'IATA', 'SOVEREIGN',
  // agencies, programmes and terms that appear in investigative answers and records requests
  'USAF', 'DDTC', 'DSCA', 'ACMI', 'CRAF', 'ITAR', 'FOIA', 'EASA', 'USTC', 'TSAT', 'OFAC', 'UNSC', 'NOTAM', 'SIPRI', 'HTML', 'CSV', 'HTTP', 'NEXT', 'LEAD', 'HIGH', 'MEDIUM', 'WEAK', 'OPEN',
  // ordinary words an answer writes in capitals (headings, emphasis)
  'PORT', 'AREA', 'BASE', 'CASE', 'DATE', 'TIME', 'YEAR', 'UNIT', 'CODE', 'TYPE', 'EAST', 'WEST', 'GULF', 'ARMS', 'WHAT', 'WHEN', 'EACH', 'BOTH', 'MOST', 'LAST', 'ZONE', 'FACT', 'STEP', 'PLAN']);
// ICAO airport codes never start with these letters, so 4-letter words starting with them are not airports
const NOT_ICAO_START = /^[IJQX]/;

export interface VerifyReport { ok: boolean; unverified: { kind: string; value: string }[]; outOfCoverage: string[]; checked: number;
  unverifiedNumbers?: string[]; numbersChecked?: number }

// Numbers the answer states (counts, totals, money) must come from a tool result: every figure of 1,000 or more (and every
// dollar figure with a unit) is looked for in the evidence, digits only, with 1% tolerance for rounding ("about $2.84B"
// matches 2,838,352,474). Years, dates, times, identifiers and coordinates are left alone. Advisory: reported, not a
// reason for a correction round.
const NUM_SKIP = /\bHS\s?\d{2,10}\b|\b(19|20)\d\d\b|\d{4}-\d\d-\d\d|\d\d:\d\d|[0-9a-f]{6}-\d{9,11}|-?\d+\.\d{3,}°?|\d+\.\d+°/g;   // HS codes, years, dates, times, leg ids, coordinates
const NUM = /\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*(?:[kKmMbB]|million|billion|thousand)?\b|\$\s?\d+(?:\.\d+)?\s*(?:[kKmMbB]|million|billion|thousand)\b|\b\d{4,}\b/g;
export function checkNumbers(answer: string, evidence: string): { unverified: string[]; checked: number } {
  const text = answer.replace(NUM_SKIP, ' ');
  const nums = [...evidence.matchAll(/\d{4,}/g)].map(m => Number(m[0]));
  const out: string[] = []; let checked = 0;
  for (const m of text.matchAll(NUM)) {
    const raw = m[0].trim();
    const unit = /billion|[bB]$/.test(raw) ? 1e9 : /million|[mM]$/.test(raw) ? 1e6 : /thousand|[kK]$/.test(raw) ? 1e3 : 1;
    const v = Number(raw.replace(/[$,\s]/g, '').replace(/(million|billion|thousand|[kKmMbB])$/, '')) * unit;
    if (!Number.isFinite(v) || v < 1000) continue;
    checked++;
    if (!nums.some(e => e >= v * 0.99 && e <= v * 1.01)) out.push(raw);
  }
  return { unverified: [...new Set(out)], checked };
}

export function collectEvidence(...items: unknown[]): string {
  return items.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
}

// Airspace claims ("observed over Iceland", "crossed Icelandic airspace") must be backed by a zone result: the evidence has to
// contain that country's sovereign zone id (sov:ISL) or name. Country names in other sentences (destinations etc.) are not checked.
// military aircraft TYPE names look like registrations (C-17, C-130J, KC-135, F-35): mission letters, dash, 1–3 digits
const MIL_TYPE = /^(?:A|B|C|E|F|K|P|T|U|V|KC|EC|RC|MC|HC|AC|WC|MQ|RQ|CV|MV|HH|UH|CH|AH|SH)-\d{1,3}[A-Z]?$/;
const AIRSPACE_WORDS = /\b(airspace|overfl[eoi]w\w*|crossed|crossing|over the territory)\b|\b(observed|seen|recorded|tracked|passed|flew)\b[^.]{0,40}\bover\b/i;
export interface ZoneRef { id: string; name: string; kind: string }
function airspaceClaims(answer: string, evidence: string, zones: ZoneRef[]) {
  const out: { kind: string; value: string }[] = [];
  const countries = zones.filter(z => z.kind === 'sovereign').map(z => ({ id: z.id, country: z.name.split(':')[0].trim() }))
    .filter(c => c.country.length > 3);
  for (const sentence of answer.split(/(?<=[.!?\n])\s+/)) {
    if (!AIRSPACE_WORDS.test(sentence) || /\bFIR\b/.test(sentence) && !/sovereign/i.test(sentence)) continue;
    for (const c of countries) {
      const stem = c.country.replace(/(ia|a|y|e)$/i, '');
      // the country must be tied to the airspace words: "over Iceland", "through Icelandic airspace", "Israel's sovereign
      // airspace", "crossed Iceland"; a destination in the same sentence ("flights to Israel crossed the FIR") is not a claim
      const name = `(?:${c.country}|${stem}\\w*)`;
      const m = new RegExp(`\\b(?:over|through|crossed|crossing|entered|inside|within)\\s+(?:the\\s+)?${name}\\b|\\b${name}(?:'s|n|ic|i)?\\s+(?:sovereign\\s+)?(?:airspace|territory)\\b`, 'i').exec(sentence);
      if (!m) continue;
      // negated mentions ("not Icelandic sovereign airspace", "no evidence it crossed Iceland") are not claims
      if (/\b(not|no|never|without|nor)\b[^.]{0,40}$/i.test(sentence.slice(0, m.index))) continue;
      if (!evidence.includes(c.id) && !evidence.includes(`${c.country}: sovereign`)) out.push({ kind: 'airspace claim (no zone result)', value: c.country });
    }
  }
  return out;
}

export function verifyAnswer(answer: string, evidence: string, coveredDates: string[], zones: ZoneRef[] = [], fullEvidence = ''): VerifyReport {
  const unverified: { kind: string; value: string }[] = [];
  const seen = new Set<string>();
  let checked = 0;
  for (const [kind, re] of PATTERNS) {
    for (const m of answer.matchAll(re)) {
      const v = m[0];
      if (seen.has(v) || IGNORE.has(v) || (kind === 'ICAO airport' && NOT_ICAO_START.test(v)) || (kind === 'registration' && MIL_TYPE.test(v))) continue;
      seen.add(v);
      checked++;
      if (!evidence.includes(v)) unverified.push({ kind, value: v });
    }
  }
  const filtered = [...unverified, ...airspaceClaims(answer, evidence, zones).filter(u => !seen.has('air:' + u.value) && seen.add('air:' + u.value))];
  checked += filtered.length - unverified.length;
  const outOfCoverage = [...new Set([...answer.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)].map(m => m[0]))].filter(d => !coveredDates.includes(d) && !evidence.includes(d));
  const nums = checkNumbers(answer, fullEvidence ? evidence + '\n' + fullEvidence : evidence);
  return { ok: !filtered.length && !outOfCoverage.length, unverified: filtered, outOfCoverage, checked, unverifiedNumbers: nums.unverified, numbersChecked: nums.checked };
}

export function correctionPrompt(r: VerifyReport, covered: string[]) {
  const parts = [];
  const ids = r.unverified.filter(u => !u.kind.startsWith('airspace')), air = r.unverified.filter(u => u.kind.startsWith('airspace'));
  if (ids.length) parts.push(`These identifiers in your answer do not appear in any tool result: ${ids.map(u => `${u.value} (${u.kind})`).join(', ')}.`);
  if (air.length) parts.push(`You made airspace claims about ${air.map(u => u.value).join(', ')} without a zone result for those countries. Check with flight_dossier (zones_crossed) or flights_through_zone, or remove the claims; remember that a FIR crossing is not a sovereign-airspace crossing.`);
  if (r.outOfCoverage.length) parts.push(`These dates are outside the flight dataset (covered: ${dateRanges(covered)}): ${r.outOfCoverage.join(', ')}. Dates from other cited sources are fine if you attribute them.`);
  return `${parts.join(' ')} Check them with the tools or remove them, then give the corrected answer in full. Do not apologise or describe the correction.`;
}
