// Per-tool timings across sessions (from the research trail's finished steps), so "it feels slow" becomes a number:
// p50 and p95 per tool, kept in this browser only (last 300 runs per tool).
const KEY = 'sada.perf';
type Store = Record<string, number[]>;
function load(): Store { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }
export function recordTiming(tool: string, ms: number) {
  if (!(ms > 0) || tool.startsWith('map_')) return;
  const st = load(); (st[tool] ??= []).push(Math.round(ms)); if (st[tool].length > 300) st[tool] = st[tool].slice(-300);
  try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* storage unavailable */ }
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
export function perfTable() {
  return Object.entries(load()).map(([tool, xs]) => ({ tool, n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), last: xs[xs.length - 1] }))
    .sort((a, b) => b.p95 - a.p95);
}
export function clearPerf() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
