<script lang="ts">
  // The research row of the map dock (always present, full width): what the assistant is doing NOW (with live progress
  // and a timer), numbered step markers (hover for the step, click to see the map as it was then), and the full step
  // list on demand. Minimised it is a one-line footnote that still shows the live progress; maximised it fills the map.
  import { trail, currentTrail } from './trail.svelte';
  import { winMode, setWin } from './dock.svelte';
  import WinCtl from './WinCtl.svelte';

  const t = $derived((trail.seq, currentTrail()));
  const steps = $derived(t?.steps ?? []);
  const pins = $derived(t?.pins ?? []);
  const running = $derived(steps.findLast(s => s.status === 'running'));
  const busy = $derived(trail.busy || !!running);
  const focused = $derived(trail.focus != null ? steps.find(s => s.i === trail.focus) : null);
  let now = $state(Date.now());
  $effect(() => { if (!busy) return; const id = setInterval(() => (now = Date.now()), 1000); return () => clearInterval(id); });
  const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const total = $derived(steps.length ? (busy ? now : Math.max(...steps.map(s => s.at + (s.ms ?? 0)))) - steps[0].at : 0);
  const short = (s: string) => s.replace(/ · \d{4}-\d\d-\d\d → \d{4}-\d\d-\d\d$/, '').replace(/: sovereign airspace \([^)]*\)/, '').replace(/^Web · /, 'Web search: ');
  const PIN: Record<string, string> = { finding: 'Finding', hypothesis: 'Hypothesis', lead: 'Lead', question: 'Open question', records_request: 'Records request' };
  const pick = (i: number) => (trail.focus = trail.focus === i ? null : i);
  const last = $derived(steps.at(-1));
  const mode = $derived(winMode('research'));
  // one line for the footnote bar: what is happening now, or how it ended
  const summary = $derived(running ? `${short(running.label)}${running.progress ? ' — ' + running.progress : ''}`
    : trail.busy ? `${trail.phase || 'Thinking'}…` : last ? `Done · ${t?.question ?? ''}` : '');
</script>

{#if !t || !(steps.length || trail.busy)}
  <div class="rp min empty">
    <div class="top">
      <span class="dot"></span>
      <span class="label">Research</span>
      <span class="sum static"><span class="long">Nothing yet — ask the assistant a question and its steps appear here as it works.</span><span class="short">Nothing yet — ask the assistant</span></span>
    </div>
  </div>
{:else}
  <div class="rp {mode}" class:busy>
    <div class="top">
      <span class="dot"></span>
      <span class="label">{busy ? 'Researching' : 'Research'}</span>
      {#if mode === 'min'}
        <button class="sum" title="Show the research panel" onclick={() => setWin('research', 'normal')}>{summary}</button>
        <span class="meta">{steps.length} · {clock(total)}</span>
      {:else}
        <span class="meta">{steps.length} step{steps.length === 1 ? '' : 's'} · {clock(total)}{pins.length ? ` · ${pins.length} pinned` : ''}</span>
        <span class="sp"></span>
        <button class="tb" class:on={trail.follow} title="Move the map to each step as it happens" onclick={() => (trail.follow = !trail.follow)}>{trail.follow ? 'Following' : 'Follow'}</button>
        {#if mode === 'normal'}<button class="tb" title={trail.open ? 'Hide the step list' : 'Show every step'} onclick={() => (trail.open = !trail.open)}>{trail.open ? 'Less' : 'All steps'}</button>{/if}
      {/if}
      <WinCtl win="research" name="research panel" />
    </div>
    {#if mode !== 'min'}
      {#if mode === 'max' && t?.question}<div class="q">{t.question}</div>{/if}
      <div class="mid">

    <!-- now: the running step (or, when done, the step the user picked / the last step) -->
    {#if focused}
      <div class="now picked">
        <span class="n">{focused.i + 1}</span>
        <div class="body">
          <div class="what">{short(focused.label)}</div>
          {#if focused.status === 'running'}<div class="sub">{focused.progress ?? 'Working…'} · {clock(now - focused.at)}</div>
          {:else if focused.detail}<div class="sub">{focused.detail}</div>{/if}
          {#each pins.filter(p => p.step === focused.i) as p}<div class="pin {p.kind}"><i></i><b>{PIN[p.kind] ?? p.kind}</b> {p.text}</div>{/each}
        </div>
        <button class="tb" onclick={() => (trail.focus = null)}>Show all</button>
      </div>
    {:else if running}
      <div class="now">
        <span class="spin"></span>
        <div class="body">
          <div class="what">{short(running.label)}</div>
          <div class="sub">{running.progress ?? 'Working…'}</div>
        </div>
        <span class="t">{clock(now - running.at)}</span>
      </div>
    {:else if trail.busy}
      <div class="now">
        <span class="spin"></span>
        <div class="body"><div class="what">{trail.phase || 'Thinking'}…</div><div class="sub">{steps.length ? 'Deciding the next step from what it found.' : 'Reading the question and planning the research.'}</div></div>
        <span class="t">{clock(now - trail.phaseAt)}</span>
      </div>
    {:else if last}
      <div class="now done">
        <span class="ok">✓</span>
        <div class="body"><div class="what">Done · {steps.length} step{steps.length === 1 ? '' : 's'}</div><div class="sub">Click a step below to see the map as it was at that point.</div></div>
      </div>
    {/if}

    <div class="ticks" role="list">
      {#each steps as s (s.i)}
        <button class="tick {s.status}" class:focus={trail.focus === s.i} role="listitem"
          title={`${s.i + 1}. ${short(s.label)}${s.detail ? ' — ' + s.detail : ''}`} onclick={() => pick(s.i)}>{s.i + 1}</button>
      {/each}
      <span class="mob sp"></span>
      <button class="tb mob" class:on={trail.follow} onclick={() => (trail.follow = !trail.follow)}>{trail.follow ? 'Following' : 'Follow'}</button>
      {#if mode === 'normal'}<button class="tb mob" onclick={() => (trail.open = !trail.open)}>{trail.open ? 'Less' : 'All steps'}</button>{/if}
    </div>
      </div>

    {#if trail.open || mode === 'max'}
      <ol class="list">
        {#each steps as s (s.i)}
          <li class={s.status} class:focus={trail.focus === s.i}>
            <button onclick={() => pick(s.i)}>
              <span class="n">{s.i + 1}</span>
              <span class="body"><span class="what">{short(s.label)}</span>{#if s.detail || s.progress}<span class="sub">{s.detail ?? s.progress}</span>{/if}</span>
              <span class="t">{s.status === 'running' ? clock(now - s.at) : s.ms != null ? clock(s.ms) : ''}</span>
            </button>
          </li>
        {/each}
      </ol>
    {/if}
    {/if}
  </div>
{/if}

<style>
  .rp { background: rgba(16,16,16,.95); border: 1px solid var(--line2);
    border-radius: var(--r); backdrop-filter: blur(8px); padding: 10px 12px 10px; animation: up .25s ease-out; box-shadow: 0 16px 40px rgba(0,0,0,.45); }
  @keyframes up { from { opacity: 0; transform: translateY(6px); } }
  .top { display: flex; align-items: center; gap: 8px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); flex: none; }
  .busy .dot { background: #fff; animation: blink 1.2s ease-in-out infinite; }
  @keyframes blink { 50% { opacity: .25; } }
  .label { font-size: 9.5px; text-transform: uppercase; letter-spacing: 2px; color: var(--ink); }
  .meta { font-size: 10.5px; color: var(--faint); font-family: var(--mono); white-space: nowrap; }
  .sp { flex: 1; }
  .tb { font-size: 9px; padding: 3px 8px; color: var(--muted); flex: none; }
  .tb.on { color: var(--ink); border-color: var(--line2); }
  .mid { display: flex; align-items: flex-start; gap: 14px; margin-top: 9px; }
  .now { flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: 10px; padding: 9px 10px; border: 1px solid var(--line); border-radius: var(--r); background: rgba(232,232,232,.03); }
  .now .body { flex: 1; min-width: 0; }
  .what { font-size: 13px; color: var(--ink); line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; line-height: 1.45; }
  .now .t { font-family: var(--mono); font-size: 11px; color: var(--muted); flex: none; padding-top: 1px; }
  .spin { width: 12px; height: 12px; margin-top: 2px; border: 1.5px solid var(--ink); border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .ok { width: 14px; text-align: center; color: var(--ink); font-size: 12px; flex: none; }
  .now .n, .list .n { font-family: var(--mono); font-size: 10.5px; color: var(--faint); width: 18px; flex: none; padding-top: 2px; }
  .picked { border-color: var(--line2); }
  .pin { display: flex; gap: 6px; align-items: baseline; margin-top: 4px; font-size: 11.5px; color: var(--muted); line-height: 1.45; }
  .pin i { width: 7px; height: 7px; border-radius: 50%; background: #fff; flex: none; transform: translateY(-1px); }
  .pin b { color: var(--ink); font-weight: 500; }
  .pin.hypothesis i, .pin.lead i { background: #ffb454; } .pin.question i { background: #8fb8ff; } .pin.records_request i { background: #7fd1ff; }
  .ticks { display: flex; flex-wrap: wrap; gap: 4px; flex: none; max-width: 38%; justify-content: flex-end; padding-top: 2px; }
  .ticks:empty { display: none; }
  .tick { width: 22px; height: 18px; padding: 0; font-size: 9.5px; font-family: var(--mono); letter-spacing: 0; color: var(--muted); border-color: var(--line2); border-radius: 3px; }
  .tick.done { color: var(--ink); }
  .tick.running { border-color: var(--ink); color: var(--ink); animation: blink 1.2s ease-in-out infinite; }
  .tick.error { color: var(--sov); border-color: rgba(255,138,128,.5); }
  .tick.focus { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  .tick:disabled { opacity: 1; cursor: default; }
  .list { list-style: none; margin: 8px 0 0; padding: 0; max-height: min(34vh, 300px); overflow: auto; border-top: 1px solid var(--line); }
  .list li button { display: flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--line); border-radius: 0;
    padding: 7px 2px; text-transform: none; letter-spacing: 0; font-size: 12px; }
  .list li button:hover { background: rgba(232,232,232,.04); }
  .list .body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .list .what { font-size: 12px; }
  .list .sub { font-size: 11px; }
  .list .t { font-family: var(--mono); font-size: 10.5px; color: var(--faint); }
  .list li.focus button { background: rgba(232,232,232,.07); }
  .list li.error .what { color: var(--sov); }
  /* footnote bar */
  .rp.min { padding: 6px 8px 6px 12px; }
  .sum { flex: 1; min-width: 0; border: 0; padding: 2px 0; text-align: left; text-transform: none; letter-spacing: 0; font-size: 12px; color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sum:hover { color: var(--ink); background: none; }
  .sum.static { cursor: default; } .sum.static:hover { color: var(--muted); }
  .empty .dot { background: var(--line2); }
  /* filling the map */
  .rp.max { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 14px 18px; }
  .q { font-size: 15px; color: var(--ink); margin-top: 12px; line-height: 1.4; }
  .max .mid { flex-direction: column; gap: 10px; } .max .ticks { max-width: none; justify-content: flex-start; }
  .max .now { padding: 12px 14px; align-self: stretch; } .max .what { white-space: normal; font-size: 14px; }
  .max .list { flex: 1; max-height: none; margin-top: 12px; }
  .max .list .what { white-space: normal; font-size: 13px; } .max .list .sub { font-size: 12px; }
  .max .list li button { padding: 9px 4px; }
  @media (prefers-reduced-motion: reduce) { .rp, .busy .dot, .spin, .tick.running { animation: none; } }
  @media (hover: none) { .list li button:hover { background: transparent; } .sum:hover { color: var(--muted); } }
  .mob { display: none; } .short { display: none; }
  /* phones: the card stacks (step above the ticks), the text buttons sit with the ticks, nothing is cut off */
  @media (max-width: 900px) {
    .rp { padding: 9px 10px 10px; } .long { display: none; } .short { display: inline; }
    .top .tb { display: none; }
    .mid { flex-direction: column; gap: 8px; }
    .ticks { max-width: none; justify-content: flex-start; align-items: center; width: 100%; }
    .ticks .mob { display: inline-flex; } .ticks .sp { display: block; flex: 1; }
    .what { white-space: normal; }
    .now { padding: 8px 10px; }
    .list { max-height: 40vh; }
    .rp.max { padding: 12px 12px; } .max .q { font-size: 15px; }
  }
</style>
