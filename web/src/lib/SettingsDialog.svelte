<script lang="ts">
  // Settings, in the order that matters: 1 the assistant (sign in with OpenRouter; an Anthropic key is the alternative),
  // 2 the model, 3 the free data sources that make answers better. The technical URLs sit under "Advanced".
  import { app } from './state.svelte';
  import { settings, saveSettings } from './prefs.svelte';
  import { PROFILES, profileById } from './models';
  import { OPENROUTER_MODELS, startOpenRouterSignIn, openrouterCredits, OPENROUTER_CREDITS_URL } from './openrouter';
  import { perfTable, clearPerf } from './perf';
  let perf = $state(perfTable());
  let credits = $state<{ balance: number; used: number } | null>(null);
  $effect(() => { if (app.settingsOpen && settings.openrouterKey) openrouterCredits(settings.openrouterKey).then(c => (credits = c)); else credits = null; });
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const TIERS: { id: 'fast' | 'balanced' | 'deep'; label: string }[] = [{ id: 'fast', label: 'Fast and cheap' }, { id: 'balanced', label: 'Balanced' }, { id: 'deep', label: 'Deep' }];
  let showAnthropic = $state(false);
  $effect(() => { if (app.settingsOpen) showAnthropic = !!settings.apiKey; });
  const signOut = () => { settings.openrouterKey = ''; if (settings.apiKey) settings.provider = 'anthropic'; saveSettings(); };
</script>

{#if app.settingsOpen}
  <div class="backdrop" role="presentation" onclick={() => (app.settingsOpen = false)}></div>
  <div class="dialog" role="dialog" aria-label="Settings">
    <div class="label">Settings</div>

    <section>
      <h3><span class="n">1</span>Assistant</h3>
      {#if settings.openrouterKey}
        <div class="status ok">
          <i></i>
          <div>
            <b>Signed in with OpenRouter</b>
            <small>{#if credits && Number.isFinite(credits.balance)}{usd(credits.balance)} of credit left · {usd(credits.used)} spent{:else if credits}{usd(credits.used)} spent{:else}Checking your balance…{/if}
              · <a href={OPENROUTER_CREDITS_URL} target="_blank" rel="noopener noreferrer">Add credits ↗</a> · <button class="link" onclick={signOut}>Sign out</button></small>
          </div>
          {#if settings.provider !== 'openrouter'}<button class="use" onclick={() => { settings.provider = 'openrouter'; saveSettings(); }}>Use</button>{:else}<span class="active">in use</span>{/if}
        </div>
      {:else}
        <div class="status">
          <i></i>
          <div><b>Sign in with OpenRouter</b><small>Log in with OpenRouter to enable your AI model. Claude, GPT, Gemini and more; you pay only for what you use.</small></div>
          <button class="primary" onclick={startOpenRouterSignIn}>Sign in</button>
        </div>
      {/if}
      <button class="link alt" onclick={() => (showAnthropic = !showAnthropic)}>{showAnthropic ? 'Hide' : 'Or use an Anthropic API key'}</button>
      {#if showAnthropic}
        <div class="alt-box">
          <label class="field"><span>Anthropic API key</span><input type="password" bind:value={settings.apiKey} placeholder="sk-ant-…" autocomplete="off" /></label>
          <small>Runs the Claude models on your own Anthropic account; the key stays in this browser. <button class="link" onclick={() => { app.settingsOpen = false; app.keySetupOpen = true; }}>How to get one</button>
            {#if settings.apiKey}· {#if settings.provider === 'anthropic'}<span class="active">in use</span>{:else}<button class="link" onclick={() => { settings.provider = 'anthropic'; saveSettings(); }}>Use this instead</button>{/if}{/if}</small>
        </div>
      {/if}
    </section>

    <section>
      <h3><span class="n">2</span>Model</h3>
      {#if settings.provider === 'openrouter'}
        <label class="field"><span>Model</span>
          <select bind:value={settings.openrouterModel}>
            {#each TIERS as t}<optgroup label={t.label}>{#each OPENROUTER_MODELS.filter(m => m.tier === t.id) as m}<option value={m.id}>{m.label.replace(/ · (fast|balanced|deep)$/, '')}</option>{/each}</optgroup>{/each}
          </select></label>
        <small>Start with a fast model; switch to a deeper one for long investigations. SADA's test questions are scored on the Claude models.</small>
      {:else}
        <div class="two">
          <label class="field"><span>Chat</span><select bind:value={settings.profile}>{#each PROFILES as p}<option value={p.id}>{p.label}</option>{/each}</select></label>
          <label class="field"><span>Flight research</span><select bind:value={settings.researchProfile}>{#each PROFILES as p}<option value={p.id}>{p.label}</option>{/each}</select></label>
        </div>
        <small>{profileById(settings.profile).note}</small>
      {/if}
    </section>

    <section>
      <h3><span class="n">3</span>Better answers</h3>
      <p class="why">Two free sources the assistant can use once connected. Both take a couple of minutes to set up.</p>
      <div class="src-card">
        <div class="src-head"><i class:on={!!settings.censusKey}></i><b>US arms-export figures</b><a href="https://api.census.gov/data/key_signup.html" target="_blank" rel="noopener noreferrer">Get a free key ↗</a></div>
        <small>Official US Census trade statistics by month and customs port. Lets the assistant compare export peaks with the flights that left those airports.</small>
        <label class="field"><span>Census API key</span><input type="password" bind:value={settings.censusKey} autocomplete="off" placeholder="paste the key from the Census email" /></label>
      </div>
      <div class="src-card">
        <div class="src-head"><i class:on={!!(settings.openskyId && settings.openskySecret)}></i><b>OpenSky flight lookups</b><a href="https://opensky-network.org" target="_blank" rel="noopener noreferrer">Free account ↗</a></div>
        <small>A second tracking network: extra departures, arrivals and aircraft lookups. In your OpenSky account, open API client and copy the id and secret.</small>
        <div class="two">
          <label class="field"><span>Client id</span><input bind:value={settings.openskyId} autocomplete="off" /></label>
          <label class="field"><span>Secret</span><input type="password" bind:value={settings.openskySecret} autocomplete="off" /></label>
        </div>
      </div>
    </section>

    <details class="adv"><summary>Advanced</summary>
      <label class="field"><span>Data source URL</span><input bind:value={settings.dataUrl} /></label>
      <small>Where the flight archive is served. Change only if you run your own copy; needs a page reload.</small>
      <label class="field"><span>Live-data proxy URL</span><input bind:value={settings.proxyBase} placeholder="https://live.example.org" /></label>
      <small>Relays live positions and OpenSky, which browsers cannot reach directly. Change only if you run your own.</small>
      {#if perf.length}
        <table class="perf"><thead><tr><th>Tool</th><th>runs</th><th>typical</th><th>slowest 5%</th></tr></thead>
          <tbody>{#each perf as r}<tr><td>{r.tool.replace(/_/g, ' ')}</td><td>{r.n}</td><td>{(r.p50 / 1000).toFixed(1)} s</td><td>{(r.p95 / 1000).toFixed(1)} s</td></tr>{/each}</tbody></table>
        <small>How long each assistant tool took in this browser. <button class="link" onclick={() => { clearPerf(); perf = []; }}>Clear</button></small>
      {/if}
    </details>

    <div class="row"><button onclick={() => (app.settingsOpen = false)}>Cancel</button>
      <button class="primary" onclick={() => { saveSettings(); app.settingsOpen = false; }}>Save</button></div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(8,8,8,.6); backdrop-filter: blur(12px) grayscale(.4); -webkit-backdrop-filter: blur(12px) grayscale(.4); z-index: 50; }
  .dialog { position: fixed; z-index: 51; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(540px, 92vw); max-height: 90vh; overflow: auto; background: var(--bg);
    border: 1px solid var(--line2); border-radius: var(--r); padding: 24px 26px; display: flex; flex-direction: column; gap: 6px; box-shadow: 0 40px 100px rgba(0,0,0,.6); }
  section { padding: 14px 0 16px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
  h3 { display: flex; align-items: center; gap: 10px; margin: 0 0 2px; font-size: 15px; font-weight: 600; color: var(--ink); }
  .n { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line2); display: grid; place-items: center; font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .status { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid rgba(120,165,255,.35); background: rgba(90,140,255,.06); border-radius: var(--r); }
  .status.ok { border-color: var(--line2); background: rgba(232,232,232,.03); }
  .status > div { flex: 1; min-width: 0; } .status b { display: block; font-size: 13.5px; color: var(--ink); }
  .status i { width: 8px; height: 8px; border-radius: 50%; background: var(--line2); flex: none; } .status.ok i { background: var(--ok, #7fd1a0); }
  .status small, .src-card small, section > small, .adv small { color: var(--muted); font-size: 11.5px; line-height: 1.5; margin: 0; }
  .active { color: var(--ok, #7fd1a0); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; }
  .use { font-size: 9.5px; padding: 6px 12px; }
  .alt { align-self: flex-start; color: var(--muted); font-size: 11.5px; }
  .alt-box { border: 1px solid var(--line); border-radius: var(--r); padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
  .field { margin-top: 2px; }
  .why { margin: 0; font-size: 12.5px; color: var(--muted); }
  .src-card { border: 1px solid var(--line); border-radius: var(--r); padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
  .src-head { display: flex; align-items: center; gap: 8px; font-size: 13px; } .src-head b { flex: 1; color: var(--ink); }
  .src-head i { width: 7px; height: 7px; border-radius: 50%; background: var(--line2); } .src-head i.on { background: var(--ok, #7fd1a0); }
  .src-head a { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; text-decoration: none; color: var(--muted); border: 1px solid var(--line2); border-radius: 3px; padding: 4px 8px; }
  .src-head a:hover { color: var(--ink); border-color: var(--ink); }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .adv { padding: 12px 0; display: flex; flex-direction: column; gap: 8px; }
  .adv summary { cursor: pointer; font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.6px; color: var(--muted); }
  .perf { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-top: 6px; } .perf th { text-align: left; font-weight: 500; color: var(--muted); font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.2px; padding: 0 6px 4px 0; }
  .perf td { padding: 4px 6px 4px 0; border-top: 1px solid var(--line); font-family: var(--mono); } .perf td:first-child { font-family: inherit; }
  .link { border: 0; padding: 0; background: none; color: var(--ink); text-decoration: underline; text-transform: none; letter-spacing: 0; font-size: 11.5px; cursor: pointer; }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  @media (max-width: 760px) { .dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 24px); padding: 18px 16px; } }
</style>
