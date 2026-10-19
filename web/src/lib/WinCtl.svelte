<script lang="ts">
  // Minimise / maximise / restore buttons for a dock card (see dock.svelte.ts).
  import { setWin, winMode, type Win } from './dock.svelte';
  let { win, name, canMax = true }: { win: Win; name: string; canMax?: boolean } = $props();
  const m = $derived(winMode(win));
</script>

<span class="wc">
  {#if m === 'min'}
    <button title={`Show the ${name}`} aria-label={`Show the ${name}`} onclick={() => setWin(win, 'normal')}>
      <svg viewBox="0 0 10 10"><path d="M2 6.5l3-3 3 3" /></svg></button>
  {:else}
    <button title={`Minimise the ${name}`} aria-label={`Minimise the ${name}`} onclick={() => setWin(win, 'min')}>
      <svg viewBox="0 0 10 10"><path d="M2 7.5h6" /></svg></button>
  {/if}
  {#if m === 'max'}
    <button title={`Restore the ${name} (Esc)`} aria-label={`Restore the ${name}`} onclick={() => setWin(win, 'normal')}>
      <svg viewBox="0 0 10 10"><rect x="1.5" y="3.5" width="5" height="5" /><path d="M3.5 3.5V1.5h5v5h-2" /></svg></button>
  {:else}
    <button title={canMax ? `Fill the map with the ${name}` : 'Nothing to show larger'} aria-label={`Maximise the ${name}`} disabled={!canMax} onclick={() => setWin(win, 'max')}>
      <svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" /></svg></button>
  {/if}
</span>

<style>
  .wc { display: inline-flex; gap: 2px; flex: none; }
  button { width: 24px; height: 22px; padding: 0; border: 0; display: grid; place-items: center; color: var(--muted); border-radius: 3px; }
  button:hover:not(:disabled) { color: var(--ink); background: rgba(232,232,232,.08); }
  button:disabled { opacity: .3; }
  svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1.2; }
  @media (hover: none) { button:hover:not(:disabled) { color: inherit; background: transparent; } }
</style>
