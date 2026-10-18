// Model profiles for the chat/agent harness. Prices: platform.claude.com/docs/en/about-claude/pricing.
// The harness is designed so the cheapest profile works; stronger profiles are for harder questions.

export interface Profile {
  id: 'fast' | 'balanced' | 'deep';
  label: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  web: { search: string; fetch: string };   // server tool versions supported by the model
  fallbacks: boolean;                          // server-side refusal fallback (not available for Haiku)
  rowsForModel: number;                        // how many result rows the model sees (the UI always gets all)
  webUses?: number;                            // web searches (and fetches) allowed per model request
  price: { input: number; output: number; cacheWrite: number; cacheRead: number }; // USD per MTok
  note: string;
}

export const PROFILES: Profile[] = [
  { id: 'fast', label: 'Fast (Haiku 5.5)', model: 'claude-haiku-5-5', effort: 'low',
    web: { search: 'web_search_20250305', fetch: 'web_fetch_20250910' }, fallbacks: false, rowsForModel: 20, webUses: 4,
    price: { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
    note: 'Cheapest. Stand-in for any low-cost model: relies on the harness (compact results, checks).' },
  { id: 'balanced', label: 'Balanced (Sonnet 5.5)', model: 'claude-sonnet-5-5', effort: 'low',
    web: { search: 'web_search_20260209', fetch: 'web_fetch_20260209' }, fallbacks: true, rowsForModel: 30, webUses: 6,
    price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.10 },
    note: 'Good default for analysis.' },
  { id: 'deep', label: 'Deep (Opus 5.5)', model: 'claude-opus-5-5', effort: 'medium',
    web: { search: 'web_search_20260209', fetch: 'web_fetch_20260209' }, fallbacks: true, rowsForModel: 40, webUses: 10,
    price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.20 },
    note: 'Most capable; use for hard synthesis and research briefs.' },
];
export const profileById = (id: string) => PROFILES.find(p => p.id === id) ?? PROFILES[0];
export const WEB_SEARCH_USD = 0.01;   // $10 per 1,000 searches, plus result tokens

export interface Usage { input: number; output: number; cacheWrite: number; cacheRead: number; searches: number; calls: number; usd: number }
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0, calls: 0, usd: 0 });

export function addUsage(u: Usage, p: Profile, api: any) {
  // Haiku 5.5 bills at a higher rate card when a single request's prompt exceeds 100K tokens
  const prompt = (api.input_tokens || 0) + (api.cache_creation_input_tokens || 0) + (api.cache_read_input_tokens || 0);
  const mult = p.model === 'claude-haiku-5-5' && prompt > 100_000 ? 5 : 1;
  const i = api.input_tokens || 0, o = api.output_tokens || 0, w = api.cache_creation_input_tokens || 0, r = api.cache_read_input_tokens || 0;
  const s = api.server_tool_use?.web_search_requests || 0;
  u.input += i; u.output += o; u.cacheWrite += w; u.cacheRead += r; u.searches += s; u.calls += 1;
  u.usd += mult * (i * p.price.input + o * p.price.output + w * p.price.cacheWrite + r * p.price.cacheRead) / 1e6 + s * WEB_SEARCH_USD;
}
