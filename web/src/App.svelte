<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { polygonToCells } from 'h3-js';
  import MapView from './lib/MapView.svelte';
  import Explore from './lib/Explore.svelte';
  import Inspector from './lib/Inspector.svelte';
  import Chat from './lib/Chat.svelte';
  import SettingsDialog from './lib/SettingsDialog.svelte';
  import About from './lib/About.svelte';
  import Coffee from './lib/Coffee.svelte';
  import { session, saveSession, loadSession, newSession } from './lib/session.svelte';
  let menuOpen = $state('');
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  // desktop-style shortcuts for the session file; a click anywhere closes an open menu
  const onKey = (e: KeyboardEvent) => { if (!(e.metaKey || e.ctrlKey) || e.altKey) return; const k = e.key.toLowerCase(); if (k === 's') { e.preventDefault(); saveSession(); } else if (k === 'o') { e.preventDefault(); loadSession(); } };
  import KeySetup from './lib/KeySetup.svelte';
  import Memorial from './lib/Memorial.svelte';
  import { app, selectLeg } from './lib/state.svelte';
  import { settings, saveSettings } from './lib/prefs.svelte';
  import { setLive } from './lib/live.svelte';
  import { finishOpenRouterSignIn } from './lib/openrouter';
  import { openDb, loadManifest, queryWithin, cancelCurrent, pending } from './lib/db';
  import { warmCache } from './lib/tools';
  import { currentTrail } from './lib/trail.svelte';
  import { setDbCancel } from './lib/agent';
  import { setupViews, type Ctx, type ZoneMeta } from './lib/tools';

  let manifest = $state<any>(null);
  // phones and small tablets: the three panels become tabs over a full-screen map; the dock starts folded
  import { setWin } from './lib/dock.svelte';
  import { trail } from './lib/trail.svelte';
  // (untracked: folding the dock reads its state, which must not make this effect re-run and fold it again on every change)
  $effect(() => {
    const mq = matchMedia('(max-width: 900px)');
    const apply = () => untrack(() => { app.mobile = mq.matches; if (mq.matches) { setWin('research', 'min'); setWin('scene', 'min'); } });
    apply(); mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  });

  onMount(async () => {
    try {
      const step = (label: string, progress: number) => { app.loading = { step: label, progress }; };
      step('Starting the database engine', 0.08);
      const query = await openDb();
      setDbCancel(cancelCurrent);   // the chat's Stop cancels the running database query
      // back from "Sign in with OpenRouter": swap the one-time code for the key, then show the setup screen as connected
      try {
        const k = await finishOpenRouterSignIn();
        if (k) { settings.openrouterKey = k; settings.provider = 'openrouter'; saveSettings(); app.memorialOpen = false; app.keySetupOpen = true; }
      } catch (e) { app.status = String((e as Error).message ?? e); }
      step('Reading the dataset manifest', 0.45);
      manifest = await loadManifest(settings.dataUrl.replace(/\/$/, ''));
      step('Loading airspace boundaries', 0.62);
      const geo = await (await fetch(`${manifest.base}/${manifest.files.zones}`)).json();
      app.zoneGeo = geo;
      app.zones = geo.features.map((f: any) => f.properties as ZoneMeta);
      // independent checks of our inferred crossings (optional file; absent on datasets without one)
      const validation: Record<string, any> = {};
      try { const v = await fetch(`${manifest.base}/meta/validation/iceland_sov_adsbx.json`); if (v.ok) validation['sov:ISL'] = await v.json(); } catch { /* none */ }
      const ctx: Ctx = { query, queryWithin, manifest, validation, zones: app.zones, cellsForPolygon: (ring, res) => polygonToCells(ring, res, true),
        defaultPeriod: () => (app.dateFrom && app.dateTo ? [app.dateFrom, app.dateTo] : null),
        keys: () => ({ census: settings.censusKey, openskyId: settings.openskyId, openskySecret: settings.openskySecret,
          openskyBase: settings.openskyBase || (settings.proxyBase ? settings.proxyBase.replace(/\/$/, '') + '/opensky' : ''), proxyBase: settings.proxyBase }) };
      step('Preparing flight tables', 0.85);
      await setupViews(ctx);
      step('Ready', 1);
      app.ctx = ctx;
      // every session starts with the live layer on: what is in the air right now, from the first second
      if (settings.proxyBase) setLive(true);
      if (import.meta.env.DEV) (window as any).__oam = { app, ctx, selectLeg, cancelCurrent, tools: (await import('./lib/tools')).TOOLS, uiTools: (await import('./lib/uiTools')).UI_TOOLS, allTools: [...(await import('./lib/tools')).TOOLS, ...(await import('./lib/sources')).SOURCE_TOOLS, ...(await import('./lib/playbooks')).PLAYBOOKS, ...(await import('./lib/uiTools')).UI_TOOLS], trailApi: await import('./lib/trail.svelte'), stateApi: await import('./lib/state.svelte'), dockApi: await import('./lib/dock.svelte'), liveApi: await import('./lib/live.svelte'), orApi: await import('./lib/openrouter'), sessionApi: await import('./lib/session.svelte'), trailSteps: () => (currentTrail()?.steps ?? []).map(s => ({ ...s })) };   // test hook (dev server only)
      // start on the latest week: whole-archive queries are possible but slow in the browser
      // no preset period: the user chooses one in the search form
      app.ready = true;
      setTimeout(() => warmCache(ctx, () => pending() > 0), 1500);   // after the first paint, between the user's queries: footers and the registry into the cache
      app.status = '';
      const h = new URLSearchParams(location.hash.slice(1));
      if (h.get('leg')) selectLeg(h.get('leg')!);
    } catch (e) { app.error = String(e); }
  });
</script>

<svelte:window onkeydown={onKey} onclick={() => (menuOpen = '')} />
<header>
  <div class="hleft">
  <button class="brand" title="In memory of Sha'ban al-Dalou" onclick={() => (app.memorialOpen = true)}><img class="logo" src="/eye-32.png" srcset="/eye-32.png 1x, /eye-64.png 2x" width="32" height="32" alt="" />SADA<span class="beta" title="First public version">beta</span></button>
  <!-- the menu bar: sessions as files (like a desktop app), About, and support -->
  <nav class="menu" aria-label="Main menu">
    <div class="dd" class:open={menuOpen === 'session'}>
      <button class="mi" aria-haspopup="menu" aria-expanded={menuOpen === 'session'} onclick={e => { e.stopPropagation(); menuOpen = menuOpen === 'session' ? '' : 'session'; }}>Session{#if session.file}<span class="file"> · {session.file}</span>{/if}</button>
      {#if menuOpen === 'session'}
        <div class="list" role="menu">
          <button role="menuitem" onclick={() => { menuOpen = ''; saveSession(); }}>Save session…<kbd>{mod}S</kbd></button>
          <button role="menuitem" onclick={() => { menuOpen = ''; loadSession(); }}>Load session…<kbd>{mod}O</kbd></button>
          <button role="menuitem" onclick={() => { menuOpen = ''; newSession(); }}>New session</button>
          <div class="hint">A session is your chat tabs with their answers, case files and research trails. The browser keeps the current one; a file survives a cleared browser and moves between machines.</div>
        </div>
      {/if}
    </div>
    <button class="mi" onclick={() => (app.aboutOpen = true)}>About</button>
  </nav>
  </div>
  <div class="range" title="Days covered by the data (some days may be missing); updated daily">
  {#if manifest}
      <span class="label">Data</span>
      <span class="count"><b>{manifest.dates[0]}</b> <i>→</i> <b>{manifest.dates[manifest.dates.length - 1]}</b> <i>/</i> <b>{manifest.legs.toLocaleString()}</b> flights</span>
  {/if}
  </div>
  <div class="hright">
    {#if app.status}<span class="status">{app.status}</span>{/if}
    <button class="mi coffee" onclick={() => (app.coffeeOpen = true)}>Buy me a coffee ☕</button>
    <button class="gear" title="Settings" onclick={() => (app.settingsOpen = true)}>Settings</button>
    <!-- phones: everything but Settings behind one menu -->
    <div class="dd more" class:open={menuOpen === 'more'}>
      <button class="burger" aria-label="Menu" aria-haspopup="menu" aria-expanded={menuOpen === 'more'} onclick={e => { e.stopPropagation(); menuOpen = menuOpen === 'more' ? '' : 'more'; }}><i></i><i></i><i></i></button>
      {#if menuOpen === 'more'}
        <div class="list end" role="menu">
          <button role="menuitem" onclick={() => { menuOpen = ''; saveSession(); }}>Save session…</button>
          <button role="menuitem" onclick={() => { menuOpen = ''; loadSession(); }}>Load session…</button>
          <button role="menuitem" onclick={() => { menuOpen = ''; newSession(); }}>New session</button>
          <button role="menuitem" onclick={() => { menuOpen = ''; app.aboutOpen = true; }}>About</button>
          <button role="menuitem" onclick={() => { menuOpen = ''; app.coffeeOpen = true; }}>Buy me a coffee ☕</button>
          <button role="menuitem" onclick={() => { menuOpen = ''; app.memorialOpen = true; }}>In memory of Sha'ban</button>
        </div>
      {/if}
    </div>
  </div>
</header>

{#if app.error}
  <div class="err"><h3>Could not load the data</h3><p>{app.error}</p>
    <p class="muted">Is the data server running? Expected <code>{settings.dataUrl}/manifest.json</code>.</p></div>
{:else}
  <main class:mobile={app.mobile}>
    <aside class="left" class:show={app.tab === 'search'}>{#if app.ready}<Explore />{/if}</aside>
    <div class="stage"><MapView /></div>
    <aside class="right" class:show={app.tab === 'ask'}>{#if app.ready}<Chat />{/if}</aside>
  </main>
  {#if app.mobile && app.ready}
    <nav class="tabbar" aria-label="Sections">
      <button class:on={app.tab === 'search'} onclick={() => (app.tab = 'search')}>Search{#if app.explore.kind !== 'home'}<i class="dot"></i>{/if}</button>
      <button class:on={app.tab === 'map'} onclick={() => (app.tab = 'map')}>Map</button>
      <button class:on={app.tab === 'ask'} onclick={() => (app.tab = 'ask')}>Ask{#if trail.busy}<i class="dot busy"></i>{/if}</button>
    </nav>
  {/if}
{/if}
{#if app.ready}<Inspector />{/if}
<SettingsDialog />
<About />
<Coffee />
<KeySetup />
<Memorial />

{#if !app.ready && !app.error}
  <div class="splash" role="status" aria-live="polite">
    <div class="spin"><img class="eye" src="/eye-64.png" width="128" height="128" alt="" /><span></span><span></span></div>
    <div class="name">SADA</div>
    <div class="bar"><i style="width: {Math.round(app.loading.progress * 100)}%"></i></div>
    <div class="step">{app.loading.step || 'Loading'}</div>
  </div>
{/if}

<style>
  header { --fieldbg: var(--bg); height: 58px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 28px; padding: 0 18px; background: var(--bg); border-bottom: 1px solid var(--line); }
  .hleft { display: flex; align-items: center; gap: 28px; min-width: 0; }
  .beta { font-size: 7.5px; letter-spacing: .6px; font-weight: 500; text-transform: lowercase; color: var(--muted); margin-left: -15px; align-self: flex-start; line-height: 1; padding-top: 1px; }   /* like a ™ mark, tight to the name */
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: 5px; white-space: nowrap; border: 0; padding: 0; background: none; color: var(--ink); cursor: pointer; }
  .brand:hover { background: none; }
  .logo { width: 32px; height: 32px; margin: -4px 0; image-rendering: pixelated; flex: none; }
  .menu { display: flex; align-items: center; gap: 2px; margin-left: -8px; }
  .mi { border: 0; background: none; padding: 7px 10px; font-size: 10.5px; letter-spacing: 2px; text-transform: uppercase; color: var(--muted); text-decoration: none; border-radius: var(--r); }
  .mi:hover, .dd.open .mi { color: var(--ink); background: rgba(232,232,232,.06); }
  .mi .file { letter-spacing: 0; text-transform: none; font-family: var(--mono); font-size: 10.5px; color: var(--faint); }
  .dd { position: relative; }
  .list { position: absolute; top: calc(100% + 4px); left: 0; z-index: 40; min-width: 260px; background: rgba(16,16,16,.98); border: 1px solid var(--line2); border-radius: var(--r); padding: 6px; box-shadow: 0 16px 40px rgba(0,0,0,.5); display: flex; flex-direction: column; }
  .list button { display: flex; justify-content: space-between; gap: 18px; width: 100%; border: 0; text-align: left; padding: 8px 10px; font-size: 12.5px; text-transform: none; letter-spacing: 0; color: var(--ink); border-radius: 4px; }
  .list button:hover { background: rgba(232,232,232,.08); }
  .list kbd { font-family: var(--mono); font-size: 10.5px; color: var(--faint); }
  .list .hint { padding: 8px 10px 6px; font-size: 11px; line-height: 1.45; color: var(--muted); border-top: 1px solid var(--line); margin-top: 4px; }
  .range { display: flex; align-items: center; gap: 10px; }
  .range .field input { padding: 8px 10px 6px; font-size: 12px; font-family: var(--mono); width: 138px; }
  .count { font-size: 11px; color: var(--muted); letter-spacing: .5px; } .count b { color: var(--ink); font-family: var(--mono); font-weight: 500; } .count i { color: var(--faint); font-style: normal; margin: 0 4px; }
  .hright { justify-self: end; display: flex; align-items: center; gap: 12px; }
  .status { color: var(--obs); font-size: 11px; letter-spacing: .5px; font-family: var(--mono); }
  main { display: flex; height: calc(100% - 58px); }
  .left { width: 340px; flex: none; background: var(--bg); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
  .stage { flex: 1; position: relative; min-width: 320px; }
  .right { width: 400px; flex: none; background: var(--bg); border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
  .err { padding: 40px; max-width: 700px; }
  .more { display: none; }
  .splash { position: fixed; inset: 0; z-index: 100; background: #000; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; animation: in .3s ease-out; }
  @keyframes in { from { opacity: 0; } }
  /* the eye, watching, with two thin rings turning around it */
  .spin { position: relative; width: 176px; height: 176px; display: grid; place-items: center; }
  .eye { width: 128px; height: 128px; image-rendering: pixelated; animation: breathe 2.8s ease-in-out infinite; }
  @keyframes breathe { 50% { transform: scale(1.03); filter: brightness(1.12); } }
  .spin span { position: absolute; inset: 0; border: 1.5px solid transparent; border-top-color: #fff; border-radius: 50%; animation: rot 1.1s cubic-bezier(.5,.1,.5,.9) infinite; }
  .spin span:last-child { inset: 10px; border-top-color: transparent; border-bottom-color: rgba(255,255,255,.4); animation-duration: 1.6s; animation-direction: reverse; }
  @media (prefers-reduced-motion: reduce) { .eye, .spin span { animation: none; } }
  @keyframes rot { to { transform: rotate(360deg); } }
  .name { font-size: 11px; text-transform: uppercase; letter-spacing: 4px; color: #fff; font-weight: 600; }
  .bar { width: 220px; height: 2px; background: rgba(255,255,255,.12); overflow: hidden; }
  .bar i { display: block; height: 100%; background: #fff; transition: width .45s ease; }
  .step { font-size: 10.5px; color: rgba(255,255,255,.5); font-family: var(--mono); letter-spacing: .3px; min-height: 14px; }
  /* phones: the map fills the screen; Search and Ask are full-screen panels over it, chosen with the tab bar */
  .tabbar { display: none; }
  /* small laptops and landscape tablets: narrower side columns, a lighter header, so the map keeps room */
  @media (min-width: 901px) and (max-width: 1200px) {
    .left { width: 290px; } .right { width: 340px; }
    header { gap: 14px; } .hleft { gap: 14px; } .range .count { font-size: 10.5px; } .mi.coffee { display: none; }
  }
  @media (min-width: 901px) and (max-width: 1040px) { .range { display: none; } }
  @media (max-width: 900px) {
    header { height: 50px; display: flex; justify-content: space-between; gap: 10px; padding: 0 12px 0 14px; }
    .hleft { gap: 14px; flex: 1; } .hright { flex: none; } .menu, .mi.coffee, .range { display: none; }
    .more { display: block; position: relative; }
    .burger { width: 40px; height: 40px; padding: 0; border: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; }
    .burger i { display: block; width: 18px; height: 1.5px; background: var(--ink); } .burger:hover { background: transparent; }
    .list.end { left: auto; right: 0; min-width: 220px; } .list button { padding: 12px 12px; font-size: 14px; }
    .brand { font-size: 12px; letter-spacing: 4px; gap: 10px; } .logo { width: 28px; height: 28px; }
    .hright { gap: 8px; } .gear { padding: 7px 10px; font-size: 10px; }
    main { display: block; position: relative; height: calc(100dvh - 50px - 54px - env(safe-area-inset-bottom, 0px)); }
    .stage { position: absolute; inset: 0; min-width: 0; }
    .left, .right { position: absolute; inset: 0; width: auto; border: 0; display: none; z-index: 5; }
    .left.show, .right.show { display: flex; }
    .tabbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; height: calc(54px + env(safe-area-inset-bottom, 0px)); padding-bottom: env(safe-area-inset-bottom, 0px);
      display: flex; background: var(--bg); border-top: 1px solid var(--line2); }
    .tabbar button { flex: 1; border: 0; border-radius: 0; padding: 0; font-size: 10.5px; letter-spacing: 2.4px; color: var(--muted); position: relative; display: flex; align-items: center; justify-content: center; gap: 6px; }
    .tabbar button.on { color: var(--ink); box-shadow: inset 0 2px 0 var(--ink); }
    .tabbar button:hover { background: transparent; color: var(--muted); } .tabbar button.on:hover { color: var(--ink); }
    .tabbar .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--ink); } .tabbar .dot.busy { background: var(--obs); animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .3; } }
  }
  @media (hover: none) { .mi:hover { color: var(--muted); background: none; } .list button:hover { background: transparent; } }
</style>
