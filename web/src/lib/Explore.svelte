<script lang="ts">
  // Explore: one "Find flights" question builder in plain language, results with an overview first, then the list.
  // Designed for journalists and researchers, not aviation experts: no codes needed, the period is always chosen by the user.
  import { app, tool, showFlows, clearScene, countryName, togglePin, type Leg } from './state.svelte';
  import { builder, blankQuery, PRESETS, periodDates, periodDays, periodLabel, toArgs, describe, isEmpty, type QuerySpec, type Entity } from './query.svelte';
  import EntityField from './EntityField.svelte';
  import FlightRow from './FlightRow.svelte';
  import Cases from './Cases.svelte';

  let res: any = $state(null), busy = $state(false), err = $state(''), seconds = $state(0), filter = $state('');
  let needPeriod = $state(false);
  const q = $derived(builder.q);



  const shown = $derived(!res ? [] : !filter ? res.flights : res.flights.filter((l: any) =>
    `${l.callsigns} ${l.reg} ${l.type} ${l.operator} ${l.from_code} ${l.to_code} ${l.from_name} ${l.to_name}`.toLowerCase().includes(filter.toLowerCase())));

  function find() {
    if (!q.period.preset) { needPeriod = true; return; }
    needPeriod = false;
    app.explore = { kind: 'query', spec: $state.snapshot(builder.q) as QuerySpec };
  }
  // one search at a time: starting another (or leaving) stops the previous one's queries, so nothing waits behind a search
  // the user has abandoned
  let job: AbortController | null = null;
  const stopSearch = () => { job?.abort(); job = null; };
  async function load(spec: QuerySpec) {
    stopSearch();
    const mine = (job = new AbortController());
    busy = true; err = ''; res = null; filter = '';
    const t = performance.now();
    try {
      const args = toArgs(spec);
      [app.dateFrom, app.dateTo] = periodDates(spec.period);
      const r = await tool('find_flights', { ...args, limit: app.mobile ? 1200 : 3000 }, mine.signal);
      if (mine.signal.aborted) return;
      res = r;
      showFlows(res.flights as Leg[], describe(spec), spec.through ? { zone: spec.through.value } : {});
    } catch (e) { if (mine.signal.aborted) return; err = String(e).replace(/^Error: /, ''); }
    busy = false; seconds = (performance.now() - t) / 1000;
  }
  async function loadArea(ring: [number, number][]) {
    if (!q.period.preset || periodDays(q.period) > 31) { err = 'Choose a period of at most 31 days in the search form first: area searches read every day in the period.'; res = null; return; }
    busy = true; err = ''; const t = performance.now();
    try {
      const [date_from, date_to] = periodDates(q.period);
      const legs = await tool('flights_through_area', { polygon: ring, date_from, date_to, limit: 3000 });
      res = { flights: legs, totals: { flights: legs.length }, per_month: [], top_routes: [], top_aircraft: [], top_companies: [], top_destination_countries: [], top_origin_countries: [] };
      showFlows(legs, `${legs.length.toLocaleString()} flights through the drawn area, ${periodLabel(q.period)}`, { area: ring });
    } catch (e) { err = String(e).replace(/^Error: /, ''); }
    busy = false; seconds = (performance.now() - t) / 1000;
  }
  $effect(() => {
    const v = app.explore;
    if (v.kind === 'query') load(v.spec);
    else if (v.kind === 'area') loadArea(v.ring);
    else if (v.kind === 'list') { res = { flights: v.legs, totals: { flights: v.legs.length }, per_month: [], top_routes: [], top_aircraft: [], top_companies: [], top_destination_countries: [], top_origin_countries: [] }; showFlows(v.legs, v.title); }
    else { res = null; if (v.kind === 'cases' || v.kind === 'pins') stopSearch(); }
  });

  // refine: click an item in the overview to narrow the search
  function refine(patch: Partial<QuerySpec>) { Object.assign(builder.q, patch); app.explore = { kind: 'query', spec: $state.snapshot(builder.q) as QuerySpec }; }
  const ent = (kind: Entity['kind'], value: string, label = value): Entity => ({ kind, value, label });
  function refineRoute(route: string) {
    const [a, b] = route.split(' → ');
    refine({ from: a && a !== '?' ? ent('airport', a) : null, to: b && b !== '?' ? ent('airport', b) : null, both: false });
  }
  function home(keep = true) { stopSearch(); busy = false; app.explore = { kind: 'home' }; res = null; if (!keep) { builder.q = blankQuery(); if (app.map.scene?.by === 'you') clearScene(); } }
  function ask() {
    const v = app.explore; if (v.kind !== 'query') return;
    app.chatDraft = `${describe(v.spec)}: what stands out, and what should I look at next? (Search used: find_flights ${JSON.stringify(toArgs(v.spec))})`;
    if (app.mobile) app.tab = 'ask';
  }
  function exportCsv() {
    const cols = ['leg_id', 'date', 'departed_utc', 'arrived_utc', 'callsigns', 'reg', 'hex', 'type', 'operator', 'mil', 'from_code', 'from_name', 'from_country', 'from_cert',
      'to_code', 'to_name', 'to_country', 'to_cert', 'evidence', 'zone_in_utc', 'zone_out_utc'];
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const title = app.explore.kind === 'query' ? describe(app.explore.spec) : 'Flights';
    const lines = [`# ${title}`, `# Source: ADSB.lol globe_history (ODbL 1.0), processed by SADA; exported ${new Date().toISOString()}. "inferred" = estimated across a receiver coverage gap.`,
      cols.join(','), ...res.flights.map((l: any) => cols.map(c => esc(l[c])).join(','))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `${title.replace(/[^\w]+/g, '-').slice(0, 80)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }
  const maxMonth = $derived(res?.per_month?.length ? Math.max(...res.per_month.map((m: any) => Number(m.flights))) : 0);
  const cov = $derived(app.ctx?.manifest.dates ?? []);
</script>

{#if app.explore.kind === 'home'}
  <div class="home">
    <div class="label">Find flights</div>
    <h2>What do you want to find out?</h2>
    <p class="lead" title="Fill in what you know and leave the rest empty. Data covers {cov[0]} to {cov[cov.length - 1]}; some days may be missing.">Fill in what you know.</p>

    <div class="form">
      <!-- one per row: a picked place (name + code) needs the full width -->
      <EntityField label="From" placeholder="Country or airport" kinds="place" bind:value={builder.q.from} />
      <EntityField label="To" placeholder="Country or airport" kinds="place" bind:value={builder.q.to} />
      <label class="check" title="Also include flights in the opposite direction (or, with only one place, flights to and from it)"><input type="checkbox" bind:checked={builder.q.both} /> Both directions</label>
      <EntityField label="Through airspace" placeholder="A country or flight region" kinds="zone" bind:value={builder.q.through} />
      <EntityField label="Aircraft, airline or callsign" placeholder="Tail number, airline or callsign" kinds="subject" bind:value={builder.q.subject} />

      <div class="period" class:need={needPeriod}>
        <div class="label">Period</div>
        <div class="chips">
          {#each PRESETS as p}<button class:on={builder.q.period.preset === p.id} onclick={() => { builder.q.period.preset = p.id; needPeriod = false; }}>{p.label}</button>{/each}
        </div>
        {#if builder.q.period.preset === 'custom'}
          <div class="two dates">
            <label class="field"><span>From date</span><input type="date" bind:value={builder.q.period.from} min={cov[0]} max={cov[cov.length - 1]} /></label>
            <label class="field"><span>To date</span><input type="date" bind:value={builder.q.period.to} min={cov[0]} max={cov[cov.length - 1]} /></label>
          </div>
        {/if}
        {#if needPeriod}<p class="warn">Choose a period first.</p>
{/if}
      </div>

      <label class="check"><input type="checkbox" bind:checked={builder.q.military} /> Military aircraft only</label>
      <button class="primary go" disabled={isEmpty(builder.q)} onclick={find} title={isEmpty(builder.q) ? 'Fill in at least one of: from, to, airspace, or aircraft / airline' : periodDays(builder.q.period) > 120 ? 'Long periods search many months of data and take longer' : ''}>Find flights</button>
    </div>

    <div class="links">
      <button class="link" onclick={() => (app.map.drawMode = true)}>Or draw an area on the map →</button>
      {#if !isEmpty(builder.q)}<button class="link" onclick={() => (builder.q = blankQuery())} title="Empty every field">Clear</button>{/if}
    </div>
    <!-- the two other lists: the published case library, and this session's board of pinned flights -->
    <div class="entries">
      <button class="entry" onclick={() => (app.explore = { kind: 'cases' })}>
        <span class="label">Library</span><b>Documented shipments</b><small>Weapons movements reported by journalists and governments since 2023, matched against the archive</small><i>→</i>
      </button>
      <button class="entry" onclick={() => (app.explore = { kind: 'pins' })}>
        <span class="label">This session</span><b>Flights of interest</b><small>{app.pins.length ? `${app.pins.length} pinned flight${app.pins.length === 1 ? '' : 's'}, saved with the session` : 'Pin flights from the flight sheet to keep them here'}</small><i>→</i>
      </button>
    </div>
  </div>
{:else}
  <div class="bar">
    <button class="back" onclick={() => home(true)} title="Edit the search">←</button>
    <div class="tt">
      <div class="label">{app.explore.kind === 'area' ? 'Map area' : app.explore.kind === 'list' ? 'From the assistant' : app.explore.kind === 'cases' ? 'Library' : app.explore.kind === 'pins' ? 'Board' : 'Search'}</div>
      <span class="title">{app.explore.kind === 'query' ? describe(app.explore.spec) : app.explore.kind === 'list' ? app.explore.title : app.explore.kind === 'cases' ? 'Documented shipments' : app.explore.kind === 'pins' ? 'Flights of interest' : `Drawn area, ${periodLabel(q.period)}`}</span>
    </div>
  </div>
  <div class="body">
    {#if app.explore.kind === 'cases'}
      <Cases />
    {:else if app.explore.kind === 'pins'}
      {#if !app.pins.length}
        <p class="muted">Nothing pinned yet. Open a flight and press <b>☆ Pin</b> to keep it here. The board is saved with the session (Session → Save) and the assistant can read it ("my pinned flights").</p>
      {:else}
        <div class="acts">
          <button class="primary" onclick={() => { showFlows(app.pins.slice(), `Flights of interest (${app.pins.length})`); if (app.mobile) app.tab = 'map'; }}>Map all</button>
          <button onclick={() => { app.chatDraft = `Look at my pinned flights (pinned_flights): what do they have in common, what stands out, and what should I check next?`; if (app.mobile) app.tab = 'ask'; }}>Ask the assistant</button>
        </div>
        <div class="list">
          {#each app.pins.slice().reverse() as l (l.leg_id)}
            <div class="pinrow"><FlightRow leg={l} /><button class="unpin" title="Remove from the board" onclick={() => togglePin(l)}>✕</button></div>
          {/each}
        </div>
      {/if}
    {:else if busy}
      <div class="loading"><span class="spin"></span>Searching{app.explore.kind === 'query' && periodDays(app.explore.spec.period) > 120 && !app.explore.spec.from && !app.explore.spec.to && !app.explore.spec.through ? ' month by month: an aircraft or company over a long period takes a while' : ''}…</div>
      <div class="acts"><button onclick={() => home(false)} title="Clear and start a new search">New search</button></div>
    {:else if err}
      <div class="err">{err}</div>
      <div class="acts"><button onclick={() => home(true)} title="Edit the search">Edit the search</button><button onclick={() => home(false)} title="Clear and start a new search">New search</button></div>
    {:else if res}
      <div class="kpis">
        <div><b>{Number(res.totals.flights).toLocaleString()}</b><span>flights</span></div>
        {#if res.totals.aircraft != null}<div><b>{Number(res.totals.aircraft).toLocaleString()}</b><span>aircraft</span></div>{/if}
        {#if res.totals.observed != null}<div title="Seen by receivers in the airspace"><b>{Number(res.totals.observed).toLocaleString()}</b><span>observed</span></div>
          <div title="Estimated across a receiver coverage gap"><b>{Number(res.totals.inferred).toLocaleString()}</b><span>estimated</span></div>
        {:else if res.totals.military_aircraft != null}<div><b>{Number(res.totals.military_aircraft).toLocaleString()}</b><span>military</span></div>{/if}
      </div>

      {#if res.per_month.length > 1}
        <div class="chartwrap">
          <div class="label">Flights per month</div>
          <div class="chart" class:few={res.per_month.length <= 8}>
            {#each res.per_month as m}<div class="col" title="{m.month}: {m.flights} flights"><b>{res.per_month.length <= 14 ? Number(m.flights).toLocaleString() : ''}</b><i style="height: {Math.max(2, (Number(m.flights) / maxMonth) * 100)}%"></i><span>{res.per_month.length <= 8 ? m.month.slice(2).replace('-', '/') : ''}</span></div>{/each}
          </div>
          {#if res.per_month.length > 8}<div class="axis"><span>{res.per_month[0].month}</span><span>{res.per_month[res.per_month.length - 1].month}</span></div>{/if}
        </div>
      {/if}

      {#if res.top_routes.length || res.top_companies.length}
        <div class="tops">
          {#if res.top_routes.length}<div><h4 class="label">Routes</h4>{#each res.top_routes.slice(0, 5) as r}<button class="tr" onclick={() => refineRoute(String(r.value))} title={String(r.value).includes('?') ? 'Narrow to this route. "?" = that end was not recorded (the aircraft was outside receiver coverage)' : 'Narrow to this route'}><span>{r.value}</span><b>{r.flights}</b></button>{/each}</div>{/if}
          {#if res.top_companies.length}<div><h4 class="label">Companies</h4>{#each res.top_companies.slice(0, 5) as r}<button class="tr" onclick={() => refine({ subject: ent('company', String(r.value)) })} title="Narrow to this company"><span>{r.value}</span><b>{r.flights}</b></button>{/each}</div>{/if}
          {#if res.top_aircraft.length}<div><h4 class="label">Aircraft</h4>{#each res.top_aircraft.slice(0, 5) as r}<button class="tr" onclick={() => refine({ subject: ent('aircraft', String(r.value)) })} title="Narrow to this aircraft"><span>{r.value} <i>{r.type ?? ''}</i></span><b>{r.flights}</b></button>{/each}</div>{/if}
          {#if res.top_destination_countries.length}<div><h4 class="label">Destinations</h4>{#each res.top_destination_countries.slice(0, 5) as r}<button class="tr" onclick={() => refine({ to: ent('country', String(r.value), countryName(r.value)) })} title="Narrow to this destination"><span>{countryName(r.value)}</span><b>{r.flights}</b></button>{/each}</div>{/if}
        </div>
      {/if}

      <div class="acts">
        {#if app.mobile}<button class="primary" onclick={() => (app.tab = 'map')} title="See these flights on the map">Map</button>{/if}
        {#if app.explore.kind === 'query'}<button onclick={ask} title="Hand this search to the assistant">Ask the assistant</button>{/if}
        <button onclick={exportCsv} disabled={!res.flights.length} title="Download these flights as CSV, with the data source">Export CSV</button>
        <button onclick={() => home(false)} title="Clear and start a new search">New search</button>
      </div>

      <div class="lhead">
        <span class="label">{res.flights.length < Number(res.totals.flights) ? `Newest ${res.flights.length.toLocaleString()} of ${Number(res.totals.flights).toLocaleString()}` : `${res.flights.length.toLocaleString()} flights`}{seconds ? ` · ${seconds.toFixed(1)} s` : ''}</span>
        {#if res.flights.length}<input class="filter" placeholder="Filter the list" bind:value={filter} />{/if}
      </div>
      <div class="list">
        {#each shown.slice(0, 500) as l (l.leg_id + (l.t_in ?? ''))}<FlightRow leg={l} />{/each}
        {#if shown.length > 500}<div class="more">Showing 500 of {shown.length.toLocaleString()}. Narrow the search or use the filter.</div>{/if}
        {#if !res.flights.length}<div class="more">No flights match. Try a longer period or fewer filters. Note that areas without receiver coverage show no flights even when there were some.</div>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .home { padding: 22px 18px 28px; overflow-y: auto; overflow-x: hidden; }
  h2 { margin: 8px 0 6px; font-size: 18px; font-weight: 600; letter-spacing: -.2px; }
  .lead { cursor: help; margin: 0 0 16px; color: var(--muted); font-size: 12.5px; line-height: 1.55; } .lead b { color: var(--ink); font-weight: 500; font-family: var(--mono); font-size: 11.5px; }
  .form { display: flex; flex-direction: column; gap: 14px; border-top: 1px solid var(--line); padding-top: 18px; }
  .two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }   /* columns may shrink; content never pushes the other one */
  .check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); margin-top: -6px; cursor: pointer; }
  .period .label { margin-bottom: 8px; } .period.need .label { color: var(--obs); }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chips button { font-size: 9.5px; padding: 5px 9px; color: var(--muted); border-color: var(--line2); }
  .chips button.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  .dates { margin-top: 12px; } .dates input { width: 100%; font-family: var(--mono); font-size: 12px; }
  .warn { color: var(--obs); font-size: 11.5px; margin: 8px 0 0; } .note { color: var(--faint); font-size: 11px; margin: 6px 0 0; line-height: 1.45; }
  .go { padding: 12px; font-size: 11px; }
  .links { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .link { margin-top: 18px; border: 0; padding: 0; text-transform: none; letter-spacing: 0; font-size: 12.5px; color: var(--muted); }
  .link:hover { background: transparent; color: var(--ink); }
  .tip { color: var(--faint); font-size: 11.5px; margin: 8px 0 0; }
  .bar { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .back { width: 32px; height: 32px; padding: 0; font-size: 14px; letter-spacing: 0; flex: none; }
  .tt { min-width: 0; } .title { display: block; font-weight: 600; font-size: 13px; line-height: 1.35; }
  .body { padding: 16px; display: flex; flex-direction: column; gap: 14px; overflow-y: auto; overflow-x: hidden; flex: 1; min-height: 0; }
  .loading { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12.5px; padding: 20px 0; }
  .spin { width: 12px; height: 12px; border: 1.5px solid var(--line2); border-top-color: var(--ink); border-radius: 50%; animation: spin .8s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .kpis { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; border: 1px solid var(--line2); border-radius: var(--r); }
  .kpis div { padding: 10px 6px 8px; text-align: center; border-left: 1px solid var(--line); } .kpis div:first-child { border-left: 0; }
  .kpis b { display: block; font-size: 17px; font-weight: 500; font-family: var(--mono); letter-spacing: -.5px; }
  .kpis span { font-size: 9px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--muted); }
  .chartwrap { display: flex; flex-direction: column; gap: 6px; }
  .chart { display: flex; align-items: stretch; gap: 2px; height: 72px; }
  .chart.few { gap: 10px; justify-content: flex-start; }
  .col { flex: 1; max-width: 44px; display: grid; grid-template-rows: 12px 1fr 12px; row-gap: 3px; min-width: 0; }
  .chart:not(.few) .col { max-width: none; }
  .col b { font-size: 9.5px; font-weight: 500; color: var(--muted); font-family: var(--mono); text-align: center; line-height: 12px; white-space: nowrap; overflow: hidden; }
  .col i { display: block; width: 100%; align-self: end; background: var(--ink); opacity: .7; border-radius: 2px 2px 0 0; }
  .col span { font-size: 9px; color: var(--faint); font-family: var(--mono); text-align: center; line-height: 12px; border-top: 1px solid var(--line2); white-space: nowrap; }
  .col:hover i { opacity: 1; }
  .axis { display: flex; justify-content: space-between; font-size: 10px; color: var(--faint); font-family: var(--mono); border-top: 1px solid var(--line2); padding-top: 3px; margin-top: -4px; }
  .tops { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
  h4 { margin: 0 0 4px; }
  .tr { display: flex; justify-content: space-between; gap: 6px; width: 100%; border: 0; border-radius: 0; padding: 3px 0; text-transform: none; letter-spacing: 0; font-size: 12px; text-align: left; }
  .tr span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; } .tr i { font-style: normal; color: var(--faint); font-size: 11px; }
  .tr b { font-family: var(--mono); font-weight: 500; flex: none; } .tr:hover { background: transparent; color: var(--ink); text-decoration: underline; }
  .acts { display: flex; flex-wrap: wrap; gap: 6px; } .acts button { font-size: 9.5px; padding: 6px 10px; }
  .lhead { display: flex; align-items: center; gap: 10px; }
  .filter { flex: 1; min-width: 0; font-size: 12px; padding: 6px 10px; }
  .list { border-top: 1px solid var(--line); } .more { padding: 12px 4px; color: var(--faint); font-size: 12px; line-height: 1.5; }
  .err { color: var(--sov); font-size: 12.5px; line-height: 1.5; }
  @media (max-width: 900px) {
    .home { padding: 18px 16px calc(24px + env(safe-area-inset-bottom, 0px)); }
    .body { padding: 14px; }
    .tr { padding: 7px 0; } .period button { padding: 9px 12px; }
    .acts button { padding: 10px 12px; }
  }
  .entries { display: flex; flex-direction: column; gap: 8px; margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); }
  .entry { display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto auto; column-gap: 12px; row-gap: 2px; padding: 12px 14px; text-align: left; text-transform: none; letter-spacing: 0; border: 1px solid var(--line); border-radius: var(--r); }
  .entry:hover { background: rgba(232,232,232,.04); color: inherit; border-color: var(--line2); }
  .entry .label { font-size: 9.5px; } .entry b { font-size: 13.5px; color: var(--ink); font-weight: 600; } .entry small { font-size: 11.5px; line-height: 1.45; color: var(--muted); }
  .entry i { grid-column: 2; grid-row: 1 / 4; align-self: center; font-style: normal; color: var(--muted); }
  .pinrow { display: grid; grid-template-columns: 1fr auto; align-items: center; } .pinrow .unpin { border: 0; padding: 6px 8px; color: var(--faint); font-size: 11px; letter-spacing: 0; } .pinrow .unpin:hover { color: var(--ink); background: none; }
  .muted b { color: var(--ink); }
  @media (hover: none) { .entry:hover { background: transparent; border-color: var(--line); } .tr:hover { color: inherit; } .link:hover { color: var(--muted); } }
</style>
