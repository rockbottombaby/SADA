<script lang="ts">
  import { app, selectLeg, hm, endLabel, endTitle, type Leg } from './state.svelte';
  let { leg }: { leg: Leg } = $props();
  // lead with the informative callsign (e.g. LOY026) rather than routine company ones
  const cs = $derived(String(leg.callsigns || '').split(' ').filter(Boolean)
    .sort((a, b) => (/^(ICL|ELY0)/.test(a) ? 1 : 0) - (/^(ICL|ELY0)/.test(b) ? 1 : 0))[0] || String(leg.reg || leg.hex));
</script>

<button class="row" class:sel={app.selected?.leg_id === leg.leg_id} onclick={() => selectLeg(leg)}>
  <div class="l1">
    <b>{cs}</b>
    <span class="ac">{leg.reg ?? ''}{leg.type ? ' · ' + leg.type : ''}</span>
    {#if leg.mil}<i class="tag mil">military</i>{/if}
    {#if leg.evidence}<i class="tag {leg.evidence}">{leg.evidence}</i>{/if}
  </div>
  <div class="l2">
    <span title={endTitle(leg.from_name, leg.from_cert)} class:unc={leg.from_cert !== 'recorded'}>{endLabel(leg.from_code, leg.from_name, leg.from_cert)}</span>
    <span class="arr">→</span>
    <span title={endTitle(leg.to_name, leg.to_cert)} class:unc={leg.to_cert !== 'recorded'}>{endLabel(leg.to_code, leg.to_name, leg.to_cert)}</span>
    <span class="time">{leg.date} · {hm(Number(leg.t0))}–{hm(Number(leg.t1))}</span>
  </div>
</button>

<style>
  .row { display: block; width: 100%; min-width: 0; overflow: hidden; text-align: left; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 9px 6px;
    text-transform: none; letter-spacing: 0; font-size: 13px; transition: background .15s; }
  .row:hover { background: rgba(232,232,232,.04); color: var(--text); }
  .row.sel { background: rgba(232,232,232,.07); box-shadow: inset 2px 0 0 var(--ink); }
  .l1 { display: flex; gap: 8px; align-items: center; white-space: nowrap; overflow: hidden; }
  .l1 b { font-weight: 600; letter-spacing: .3px; }
  .ac { color: var(--muted); font-size: 11.5px; font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .l2 { display: flex; gap: 6px; font-size: 12px; align-items: baseline; margin-top: 2px; font-family: var(--mono); min-width: 0; }
  .l2 > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .arr { color: var(--faint); } .unc { color: var(--muted); border-bottom: 1px dotted var(--faint); cursor: help; }
  .time { margin-left: auto; color: var(--faint); font-size: 11px; white-space: nowrap; flex: none; }
  .tag { flex: none; font-size: 9px; padding: 0 5px; }
  .tag.observed { color: var(--obs); border-color: rgba(242,193,78,.5); }
  .tag.inferred { color: var(--inf); border-color: rgba(143,184,255,.5); border-style: dashed; }
  .tag.mil { color: var(--mil); border-color: rgba(199,166,255,.5); }
  @media (hover: none) { .row:hover { background: transparent; color: inherit; } }
</style>
