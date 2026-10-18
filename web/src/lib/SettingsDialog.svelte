<script lang="ts">
  import { app } from './state.svelte';
  import { settings, saveSettings } from './prefs.svelte';
  import { PROFILES, profileById } from './models';
  import { perfTable, clearPerf } from './perf';
  let perf = $state(perfTable());
</script>

{#if app.settingsOpen}
  <div class="backdrop" role="presentation" onclick={() => (app.settingsOpen = false)}></div>
  <div class="dialog" role="dialog" aria-label="Settings">
    <div class="label">Settings</div>
    <h3>Keys and models</h3>
    <label class="field"><span>Anthropic API key</span><input type="password" bind:value={settings.apiKey} placeholder="sk-ant-…" autocomplete="off" /></label>
    <small>Stored only in this browser; sent only to api.anthropic.com. <button class="link" onclick={() => { app.settingsOpen = false; app.keySetupOpen = true; }}>Don’t have a key? Step-by-step guide →</button></small>
    <div class="two">
      <label class="field"><span>Assistant model</span><select bind:value={settings.profile}>{#each PROFILES as p}<option value={p.id}>{p.label}</option>{/each}</select></label>
      <label class="field"><span>Research model</span><select bind:value={settings.researchProfile}>{#each PROFILES as p}<option value={p.id}>{p.label}</option>{/each}</select></label>
    </div>
    <small>{profileById(settings.profile).note}</small>
    <details class="src"><summary>Other data sources (optional)</summary>
      <label class="field"><span>US Census API key</span><input type="password" bind:value={settings.censusKey} autocomplete="off" /></label>
      <small>Official US export statistics. Free, instant: <a href="https://api.census.gov/data/key_signup.html" target="_blank" rel="noopener noreferrer">api.census.gov/data/key_signup.html</a></small>
      <div class="two">
        <label class="field"><span>OpenSky client id</span><input bind:value={settings.openskyId} autocomplete="off" /></label>
        <label class="field"><span>OpenSky secret</span><input type="password" bind:value={settings.openskySecret} autocomplete="off" /></label>
      </div>
      <small>Free account at opensky-network.org → Account → API client. Requests go through the SADA proxy below (OpenSky blocks browsers).</small>
      <label class="field"><span>SADA proxy URL</span><input bind:value={settings.proxyBase} placeholder="https://live.example.org" /></label>
      <small>Relays live ADSB.lol positions and OpenSky, which browsers cannot reach directly. Set by the site; change only if you run your own.</small>
    </details>
    <details class="src"><summary>Performance (this browser)</summary>
      {#if perf.length}
        <table class="perf"><thead><tr><th>Tool</th><th>runs</th><th>typical</th><th>slowest 5%</th></tr></thead>
          <tbody>{#each perf as r}<tr><td>{r.tool.replace(/_/g, ' ')}</td><td>{r.n}</td><td>{(r.p50 / 1000).toFixed(1)} s</td><td>{(r.p95 / 1000).toFixed(1)} s</td></tr>{/each}</tbody></table>
        <small>Time each assistant tool took, from this browser's research trails. <button class="link" onclick={() => { clearPerf(); perf = []; }}>Clear</button></small>
      {:else}<small>No timings yet; they appear after the assistant has run some tools.</small>{/if}
    </details>
    <label class="field"><span>Data source URL</span><input bind:value={settings.dataUrl} /></label>
    <small>Where the Parquet files are served. Changing it needs a page reload.</small>
    <div class="row"><button onclick={() => (app.settingsOpen = false)}>Cancel</button>
      <button class="primary" onclick={() => { saveSettings(); app.settingsOpen = false; }}>Save</button></div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(8,8,8,.6); backdrop-filter: blur(12px) grayscale(.4); -webkit-backdrop-filter: blur(12px) grayscale(.4); z-index: 50; }
  .dialog { position: fixed; z-index: 51; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(520px, 92vw); max-height: 90vh; overflow: auto; background: var(--bg);
    border: 1px solid var(--line2); border-radius: var(--r); padding: 24px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 40px 100px rgba(0,0,0,.6); }
  h3 { margin: 2px 0 12px; font-size: 18px; font-weight: 600; }
  .field { margin-top: 8px; }
  small { color: var(--faint); font-size: 11px; margin-top: -4px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .src { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 12px 0; margin: 6px 0; }
  .src[open] { gap: 10px; } .src summary { cursor: pointer; font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.6px; color: var(--muted); }
  .src[open] summary { margin-bottom: 8px; }
  .perf { width: 100%; border-collapse: collapse; font-size: 11.5px; } .perf th { text-align: left; font-weight: 500; color: var(--muted); font-size: 9.5px; text-transform: uppercase; letter-spacing: 1px; padding: 4px 6px 4px 0; }
  .perf td { padding: 4px 6px 4px 0; border-top: 1px solid var(--line); font-family: var(--mono); } .perf td:first-child { font-family: inherit; }
  .link { border: 0; padding: 0; background: none; color: var(--ink); text-decoration: underline; text-transform: none; letter-spacing: 0; font-size: 11px; cursor: pointer; }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
</style>
