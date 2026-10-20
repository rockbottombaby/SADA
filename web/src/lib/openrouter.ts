// OpenRouter as a second way to run the assistant: one login ("Sign in with OpenRouter", OAuth PKCE, no app registration),
// one key kept in this browser, any of the models below. The harness keeps its Anthropic-shaped messages and tools; this
// file translates them to and from OpenRouter's OpenAI-style chat API for each model call, so the loop in agent.ts, the
// evidence tags and the answer checker stay exactly the same whichever provider runs the model.
// Web search here is a normal tool the model calls; it runs as a small OpenRouter request with the web plugin (Exa).
import type { Usage } from './models';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const APP_HEADERS = { 'HTTP-Referer': 'https://sadawatch.com', 'X-Title': 'SADA' };   // OpenRouter's app attribution (optional)

// ---------- models ----------
export interface ORModel { id: string; label: string; tier: 'fast' | 'balanced' | 'deep'; tested: boolean; note?: string }
// tested = scored on SADA's evaluation questions. Claude models are the same ones the Anthropic path uses.
export const OPENROUTER_MODELS: ORModel[] = [
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5 · fast', tier: 'fast', tested: true },
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 · balanced', tier: 'balanced', tested: true },
  { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5 · deep', tier: 'deep', tested: true },
  { id: 'openai/gpt-5-mini', label: 'GPT-5 mini · fast', tier: 'fast', tested: false },
  { id: 'openai/gpt-5.2', label: 'GPT-5.2 · balanced', tier: 'balanced', tested: false },
  { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash · fast', tier: 'fast', tested: false },
  { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro · balanced', tier: 'balanced', tested: false },
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro · balanced', tier: 'balanced', tested: false },
  { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6 · balanced', tier: 'balanced', tested: false },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash · fast', tier: 'fast', tested: false },
  { id: 'z-ai/glm-5.3', label: 'GLM 5.3 · balanced', tier: 'balanced', tested: false },
  { id: 'z-ai/glm-5.3-prime', label: 'GLM 5.3 Prime · deep', tier: 'deep', tested: false },
];
export const orModel = (id: string) => OPENROUTER_MODELS.find(m => m.id === id) ?? { id, label: id, tier: 'balanced' as const, tested: false };

// ---------- sign in (OAuth PKCE) ----------
const b64url = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function startOpenRouterSignIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem('or.verifier', verifier);
  const back = `${location.origin}/`;   // OpenRouter appends ?code=… to this
  location.href = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(back)}&code_challenge=${challenge}&code_challenge_method=S256&key_label=${encodeURIComponent('SADA · ' + location.host)}`;   // one key per browser and site; the label says which
}
// On page load: if OpenRouter sent us back with a code, exchange it for the key (and clean the URL). Returns the key or null.
export async function finishOpenRouterSignIn(): Promise<string | null> {
  const code = new URLSearchParams(location.search).get('code');
  const verifier = sessionStorage.getItem('or.verifier');
  if (!code || !verifier) return null;
  sessionStorage.removeItem('or.verifier');
  history.replaceState(null, '', location.pathname);
  const r = await fetch(`${OPENROUTER_API}/auth/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }) });
  if (!r.ok) throw new Error(r.status === 403 ? 'The sign-in code was not accepted (it may have expired; try again).' : `OpenRouter sign-in failed (${r.status}).`);
  const { key } = await r.json();
  if (!key) throw new Error('OpenRouter returned no key.');
  return String(key);
}
// the key's own account info (credits left); proves the key works
export async function openrouterKeyInfo(apiKey: string): Promise<{ label?: string; usage?: number; limit?: number | null }> {
  const r = await fetch(`${OPENROUTER_API}/auth/key`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!r.ok) throw Object.assign(new Error(`OpenRouter did not accept this key (${r.status}).`), { status: r.status });
  return (await r.json()).data ?? {};
}

// account credits: what is left to spend (shown in Settings and on the setup screen)
export async function openrouterCredits(apiKey: string): Promise<{ balance: number; used: number } | null> {
  try {
    const r = await fetch(`${OPENROUTER_API}/credits`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (r.ok) { const d = (await r.json()).data ?? {}; return { balance: Number(d.total_credits || 0) - Number(d.total_usage || 0), used: Number(d.total_usage || 0) }; }
    const k = await openrouterKeyInfo(apiKey);   // a key without account access: at least what this key has spent
    return { balance: NaN, used: Number(k.usage || 0) };
  } catch { return null; }
}
export const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/settings/credits';

// ---------- message translation (Anthropic shapes → OpenAI chat) ----------
type Block = any;
export function toOpenAI(system: string, messages: { role: string; content: any }[], cache: boolean) {
  const out: any[] = [{ role: 'system', content: cache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const blocks: Block[] = m.content;
    if (m.role === 'user') {
      // tool results become one tool message each; plain text parts become a user message
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      for (const b of blocks) if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${c}` : c });
      }
      if (text) out.push({ role: 'user', content: text });
    } else {
      // thinking and server-tool blocks belong to the Anthropic path only
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      const calls = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg: any = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      if (text || calls.length) out.push(msg);
    }
  }
  return out;
}

export interface ORTurn {
  content: Block[];                                  // Anthropic-shaped: text and tool_use blocks
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; cost: number };
}

// One model turn, streamed. onText gets answer text as it arrives; onPhase gets Thinking / Writing / Preparing <tool>.
export async function openrouterTurn(o: {
  apiKey: string; model: string; effort: 'low' | 'medium' | 'high'; system: string; messages: any[];
  tools: { name: string; description: string; input_schema: any }[]; signal?: AbortSignal; maxTokens?: number;
  onText: (t: string) => void; onThink?: (t: string) => void; onPhase: (p: string) => void; onActivity: () => void;
}): Promise<ORTurn> {
  const body: any = {
    model: o.model, stream: true, max_tokens: o.maxTokens ?? 32000,
    messages: toOpenAI(o.system, o.messages, o.model.startsWith('anthropic/')),
    tools: o.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    parallel_tool_calls: true,
    reasoning: { effort: o.effort },
  };
  const r = await fetch(`${OPENROUTER_API}/chat/completions`, { method: 'POST', signal: o.signal,
    headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json', ...APP_HEADERS }, body: JSON.stringify(body) });
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => '');
    const msg = (() => { try { return JSON.parse(t)?.error?.message; } catch { return ''; } })() || t.slice(0, 200);
    throw Object.assign(new Error(r.status === 401 ? 'OpenRouter did not accept the key. Sign in again.' : r.status === 402 ? 'Your OpenRouter credits are used up. Add credits at openrouter.ai.' : `OpenRouter error ${r.status}: ${msg}`), { status: r.status, api: true });
  }
  let text = '', reasoning = false, phase = '';
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finish = '', usage: any = null;
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  const setPhase = (p: string) => { if (p !== phase) { phase = p; o.onPhase(p); } };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    o.onActivity();
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j: any; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw Object.assign(new Error(j.error.message || 'OpenRouter error'), { api: true });
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta ?? {};
      if (d.reasoning) { if (!reasoning) { reasoning = true; setPhase('Thinking'); } if (typeof d.reasoning === 'string') o.onThink?.(d.reasoning); }
      if (d.content) { text += d.content; setPhase('Writing'); o.onText(d.content); }
      for (const tc of d.tool_calls ?? []) {
        const k = tc.index ?? 0;
        const cur = calls.get(k) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) { cur.name = tc.function.name; setPhase(`Preparing ${cur.name.replace(/_/g, ' ')}`); }
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(k, cur);
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  const content: Block[] = [];
  if (text) content.push({ type: 'text', text });
  for (const [, c] of [...calls].sort((a, b) => a[0] - b[0])) {
    let input: any = {};
    try { input = c.args.trim() ? JSON.parse(c.args) : {}; } catch { throw new Error(`malformed tool call arguments for ${c.name}`); }
    content.push({ type: 'tool_use', id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: c.name, input });
  }
  const stop_reason: ORTurn['stop_reason'] = finish === 'tool_calls' || calls.size ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn';
  const u = usage ?? {};
  return { content, stop_reason, usage: {
    input_tokens: (u.prompt_tokens || 0) - (u.prompt_tokens_details?.cached_tokens || 0), output_tokens: u.completion_tokens || 0,
    cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens || 0, cache_creation_input_tokens: u.prompt_tokens_details?.cache_write_tokens || 0,
    cost: Number(u.cost) || 0 } };
}

// ---------- web search as a tool ----------
export const OR_WEB_SEARCH_TOOL = {
  name: 'web_search',
  description: 'Search the web (news, official statements, company and registry pages). Returns the top results with title, URL and an extract. Cite the URL of anything you use.',
  input_schema: { type: 'object', properties: { query: { type: 'string', description: 'what to search for; include names, callsigns, dates' } }, required: ['query'] },
};
export interface WebResult { url: string; title?: string; content?: string }
// A small request with OpenRouter's web plugin (Exa): the cheap model only lists what the search returned; the
// citations carry the URLs and extracts, which is what the investigating model needs.
export async function openrouterWebSearch(apiKey: string, query: string, signal?: AbortSignal): Promise<{ summary: string; results: WebResult[]; cost: number }> {
  const r = await fetch(`${OPENROUTER_API}/chat/completions`, { method: 'POST', signal,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...APP_HEADERS },
    // a non-reasoning model: a reasoning one spends the output budget thinking and returns an empty list
    body: JSON.stringify({ model: 'openai/gpt-4.1-mini', max_tokens: 1200, temperature: 0, plugins: [{ id: 'web', engine: 'exa', max_results: 8 }],
      messages: [{ role: 'user', content: `Web search: ${query}\n\nFor each result you were given write one line: "- title — url: what it says that is relevant to the search (one or two sentences)". Keep every result. Do not add anything that is not in the results.` }] }) });
  if (!r.ok) throw new Error(`web search failed (${r.status})`);
  const j = await r.json();
  const m = j.choices?.[0]?.message ?? {};
  const results: WebResult[] = (m.annotations ?? []).filter((a: any) => a.type === 'url_citation').map((a: any) => ({ url: a.url_citation.url, title: a.url_citation.title, content: a.url_citation.content?.slice(0, 1500) }));
  return { summary: String(m.content ?? ''), results, cost: Number(j.usage?.cost) || 0 };
}

export function addOpenRouterUsage(u: Usage, t: ORTurn['usage'], extraCost = 0) {
  u.input += t.input_tokens; u.output += t.output_tokens; u.cacheRead += t.cache_read_input_tokens; u.cacheWrite += t.cache_creation_input_tokens;
  u.calls += 1; u.usd += t.cost + extraCost;
}
