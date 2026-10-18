<script lang="ts">
  // Notched input with typed suggestions. kinds: 'place' (country or airport/base), 'zone' (airspace), 'subject'
  // (aircraft, company, callsign). The chosen entity is shown as a chip; ✕ clears it.
  import { app } from './state.svelte';
  import { lit } from './tools';
  import type { Entity } from './query.svelte';

  let { label, placeholder, kinds, value = $bindable(null), autofocus = false }:
    { label: string; placeholder: string; kinds: 'place' | 'zone' | 'subject'; value: Entity | null; autofocus?: boolean } = $props();

  let text = $state(''), open = $state(false), sel = $state(0), opts: Entity[] = $state([]);
  let inputEl: HTMLInputElement | undefined = $state();
  let timer: ReturnType<typeof setTimeout>;

  // country names + ISO2 codes (same file as the map labels), loaded once
  let countries: { name: string; iso2: string; prio: number }[] = [];
  const countriesP = fetch('/country_labels.geojson').then(r => r.json())
    .then(g => (countries = g.features.map((f: any) => ({ name: f.properties.name, iso2: f.properties.iso2, prio: f.properties.prio ?? 0 })).filter((c: any) => c.iso2)));

  $effect(() => { if (autofocus && inputEl) inputEl.focus(); });

  async function suggest(q: string) {
    q = q.trim();
    if (q.length < 2) { opts = []; return; }
    const out: Entity[] = [];
    const ql = q.toLowerCase();
    const run = async (sql: string) => { try { return await app.ctx!.query(sql); } catch { return []; } };
    if (kinds === 'place') {
      await countriesP;
      // names starting with the typed text first, then larger countries (prio = minus area)
      for (const c of countries.filter(c => c.name.toLowerCase().includes(ql))
        .sort((a, b) => (a.name.toLowerCase().startsWith(ql) ? 0 : 1) - (b.name.toLowerCase().startsWith(ql) ? 0 : 1) || a.prio - b.prio).slice(0, 4))
        out.push({ kind: 'country', value: c.iso2, label: c.name, hint: 'country' });
      const rows = await run(`SELECT ident, name, country, military FROM airports WHERE ident ILIKE ${lit(q + '%')} OR iata ILIKE ${lit(q)} OR name ILIKE ${lit('%' + q + '%')}
        ORDER BY (ident ILIKE ${lit(q)}) DESC, military DESC, length(name) LIMIT 6`);
      for (const r of rows) out.push({ kind: 'airport', value: String(r.ident), label: String(r.name), hint: `${r.ident} · ${r.military ? 'military airfield' : 'airport'} · ${r.country}` });
    } else if (kinds === 'zone') {
      for (const z of app.zones.filter(z => (z.name + ' ' + z.country + ' ' + z.id).toLowerCase().includes(ql))
        .sort((a, b) => (a.kind === 'sovereign' ? 0 : 1) - (b.kind === 'sovereign' ? 0 : 1)).slice(0, 7))
        out.push({ kind: 'zone', value: z.id, label: z.kind === 'sovereign' ? `${z.country}'s airspace` : z.name.replace(/^[A-Z]{4} /, ''),
          hint: z.kind === 'sovereign' ? 'country airspace (12 nm)' : z.kind === 'fir' ? 'flight region (FIR), larger than the airspace' : 'control area' });
    } else {
      if (/^[A-Za-z]{3}\d{0,4}$/.test(q)) out.push({ kind: 'callsign', value: q.toUpperCase(), label: q.toUpperCase(), hint: 'callsign starting with this' });
      const ac = await run(`SELECT reg, hex, type, coalesce(operator, owner) AS who FROM registry WHERE reg ILIKE ${lit(q + '%')} OR hex = ${lit(ql)} ORDER BY reg LIMIT 4`);
      for (const r of ac) out.push({ kind: 'aircraft', value: String(r.reg || r.hex), label: String(r.reg || r.hex), hint: `aircraft · ${r.type ?? '?'}${r.who ? ' · ' + r.who : ''}` });
      if (!ac.length && /^([A-Z0-9]{1,2}-[A-Z0-9]{2,5}|N\d{1,5}[A-Z]{0,2}|[0-9a-f]{6})$/i.test(q))
        out.push({ kind: 'aircraft', value: q, label: q.toUpperCase(), hint: 'aircraft (registration or hex)' });
      const co = await run(`SELECT coalesce(operator, owner) AS name, count(*) AS n FROM registry WHERE owner ILIKE ${lit('%' + q + '%')} OR operator ILIKE ${lit('%' + q + '%')}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
      for (const r of co) out.push({ kind: 'company', value: String(r.name), label: String(r.name), hint: `company · ${r.n} aircraft in the registry` });
    }
    opts = out; sel = 0; open = true;
  }
  function onInput() { clearTimeout(timer); timer = setTimeout(() => suggest(text), 180); }
  function pick(e: Entity) { value = e; text = ''; open = false; opts = []; }
  function key(e: KeyboardEvent) {
    if (!open || !opts.length) return;
    if (e.key === 'ArrowDown') { sel = (sel + 1) % opts.length; e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = (sel - 1 + opts.length) % opts.length; e.preventDefault(); }
    else if (e.key === 'Enter') { pick(opts[sel]); e.preventDefault(); }
    else if (e.key === 'Escape') open = false;
  }
</script>

<div class="ef">
  <div class="field">
    <span>{label}</span>
    {#if value}
      <div class="chip" title={value.hint}><b>{value.label}</b>{#if value.hint}<small>{value.hint.split(' · ')[0]}</small>{/if}
        <button class="x" title="Clear" aria-label="Clear {label}" onclick={() => (value = null)}>✕</button></div>
    {:else}
      <input bind:this={inputEl} bind:value={text} {placeholder} oninput={onInput} onkeydown={key} onfocus={() => opts.length && (open = true)}
        onblur={() => setTimeout(() => (open = false), 150)} autocomplete="off" />
    {/if}
  </div>
  {#if open && opts.length && !value}
    <div class="drop" role="listbox">
      {#each opts as o, i}
        <button class:on={i === sel} role="option" aria-selected={i === sel} onmousedown={() => pick(o)}><span>{o.label}</span><small>{o.hint}</small></button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .ef { position: relative; }
  .field input { width: 100%; }
  .chip { display: flex; align-items: center; gap: 8px; border: 1px solid var(--ink); border-radius: var(--r); padding: 9px 8px 9px 14px; min-height: 44px; }
  .chip b { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip small { color: var(--muted); font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.2px; white-space: nowrap; }
  .x { margin-left: auto; border: 0; padding: 2px 6px; letter-spacing: 0; color: var(--muted); font-size: 12px; }
  .x:hover { background: transparent; color: var(--ink); }
  .drop { position: absolute; z-index: 20; left: 0; right: 0; top: 100%; margin-top: 4px; background: var(--bg); border: 1px solid var(--ink); border-radius: var(--r); overflow: hidden; box-shadow: 0 12px 30px rgba(0,0,0,.5); }
  .drop button { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; border: 0; border-radius: 0; text-align: left; padding: 8px 12px; text-transform: none; letter-spacing: 0; font-size: 13px; }
  .drop button small { color: var(--faint); font-size: 10.5px; font-family: var(--mono); }
  .drop button.on, .drop button:hover { background: rgba(232,232,232,.08); color: var(--text); }
</style>
