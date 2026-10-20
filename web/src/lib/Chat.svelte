<script lang="ts">
  import { md } from './markdown';
  import { app, showFlows, selectLeg, zoneName, hm, setScene, restoreChatScene, describeScene, type Leg } from './state.svelte';
  import { builder, blankQuery, describe, toArgs } from './query.svelte';
  import { runAgent, systemPrompt, StoppedError } from './agent';
  import { sourceStatus } from './sources';
  import { describeCall, setActivity } from './activity';
  import { UI_TOOLS } from './uiTools';
  import { caseTool, caseSummary, KIND_LABEL, type CaseFile, type CaseKind } from './caseFile';
  import { PROFILES, profileById, emptyUsage, type Usage } from './models';
  import { OPENROUTER_MODELS, startOpenRouterSignIn } from './openrouter';
  // one model menu for both providers: "anthropic:fast" or "openrouter:<model id>"; the entry says which key it runs on
  const modelChoice = $derived(settings.provider === 'openrouter' ? `openrouter:${settings.openrouterModel}` : `anthropic:${settings.profile}`);
  function chooseModel(v: string) {
    const [prov, id] = [v.slice(0, v.indexOf(':')), v.slice(v.indexOf(':') + 1)];
    settings.provider = prov as 'anthropic' | 'openrouter';
    if (prov === 'openrouter') settings.openrouterModel = id; else settings.profile = id;
    saveSettings();
  }
  import { settings, saveSettings, hasKey, activeKey, activeProfile, usingOpenRouter } from './prefs.svelte';
  import { showLive } from './live.svelte';
  import { trailStart, trailCall, trailResult, trailWeb, trailProgress, trailPhase, trailEnd, focusEvidence } from './trail.svelte';
  import { kvGet, kvSet } from './idb';
  import { registerSession } from './session.svelte';
  import FlightRow from './FlightRow.svelte';

  type Card =
    | { kind: 'legs'; tool: string; legs: Leg[]; title: string }
    | { kind: 'zone'; overview: any }
    | { kind: 'flight'; leg: Leg }
    | { kind: 'chip'; text: string; pending?: string };   // pending = tool name while that step runs
  type Turn = { role: 'user' | 'assistant'; text: string; cards: Card[]; usd?: number; profile?: string; verify?: any };
  type ChatT = { id: string; title: string; turns: Turn[]; history: any[]; usage: Usage; created: number; sig?: string; case?: CaseFile };

  const newChat = (): ChatT => ({ id: Math.random().toString(36).slice(2, 10), title: 'New chat', turns: [], history: [], usage: emptyUsage(), created: Date.now() });
  let chats: ChatT[] = $state([newChat()]);
  let activeId = $state('');
  let input = $state('');
  let running = $state(false);
  let useWeb = $state(true);
  let abort: AbortController | null = null;
  let scroller: HTMLDivElement;
  // follow the answer while the reader is at the bottom; when they have scrolled up to read, leave them there and offer
  // a jump to the newest content instead
  let atBottom = $state(true), unseen = $state(false);
  const onScroll = () => { atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40; if (atBottom) unseen = false; };
  function follow(force = false) {
    if (!scroller) return;
    if (force || atBottom) requestAnimationFrame(() => { scroller.scrollTo({ top: scroller.scrollHeight }); atBottom = true; unseen = false; });
    else unseen = true;
  }
  // jumping re-attaches the follow at once, so content that arrives during the smooth scroll keeps the reader at the bottom
  const jump = () => { atBottom = true; unseen = false; scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }); };
  let composerEl: HTMLTextAreaElement | undefined = $state();
  let expanded: Record<string, boolean> = $state({});
  // a ticking clock for the "what it is doing" line while an answer is being produced
  let nowTick = $state(Date.now());
  $effect(() => { if (!running) return; const id = setInterval(() => (nowTick = Date.now()), 1000); return () => clearInterval(id); });
  // "[E3]" in an answer becomes a chip; clicking it shows the step on the map that produced that evidence
  // "[E3]", "[E1, E7]" and "[E4–E6]" all become chips (a range expands to each id)
  const chip = (id: string) => `<button class="ev" title="Show the step that produced this evidence">${id}</button>`;
  const withCitations = (html: string) => html.replace(/\[(E\d{1,3}(?:\s*(?:,|–|-|—)\s*E\d{1,3})*)\]/g, (_, body: string) => {
    const ids: string[] = [];
    for (const part of body.split(/\s*,\s*/)) {
      const r = part.match(/^E(\d+)\s*[–—-]\s*E(\d+)$/);
      if (r && +r[2] >= +r[1] && +r[2] - +r[1] <= 20) for (let i = +r[1]; i <= +r[2]; i++) ids.push(`E${i}`);
      else ids.push(...part.split(/\s*[–—-]\s*/));
    }
    return ids.map(chip).join(' ');
  }).replace(/<\/button><button class="ev"/g, '</button> <button class="ev"');   // "[E7][E9]" written back to back
  const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  const active = $derived(chats.find(c => c.id === activeId) ?? chats[0]);
  kvGet<any>('chats:v2').then(v => { if (v?.chats?.length) { chats = v.chats; activeId = v.activeId; } else activeId = chats[0].id; });
  const persist = () => kvSet('chats:v2', { chats: $state.snapshot(chats), activeId });
  // the Session menu in the top bar saves and loads these tabs as a file
  registerSession({
    get: () => ({ chats: $state.snapshot(chats), activeId }),
    set: (cs, id) => { abort?.abort(); chats = cs.length ? cs : [newChat()]; activeId = id && chats.some(c => c.id === id) ? id : chats[0].id; expanded = {}; persist(); },
  });

  function addTab() { const c = newChat(); chats = [...chats, c]; activeId = c.id; persist(); }
  function closeTab(id: string) {
    const i = chats.findIndex(c => c.id === id);
    chats = chats.filter(c => c.id !== id);
    if (!chats.length) chats = [newChat()];
    if (activeId === id) activeId = chats[Math.max(0, i - 1)].id;
    persist();
  }
  const money = (x: number) => (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);
  const legsTitle = (tool: string, input: any, n: number) =>
    tool === 'flights_through_zone' ? `${n} flights through ${zoneName(input.zone_id)}`
    : tool === 'search_flights' ? `${n} flights matching “${input.text}”`
    : tool === 'airport_movements' ? `${n} flights at ${input.airport}`
    : tool === 'aircraft_history' ? `${n} flights by ${input.aircraft}`
    : tool === 'flights_through_area' ? `${n} flights through an area` : `${n} flights`;

  // What the user currently sees, sent with every message so the assistant always knows the app's state.
  function appState() {
    const st = sourceStatus(app.ctx!);
    const ex = app.explore;
    const view = ex.kind === 'query' ? `search results: ${describe(ex.spec)} (find_flights ${JSON.stringify(toArgs(ex.spec))})`
      : ex.kind === 'area' ? 'flights through a drawn area' : ex.kind === 'list' ? ex.title : 'the empty search form';
    return [
      `- period of the user's current search: ${app.dateFrom ? `${app.dateFrom} to ${app.dateTo}` : 'none chosen (ask, or pick one that fits the question)'}`,
      `- map: ${describeScene()}`,
      `- selected flight: ${app.selected ? `leg_id ${app.selected.leg_id} (${app.selected.callsigns || ''} ${app.selected.reg || ''})`.replace(/\s+\)/, ')') : 'none'}`,
      `- left panel: ${view}`,
      `- sources: flight database yes; web search ${useWeb ? 'on' : 'off'}; US Census ${st.census ? 'connected' : 'no key'}; OpenSky ${!st.opensky ? 'no key' : settings.openskyBase ? 'connected' : 'key set but blocked in the browser (needs a proxy URL in Settings)'}`,
      `- case file: ${caseSummary(active.case)}`,
    ].join('\n');
  }

  async function send(text?: string) {
    // a starter template with an unfilled [placeholder]: select it instead of sending
    const ph = (text ?? input).match(/\[(country|country or airport|registration|date|airport or air base)\]/);
    if (ph && ph.index != null && composerEl) { composerEl.focus(); composerEl.setSelectionRange(ph.index, ph.index + ph[0].length); return; }
    const q = (text ?? input).trim();
    if (!q || running) return;
    if (!hasKey()) { app.keySetupOpen = true; return; }
    follow(true);
    input = ''; running = true; abort = new AbortController();
    if (composerEl) composerEl.style.height = 'auto';   // shrink the auto-grown box back
    const chat = active;
    app.map.activeChat = chat.id;   // the assistant's map tools draw scenes owned by this tab
    trailStart(chat.id, q);         // the research trail on the map starts fresh for each question
    if (chat.title === 'New chat') chat.title = q.slice(0, 32) + (q.length > 32 ? '…' : '');
    chat.history.push({ role: 'user', content: `${q}\n\n[App state]\n${appState()}` });
    chat.turns.push({ role: 'user', text: q, cards: [] }, { role: 'assistant', text: '', cards: [] });
    const cur = chat.turns[chat.turns.length - 1];
    const prof = activeProfile();
    // Thinking blocks are bound to the model and tool list that produced them. After switching model (Haiku and
    // Sonnet/Opus use different web tool versions) or toggling web search, drop earlier thinking; keep the conversation.
    const sig = `${prof.model}|${useWeb}`;
    if (chat.sig !== sig)   // also for chats saved before this check existed (no sig yet)
      chat.history = chat.history.map((m: any) => m.role === 'assistant' && Array.isArray(m.content)
        ? { ...m, content: m.content.filter((b: any) => b.type !== 'thinking' && b.type !== 'redacted_thinking') } : m);
    chat.sig = sig;
    cur.profile = prof.provider === 'openrouter' ? `${prof.label.replace(/ · (fast|balanced|deep)$/, '')} · OpenRouter` : `${prof.label.replace(/ \(.*\)$/, '')} · Anthropic key`;
    const before = { ...chat.usage };
    try {
      const out = await runAgent({
        apiKey: activeKey(), profile: prof, ctx: app.ctx!, web: useWeb, signal: abort.signal, extraTools: [...UI_TOOLS, caseTool(() => (chat.case ??= { items: [] }), persist)],
        system: systemPrompt(app.ctx!, `The user sees a map next to this chat. Results of data tools are shown to the user as cards in the chat automatically.
Use the map_* tools to show what your answer is about. Each call REPLACES what is on the map (one clean scene per answer); set keep_current: true only to add to the scene you drew in this answer (e.g. a zone, then the flights through it). map_focus_zone for a country/FIR, map_show_flights for the flights you discuss, map_show_track for one flight, map_country_labels to highlight countries, map_fly_to for a point of interest. The app state says what the map currently shows and who drew it.`),
        messages: chat.history,
        onEvent: e => {
          if (e.type === 'text') cur.text += e.text;
          else if (e.type === 'server_tool') {
            const q = String((e.input as any)?.query ?? (e.input as any)?.url ?? 'search');
            cur.cards.push({ kind: 'chip', text: `Web · ${q}` }); setActivity({ text: `Searching the web: ${q}` }); trailWeb(chat.id, q);
          } else if (e.type === 'tool_call') {
            // show the step as it starts, in plain words, and on the globe
            const act = describeCall(e.name!, e.input);
            if (!e.name!.startsWith('map_')) cur.cards.push({ kind: 'chip', text: `${act.text}…`, pending: e.name });
            trailCall(chat.id, e.name!, act.text, e.input);
            cur.phase = act.text; cur.phaseAt = Date.now();
            setActivity(act);
          }
          if (e.type === 'phase') { cur.phase = e.text; cur.phaseAt = Date.now(); trailPhase(e.text!); return; }
          if (e.type === 'progress') { trailProgress(chat.id, e.name!, e.text!, e.result as any); cur.phase = e.text; cur.phaseAt ??= Date.now(); if (app.map.activity) setActivity({ ...app.map.activity, text: e.text! }); return; }
          if (e.type === 'tool_result') trailResult(chat.id, e.name!, e.input, e.result, e.error, e.evidenceId);
          if (e.type === 'tool_result') {   // the step finished: replace its "…" placeholder with the result
            const i = cur.cards.findIndex((c: any) => c.pending === e.name);
            if (i >= 0) cur.cards.splice(i, 1);
          }
          if (e.type === 'tool_result' && !e.error) {
            const r: any = e.result, inp: any = e.input;
            if (Array.isArray(r) && e.name !== 'run_sql' && (r.length === 0 || (r[0]?.leg_id && r[0]?.t0 != null))) { cur.cards.push({ kind: 'legs', tool: e.name!, legs: r, title: legsTitle(e.name!, inp, r.length) }); app.lastLegs = { title: legsTitle(e.name!, inp, r.length), legs: r }; }
            else if (e.name === 'zone_overview') cur.cards.push({ kind: 'zone', overview: r });
            else if (e.name === 'flight_dossier') cur.cards.push({ kind: 'flight', leg: r.leg });
            else if (e.name?.startsWith('map_')) cur.cards.push({ kind: 'chip', text: `Map · ${e.name.replace('map_', '').replace(/_/g, ' ')}${r?.shown != null ? ': ' + r.shown : ''}` });
            else if (e.name === 'us_exports') cur.cards.push({ kind: 'chip', text: `Census · US exports to ${r.country}, HS ${r.hs_code}, ${r.months}: $${Math.round(r.totals.total_value_usd).toLocaleString()} (air $${Math.round(r.totals.air_value_usd).toLocaleString()}) ` });
            else if (e.name === 'case_file') cur.cards.push({ kind: 'chip', text: `Case · ${inp.action}${inp.kind ? ' ' + inp.kind.replace('_', ' ') : ''}${inp.id ? ' #' + inp.id : ''}${inp.status ? ' → ' + inp.status : ''}` });
            else if (e.name === 'export_flight_crosscheck') cur.cards.push({ kind: 'chip', text: `Cross-check · ${r.country} HS ${r.hs_code} ${r.months}: ${r.ports.length} ports, $${Math.round(r.census_totals.air_value_usd).toLocaleString()} by air` });
            else if (e.name === 'airport_movements') { const title = `${Number(r.total).toLocaleString()} flights at ${inp.airport} · ${r.period[0]} → ${r.period[1]}`; cur.cards.push({ kind: 'legs', tool: e.name, legs: r.flights, title }); app.lastLegs = { title, legs: r.flights }; }
            else if (e.name === 'live_aircraft' && Array.isArray(r.aircraft)) showLive(r.aircraft.filter((x: any) => !x.military).map((x: any) => x.hex));
            else if (e.name === 'find_flights') { const title = `${Number(r.totals.flights).toLocaleString()} flights · ${r.period[0]} → ${r.period[1]}`; cur.cards.push({ kind: 'legs', tool: e.name, legs: r.flights, title }); app.lastLegs = { title, legs: r.flights }; }
            else if (e.name === 'us_contracts') cur.cards.push({ kind: 'chip', text: `Contracts · ${r.company}: ${r.awards_shown} ${r.scope === 'Department of Defense' ? 'DoD ' : ''}awards, $${Math.round(r.total_shown_usd).toLocaleString()} · USAspending` });
            else if (e.name === 'aircraft_registry') cur.cards.push({ kind: 'chip', text: `Registry · ${r.company ? `${r.company}: ${r.aircraft_count} aircraft` : `${r.query}: ${r.aircraft?.[0]?.owner ?? r.aircraft?.[0]?.operator ?? 'not found'}`}` });
            else if (e.name?.startsWith('opensky_')) cur.cards.push({ kind: 'chip', text: `OpenSky · ${r.flights.length} flights${r.airport ? ` ${r.direction === 'departure' ? 'from' : 'to'} ${r.airport}` : ` by ${r.icao24}`}` });
            else cur.cards.push({ kind: 'chip', text: describeCall(e.name!, inp).text });
          } else if (e.type === 'tool_result' && e.error) cur.cards.push({ kind: 'chip', text: `Error · ${e.name}: ${e.error.replace(/^Error: /, '').slice(0, 80)}` });
          else if (e.type === 'notice') { cur.cards.push({ kind: 'chip', text: e.text! }); cur.phase = e.text!.replace(/…$/, ''); cur.phaseAt = Date.now(); }
          else if (e.type === 'usage' && e.usage) {
            cur.usd = e.usage.usd;
            chat.usage = { ...before, usd: before.usd + e.usage.usd, calls: before.calls + e.usage.calls, input: before.input + e.usage.input,
              output: before.output + e.usage.output, cacheRead: before.cacheRead + e.usage.cacheRead, cacheWrite: before.cacheWrite + e.usage.cacheWrite, searches: before.searches + e.usage.searches };
          } else if (e.type === 'verify') cur.verify = e.report;
          follow();
        },
      });
      chat.history = out.messages;
      cur.text = out.text || cur.text;
      if (out.report) cur.verify = out.report;
    } catch (e) {
      cur.cards = cur.cards.filter((c: any) => !c.pending);
      const stop = e instanceof StoppedError || abort?.signal.aborted;
      if (stop) cur.cards.push({ kind: 'chip', text: 'Stopped' });
      else cur.text += `\n\n**Error:** ${String(e)}`;
      // close the turn so the next message is valid; a cut-off reply is unchecked, so it is not kept as something "said"
      chat.history.push({ role: 'assistant', content: stop ? '(The user stopped this answer before it was finished; nothing from it has been verified.)' : '(This answer failed with an error.)' });
    }
    running = false; trailEnd();
    setActivity(null);
    persist();
  }

  // starting points for anyone, as templates: clicking fills the box with the first [placeholder] selected, ready to type over
  const SUGGESTIONS = [
    "Which military aircraft crossed [country]'s airspace in the last 30 days? Separate the ones seen by receivers from the estimated ones.",
    'Which cargo and military flights went from [country or airport] to [country or airport] since [date], and who operated them?',
    'The tail number [registration] is in a news photo. What has this aircraft been doing, and is anything unusual?',
    'What flew in and out of [airport or air base] in the last 30 days? Highlight military and cargo flights and where they came from.',
  ];
  function useSuggestion(text: string) {
    input = text;
    queueMicrotask(() => {
      if (!composerEl) return;
      composerEl.focus();
      const a = text.indexOf('['), b = text.indexOf(']', a);
      if (a >= 0 && b > a) composerEl.setSelectionRange(a, b + 1);
    });
  }
  let caseOpen = $state(false);
  // "Ask the assistant" from the Explore results: put the text in the input, ready to send or edit
  $effect(() => { if (app.chatDraft) { input = app.chatDraft; app.chatDraft = ''; queueMicrotask(() => composerEl?.focus()); } });
  $effect(() => { if (app.composerFocus) setTimeout(() => composerEl?.focus(), 50); });
</script>

<div class="wrap">
  <div class="tabs">
    {#each chats as c (c.id)}
      <div class="tab" class:on={c.id === active.id}>
        <button class="t" onclick={() => { activeId = c.id; restoreChatScene(c.id); }} title={c.title}>{c.title}</button>
        <button class="x" title="Close chat" aria-label="Close chat" onclick={() => closeTab(c.id)}>×</button>
      </div>
    {/each}
    <button class="add" title="New chat" aria-label="New chat" onclick={addTab}>+</button>
  </div>

  {#if active.case?.items.length}
    <div class="case" class:open={caseOpen}>
      <button class="cbar" onclick={() => (caseOpen = !caseOpen)}>
        <span>Case file</span><b>{active.case.items.length}</b>
        <i>{active.case.items.filter(x => x.status === 'open').length} open</i><span class="car">{caseOpen ? '▾' : '▸'}</span>
      </button>
      {#if caseOpen}
        <div class="clist">
          {#each Object.keys(KIND_LABEL) as k}
            {@const items = active.case.items.filter(x => x.kind === k)}
            {#if items.length}
              <div class="ck">{KIND_LABEL[k as CaseKind]}</div>
              {#each items as it}
                <div class="ci st-{it.status}"><em>#{it.id}</em><span>{it.text}{#if it.refs}<small>{it.refs}</small>{/if}</span>
                  <i class="tag">{it.status === 'open' ? (it.confidence ?? 'open') : it.status}</i></div>
              {/each}
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/if}
  <div class="caution" role="note"><i></i>Don’t rely on the AI: models hallucinate, the data doesn’t. Be the brains of the operation.</div>
  <div class="thread">
  <div class="msgs" bind:this={scroller} onscroll={onScroll}>
    {#if !active.turns.length}
      <div class="intro">
        <img class="eye big" src="/eye-64.png" width="44" height="44" alt="" />
        <div class="label">Assistant</div>
        <h3>Ask about the flights</h3>
        <p>The assistant queries the same data as the Explore panel, shows results on the map, and checks every flight it names against the data.</p>
        {#if hasKey()}
          <div class="sugs">{#each SUGGESTIONS as s, i}<button class="sug" onclick={() => useSuggestion(s)}><em>0{i + 1}</em><span>{s}</span><i>→</i></button>{/each}</div>
        {:else}
          <div class="keycard">
            <b>Sign in to start</b>
            <p>Log in with OpenRouter to enable your AI model.</p>
            <button class="primary" onclick={startOpenRouterSignIn}>Sign in with OpenRouter</button>
            <button class="link" onclick={() => (app.keySetupOpen = true)}>I have an Anthropic API key</button>
          </div>
        {/if}
      </div>
    {/if}
    {#each active.turns as t, ti}
      {#if t.role === 'user'}
        <div class="user">{t.text}</div>
      {:else}
        {@const steps = t.cards.filter((c: any) => c.kind === 'chip')}
        {@const live = running && ti === active.turns.length - 1}
        {@const skey = `${active.id}-${ti}-steps`}
        <div class="asst">
          <div class="who" class:live><img class="eye" src="/eye-32.png" srcset="/eye-32.png 1x, /eye-64.png 2x" width="20" height="20" alt="" /><span>SADA</span>{#if t.profile}<i>{t.profile}</i>{/if}</div>
          {#if steps.length}
            <div class="steps" class:open={expanded[skey]}>
              <button class="sh" onclick={() => (expanded[skey] = !expanded[skey])}>
                {#if live}<span class="spin"></span>{:else}<span class="tick">✓</span>{/if}
                <span class="lbl">{live ? steps[steps.length - 1].text : `${steps.length} step${steps.length > 1 ? 's' : ''}`}</span>
                {#if steps.some((c: any) => c.text.startsWith('Error'))}<span class="warnc">{steps.filter((c: any) => c.text.startsWith('Error')).length} retried</span>{/if}
                <span class="car">{expanded[skey] ? '▾' : '▸'}</span>
              </button>
              {#if expanded[skey]}<div class="sl">{#each steps as c}<div class="st" class:err={c.text.startsWith('Error')}>{c.text}</div>{/each}</div>{/if}
            </div>
          {/if}
          {#each t.cards as c, ci}
            {#if c.kind === 'legs'}
              {@const key = `${active.id}-${ti}-${ci}`}
              <div class="card">
                <div class="ch"><span class="ct">{c.title}</span>
                  <span class="acts">
                    <button title="Show these flights on the map" onclick={() => showFlows(c.legs, c.title)}>Map</button>
                    <button title="Open the full list in the Explore panel" onclick={() => (app.explore = { kind: 'list', title: c.title, legs: c.legs })}>Explore</button>
                  </span></div>
                <div class="rows">{#each c.legs.slice(0, expanded[key] ? 25 : 4) as l}<FlightRow leg={l} />{/each}</div>
                {#if c.legs.length > 4}<button class="more" onclick={() => (expanded[key] = !expanded[key])}>
                  {expanded[key] ? 'Show fewer' : `Show ${Math.min(25, c.legs.length) - 4} more`}{c.legs.length > 25 ? ` · all ${c.legs.length} in Explore` : ''}</button>{/if}
              </div>
            {:else if c.kind === 'zone'}
              <div class="card">
                <div class="ch"><span class="ct">{c.overview.zone?.name}</span>
                  <span class="acts">
                    <button onclick={() => setScene({ zone: c.overview.zone?.id }, { title: c.overview.zone?.name ?? 'Zone', by: 'you' })}>Map</button>
                    <button onclick={() => { builder.q = { ...blankQuery(), through: { kind: 'zone', value: c.overview.zone?.id, label: c.overview.zone?.name ?? '' }, period: { preset: '30d', from: '', to: '' } }; app.explore = { kind: 'home' }; }}>Explore</button>
                  </span></div>
                <div class="kpis"><div><b>{c.overview.totals.flights.toLocaleString()}</b>flights</div><div><b>{c.overview.totals.observed.toLocaleString()}</b>observed</div>
                  <div><b>{c.overview.totals.inferred.toLocaleString()}</b>inferred</div><div><b>{c.overview.totals.military.toLocaleString()}</b>military</div></div>
              </div>
            {:else if c.kind === 'flight' && c.leg}
              <button class="card fl" onclick={() => selectLeg(c.leg)} title="Open flight details">
                <div class="fh"><b>{String(c.leg.callsigns || '').split(' ')[0] || c.leg.reg}</b><span>{c.leg.reg ?? ''}{c.leg.type ? ' · ' + c.leg.type : ''}</span>{#if c.leg.mil}<i class="mil">military</i>{/if}</div>
                <div class="fr"><span class="code">{c.leg.from_code || '?'}</span><span class="ln"></span><span class="code">{c.leg.to_code || '?'}</span></div>
                <div class="ft"><span>{c.leg.date} · {hm(c.leg.t0)}–{hm(c.leg.t1)} UTC</span><span class="open">Details →</span></div>
              </button>
            {/if}
          {/each}
          {#if t.text}<div class="md" onclick={e => { const el = (e.target as HTMLElement).closest('.ev'); if (el) focusEvidence(el.textContent!.trim()); }}>{@html withCitations(md(t.text))}</div>{/if}
          {#if live}
            <!-- what the assistant is doing right now, always at the bottom where you are reading -->
            <div class="working" role="status" aria-live="polite">
              <img class="eye watch" src="/eye-32.png" srcset="/eye-32.png 1x, /eye-64.png 2x" width="16" height="16" alt="" /><span class="wt">{t.phase ?? 'Thinking'}…</span>
              {#if t.phaseAt}<span class="wc">{clock(nowTick - t.phaseAt)}</span>{/if}
            </div>
          {/if}
          {#if t.verify || t.usd != null}
            <div class="meta">
              {#if t.verify}{#if t.verify.ok}{#if t.verify.checked > 0}<span class="ok" title="Every flight fact in this answer was found in the data">✓ {t.verify.checked} facts verified</span>{/if}
                {:else}<span class="bad">⚠ not found in the data: {[...t.verify.unverified.map((u: any) => u.value), ...t.verify.outOfCoverage].join(', ')}</span>{/if}
                {#if t.verify.unverifiedNumbers?.length}<span class="warn" title="These figures were not found in any tool result (unit conversions and rounding can cause this)">· figures not in evidence: {t.verify.unverifiedNumbers.join(', ')}</span>{/if}{/if}
              {#if t.usd != null}<span>{t.profile} · {money(t.usd)}</span>{/if}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
  {#if !atBottom}
    <button class="jump" class:fresh={unseen} onclick={jump} title={unseen ? 'New content below' : 'Jump to the latest'} aria-label="Jump to the latest">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
    </button>
  {/if}
  </div>

  <form class="composer" onsubmit={e => { e.preventDefault(); send(); }}>
    <div class="box field">
      <span>Ask the data</span>
      <textarea rows="1" bind:this={composerEl} bind:value={input} placeholder="Ask about flights, countries, aircraft…"
        oninput={e => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 180) + 'px'; }}
        onkeydown={e => { if (e.key === 'Enter' && !e.shiftKey && !app.mobile) { e.preventDefault(); send(); } }}></textarea>
      {#if running}<button type="button" class="send stop" title="Stop" aria-label="Stop" onclick={() => abort?.abort()}>■</button>
      {:else}<button class="send" title="Send (Enter)" aria-label="Send" disabled={!input.trim()}>↑</button>{/if}
    </div>
    <div class="row">
      <select class="pill" value={modelChoice} onchange={e => chooseModel((e.target as HTMLSelectElement).value)} title="Model, and which key it runs on">
        <optgroup label={settings.apiKey ? 'Anthropic key' : 'Anthropic key (not connected)'}>{#each PROFILES as p}<option value={`anthropic:${p.id}`} disabled={!settings.apiKey}>{p.label.replace(/^(\w+) \((.*)\)$/, '$2 · $1')} · Anthropic</option>{/each}</optgroup>
        <optgroup label={settings.openrouterKey ? 'OpenRouter' : 'OpenRouter (not signed in)'}>{#each OPENROUTER_MODELS as m}<option value={`openrouter:${m.id}`} disabled={!settings.openrouterKey}>{m.label.replace(/ · (fast|balanced|deep)$/, '')} · OpenRouter</option>{/each}</optgroup>
      </select>
      <button type="button" class="pill" class:on={useWeb} title="Allow web search" onclick={() => (useWeb = !useWeb)}>Web {useWeb ? 'on' : 'off'}</button>
      <span class="sp"></span>
      <span class="cost" title="Estimated cost of this chat">{money(active.usage.usd)}</span>
    </div>
  </form>
</div>

<style>
  .wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .tabs { display: flex; align-items: stretch; border-bottom: 1px solid var(--line); overflow-x: auto; flex: none; scrollbar-width: none; height: 42px; }
  .tab { display: flex; align-items: center; max-width: 170px; flex: none; border-right: 1px solid var(--line); position: relative; }
  .tab.on::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px; background: var(--ink); }
  .tab .t { border: 0; border-radius: 0; padding: 0 4px 0 14px; height: 100%; font-size: 9.5px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab .t:hover { background: transparent; color: var(--text); } .tab.on .t { color: var(--ink); }
  .tab .x { border: 0; padding: 0 10px 0 6px; height: 100%; color: var(--faint); opacity: 0; letter-spacing: 0; font-size: 13px; }
  .tab .x:hover { background: transparent; color: var(--ink); } .tab:hover .x, .tab.on .x { opacity: 1; }
  .add { width: 42px; padding: 0; border: 0; border-radius: 0; color: var(--muted); font-size: 16px; letter-spacing: 0; flex: none; }

  .case { border-bottom: 1px solid var(--line); flex: none; max-height: 45%; display: flex; flex-direction: column; }
  .cbar { display: flex; align-items: center; gap: 10px; border: 0; border-radius: 0; padding: 10px 18px; font-size: 9.5px; color: var(--muted); width: 100%; text-align: left; }
  .cbar:hover { background: transparent; color: var(--ink); } .cbar b { font-family: var(--mono); color: var(--ink); font-weight: 500; }
  .cbar i { font-style: normal; color: var(--obs); text-transform: none; letter-spacing: 0; font-size: 11px; } .cbar .car { margin-left: auto; }
  .clist { overflow-y: auto; overflow-x: hidden; padding: 0 18px 12px; }
  .ck { font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.6px; color: var(--faint); margin: 10px 0 4px; }
  .ci { display: grid; grid-template-columns: 28px 1fr auto; gap: 8px; align-items: baseline; font-size: 12px; padding: 4px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
  .ci em { font-style: normal; font-family: var(--mono); color: var(--faint); font-size: 10.5px; }
  .ci small { display: block; color: var(--faint); font-family: var(--mono); font-size: 10.5px; margin-top: 2px; }
  .ci.st-refuted span { text-decoration: line-through; color: var(--faint); } .ci.st-supported .tag { color: var(--ok); border-color: rgba(143,214,164,.5); }
  .msgs { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 22px 18px 10px; display: flex; flex-direction: column; gap: 22px; min-height: 0; }
  .intro { margin: auto 0; padding: 0 4px; }
  .mark { width: 14px; height: 14px; border: 1.5px solid var(--ink); transform: rotate(45deg); margin: 0 0 18px 3px; }
  .intro h3 { margin: 6px 0 6px; font-size: 18px; font-weight: 600; letter-spacing: -.2px; }
  .intro p { color: var(--muted); font-size: 12.5px; line-height: 1.6; margin: 0 0 18px; }
  .sugs { display: flex; flex-direction: column; border-top: 1px solid var(--line); }
  .sug { display: flex; align-items: baseline; gap: 12px; width: 100%; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 12px 2px;
    text-transform: none; letter-spacing: 0; font-size: 12.5px; text-align: left; color: var(--text); }
  .sug em { font-style: normal; font-family: var(--mono); font-size: 10.5px; color: var(--faint); }
  .sug span { flex: 1; } .sug i { font-style: normal; color: var(--faint); transition: transform .2s; }
  .sug:hover { background: transparent; color: var(--ink); } .sug:hover i { transform: translateX(3px); color: var(--ink); }
  .keycard { margin-top: 18px; padding: 14px; border: 1px solid var(--line2); border-radius: var(--r); display: flex; flex-direction: column; gap: 6px; align-items: flex-start; font-size: 13px; }
  .keycard .link { border: 0; padding: 0; background: none; color: var(--muted); text-decoration: underline; text-transform: none; letter-spacing: 0; font-size: 11.5px; cursor: pointer; align-self: flex-start; margin-top: 2px; }
  .keycard p { margin: 0 0 6px !important; color: var(--muted); font-size: 12px !important; line-height: 1.55 !important; }
  .md :global(.ev) { display: inline-block; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0; padding: 0 5px; margin: 0 1px; border: 1px solid var(--line2); border-radius: 3px; color: var(--muted); vertical-align: 1px; text-transform: none; }
  .md :global(.ev:hover) { color: var(--ink); border-color: var(--ink); background: transparent; }
  .meta .warn { color: var(--obs); }
  .keynote { color: var(--muted) !important; margin-top: 16px !important; font-size: 11.5px !important; line-height: 1.55 !important; border-left: 1px solid var(--line2); padding-left: 10px; }

  /* the person's questions are solid, so each turn's start is easy to find while scrolling */
  .user { overflow-wrap: anywhere; align-self: flex-end; background: var(--ink); color: var(--bg); padding: 10px 14px 11px; border-radius: 12px 12px 3px 12px;
    max-width: 86%; white-space: pre-wrap; line-height: 1.5; font-size: 13.5px; box-shadow: 0 6px 20px rgba(0,0,0,.35); margin-top: 6px; }
  /* the assistant signs with the eye; it pulses while the assistant is working */
  .who { display: flex; align-items: center; gap: 8px; font-size: 9.5px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--ink); }
  .who i { font-style: normal; letter-spacing: 1px; color: var(--faint); }
  .eye { image-rendering: pixelated; flex: none; border-radius: 50%; }
  .eye.big { display: block; margin: 0 0 16px; filter: drop-shadow(0 0 14px rgba(80,140,255,.35)); }
  .who.live .eye, .eye.watch { animation: watch 1.6s ease-in-out infinite; }
  @keyframes watch { 0%, 100% { box-shadow: 0 0 0 0 rgba(90,150,255,.0); transform: scale(1); } 50% { box-shadow: 0 0 0 4px rgba(90,150,255,.25); transform: scale(1.06); } }
  .asst { display: flex; flex-direction: column; gap: 10px; font-size: 13.5px; min-width: 0; max-width: 100%; }
  .asst > * { min-width: 0; max-width: 100%; }

  .steps { align-self: flex-start; max-width: 100%; }
  .sh { display: flex; align-items: center; gap: 8px; border: 0; padding: 0; color: var(--faint); font-size: 9.5px; max-width: 100%; }
  .sh:hover { background: transparent; color: var(--ink); } .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tick { color: var(--ok); } .car { letter-spacing: 0; } .warnc { color: var(--obs); }
  .spin { width: 9px; height: 9px; border: 1.5px solid var(--line2); border-top-color: var(--ink); border-radius: 50%; animation: spin .8s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .sl { margin: 8px 0 2px 4px; padding-left: 12px; border-left: 1px solid var(--line2); display: flex; flex-direction: column; gap: 4px; }
  .st { font-size: 11px; font-family: var(--mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .st.err { color: var(--obs); }

  .card { border: 1px solid var(--line2); border-radius: var(--r); padding: 12px 12px 8px; min-width: 0; overflow: hidden; }
  .ch { display: flex; align-items: center; gap: 8px; justify-content: space-between; margin-bottom: 6px; }
  .ct { font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.6px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acts { display: flex; gap: 4px; flex: none; } .acts button { font-size: 9px; padding: 3px 8px; }
  .more { margin: 6px 0 2px; font-size: 9.5px; padding: 4px 0; border: 0; color: var(--muted); }
  .more:hover { background: transparent; color: var(--ink); }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid var(--line); margin: 4px -12px -8px; }
  .kpis div { text-align: center; padding: 10px 2px 8px; border-left: 1px solid var(--line); font-size: 9px; text-transform: uppercase; letter-spacing: 1.3px; color: var(--muted); }
  .kpis div:first-child { border-left: 0; } .kpis b { display: block; font-size: 16px; font-weight: 500; font-family: var(--mono); color: var(--ink); letter-spacing: -.5px; text-transform: none; }

  .fl { display: block; width: 100%; text-align: left; text-transform: none; letter-spacing: 0; font-size: 13px; padding: 12px; }
  .fl:hover { background: transparent; color: var(--text); border-color: var(--ink); }
  .fh { display: flex; align-items: baseline; gap: 8px; } .fh b { font-size: 15px; font-weight: 600; } .fh span { color: var(--muted); font-size: 11.5px; font-family: var(--mono); }
  .fh .mil { font-style: normal; font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px; padding: 0 5px; border: 1px solid rgba(199,166,255,.5); color: var(--mil); border-radius: 3px; }
  .fr { display: flex; align-items: center; gap: 12px; margin: 10px 0 8px; } .code { font-size: 18px; font-weight: 500; font-family: var(--mono); letter-spacing: 1px; }
  .ln { flex: 1; height: 0; border-top: 1px dashed var(--line2); }
  .ft { display: flex; justify-content: space-between; font-size: 11px; color: var(--faint); font-family: var(--mono); }
  .open { font-family: inherit; font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--muted); } .fl:hover .open { color: var(--ink); }

  .md { line-height: 1.65; color: #d6d6d6; overflow-wrap: anywhere; min-width: 0; }
  .md :global(pre) { white-space: pre-wrap; overflow-wrap: anywhere; }
  .md :global(img) { max-width: 100%; }
  .md :global(p) { margin: 0 0 10px; } .md :global(p:last-child) { margin-bottom: 0; }
  .md :global(ul), .md :global(ol) { margin: 4px 0 10px; padding-left: 18px; } .md :global(li) { margin: 4px 0; } .md :global(li::marker) { color: var(--faint); }
  .md :global(strong) { color: var(--ink); font-weight: 600; }
  .md :global(h1), .md :global(h2), .md :global(h3) { font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: var(--muted); margin: 16px 0 6px; font-weight: 500; }
  .md :global(code) { font-family: var(--mono); font-size: 11.5px; border: 1px solid var(--line); padding: 0 4px; border-radius: 3px; }
  .md :global(table) { border-collapse: collapse; font-size: 12px; margin: 8px 0; width: 100%; table-layout: fixed; }
  .md :global(td), .md :global(th) { border-bottom: 1px solid var(--line); padding: 5px 10px 5px 0; text-align: left; overflow-wrap: anywhere; vertical-align: top; }
  .md :global(th) { font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.4px; color: var(--muted); font-weight: 500; }

  .working { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--r); font-size: 12px; color: var(--muted); }
  .wspin { width: 10px; height: 10px; border: 1.5px solid var(--ink); border-top-color: transparent; border-radius: 50%; animation: wspin .8s linear infinite; flex: none; }
  @keyframes wspin { to { transform: rotate(360deg); } }
  .wt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
  .wc { font-family: var(--mono); font-size: 11px; color: var(--faint); }
  @media (prefers-reduced-motion: reduce) { .wspin, .who.live .eye, .eye.watch { animation: none; } }
  .typing { display: flex; gap: 5px; padding: 6px 0; } .typing span { width: 5px; height: 5px; background: var(--muted); animation: blink 1.2s infinite; }
  .typing span:nth-child(2) { animation-delay: .2s; } .typing span:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: .2; } 40% { opacity: 1; } }
  .meta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 10.5px; color: var(--faint); font-family: var(--mono); } .meta .ok { color: var(--ok); } .meta .bad { color: var(--obs); }

  .composer { padding: 14px 16px 14px; display: flex; flex-direction: column; gap: 10px; flex: none; border-top: 1px solid var(--line); }
  .box { display: flex; align-items: flex-end; gap: 8px; border: 1px solid var(--line2); border-radius: var(--r); padding: 10px 8px 8px 14px; transition: border-color .2s; }
  .box:focus-within { border-color: var(--ink); }
  .box textarea { flex: 1; resize: none; border: 0; padding: 4px 0; min-height: 22px; max-height: 180px; line-height: 1.5; }
  .send { width: 32px; height: 32px; padding: 0; font-size: 14px; letter-spacing: 0; flex: none; border-color: var(--ink); }
  .send:disabled { border-color: var(--line2); opacity: .5; } .send.stop { font-size: 9px; }
  .row { display: flex; gap: 6px; align-items: center; }
  .pill { font-size: 9.5px; padding: 4px 9px; color: var(--muted); border: 1px solid var(--line2); border-radius: var(--r); text-transform: uppercase; letter-spacing: 1.4px; }
  select.pill { padding: 4px 6px; max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } button.pill.on { color: var(--ink); border-color: var(--ink); }
  .sp { flex: 1; } .cost { color: var(--faint); font-size: 10.5px; font-family: var(--mono); }
  /* phones: a full-screen panel; everything a finger can hit is at least 40 px */
  @media (max-width: 900px) {
    .tab .x { opacity: 1; padding: 0 12px 0 8px; }
    .msgs { padding: 16px 14px 10px; gap: 18px; }
    .composer { padding: 10px 12px calc(10px + env(safe-area-inset-bottom, 0px) * 0); }
    .sug { padding: 14px 2px; }
  }
  .caution { display: flex; align-items: center; gap: 8px; padding: 7px 18px; font-size: 11px; line-height: 1.4; color: var(--obs); border-bottom: 1px solid var(--line); flex: none; }
  .caution i { width: 6px; height: 6px; border-radius: 50%; background: var(--obs); flex: none; }
  @media (hover: none) { .tab .t:hover { color: inherit; } .sug:hover { color: inherit; } .sug:hover i { transform: none; color: inherit; } .cbar:hover, .sh:hover, .more:hover { color: inherit; } .fl:hover { color: inherit; border-color: var(--line2); } }
  .thread { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .thread::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 28px; background: linear-gradient(to bottom, transparent, var(--bg)); pointer-events: none; }   /* the thread fades out above the composer */
  .jump { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); width: 40px; height: 40px; padding: 0; border-radius: 50%; display: grid; place-items: center;
    background: #1a1a1a; border: 1px solid var(--line2); color: var(--muted); box-shadow: 0 8px 24px rgba(0,0,0,.6), 0 0 0 4px var(--bg); animation: jumpin .2s ease-out; }
  .jump:hover { color: var(--ink); background: #222; border-color: var(--ink); }
  .jump.fresh { color: var(--ink); border-color: var(--ink); background: #202020; }
  @keyframes jumpin { from { opacity: 0; transform: translate(-50%, 6px); } }
</style>
