<script lang="ts">
  // Guided setup of the Anthropic key, for people who have never used an API: what the assistant gives them,
  // what it costs, how to get a key step by step, and a live check that the pasted key works.
  import Anthropic from '@anthropic-ai/sdk';
  import { app } from './state.svelte';
  import { settings, saveSettings } from './prefs.svelte';

  const CONSOLE = 'https://console.anthropic.com';
  let path = $state<'have' | 'need'>('need');
  let key = $state(settings.apiKey);
  let check = $state<{ state: 'idle' | 'checking' | 'ok' | 'bad'; msg?: string }>({ state: settings.apiKey ? 'ok' : 'idle' });

  $effect(() => { if (app.keySetupOpen) { key = settings.apiKey; path = settings.apiKey ? 'have' : 'need'; check = { state: settings.apiKey ? 'ok' : 'idle' }; } });

  async function connect() {
    const k = key.trim();
    if (!k) { check = { state: 'bad', msg: 'Paste your key in the box first.' }; return; }
    if (!k.startsWith('sk-ant-')) { check = { state: 'bad', msg: 'That does not look like an Anthropic key. It should start with “sk-ant-”. Copy it again from the Anthropic Console.' }; return; }
    check = { state: 'checking' };
    try {
      // listing the models costs nothing and proves the key works
      await new Anthropic({ apiKey: k, dangerouslyAllowBrowser: true }).models.list({ limit: 1 });
      settings.apiKey = k; saveSettings();
      check = { state: 'ok' };
    } catch (e: any) {
      const s = e?.status;
      check = { state: 'bad', msg:
        s === 401 ? 'Anthropic did not accept this key. Check that you copied all of it (it is long), or create a new one.' :
        s === 403 ? 'This key is not allowed to use the API. Check that the key is active in the Anthropic Console.' :
        s === 429 ? 'The key works, but Anthropic is busy or the account has hit a limit. Try again in a minute.' :
        'Could not reach Anthropic. Check your internet connection and try again.' };
      if (s === 429) { settings.apiKey = k; saveSettings(); }
    }
  }
  function remove() { settings.apiKey = ''; saveSettings(); key = ''; check = { state: 'idle' }; }
  const close = () => (app.keySetupOpen = false);
</script>

<svelte:window onkeydown={e => { if (e.key === 'Escape' && app.keySetupOpen) close(); }} />

{#if app.keySetupOpen}
  <div class="backdrop" role="presentation" onclick={close}></div>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Set up the assistant">
    <button class="x" aria-label="Close" onclick={close}>✕</button>
    <div class="label">Assistant</div>
    <h3>Turn on the assistant</h3>
    <p class="lead">An AI research partner (Claude, made by Anthropic). Ask in plain words: it searches the flight data for you, shows the results on the map, and checks every flight it names against the data.</p>

    <ul class="gets">
      <li><b>Answers questions</b><span>“Which cargo flights went from the US to Israel through Icelandic airspace last month?”</span></li>
      <li><b>Follows leads</b><span>Tracks an aircraft over time, compares flights with US export figures and government contracts.</span></li>
      <li><b>Helps you write</b><span>Summaries with sources, and drafts of freedom-of-information requests.</span></li>
    </ul>

    <div class="why">
      <b>Why do I need a key?</b>
      <p>This site is free and has no accounts. The AI runs on your own Anthropic account, so you pay Anthropic directly for what you use: usually <b>about 1 cent per question</b>, a few cents for deep research. $5 of credit lasts a long time. Exploring flights and the map work without a key.</p>
    </div>

    {#if check.state === 'ok'}
      <div class="done">
        <div class="tick">✓</div>
        <div><b>Connected. The assistant is ready.</b><p>Your key is saved in this browser only.</p></div>
      </div>
      <div class="row"><button class="ghost" onclick={remove}>Remove key</button><span class="sp"></span><button class="primary" onclick={close}>Start asking</button></div>
    {:else}
      <div class="tabs">
        <button class:on={path === 'need'} onclick={() => (path = 'need')}>Help me get a key</button>
        <button class:on={path === 'have'} onclick={() => (path = 'have')}>I already have a key</button>
      </div>

      {#if path === 'need'}
        <ol class="steps">
          <li><b>Create an Anthropic account.</b> It is free to sign up; use your email or Google.
            <a class="btn" href={CONSOLE} target="_blank" rel="noopener noreferrer">Open Anthropic Console ↗</a></li>
          <li><b>Add some credit.</b> Go to Billing and add $5 (enough for hundreds of questions).
            <span class="tip">Tip: under Limits, set a monthly spending limit so you can never spend more than you planned.</span>
            <a class="btn" href="{CONSOLE}/settings/billing" target="_blank" rel="noopener noreferrer">Open Billing ↗</a></li>
          <li><b>Create a key.</b> Go to API keys → Create key, name it “SADA”, and copy it. It starts with <code>sk-ant-</code>.
            <a class="btn" href="{CONSOLE}/settings/keys" target="_blank" rel="noopener noreferrer">Open API keys ↗</a></li>
          <li><b>Paste it here.</b></li>
        </ol>
      {/if}

      <div class="paste">
        <input type="password" bind:value={key} placeholder="Paste your key here (sk-ant-…)" autocomplete="off" spellcheck="false"
          onkeydown={e => { if (e.key === 'Enter') connect(); }} />
        <button class="primary" disabled={check.state === 'checking'} onclick={connect}>{check.state === 'checking' ? 'Checking…' : 'Connect'}</button>
      </div>
      {#if check.state === 'bad'}<p class="bad">{check.msg}</p>{/if}
    {/if}

    <p class="safe">🔒 Your key stays in this browser and is sent only to Anthropic, never to us. You can remove it here at any time, or delete it in the Anthropic Console.</p>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(8,8,8,.6); backdrop-filter: blur(12px) grayscale(.4); -webkit-backdrop-filter: blur(12px) grayscale(.4); z-index: 50; animation: fade .2s ease-out; }
  .dialog { position: fixed; z-index: 51; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(560px, calc(100vw - 32px)); max-height: 90vh; overflow: auto; background: var(--bg);
    border: 1px solid var(--line2); border-radius: var(--r); padding: 26px 26px 20px; box-shadow: 0 40px 100px rgba(0,0,0,.6); animation: pop .22s cubic-bezier(.2,.8,.2,1); }
  @keyframes fade { from { opacity: 0; } } @keyframes pop { from { opacity: 0; transform: translate(-50%, -48%); } }
  .x { position: absolute; top: 18px; right: 18px; width: 32px; height: 32px; padding: 0; font-size: 12px; letter-spacing: 0; }
  h3 { margin: 4px 0 8px; font-size: 20px; font-weight: 600; letter-spacing: -.2px; }
  .lead { color: var(--muted); font-size: 13.5px; line-height: 1.6; margin: 0 0 14px; }
  .gets { list-style: none; margin: 0 0 14px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .gets li { display: flex; flex-direction: column; gap: 2px; padding-left: 14px; border-left: 1px solid var(--line2); font-size: 13px; }
  .gets span { color: var(--muted); font-size: 12.5px; line-height: 1.5; }
  .why { background: rgba(232,232,232,.04); border: 1px solid var(--line); border-radius: var(--r); padding: 12px 14px; font-size: 13px; }
  .why p { margin: 4px 0 0; color: var(--muted); line-height: 1.6; font-size: 12.5px; } .why p b { color: var(--ink); font-weight: 500; }
  .tabs { display: flex; gap: 0; margin: 18px 0 4px; border-bottom: 1px solid var(--line); }
  .tabs button { border: 0; border-radius: 0; padding: 10px 14px 9px 0; margin-right: 14px; margin-bottom: -1px; border-bottom: 1px solid transparent; color: var(--faint); font-size: 9.5px; }
  .tabs button:hover { background: transparent; color: var(--ink); } .tabs button.on { color: var(--ink); border-bottom-color: var(--ink); }
  .steps { margin: 12px 0 4px; padding-left: 20px; display: flex; flex-direction: column; gap: 12px; font-size: 13px; line-height: 1.55; }
  .steps li::marker { color: var(--faint); font-family: var(--mono); font-size: 11px; }
  .steps b { font-weight: 500; }
  .tip { display: block; color: var(--muted); font-size: 12px; margin-top: 3px; }
  .btn { display: inline-block; margin-top: 6px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.4px; border: 1px solid var(--line2); border-radius: 3px; padding: 6px 10px; color: var(--ink); text-decoration: none; }
  .btn:hover { background: rgba(232,232,232,.06); }
  code { font-family: var(--mono); font-size: 12px; border: 1px solid var(--line2); border-radius: 3px; padding: 0 4px; }
  .paste { display: flex; gap: 8px; margin-top: 14px; } .paste input { flex: 1; min-width: 0; }
  .bad { color: var(--sov); font-size: 12.5px; line-height: 1.5; margin: 8px 0 0; }
  .done { display: flex; gap: 12px; align-items: center; margin-top: 18px; padding: 14px; border: 1px solid var(--line2); border-radius: var(--r); font-size: 13.5px; }
  .done p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
  .tick { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; border: 1px solid var(--ink); flex: none; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 14px; } .sp { flex: 1; }
  .ghost { font-size: 9.5px; }
  .safe { color: var(--faint); font-size: 11.5px; line-height: 1.55; margin: 18px 0 0; padding-top: 12px; border-top: 1px solid var(--line); }
  @media (prefers-reduced-motion: reduce) { .backdrop, .dialog { animation: none; } }
</style>
