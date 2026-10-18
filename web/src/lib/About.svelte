<script lang="ts">
  // About: a full-screen page over the app (the session underneath is untouched) with the mission, how the evidence works,
  // the technical design, data and licences, and support. "Back to session" returns to exactly where the user was.
  import { app } from './state.svelte';
  import Donate from './Donate.svelte';
  const repo = (import.meta.env.VITE_REPO_URL as string | undefined) || 'https://github.com/rockbottombaby/SADA';
  const SECTIONS = [
    ['mission', 'Mission'], ['what', 'What it does'], ['evidence', 'How to read it'], ['more', 'Code and details'],
    ['support', 'Support'], ['memory', 'In memory'],
  ] as const;
  let body: HTMLDivElement | undefined = $state();
  let current = $state('mission');
  const go = (id: string, smooth = true) => { body?.querySelector('#about-' + id)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }); current = id; };
  // the sidebar follows the section in view
  const onScroll = () => {
    if (!body) return;
    let best = 'mission';
    for (const [id] of SECTIONS) { const el = body.querySelector('#about-' + id) as HTMLElement | null; if (el && el.getBoundingClientRect().top - body.getBoundingClientRect().top < 120) best = id; }
    current = best;
  };
  const close = () => (app.aboutOpen = false);
  $effect(() => { if (app.aboutOpen && app.aboutSection) { const s = app.aboutSection; app.aboutSection = ''; setTimeout(() => go(s, false), 50); } });
  const n = (x: number) => x.toLocaleString();
</script>

<svelte:window onkeydown={e => { if (e.key === 'Escape' && app.aboutOpen) close(); }} />

{#if app.aboutOpen}
  <div class="page" role="dialog" aria-label="About SADA">
    <header>
      <div class="brand"><img src="/eye-32.png" srcset="/eye-32.png 1x, /eye-64.png 2x" width="24" height="24" alt="" /><span>SADA</span><i>About</i></div>
      <div class="links">
        <a href={repo} target="_blank" rel="noopener noreferrer">Source</a>
        <button class="back primary" onclick={close}>← Back to session</button>
      </div>
    </header>
    <div class="cols">
      <nav aria-label="Sections">
        {#each SECTIONS as [id, label]}<button class:on={current === id} onclick={() => go(id)}>{label}</button>{/each}
      </nav>
      <div class="body" bind:this={body} onscroll={onScroll}>
        <article>
          <section id="about-mission">
            <div class="kicker">Open-source investigative flight monitor</div>
            <h1>AI-powered research on the flights that carry weapons.</h1>
            <p class="lead">A free, open-source research tool for journalists and researchers. Ask a question; SADA searches a record of every tracked flight since 2023, shows its work on a map and gives a source for every figure.</p>
            <p>States use large-scale data and AI-assisted analysis to wage war. SADA turns the same kind of capability
              toward accountability: tracing the flights that carry weapons, and holding the governments that ship them, or let
              them pass, to account.</p>
            <p>This is the first version. It will grow, with more data sources and more tools, in the near future.</p>
            {#if app.ctx?.manifest}
              <div class="stats">
                <div><b>{n(app.ctx.manifest.legs)}</b><span>flights since {app.ctx.manifest.dates[0]}</span></div>
                <div><b>{n(app.ctx.manifest.leg_zones ?? 0)}</b><span>airspace crossings</span></div>
                <div><b>684</b><span>airspaces worldwide</span></div>
              </div>
            {/if}
          </section>

          <section id="about-what">
            <h2>What it does</h2>
            <ul class="plain">
              <li><b>Ask the AI</b> any question in plain language: it investigates, shows each step on the map and cites the evidence for every figure.</li>
              <li><b>Find flights</b> yourself between places, through any country's airspace, or by aircraft and operator, since March 2023.</li>
              <li><b>Follow live traffic</b>, including military aircraft worldwide.</li>
            </ul>
          </section>

          <section id="about-evidence">
            <h2>How to read it</h2>
            <ul class="plain">
              <li><i class="sw obs"></i><b>Observed</b> — the aircraft was seen inside the airspace.</li>
              <li><i class="sw inf"></i><b>Inferred</b> — the aircraft's path across a gap in receiver coverage crosses the airspace. An estimate, not a sighting.</li>
              <li><b>No data is not no flights.</b> Where no receiver listens, nothing is recorded. Flight data never shows cargo.</li>
            </ul>
          </section>

          <section id="about-more">
            <h2>Code and details</h2>
            <p>SADA is free and open source. How it works, the data and its licences are documented in the repository.</p>
            <a class="btn" href={repo} target="_blank" rel="noopener noreferrer">View on GitHub</a>
          </section>

          <section id="about-support">
            <h2>Support</h2>
            <p>SADA asks for nothing. If you want to give, please give where it is needed: to the family of Sha'ban al-Dalou.</p>
            <Donate />
          </section>

          <section id="about-memory">
            <h2>In memory</h2>
            <div class="mem">
              <img src="/shaban.webp" width="120" height="120" alt="Sha'ban Ahmad al-Dalou" />
              <div>
                <h3>Sha'ban Ahmad al-Dalou (2004–2024)</h3>
                <p>A young Palestinian software engineering student, burned alive when Israel bombed an emergency tent camp for families displaced
                  by the genocide, in Deir al-Balah, Gaza, on October 14, 2024.</p>
                <p>SADA takes its name from his initials, S.A.D., with A for Airwatch; <em>sada</em> (<span lang="ar">صدى</span>) also means “echo” in Arabic.</p>
              </div>
            </div>
          </section>
          <footer>Flight data © ADSB.lol contributors, ODbL · Code AGPL-3.0</footer>
        </article>
      </div>
    </div>
  </div>
{/if}

<style>
  .page { position: fixed; inset: 0; z-index: 60; background: var(--bg); display: flex; flex-direction: column; animation: in .2s ease-out; }
  @keyframes in { from { opacity: 0; } }
  header { height: 58px; flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 22px; border-bottom: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 13px; letter-spacing: 5px; text-transform: uppercase; color: var(--ink); }
  .brand i { font-style: normal; font-weight: 400; letter-spacing: 2px; color: var(--muted); font-size: 10.5px; }
  .links { display: flex; align-items: center; gap: 18px; }
  .links a { font-size: 10.5px; letter-spacing: 2px; text-transform: uppercase; color: var(--muted); text-decoration: none; }
  .links a:hover { color: var(--ink); }
  .back { font-size: 10px; letter-spacing: 2px; padding: 9px 14px; }
  .cols { flex: 1; min-height: 0; display: grid; grid-template-columns: 220px 1fr; }
  nav { border-right: 1px solid var(--line); padding: 22px 12px; display: flex; flex-direction: column; gap: 2px; overflow: auto; }
  nav button { border: 0; background: none; text-align: left; padding: 8px 12px; font-size: 12.5px; letter-spacing: 0; text-transform: none; color: var(--muted); border-radius: 4px; }
  nav button:hover { color: var(--ink); background: rgba(232,232,232,.05); }
  nav button.on { color: var(--ink); background: rgba(232,232,232,.08); box-shadow: inset 2px 0 0 var(--ink); }
  .body { overflow: auto; scroll-behavior: smooth; }
  article { max-width: 860px; margin: 0 auto; padding: 36px 40px 80px; }
  section { padding: 28px 0; border-bottom: 1px solid var(--line); scroll-margin-top: 20px; }
  section:last-of-type { border-bottom: 0; }
  .kicker { font-size: 10.5px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--muted); }
  h1 { font-size: 34px; line-height: 1.12; letter-spacing: -.4px; margin: 10px 0 16px; color: var(--ink); font-weight: 600; max-width: 720px; }
  h2 { font-size: 22px; margin: 0 0 12px; color: var(--ink); font-weight: 600; letter-spacing: -.2px; }
  h3 { font-size: 14.5px; margin: 0 0 6px; color: var(--ink); font-weight: 600; }
  p, li { font-size: 14px; line-height: 1.62; color: var(--text); }
  p { margin: 8px 0; } .lead { font-size: 16px; color: var(--ink); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; margin: 18px 0; }
  .stats div { padding: 14px 16px; border-right: 1px solid var(--line); background: var(--panel, #141414); }
  .stats div:last-child { border-right: 0; }
  .stats b { display: block; font-family: var(--mono); font-size: 20px; font-weight: 500; color: var(--ink); }
  .stats span { font-size: 11.5px; color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .card { border: 1px solid var(--line); border-radius: var(--r); padding: 16px 18px; background: rgba(232,232,232,.02); }
  .card p { margin: 0; font-size: 13.5px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; margin: 8px 0; }
  th, td { text-align: left; vertical-align: top; padding: 10px 12px 10px 0; border-top: 1px solid var(--line); line-height: 1.55; }
  th { color: var(--ink); font-weight: 600; white-space: nowrap; width: 170px; }
  thead th { font-size: 10.5px; letter-spacing: 2px; text-transform: uppercase; color: var(--muted); font-weight: 500; border-top: 0; width: auto; }
  .stack td:nth-child(2) { font-family: var(--mono); font-size: 12.5px; color: var(--ink); }
  .sw { display: inline-block; width: 12px; height: 3px; border-radius: 2px; margin-right: 8px; vertical-align: middle; }
  .sw.obs { background: var(--obs, #f2c14e); } .sw.inf { background: var(--inf, #8fb8ff); } .sw.mil { background: var(--mil, #c7a6ff); } .sw.sov { height: 0; border: 1.5px solid var(--sov, #ff8a80); }
  .steps { counter-reset: s; padding: 0; margin: 8px 0; list-style: none; }
  .steps li { counter-increment: s; display: grid; grid-template-columns: 34px 1fr; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); }
  .steps li::before { content: counter(s, decimal-leading-zero); font-family: var(--mono); font-size: 12px; color: var(--faint); padding-top: 3px; }
  ul { padding-left: 18px; margin: 8px 0; } ul li { margin: 6px 0; }
  ul.plain { list-style: none; padding: 0; } ul.plain li { padding: 10px 0; border-top: 1px solid var(--line); margin: 0; }
  b { color: var(--ink); font-weight: 600; }
  .btn { display: inline-block; padding: 11px 18px; border: 1px solid var(--line2); border-radius: var(--r); color: var(--ink); text-decoration: none; font-size: 10.5px; letter-spacing: 2.5px; text-transform: uppercase; margin: 8px 0; }
  .btn.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  .btn.dim { opacity: .5; cursor: default; margin-right: 12px; }
  .soon { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; color: var(--muted); }
  .mem { display: grid; grid-template-columns: 120px 1fr; gap: 22px; align-items: center; }
  .mem img { border-radius: var(--r); border: 1px solid var(--line2); display: block; object-fit: cover; }
  footer { margin-top: 36px; font-size: 12px; color: var(--faint); } footer a { color: var(--muted); }
  @media (max-width: 760px) { .cols { grid-template-columns: 1fr; } nav { display: none; } article { padding: 24px 16px 60px; } h1 { font-size: 26px; } .mem { grid-template-columns: 1fr; } }
</style>
