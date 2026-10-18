<script lang="ts">
  import { md } from './markdown';
  import { app, selectLeg, closeInspector, fmt, hm, dur, countryName } from './state.svelte';
  import { kvGet, kvSet } from './idb';
  import { runAgent, systemPrompt, RESEARCH_BRIEF, StoppedError, type Citation } from './agent';
  import { settings } from './prefs.svelte';
  import { hasKey, activeKey, activeProfile } from './prefs.svelte';
  import { profileById } from './models';

  let note = $state(''), noteState = $state('');
  let research: { text: string; citations: Citation[]; at: string; model: string } | null = $state(null);
  let running = $state(false), log: string[] = $state([]), live = $state('');
  let abort: AbortController | null = null;
  let tab = $state<'overview' | 'research' | 'notes'>('overview');

  // while a flight loads, the draft holds what has arrived so far; missing parts show as shimmering placeholders
  const d = $derived(app.inspectorDraft ?? app.dossier);
  const loading = $derived(!!app.inspectorDraft && !app.inspectorDraft.error);
  const leg = $derived(d?.leg);
  const sov = $derived((d?.zones_crossed ?? []).filter((z: any) => z.zone_id.startsWith('sov:')));
  const fir = $derived((d?.zones_crossed ?? []).filter((z: any) => !z.zone_id.startsWith('sov:')));
  const short = (name: string) => name.replace(/: sovereign airspace \([^)]*\)/, '').replace(/ FIR$/, '');

  $effect(() => {
    const id = leg?.leg_id;
    if (!id) return;
    note = ''; research = null; log = []; live = ''; tab = 'overview';
    kvGet<string>('note:' + id).then(v => (note = v || ''));
    kvGet<any>('research:' + id).then(v => (research = v || null));
  });
  async function saveNote() { await kvSet('note:' + leg.leg_id, note); noteState = 'saved in this browser'; }
  async function runResearch() {
    if (!hasKey()) { app.keySetupOpen = true; return; }
    running = true; log = []; live = ''; abort = new AbortController(); tab = 'research';
    try {
      const prof = activeProfile('researchProfile');
      const out = await runAgent({
        apiKey: activeKey(), profile: prof, ctx: app.ctx!, web: true, signal: abort.signal, system: systemPrompt(app.ctx!), maxTurns: 20,
        messages: [{ role: 'user', content: `${RESEARCH_BRIEF}\n\nDossier (from the flight database):\n${JSON.stringify({ leg: d.leg, aircraft: d.aircraft, zones_crossed: d.zones_crossed, same_aircraft_nearby: d.same_aircraft_nearby })}` }],
        onEvent: e => {
          if (e.type === 'text') live += e.text;
          else if (e.type === 'server_tool') log = [...log, `🔎 ${String((e.input as any)?.query ?? (e.input as any)?.url ?? e.name).slice(0, 90)}`];
          else if (e.type === 'tool_call') log = [...log, `⚙ ${e.name}`];
        },
      });
      research = { text: out.text, citations: out.citations, at: new Date().toISOString(),
        model: `${prof.label} · $${out.usage.usd.toFixed(3)}${out.report && !out.report.ok ? ' · ⚠ unverified: ' + [...out.report.unverified.map(u => u.value), ...out.report.outOfCoverage].join(', ') : ''}` };
      await kvSet('research:' + leg.leg_id, $state.snapshot(research));
    } catch (e) { log = [...log, e instanceof StoppedError || abort?.signal.aborted ? 'Stopped.' : 'Error: ' + String(e)]; }
    running = false;
  }
  function cite() {
    const zs = d.zones_crossed.map((z: any) => `${z.zone_name} ${z.evidence} ${z.in_utc}–${String(z.out_utc).slice(11)}`).join('; ');
    navigator.clipboard.writeText(`${leg.callsigns || leg.reg} (${leg.reg}, ${leg.type}, ICAO ${leg.hex}), ${leg.from_name} → ${leg.to_name}, ${leg.departed_utc}–${leg.arrived_utc}. Zones: ${zs}. Source: ADSB.lol globe_history (ODbL), processed by SADA.`);
    app.status = 'Citation copied';
  }
</script>

<svelte:window onkeydown={e => { if (e.key === 'Escape' && app.inspectorOpen) closeInspector(); }} />

{#if app.inspectorOpen && d}
  <div class="scrim" role="presentation" onclick={closeInspector}></div>
  <aside class="sheet" role="dialog" aria-modal="true" aria-label="Flight details">
    <header>
      {#if !leg}<div class="id"><div class="label">Flight</div><div class="sk" style="width:180px;height:26px;margin-top:6px"></div><div class="sk" style="width:260px;height:12px;margin-top:10px"></div></div>{:else}
      <div class="id in">
        <div class="label">Flight</div>
        <div class="cs">{String(leg.callsigns || '').split(' ').filter(Boolean).join(' · ') || leg.reg || '(no callsign)'}</div>
        <div class="ac">
          {#if leg.reg}<span class="reg">{leg.reg}</span>{/if}
          <span>{leg.desc || leg.type || 'Unknown type'}</span>
          {#if leg.operator}<span class="dot">{leg.operator}</span>{/if}
          {#if leg.mil}<span class="tag mil">military</span>{/if}
        </div>
      </div>{/if}
      <button class="x" title="Close (Esc)" aria-label="Close" onclick={closeInspector}>✕</button>
    </header>

    {#if !leg}
    <div class="route">
      <div class="end"><div class="sk" style="width:84px;height:30px"></div><div class="sk" style="width:120px;height:11px;margin-top:8px"></div></div>
      <div class="mid"><span class="line"></span></div>
      <div class="end r"><div class="sk" style="width:84px;height:30px;margin-left:auto"></div><div class="sk" style="width:120px;height:11px;margin-top:8px;margin-left:auto"></div></div>
    </div>
    {:else}
    <div class="route in">
      <div class="end">
        <div class="ap" class:unc={leg.from_cert !== 'recorded'} title={leg.from_cert}>{leg.from_code || '?'}</div>
        <div class="nm">{leg.from_name || 'Unknown'}</div>
        <div class="tm">{fmt(leg.t0)} UTC</div>
        {#if leg.from_cert !== 'recorded'}<div class="cert">{leg.from_cert}</div>{/if}
      </div>
      <div class="mid"><span class="line"></span><span class="dur">{dur(leg.t1 - leg.t0)}</span><span class="line"></span></div>
      <div class="end r">
        <div class="ap" class:unc={leg.to_cert !== 'recorded'} title={leg.to_cert}>{leg.to_code || '?'}</div>
        <div class="nm">{leg.to_name || 'Unknown'}</div>
        <div class="tm">{fmt(leg.t1)} UTC</div>
        {#if leg.to_cert !== 'recorded'}<div class="cert">{leg.to_cert}</div>{/if}
      </div>
    </div>
    {/if}

    <nav class="seg">
      <button class:on={tab === 'overview'} onclick={() => (tab = 'overview')}>Overview</button>
      <button class:on={tab === 'research'} onclick={() => (tab = 'research')}>Research{research ? ' ✓' : ''}</button>
      <button class:on={tab === 'notes'} onclick={() => (tab = 'notes')}>Notes{note ? ' •' : ''}</button>
    </nav>

    <div class="body">
      {#if d.error}<p class="err">Could not load this flight: {d.error}</p>{/if}
      {#if tab === 'overview'}
        {#if !d.zones_crossed}
        <section><h4>Countries' airspace crossed</h4><div class="chips">{#each [70, 96, 58] as w}<span class="sk chip-sk" style="width:{w}px"></span>{/each}</div></section>
        <section><h4>Flight regions (FIRs) crossed</h4><div class="chips">{#each [88, 64, 110, 76] as w}<span class="sk chip-sk" style="width:{w}px"></span>{/each}</div></section>
        {:else}
        <section class="in">
          <h4>Countries' airspace crossed</h4>
          <div class="chips">{#each sov as z}<span class="chip sov {z.evidence}" title="{z.evidence} · {hm(z.t_in)}–{hm(z.t_out)} UTC">{short(z.zone_name)}{z.evidence === 'inferred' ? ' · inferred' : ''}</span>{:else}<span class="none">None recorded</span>{/each}</div>
        </section>
        <section class="in">
          <h4>Flight regions (FIRs) crossed</h4>
          <div class="chips">{#each fir as z}<span class="chip fir {z.evidence}" class:hl={z.zone_id === app.map.focusZone} title="{z.evidence} · {hm(z.t_in)}–{hm(z.t_out)} UTC">{short(z.zone_name)}</span>{:else}<span class="none">None recorded</span>{/each}</div>
          <p class="hint">Solid = seen by receivers (observed) · dashed = estimated across a coverage gap (inferred). Country airspace is approximate (coast + 12 nm); Iceland's is the official 12 nm line.</p>
          <details><summary>Exact times</summary>
            <table><tbody>{#each d.zones_crossed as z}<tr><td>{short(z.zone_name)}</td><td class="ev">{z.evidence}</td><td class="t">{hm(z.t_in)}–{hm(z.t_out)}</td></tr>{/each}</tbody></table>
          </details>
        </section>
        {/if}
        {#if !d.same_aircraft_nearby}
        <section><h4>Same aircraft, ±3 days</h4><div class="nbs">{#each [0, 1, 2] as _}<div class="nb"><span class="sk" style="width:130px"></span><span class="sk" style="width:70px"></span><span class="sk" style="width:110px"></span></div>{/each}</div></section>
        {:else}
        <section class="in">
          <h4>Same aircraft, ±3 days</h4>
          <div class="nbs">
            {#each d.same_aircraft_nearby as n}
              <button class="nb" class:cur={n.leg_id === leg.leg_id} onclick={() => selectLeg(n)}>
                <span class="d">{n.date} <i>{hm(n.t0)}</i></span><b>{String(n.callsigns || '').split(' ')[0] || '—'}</b><span class="rt">{n.from_code || '?'} → {n.to_code || '?'}</span>
              </button>
            {/each}
          </div>
        </section>
        <section class="in">
          <h4>Sources</h4>
          {#each d.sources ?? [] as s}<div class="src">{#if s.url}<a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>{:else}{s.title}: {s.detail}{/if}</div>{/each}
        </section>
        {/if}
      {:else if tab === 'research'}
        <p class="hint">Searches the web for this aircraft, callsign and route, and writes a short brief with sources. Uses {profileById(settings.researchProfile).label}.</p>
        <div class="actions"><button class="primary" disabled={running || loading} onclick={runResearch}>{running ? 'Researching…' : research ? 'Research again' : 'Research this flight'}</button>
          {#if running}<button onclick={() => abort?.abort()}>Stop</button>{/if}</div>
        {#if log.length}<div class="log">{#each log as l}<div>{l}</div>{/each}</div>{/if}
        {#if running && live}<div class="md live">{@html md(live)}</div>{/if}
        {#if research && !running}
          <div class="md">{@html md(research.text)}</div>
          {#if research.citations.length}<div class="cites">{#each research.citations as c, i}<a href={c.url} target="_blank" rel="noopener noreferrer">[{i + 1}] {c.title || c.url}</a>{/each}</div>{/if}
          <p class="hint">{research.model} · {research.at.slice(0, 16).replace('T', ' ')} UTC · saved in this browser</p>
        {/if}
      {:else}
        <textarea bind:value={note} oninput={() => (noteState = 'unsaved')} placeholder="Leads, contacts, open questions… (stored in this browser only)"></textarea>
        <div class="actions"><span class="hint">{noteState}</span><button onclick={saveNote}>Save note</button></div>
      {/if}
    </div>

    <footer>
      <button class="ghost" disabled={loading} onclick={cite}>Copy citation</button>
      <button class="ghost" onclick={() => navigator.clipboard.writeText(location.href)}>Copy link</button>
      <span class="sp"></span>
      {#if loading}<span class="legid loading">loading flight…</span>{/if}
      <span class="legid">{leg?.leg_id ?? app.inspectorDraft?.id}</span>
    </footer>
  </aside>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 40; background: rgba(8, 8, 8, .6); backdrop-filter: blur(12px) grayscale(.4); -webkit-backdrop-filter: blur(12px) grayscale(.4); animation: fade .2s ease-out; }
  .sheet { position: fixed; z-index: 41; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(720px, calc(100vw - 32px)); max-height: min(86vh, 900px);
    display: flex; flex-direction: column; overflow: hidden; background: var(--bg); border: 1px solid var(--line2); border-radius: var(--r);
    box-shadow: 0 40px 100px rgba(0,0,0,.6); animation: pop .22s cubic-bezier(.2,.8,.2,1); }
  @keyframes fade { from { opacity: 0; } } @keyframes pop { from { opacity: 0; transform: translate(-50%, -48%); } }
  header { display: flex; justify-content: space-between; gap: 12px; padding: 22px 24px 8px; }
  .cs { font-size: 24px; font-weight: 600; letter-spacing: -.3px; margin-top: 4px; }
  .ac { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; color: var(--muted); font-size: 12px; margin-top: 6px; }
  .reg { font-family: var(--mono); color: var(--ink); border: 1px solid var(--line2); padding: 0 6px; border-radius: 3px; font-size: 11.5px; }
  .dot::before { content: '/'; margin-right: 10px; color: var(--faint); }
  .tag.mil { color: var(--mil); border-color: rgba(199,166,255,.5); }
  .x { width: 34px; height: 34px; padding: 0; letter-spacing: 0; font-size: 12px; flex: none; }
  .route { display: grid; grid-template-columns: 1fr minmax(90px, 170px) 1fr; align-items: center; gap: 14px; margin: 16px 24px 6px; padding: 18px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .end.r { text-align: right; }
  .ap { font-size: 28px; font-weight: 500; font-family: var(--mono); letter-spacing: 1px; } .ap.unc { color: var(--muted); }
  .nm { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
  .tm { font-size: 11px; color: var(--faint); margin-top: 3px; font-family: var(--mono); }
  .cert { display: inline-block; margin-top: 6px; font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--obs); border: 1px solid rgba(242,193,78,.45); padding: 0 6px; border-radius: 3px; }
  .mid { display: flex; align-items: center; gap: 8px; }
  .line { flex: 1; height: 0; border-top: 1px dashed var(--line2); }
  .dur { font-size: 11px; font-family: var(--mono); white-space: nowrap; color: var(--muted); }
  .seg { display: flex; margin: 10px 24px 0; border-bottom: 1px solid var(--line); }
  .seg button { flex: none; border: 0; border-radius: 0; color: var(--faint); padding: 10px 14px 9px; margin-bottom: -1px; border-bottom: 1px solid transparent; font-size: 9.5px; }
  .seg button:first-child { padding-left: 0; }
  .seg button:hover { background: transparent; color: var(--ink); } .seg button.on { color: var(--ink); border-bottom-color: var(--ink); }
  .body { overflow: auto; padding: 4px 24px 20px; flex: 1; }
  section { padding: 16px 0; border-bottom: 1px solid var(--line); } section:last-child { border-bottom: 0; }
  h4 { margin: 0 0 10px; font-size: 9.5px; font-weight: 500; text-transform: uppercase; letter-spacing: 2px; color: var(--muted); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 11.5px; padding: 2px 9px; border-radius: 3px; border: 1px solid; font-family: var(--mono); }
  .chip.sov { color: var(--sov); border-color: rgba(255,138,128,.5); }
  .chip.fir { color: var(--obs); border-color: rgba(242,193,78,.45); }
  .chip.inferred { border-style: dashed; } .chip.hl { background: rgba(242,193,78,.12); }
  .none { font-size: 12px; color: var(--faint); }
  .hint { color: var(--faint); font-size: 11.5px; margin: 12px 0 0; line-height: 1.55; }
  details summary { cursor: pointer; font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.6px; color: var(--muted); margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; } td { padding: 5px 4px 5px 0; border-bottom: 1px solid var(--line); }
  td.ev { color: var(--muted); font-size: 11px; } td.t { text-align: right; color: var(--muted); white-space: nowrap; font-family: var(--mono); font-size: 11.5px; }
  .nbs { display: flex; flex-direction: column; border-top: 1px solid var(--line); }
  .nb { display: grid; grid-template-columns: 160px 100px 1fr; gap: 8px; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 8px 4px;
    font-size: 12px; text-transform: none; letter-spacing: 0; font-family: var(--mono); }
  .nb:hover { background: rgba(232,232,232,.04); color: var(--text); } .nb.cur { box-shadow: inset 2px 0 0 var(--ink); background: rgba(232,232,232,.06); }
  .nb .d { color: var(--muted); } .nb i { font-style: normal; color: var(--faint); margin-left: 6px; }
  .src { font-size: 12.5px; padding: 3px 0; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
  .log { font-size: 11px; color: var(--faint); margin-top: 10px; font-family: var(--mono); } .md { font-size: 13.5px; line-height: 1.65; } .md.live { opacity: .75; }
  .cites { display: flex; flex-direction: column; gap: 4px; font-size: 12px; margin-top: 10px; } .cites a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; align-self: flex-start; max-width: 100%; }
  textarea { width: 100%; min-height: 200px; margin-top: 12px; }
  footer { display: flex; align-items: center; gap: 8px; padding: 12px 24px; border-top: 1px solid var(--line); }
  .ghost { font-size: 9.5px; padding: 6px 10px; }
  /* skeleton placeholders: a soft light sweeps across while the part loads; real content fades in when it arrives */
  .sk { display: block; height: 12px; border-radius: 3px; background: linear-gradient(90deg, rgba(232,232,232,.05) 0%, rgba(232,232,232,.13) 40%, rgba(232,232,232,.05) 80%);
    background-size: 300% 100%; animation: shimmer 1.4s ease-in-out infinite; }
  .chip-sk { display: inline-block; height: 21px; }
  .nb .sk { align-self: center; }
  @keyframes shimmer { from { background-position: 100% 0; } to { background-position: -50% 0; } }
  .in { animation: rise .35s ease-out both; }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } }
  .legid.loading { color: var(--muted); animation: fade 1s ease-in-out infinite alternate; }
  .err { color: var(--sov); font-size: 12.5px; margin: 14px 0 0; }
  @media (prefers-reduced-motion: reduce) { .sk, .in, .legid.loading { animation: none; } }
  .sp { flex: 1; } .legid { font-size: 10.5px; color: var(--faint); font-family: var(--mono); }
  /* phones: a bottom sheet, the route stacked, wider touch targets */
  @media (max-width: 760px) {
    .scrim { backdrop-filter: none; -webkit-backdrop-filter: none; background: rgba(8,8,8,.7); }
    .sheet { left: 0; right: 0; top: auto; bottom: 0; transform: none; width: 100%; max-height: calc(100dvh - 44px); border-radius: 14px 14px 0 0; border-bottom: 0; animation: rise .25s cubic-bezier(.2,.8,.2,1); }
    @keyframes rise { from { transform: translateY(40px); opacity: 0; } }
    header { padding: 18px 18px 6px; }
    .route { grid-template-columns: 1fr; gap: 6px; margin: 12px 18px 4px; padding: 14px 0; }
    .end.r { text-align: left; } .mid { display: none; }
    .ap { font-size: 24px; }
    .x { width: 40px; height: 40px; }
    .nb { grid-template-columns: 1fr 1fr; }
  }
</style>
