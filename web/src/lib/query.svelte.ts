// The "Find flights" question builder: plain-language fields, turned into find_flights arguments and a readable sentence.
import { app } from './state.svelte';

export type EntityKind = 'country' | 'airport' | 'zone' | 'aircraft' | 'company' | 'callsign';
export interface Entity { kind: EntityKind; value: string; label: string; hint?: string }
export interface Period { preset: string; from: string; to: string }   // preset '' = not chosen yet
export interface QuerySpec { from: Entity | null; to: Entity | null; through: Entity | null; subject: Entity | null; both: boolean; military: boolean; period: Period }

export const blankQuery = (): QuerySpec => ({ from: null, to: null, through: null, subject: null, both: false, military: false, period: { preset: '', from: '', to: '' } });
// the builder's current state (kept while viewing results, so "Edit search" returns to it)
export const builder = $state<{ q: QuerySpec }>({ q: blankQuery() });

const shift = (d: string, days: number) => new Date(Date.parse(d + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
export const PRESETS: { id: string; label: string }[] = [
  { id: '7d', label: 'Last 7 days' }, { id: '30d', label: 'Last 30 days' }, { id: '12m', label: 'Last 12 months' },
  { id: 'oct23', label: 'Since 7 Oct 2023' }, { id: 'all', label: 'Any time' }, { id: 'custom', label: 'Custom' },
];
// [from, to] for a period; dates are clamped to the data's coverage
export function periodDates(p: Period): [string, string] {
  const ds = app.ctx?.manifest.dates ?? [];
  const first = ds[0] ?? '', last = ds[ds.length - 1] ?? '';
  switch (p.preset) {
    case '7d': return [shift(last, -6), last];
    case '30d': return [shift(last, -29), last];
    case '12m': return [shift(last, -364), last];
    case 'oct23': return ['2023-10-07', last];
    case 'custom': return [p.from || first, p.to || last];
    default: return [first, last];
  }
}
export const periodDays = (p: Period) => { const [a, b] = periodDates(p); return a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1 : 0; };

export function toArgs(q: QuerySpec) {
  const [date_from, date_to] = periodDates(q.period);
  const a: Record<string, unknown> = { date_from, date_to };
  if (q.from) a.origin = q.from.value;
  if (q.to) a.destination = q.to.value;
  if (q.both) a.both_directions = true;
  if (q.through) a.through_zone = q.through.value;
  if (q.subject) a[q.subject.kind === 'aircraft' ? 'aircraft' : q.subject.kind === 'callsign' ? 'callsign' : 'company'] = q.subject.value;
  if (q.military) a.military_only = true;
  return a;
}

const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export function periodLabel(p: Period) {
  if (!p.preset) return '';
  if (p.preset === 'custom') { const [a, b] = periodDates(p); return `${fmtDate(a)} – ${fmtDate(b)}`; }
  if (p.preset === 'all') return 'any time';
  return PRESETS.find(x => x.id === p.preset)!.label.replace(/^./, c => c.toLowerCase());
}
// "Flights from United States to Israel through Iceland's airspace, by 4X-ICA, since 7 Oct 2023"
export function describe(q: QuerySpec) {
  const parts = ['Flights'];
  if (q.from && q.to) parts.push(q.both ? `between ${q.from.label} and ${q.to.label}` : `from ${q.from.label} to ${q.to.label}`);
  else if (q.from) parts.push(q.both ? `to or from ${q.from.label}` : `from ${q.from.label}`);
  else if (q.to) parts.push(q.both ? `to or from ${q.to.label}` : `to ${q.to.label}`);
  if (q.through) parts.push(`through ${q.through.label}`);
  if (q.subject) parts.push(q.subject.kind === 'aircraft' ? `by aircraft ${q.subject.label}` : q.subject.kind === 'callsign' ? `with callsign ${q.subject.label}…` : `by ${q.subject.label}`);
  if (q.military) parts.push('(military aircraft only)');
  const per = periodLabel(q.period);
  return parts.join(' ') + (per ? `, ${per}` : '');
}
export const isEmpty = (q: QuerySpec) => !q.from && !q.to && !q.through && !q.subject;
