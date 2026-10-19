<script lang="ts">
  // Shown every time the app opens: once the loading screen is gone, after a moment with the interface in view.
  // Reopened from the logo in the header.
  import { app } from './state.svelte';
  // the welcome on opening waits a moment; reopened from the logo it appears at once
  let first = true;
  const close = () => { app.memorialOpen = false; first = false; };
</script>

<svelte:window onkeydown={e => { if (e.key === 'Escape' && app.memorialOpen) close(); }} />

{#if app.memorialOpen && (app.ready || app.error)}
  <div class="scrim" class:now={!first} role="presentation"></div>
  <div class="wrap" class:now={!first} role="dialog" aria-modal="true" aria-labelledby="mem-name">
    <article class="card" class:now={!first}>
      <div class="portrait"><img src="/shaban.webp" width="360" height="360" alt="Sha'ban Ahmad al-Dalou" /></div>
      <div class="text">
        <div class="label">In memory of</div>
        <h2 id="mem-name">Sha'ban Ahmad al-Dalou</h2>
        <div class="years">2004 – 2024</div>
        <p>A young Palestinian software engineering student, burned alive when Israel bombed an emergency tent camp for families displaced by the genocide, in Deir al-Balah, Gaza, on October 14, 2024.</p>
        <p class="quote">The world watched him die. Now, in his memory, he watches over the skies.</p>
        <p class="nf">You are not forgotten, Sha'ban.</p>
        <p class="name">SADA takes its name from his initials, S.A.D., with A for Airwatch. Sada (<span lang="ar" dir="rtl">صدى</span>) also means “echo” in Arabic.</p>
        <button class="primary" onclick={close}>Continue to the map</button>
      </div>
    </article>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 120; background: rgba(0, 0, 0, .82); backdrop-filter: blur(16px) grayscale(.6); -webkit-backdrop-filter: blur(16px) grayscale(.6); animation: fade 1s ease-out 1.6s both, show 0s linear 1.6s both; }
  .wrap { position: fixed; inset: 0; z-index: 121; display: grid; place-items: center; overflow: auto; padding: 112px 16px;   /* equal top and bottom: the card itself is centred; the top padding leaves room for the head */
    animation: show 0s linear 1.6s both; }   /* not there at all (no stray click-blocking) until it fades in */
  /* he stands in the left column, tall enough that his head rises above the card's top edge;
     a faint light behind him keeps his dark jacket from dissolving into the card */
  .card { position: relative; width: min(960px, 100%); display: grid; grid-template-columns: 420px 1fr; background: var(--bg); border: 1px solid var(--line2); border-radius: var(--r);
    box-shadow: 0 50px 120px rgba(0, 0, 0, .7); animation: rise 1.1s cubic-bezier(.2, .7, .2, 1) 1.9s both; }
  /* clipped at the column's sides and bottom, open at the top */
  .portrait { position: relative; min-height: 380px; border-radius: var(--r) 0 0 var(--r); clip-path: inset(-160px 0 0 0 round 0 0 0 var(--r));
    background: radial-gradient(ellipse 70% 62% at 50% 62%, rgba(232, 232, 232, .09), rgba(232, 232, 232, 0) 72%); }
  .portrait img { position: absolute; left: 50%; bottom: 0; transform: translateX(-50%); height: calc(100% + 104px); width: auto; max-width: none;
    -webkit-mask-image: linear-gradient(to bottom, #000 82%, rgba(0, 0, 0, .55)); mask-image: linear-gradient(to bottom, #000 82%, rgba(0, 0, 0, .55)); }
  .text { padding: 40px 44px 36px 30px; display: flex; flex-direction: column; text-wrap: pretty; }
  .label { font-size: 9.5px; text-transform: uppercase; letter-spacing: 3px; color: var(--muted); }
  h2 { margin: 10px 0 0; font-size: 28px; font-weight: 600; letter-spacing: -.4px; line-height: 1.15; }
  .years { margin-top: 8px; font-family: var(--mono); font-size: 12px; color: var(--muted); letter-spacing: 1px; }
  p { margin: 18px 0 0; font-size: 14px; line-height: 1.7; color: var(--text, var(--ink)); }
  .quote { font-size: 17px; line-height: 1.55; color: var(--ink); padding-left: 16px; border-left: 1px solid var(--ink); margin-top: 22px; }
  .nf { font-weight: 600; color: var(--ink); }
  .name { font-size: 12.5px; font-style: italic; color: var(--muted); margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
  .name span { font-style: normal; font-size: 14px; }
  button { align-self: flex-end; margin-top: auto; }   /* bottom-right of the text column */
  .name { margin-bottom: 26px; }
  .scrim.now, .card.now { animation-delay: 0s; animation-duration: .35s; } .wrap.now { animation: none; }
  @keyframes show { from { visibility: hidden; } }
  @keyframes fade { from { opacity: 0; } }
  @keyframes rise { from { opacity: 0; transform: translateY(14px); } }
  /* phones: a compact card that fits the screen; the portrait is a short band above the text, the button always in reach */
  @media (max-width: 760px) {
    .wrap { padding: 12px; align-items: center; }
    .card { grid-template-columns: 1fr; width: 100%; max-height: calc(100dvh - 24px); overflow-y: auto; border-radius: 10px; }
    .portrait { min-height: 0; height: 150px; border-radius: 10px 10px 0 0; clip-path: none; overflow: hidden; flex: none; }
    .portrait img { position: absolute; left: 50%; top: 0; bottom: auto; transform: translateX(-50%); height: 210px; width: auto;
      -webkit-mask-image: linear-gradient(to bottom, #000 55%, rgba(0, 0, 0, 0)); mask-image: linear-gradient(to bottom, #000 55%, rgba(0, 0, 0, 0)); }
    .text { padding: 4px 20px 18px; }
    h2 { font-size: 22px; margin-top: 6px; }
    .years { margin-top: 5px; }
    p { margin-top: 12px; font-size: 13.5px; line-height: 1.55; }
    .quote { font-size: 15px; margin-top: 14px; padding-left: 12px; }
    .name { font-size: 11.5px; margin: 12px 0 14px; padding-top: 10px; }
    button { align-self: stretch; margin-top: 0; padding: 12px; }
  }
  @media (prefers-reduced-motion: reduce) { .scrim, .card { animation: none; } }
</style>
