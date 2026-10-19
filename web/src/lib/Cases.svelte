<script lang="ts">
  // The documented-shipments library in the Explore panel: published cases, filterable, each with what our archive shows
  // and the flights to open. The claims are the sources', shown with their status and the responses.
  import { app, selectLeg, showFlows, type Leg } from './state.svelte';
  import { loadCases, searchCases, STATUS_LABEL, OUTCOME_LABEL, MATCH_LABEL, type CaseLibrary, type ShipmentCase, type CaseLeg } from './cases';
  let lib = $state<CaseLibrary | null>(null), err = $state('');
  let q = $state(app.explore.kind === 'cases' ? app.explore.q ?? '' : ''), country = $state(''), mode = $state(''), only = $state(false);
  loadCases().then(l => (lib = l)).catch(e => (err = String(e)));
  // opened again with a search (from the flight sheet): take it over
  $effect(() => { if (app.explore.kind === 'cases' && app.explore.q != null) q = app.explore.q; });
  const shown = $derived(lib ? searchCases(lib, { q, country, mode }).filter(c => !only || ['exact', 'nearby', 'dark'].includes(c.sada.match)) : []);
  const legOf = (l: CaseLeg): Leg => ({ leg_id: l.leg_id, hex: l.hex, t0: Date.parse(l.date) / 1000, t1: Date.parse(l.date) / 1000, callsigns: l.callsign, reg: l.reg, type: l.type, from_code: l.from, to_code: l.to, date: l.date, evidence: l.evidence } as unknown as Leg);
  // draw every matched flight of the shown cases on the map
  async function mapAll() {
    const legs: Leg[] = [];
    for (const c of shown) for (const l of c.sada.legs) legs.push(legOf(l));
    showFlows(legs, `Documented shipments: ${legs.length} flights`);
    if (app.mobile) app.tab = 'map';
  }
  const route = (c: ShipmentCase) => [c.origin, c.transit, c.destination].filter(s => s && !/^not /i.test(s)).join(' → ');
</script>

<div class="cases">
  <p class="lead">Published reports and official statements about weapons movements since 2023, with what the flight archive shows for each. These are the sources’ claims with their status, not SADA findings.</p>
  <div class="filters">
    <input class="q" placeholder="Operator, aircraft, cargo, place…" bind:value={q} />
    <div class="row">
      <select bind:value={country}><option value="">All destinations</option><option>Israel</option><option>Ukraine</option></select>
      <select bind:value={mode}><option value="">Air, sea and land</option><option value="air">Air</option><option value="sea">Sea</option><option value="land">Land</option></select>
      <label class="check"><input type="checkbox" bind:checked={only} /> In the archive</label>
    </div>
  </div>
  {#if err}<div class="err">{err}</div>
  {:else if !lib}<div class="muted">Loading the library…</div>
  {:else}
    <div class="count"><span class="label">{shown.length} of {lib.cases.length} cases</span>{#if shown.some(c => c.sada.legs.length)}<button onclick={mapAll}>Map the flights</button>{/if}</div>
    {#each shown as c (c.id)}
      <article class="case">
        <div class="top"><span class="d">{c.date}{c.date_precision !== 'day' ? ' ~' : ''}</span><span class="mode">{c.mode}</span><span class="st {c.evidence_status}">{STATUS_LABEL[c.evidence_status] ?? c.evidence_status}</span></div>
        <b>{c.vehicle}</b>
        <div class="op">{c.operator}</div>
        <div class="rt">{route(c)}</div>
        <p class="cargo">{c.cargo}</p>
        <div class="meta">{OUTCOME_LABEL[c.delivery_outcome] ?? c.delivery_outcome} · <a href={c.source_url} target="_blank" rel="noopener noreferrer">{c.source} ↗</a>{#if c.secondary_url} · <a href={c.secondary_url} target="_blank" rel="noopener noreferrer">more ↗</a>{/if}</div>
        {#if c.operator_response}<p class="resp"><span>Operator:</span> {c.operator_response}</p>{/if}
        {#if c.government_response}<p class="resp"><span>Government:</span> {c.government_response}</p>{/if}
        {#if c.notes}<p class="note">{c.notes}</p>{/if}
        {#if c.mode === 'air'}
          <div class="sada" class:hit={c.sada.legs.length > 0}>
            <span class="label">In the archive</span> <span class="m">{MATCH_LABEL[c.sada.match]}</span>{#if c.sada.note} <span class="mn">{c.sada.note}</span>{/if}
            {#each c.sada.legs as l (l.leg_id)}
              <button class="leg" onclick={() => selectLeg(legOf(l))} title="Open this flight"><b>{l.callsign || l.reg}</b> <span>{l.reg}{l.type ? ' · ' + l.type : ''}</span> <i>{l.from || '?'} → {l.to || '?'}</i> <small>{l.date}</small></button>
            {/each}
          </div>
        {/if}
      </article>
    {/each}
    <p class="foot">{lib.cases.length} cases, {lib.aggregates.length} aggregate statements · library built {lib.built_utc.slice(0, 10)} · <a href={lib.method} target="_blank" rel="noopener noreferrer">method and licence (CC BY)</a></p>
  {/if}
</div>

<style>
  .cases { display: flex; flex-direction: column; gap: 10px; }
  .lead { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--muted); }
  .filters { display: flex; flex-direction: column; gap: 8px; }
  .q { width: 100%; padding: 10px 12px; font-size: 13px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .row select { font-size: 11.5px; padding: 6px 8px; }
  .check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .count { display: flex; justify-content: space-between; align-items: center; } .count button { font-size: 9.5px; padding: 6px 10px; }
  .case { border-top: 1px solid var(--line); padding: 12px 0 6px; display: flex; flex-direction: column; gap: 4px; }
  .top { display: flex; gap: 8px; align-items: center; font-size: 10.5px; color: var(--muted); font-family: var(--mono); }
  .mode { text-transform: uppercase; letter-spacing: 1.2px; font-size: 9.5px; }
  .st { margin-left: auto; font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.2px; padding: 1px 7px; border: 1px solid var(--line2); border-radius: 3px; font-family: inherit; }
  .st.official_confirmation { color: var(--ok); border-color: rgba(143,214,164,.5); } .st.records_supported { color: var(--ink); }
  .st.alleged, .st.disputed { color: var(--obs); border-color: rgba(242,193,78,.5); }
  .case > b { font-size: 13.5px; color: var(--ink); }
  .op, .rt { font-size: 12px; color: var(--muted); } .rt { font-family: var(--mono); font-size: 11.5px; }
  .cargo { margin: 2px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--text); }
  .meta { font-size: 11.5px; color: var(--muted); } .meta a { color: var(--ink); }
  .resp, .note { margin: 2px 0 0; font-size: 11.5px; line-height: 1.45; color: var(--muted); } .resp span { color: var(--ink); }
  .sada { margin-top: 6px; padding: 8px 10px; border: 1px dashed var(--line2); border-radius: var(--r); font-size: 11.5px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
  .sada.hit { border-style: solid; } .sada .m { color: var(--ink); } .sada .mn { color: var(--faint); }
  .leg { display: flex; gap: 8px; align-items: baseline; width: 100%; text-align: left; border: 0; border-top: 1px solid var(--line); border-radius: 0; padding: 6px 0; text-transform: none; letter-spacing: 0; font-size: 12px; }
  .leg b { font-family: var(--mono); color: var(--ink); } .leg span { color: var(--muted); font-family: var(--mono); font-size: 11px; } .leg i { font-style: normal; font-family: var(--mono); color: var(--text); } .leg small { margin-left: auto; color: var(--faint); font-family: var(--mono); }
  .leg:hover { background: rgba(232,232,232,.05); color: inherit; }
  .foot { font-size: 11px; color: var(--faint); margin: 8px 0 0; line-height: 1.5; }
  .err { color: var(--sov); font-size: 12px; }
  @media (hover: none) { .leg:hover { background: transparent; } }
</style>
