<script lang="ts">
  // "Buy me a coffee": the author has enough coffee; this points to where money is needed instead.
  import { app } from './state.svelte';
  import Donate from './Donate.svelte';
  const close = () => (app.coffeeOpen = false);
</script>

<svelte:window onkeydown={e => { if (e.key === 'Escape' && app.coffeeOpen) close(); }} />

{#if app.coffeeOpen}
  <div class="backdrop" role="presentation" onclick={close}></div>
  <div class="dialog" role="dialog" aria-label="Support">
    <div class="cup" aria-hidden="true">☕</div>
    <h3>Thanks, but I have plenty of coffee.</h3>
    <p>Please put your money where it is needed.</p>
    <Donate />
    <div class="row"><button class="primary" onclick={close}>Close</button></div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(8,8,8,.6); backdrop-filter: blur(12px) grayscale(.4); -webkit-backdrop-filter: blur(12px) grayscale(.4); z-index: 70; }
  .dialog { position: fixed; z-index: 71; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(460px, 92vw); background: var(--bg);
    border: 1px solid var(--line2); border-radius: var(--r); padding: 26px 26px 20px; box-shadow: 0 40px 100px rgba(0,0,0,.6); }
  .cup { font-size: 26px; margin-bottom: 10px; }
  h3 { margin: 0 0 4px; font-size: 18px; font-weight: 600; color: var(--ink); }
  p { margin: 0; font-size: 14px; color: var(--text); }
  .row { display: flex; justify-content: flex-end; margin-top: 16px; }
  @media (max-width: 900px) { .dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 24px); padding: 18px 16px; } }
</style>
