<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import * as maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
  import { app, selectLeg, clearScene, clearSelection, sceneBack, sceneForward, zoneName, showFlows, tool, type Leg } from './state.svelte';
  import { live, setLive, toggleWatch, shown, trailOf, loadTraces, kindOf, FILTERS, setFilter, setView, viewNote, type LiveAc } from './live.svelte';
  import { trail, currentTrail, type Pt, type Step } from './trail.svelte';
  import { dock, setWin, winMode, anyMax } from './dock.svelte';
  import WinCtl from './WinCtl.svelte';
  import FlightRow from './FlightRow.svelte';
  import ResearchTrail from './ResearchTrail.svelte';
  import { ArcLayer, type ArcFlight } from './arcs';
  maplibregl.setWorkerUrl(workerUrl);
  // flights as arcs lifted off the globe (WebGL custom layer): hover fans out overlapping arcs, click selects one
  const arcs = new ArcLayer();
  if (import.meta.env.DEV) (window as any).__arcs = arcs;

  let el: HTMLDivElement;
  let map: maplibregl.Map;
  // the flight under the pointer (from the arc layer) and where to show its label
  let hoverId = $state<string | null>(null);
  let hoverAt = $state<[number, number]>([0, 0]);
  const hoverLeg = $derived(hoverId ? app.map.flows.find(l => String(l.leg_id) === hoverId) ?? null : null);
  let loaded = $state(false);
  let drawPts: [number, number][] = [];
  let showZones = $state(true);
  const phone = matchMedia('(max-width: 900px)').matches;
  let showNames = $state(!phone);   // country names: off on phones, where they crowd the small globe
  // the early-beta note, inside the map so it never pushes the controls; dismissed once per browser
  // dismissed with its ✕, it stays away for a week, then shows again while the beta lasts
  let note = $state((() => { try { return Date.now() - Number(localStorage.getItem('sada.notice1') || 0) > 7 * 86400e3; } catch { return true; } })());
  const dismissNote = () => { note = false; try { localStorage.setItem('sada.notice1', String(Date.now())); } catch { /* storage blocked */ } };
  // the whole planet on the screen (phones): the globe's diameter is 512·2^z/π px
  const fitZoom = () => Math.log2(Math.min(el.clientWidth, el.clientHeight) * Math.PI / 512) - 0.14;
  const home = () => (phone ? { center: [-15, 30] as [number, number], zoom: fitZoom() } : { center: [-15, 55] as [number, number], zoom: 1.7 });
  let showFlowsLayer = $state(true);

  const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  const R = Math.PI / 180;
  const MAX_FLOWS = 5000;   // drawn thin and faint when many; the list keeps everything

  function arc(a: [number, number], b: [number, number], n = 40): [number, number][] {
    const [lo1, la1] = [a[0] * R, a[1] * R], [lo2, la2] = [b[0] * R, b[1] * R];
    const p1 = [Math.cos(la1) * Math.cos(lo1), Math.cos(la1) * Math.sin(lo1), Math.sin(la1)];
    const p2 = [Math.cos(la2) * Math.cos(lo2), Math.cos(la2) * Math.sin(lo2), Math.sin(la2)];
    const om = Math.acos(Math.min(1, p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2]));
    if (om < 1e-6) return [a, b];
    const out: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n, s1 = Math.sin((1 - f) * om) / Math.sin(om), s2 = Math.sin(f * om) / Math.sin(om);
      const x = s1 * p1[0] + s2 * p2[0], y = s1 * p1[1] + s2 * p2[1], z = s1 * p1[2] + s2 * p2[2];
      out.push([Math.atan2(y, x) / R, Math.atan2(z, Math.hypot(x, y)) / R]);
    }
    return out;
  }
  function fitCoords(coords: [number, number][], maxZoom = 6) {
    if (!coords.length) return;
    const b = new maplibregl.LngLatBounds();
    coords.forEach(c => b.extend(c));
    map.fitBounds(b, { padding: { top: 70, bottom: 70, left: 70, right: 70 }, maxZoom, duration: 900 });
  }
  const zoneFeature = (id: string | null) => app.zoneGeo?.features.find((x: GeoJSON.Feature) => x.properties?.id === id);

  onMount(() => {
    map = new maplibregl.Map({
      container: el,
      style: {
        version: 8,
        projection: { type: 'globe' },
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: { ocean: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -84.8], [180, -84.8], [180, 85.06], [-180, 85.06], [-180, -84.8]]] } } },
          countries: { type: 'geojson', data: '/countries.geojson' }, clabels: { type: 'geojson', data: '/country_labels.geojson' } },
        layers: [
          // The globe cannot draw map data within ~5° of the poles (tile limit); it stretches the data's edge over those caps.
          // Background = land colour and the ocean is a shape that stops short of 85°S, so the south cap (Antarctica) is
          // land-coloured while the north cap (Arctic Ocean) stays ocean-coloured.
          { id: 'bg', type: 'background', paint: { 'background-color': '#2c2c2c' } },
          { id: 'ocean', type: 'fill', source: 'ocean', paint: { 'fill-color': '#171717' } },
          { id: 'land', type: 'fill', source: 'countries', paint: { 'fill-color': '#2c2c2c' } },
          { id: 'land-hl', type: 'fill', source: 'countries', filter: ['in', ['get', 'ISO_A3'], ['literal', []]], paint: { 'fill-color': '#4b4b4b' } },   // filter set below (ISO_A3, or ADM0_A3 where ISO_A3 is -99: France, Norway, …)
          { id: 'borders', type: 'line', source: 'countries', paint: { 'line-color': '#5c5c5c', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1.1] } },
        ],
      } as any,
      ...(phone ? { center: [-15, 30], zoom: Math.log2(Math.min(el.clientWidth, el.clientHeight) * Math.PI / 512) - 0.14 } : { center: [-15, 55], zoom: 1.7 }), attributionControl: false,
      fadeDuration: 0,   // labels switch instantly; a fade lets names on the far side of the globe show through while it turns
    });
    if (import.meta.env.DEV) (window as any).__map = map;   // test hook (dev server only)
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');   // the dock owns the bottom edge
    // the attribution folded to its ⓘ everywhere (it opens on a click), tucked under the dock at the bottom right
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'ADS-B: ADSB.lol (ODbL) · Natural Earth · OurAirports' }), 'bottom-right');
    map.once('load', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
    map.on('load', () => {
      map.addSource('zones', { type: 'geojson', data: empty });
      map.addLayer({ id: 'zones-line', type: 'line', source: 'zones', paint: {
        'line-color': ['match', ['get', 'kind'], 'sovereign', '#8a4b4b', 'fir', '#7d6a3a', '#6b6448'], 'line-width': 0.6, 'line-opacity': 0.55 } });
      map.addLayer({ id: 'zone-focus-fill', type: 'fill', source: 'zones', filter: ['==', ['get', 'id'], ''], paint: {
        'fill-color': ['match', ['get', 'kind'], 'sovereign', '#ff4d4d', '#ffb020'], 'fill-opacity': 0.16 } });
      map.addLayer({ id: 'zone-focus-line', type: 'line', source: 'zones', filter: ['==', ['get', 'id'], ''], paint: {
        'line-color': ['match', ['get', 'kind'], 'sovereign', '#ff6b6b', '#ffb020'], 'line-width': 2 } });
      map.addSource('flows', { type: 'geojson', data: empty });
      map.addLayer({ id: 'flows', type: 'line', source: 'flows', paint: {
        'line-color': ['case', ['==', ['get', 'mil'], 1], '#c7a6ff', ['==', ['get', 'evidence'], 'inferred'], '#8fb8ff', '#f2c14e'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 5, 1.4], 'line-opacity': ['get', 'op'] } });
      map.addSource('track', { type: 'geojson', data: empty });
      map.addLayer({ id: 'track-gap', type: 'line', source: 'track', filter: ['==', ['get', 'kind'], 'gap'],
        paint: { 'line-color': '#ffffff', 'line-width': 1.4, 'line-dasharray': [2, 2], 'line-opacity': 0.75 } });
      map.addLayer({ id: 'track', type: 'line', source: 'track', filter: ['==', ['get', 'kind'], 'seg'],
        paint: { 'line-color': '#7fd1ff', 'line-width': 3 } });
      map.addLayer({ id: 'flows-sel', type: 'line', source: 'flows', filter: ['==', ['get', 'sel'], 1], paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-blur': 0.5 } }, 'track-gap');
      map.addLayer(arcs, 'track-gap');
      // country names appear by zoom: larger countries first, smaller ones as you zoom in (Natural Earth label rank).
      // Separate layers per band; the top layer (largest countries) wins label collisions.
      for (const [id, cond, minzoom] of [['clabels-4', ['>=', ['get', 'rank'], 6], 4.2], ['clabels-3', ['==', ['get', 'rank'], 5], 3.4],
                                         ['clabels-2', ['==', ['get', 'rank'], 4], 2.6], ['clabels-1', ['<=', ['get', 'rank'], 3], 0]] as const)
        map.addLayer({ id, type: 'symbol', source: 'clabels', minzoom, filter: cond as any, layout: {
          'text-field': ['get', 'name'], 'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 5, 13], 'text-font': ['Noto Sans Regular'],
          'text-allow-overlap': false, 'text-padding': 2, 'symbol-sort-key': ['get', 'prio'], 'symbol-z-order': 'source' },
          paint: { 'text-color': '#c8c8c8', 'text-halo-color': '#171717', 'text-halo-width': 1.4 } });
      // highlighted countries: always named, on top
      map.addLayer({ id: 'clabels-hl', type: 'symbol', source: 'clabels', filter: ['in', ['get', 'iso3'], ['literal', []]], layout: {
        'text-field': ['get', 'name'], 'text-size': ['interpolate', ['linear'], ['zoom'], 1, 11, 5, 14], 'text-font': ['Noto Sans Regular'],
        'text-allow-overlap': true },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#171717', 'text-halo-width': 1.6 } });
      // one aircraft's journey (journey.ts): a glowing route with its stops. Solid = seen by receivers, dashed = coverage gap,
      // dotted = a leg only OpenSky has. Drawn alone, so it reads as one picture.
      map.addSource('journey', { type: 'geojson', data: empty });
      map.addSource('journey-stops', { type: 'geojson', data: empty });
      map.addLayer({ id: 'journey-glow', type: 'line', source: 'journey', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#7fd1ff', 'line-width': ['case', ['==', ['get', 'kind'], 'seen'], 12, 7], 'line-blur': 10, 'line-opacity': ['case', ['==', ['get', 'kind'], 'seen'], 0.38, 0.22] } });
      map.addLayer({ id: 'journey-gap', type: 'line', source: 'journey', filter: ['==', ['get', 'kind'], 'gap'], layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#dff3ff', 'line-width': 2.2, 'line-dasharray': [2.4, 2], 'line-opacity': 0.9 } });
      map.addLayer({ id: 'journey-est', type: 'line', source: 'journey', filter: ['==', ['get', 'kind'], 'estimated'], layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#8fb8ff', 'line-width': 2.6, 'line-dasharray': [0.2, 2], 'line-opacity': 0.95 } });
      map.addLayer({ id: 'journey-seen', type: 'line', source: 'journey', filter: ['==', ['get', 'kind'], 'seen'], layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 3.2 } });
      map.addLayer({ id: 'journey-stop-ring', type: 'circle', source: 'journey-stops', paint: { 'circle-radius': 11, 'circle-color': 'rgba(127,209,255,0.18)', 'circle-stroke-color': '#7fd1ff', 'circle-stroke-width': 1.2, 'circle-stroke-opacity': 0.8 } });
      map.addLayer({ id: 'journey-stop', type: 'circle', source: 'journey-stops', paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': '#0f0f0f', 'circle-stroke-width': 1.5 } });
      map.addLayer({ id: 'journey-stop-label', type: 'symbol', source: 'journey-stops', layout: {
        'text-field': ['format', ['get', 'code'], { 'font-scale': 1.15, 'text-font': ['literal', ['Noto Sans Bold']] }, '\n', {}, ['get', 'sub'], { 'font-scale': 0.88 }],
        'text-font': ['Noto Sans Regular'], 'text-size': 13, 'text-variable-anchor': ['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'], 'text-radial-offset': 1.1, 'text-justify': 'auto', 'text-max-width': 12, 'text-padding': 4, 'symbol-sort-key': ['get', 'order'] },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#0f0f0f', 'text-halo-width': 1.8 } });
      // assistant activity: what it is looking at right now (zone outline, countries, airport pulse)
      map.addLayer({ id: 'act-countries', type: 'fill', source: 'countries', filter: ['in', ['get', 'ISO_A2'], ['literal', []]], paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.07 } }, 'borders');
      map.addLayer({ id: 'act-zone', type: 'line', source: 'zones', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#ffffff', 'line-width': 1.6, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } });
      map.addSource('act-point', { type: 'geojson', data: empty });
      map.addLayer({ id: 'act-pulse', type: 'circle', source: 'act-point', paint: { 'circle-radius': 6, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.9 } });
      map.addLayer({ id: 'act-dot', type: 'circle', source: 'act-point', paint: { 'circle-radius': 3.5, 'circle-color': '#ffffff' } });
      map.addSource('ends', { type: 'geojson', data: empty });
      map.addLayer({ id: 'ends', type: 'circle', source: 'ends', paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': '#171717', 'circle-stroke-width': 1.5 } });
      map.addLayer({ id: 'ends-label', type: 'symbol', source: 'ends', layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#171717', 'text-halo-width': 1.6 } });
      map.addSource('area', { type: 'geojson', data: empty });
      map.addLayer({ id: 'area', type: 'line', source: 'area', paint: { 'line-color': '#e8e8e8', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
      // research trail: what the assistant looked at, step by step (current step bright, earlier steps faint)
      map.addLayer({ id: 'trail-zone', type: 'line', source: 'zones', filter: ['in', ['get', 'id'], ['literal', []]], paint: { 'line-color': '#ffffff', 'line-width': 1, 'line-opacity': 0.35, 'line-dasharray': [3, 2] } });
      map.addLayer({ id: 'trail-zone-cur', type: 'fill', source: 'zones', filter: ['in', ['get', 'id'], ['literal', []]], paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.09 } });
      map.addLayer({ id: 'trail-zone-cur-line', type: 'line', source: 'zones', filter: ['in', ['get', 'id'], ['literal', []]], paint: { 'line-color': '#ffffff', 'line-width': 2 } });
      map.addSource('trail-lines', { type: 'geojson', data: empty });
      map.addLayer({ id: 'trail-legs', type: 'line', source: 'trail-lines', filter: ['==', ['get', 'kind'], 'leg'], paint: {
        'line-color': ['case', ['get', 'mil'], '#c7a6ff', ['==', ['get', 'evidence'], 'inferred'], '#8fb8ff', '#f2c14e'],
        'line-width': ['case', ['get', 'cur'], 1.4, 0.8], 'line-opacity': ['case', ['get', 'cur'], 0.75, 0.18] } });
      map.addLayer({ id: 'trail-track', type: 'line', source: 'trail-lines', filter: ['==', ['get', 'kind'], 'track'], paint: { 'line-color': '#7fd1ff', 'line-width': ['case', ['get', 'cur'], 3, 1.5], 'line-opacity': ['case', ['get', 'cur'], 1, 0.4] } });
      map.addLayer({ id: 'trail-arcs', type: 'line', source: 'trail-lines', filter: ['==', ['get', 'kind'], 'arc'], layout: { 'line-cap': 'round' }, paint: {
        'line-color': '#ffffff', 'line-width': ['case', ['get', 'cur'], ['interpolate', ['linear'], ['get', 'w'], 0, 1, 1, 4], 1], 'line-opacity': ['case', ['get', 'cur'], 0.85, 0.22], 'line-dasharray': [2, 1.5] } });
      map.addSource('trail-points', { type: 'geojson', data: empty });
      // arc labels are points at each arc's midpoint (a line label would repeat on every map tile the arc crosses)
      map.addLayer({ id: 'trail-arc-label', type: 'symbol', source: 'trail-points', filter: ['==', ['get', 'kind'], 'arclabel'], layout: {
        'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['Noto Sans Regular'], 'text-offset': [0, -0.9], 'text-allow-overlap': false },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#111', 'text-halo-width': 1.6 } });
      map.addLayer({ id: 'trail-pts', type: 'circle', source: 'trail-points', filter: ['==', ['get', 'kind'], 'pt'], paint: {
        'circle-radius': ['case', ['get', 'cur'], 6, 3.5], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': ['case', ['get', 'cur'], 0.95, 0.4] } });
      map.addLayer({ id: 'trail-pins', type: 'circle', source: 'trail-points', filter: ['==', ['get', 'kind'], 'pin'], paint: {
        'circle-radius': 6.5, 'circle-color': ['match', ['get', 'pin'], 'finding', '#ffffff', 'hypothesis', '#ffb454', 'lead', '#ffb454', 'question', '#8fb8ff', 'records_request', '#7fd1ff', '#9aa0a6'],
        'circle-stroke-color': '#111', 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'trail-pin-label', type: 'symbol', source: 'trail-points', filter: ['==', ['get', 'kind'], 'pin'], layout: {
        'text-field': ['get', 'text'], 'text-size': 11, 'text-font': ['Noto Sans Regular'], 'text-anchor': 'left', 'text-offset': [1.1, 0], 'text-max-width': 18, 'text-optional': true },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#111', 'text-halo-width': 1.6 } });
      map.on('click', 'trail-pins', (e: any) => { const st = Number(e.features?.[0]?.properties?.step); if (Number.isFinite(st)) trail.focus = trail.focus === st ? null : st; });
      map.on('mouseenter', 'trail-pins', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'trail-pins', () => (map.getCanvas().style.cursor = app.map.drawMode ? 'crosshair' : ''));

      // live aircraft: a small arrow pointing where it flies (an SDF image, so it can be coloured per aircraft)
      const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d')!;
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(16, 3); g.lineTo(26, 28); g.lineTo(16, 22); g.lineTo(6, 28); g.closePath(); g.fill();
      map.addImage('live-arrow', g.getImageData(0, 0, 32, 32), { sdf: true, pixelRatio: 2 });
      map.addSource('live-trail', { type: 'geojson', data: empty });
      map.addLayer({ id: 'live-trail', type: 'line', source: 'live-trail', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['case', ['get', 'sel'], '#ffffff', ['get', 'watched'], '#7fd1ff', ['match', ['get', 'kind'], 'mil', '#c7a6ff', 'cargo', '#ffb454', '#8d959c']], 'line-width': ['case', ['get', 'sel'], 2, 1.2],
          'line-opacity': ['case', ['get', 'sel'], 0.9, 0.45] } });
      map.addSource('live', { type: 'geojson', data: empty });
      map.addLayer({ id: 'live', type: 'symbol', source: 'live', layout: {
        'icon-image': 'live-arrow', 'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 6, 1] },
        paint: { 'icon-color': ['case', ['get', 'sel'], '#ffffff', ['get', 'watched'], '#7fd1ff', ['match', ['get', 'kind'], 'mil', '#c7a6ff', 'cargo', '#ffb454', '#8d959c']], 'icon-opacity': ['case', ['get', 'stale'], 0.45, 1],
          'icon-halo-color': '#111', 'icon-halo-width': 1 } });
      map.addLayer({ id: 'live-label', type: 'symbol', source: 'live', minzoom: 3.2, layout: {
        'text-field': ['get', 'label'], 'text-size': 10.5, 'text-offset': [0, 1.3], 'text-font': ['Noto Sans Regular'], 'text-optional': true },
        paint: { 'text-color': ['match', ['get', 'kind'], 'mil', '#d8ccff', 'cargo', '#ffd29a', '#b5bcc2'], 'text-halo-color': '#111', 'text-halo-width': 1.3 } });
      map.on('click', 'live', (e: any) => { if (app.map.drawMode) return; const hx = e.features?.[0]?.properties?.hex; live.selected = live.aircraft.find(a => a.hex === hx) ?? null; });
      map.on('mouseenter', 'live', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'live', () => (map.getCanvas().style.cursor = app.map.drawMode ? 'crosshair' : ''));
      // flight arcs: the layer picks what is under the pointer (GPU); a click opens the hovered flight
      map.on('mousemove', (e: maplibregl.MapMouseEvent) => { hoverAt = [e.point.x, e.point.y]; arcs.pointer(hoverAt); });
      map.on('mouseout', () => { arcs.pointer(null); hoverId = null; });
      arcs.onHover = id => { hoverId = id; map.getCanvas().style.cursor = id ? 'pointer' : app.map.drawMode ? 'crosshair' : ''; };
      map.on('click', (e: maplibregl.MapMouseEvent) => {
        if (app.map.drawMode) return;
        if (!app.mobile) { const id = arcs.hovered(); if (id) selectLeg(id); return; }
        // a tap: the arc under the finger opens; when several overlap, a short list to pick from
        arcs.tap([e.point.x, e.point.y], (hov, under) => { if (under.length > 1) app.chooser = under.slice(0, 12); else if (hov) selectLeg(hov); });
      });
      map.on('click', (e: maplibregl.MapMouseEvent) => {
        if (!app.map.drawMode) return;
        drawPts.push([e.lngLat.lng, e.lngLat.lat]);
        if (drawPts.length === 2) {
          const [[x1, y1], [x2, y2]] = drawPts;
          const w = Math.min(x1, x2), s = Math.min(y1, y2), ea = Math.max(x1, x2), n = Math.max(y1, y2);
          const ring: [number, number][] = [[w, s], [ea, s], [ea, n], [w, n], [w, s]];
          app.map.area = ring; app.map.drawMode = false; drawPts = [];
          app.explore = { kind: 'area', ring };
        }
      });
      // the area ADSB.lol is asked about for "All traffic" / "Cargo": map centre, reach = distance to the nearest edge (nm)
      const reportView = () => {
        const c = map.getCenter(), b = map.getBounds(), nmOf = (la: number, lo: number) => {
          const p = Math.PI / 180, h = Math.sin((la - c.lat) * p / 2) ** 2 + Math.cos(c.lat * p) * Math.cos(la * p) * Math.sin((lo - c.lng) * p / 2) ** 2;
          return 2 * 3440 * Math.asin(Math.min(1, Math.sqrt(h)));
        };
        setView({ lat: c.lat, lon: c.lng, nm: Math.round(Math.min(nmOf(b.getNorth(), c.lng), nmOf(c.lat, b.getEast()))) });
      };
      map.on('moveend', reportView); reportView();
      loaded = true;
    });
    return () => map.remove();
  });

  $effect(() => { if (loaded && app.zoneGeo) (map.getSource('zones') as maplibregl.GeoJSONSource).setData(app.zoneGeo); });
  $effect(() => { if (loaded) map.setLayoutProperty('zones-line', 'visibility', showZones ? 'visible' : 'none'); });
  $effect(() => {
    if (!loaded) return;
    const sel = live.selected?.hex;
    const list = shown(), _v = live.trailVersion;
    (map.getSource('live-trail') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: live.trails ? list.flatMap(a => {
      const t = trailOf(a.hex); if (t.length < 2) return [];
      return [{ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: t.map(p => [p[0], p[1]]) }, properties: { kind: kindOf(a), watched: live.watch.includes(a.hex), sel: a.hex === sel } }];
    }) : [] });
    (map.getSource('live') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: list.map(a => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
      properties: { hex: a.hex, heading: a.heading ?? 0, label: a.callsign || a.reg || a.type, kind: kindOf(a), watched: live.watch.includes(a.hex), sel: a.hex === sel, stale: a.seen > 60 } })) });
  });
  // ---------- research trail ----------
  // great-circle arc between two points (looks right on the globe)
  function gc(a: Pt, b: Pt, n = 40): Pt[] {
    const r = Math.PI / 180, [l1, p1] = [a[0] * r, a[1] * r], [l2, p2] = [b[0] * r, b[1] * r];
    const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
    if (!d) return [a, b];
    const out: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2), y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2), z = A * Math.sin(p1) + B * Math.sin(p2);
      out.push([Math.atan2(y, x) / r, Math.atan2(z, Math.sqrt(x * x + y * y)) / r]);
    }
    return out;
  }
  const stepCoords = (st: Step): Pt[] => {
    const v = st.viz, cs: Pt[] = [];
    for (const a of v.arcs ?? []) cs.push(a.from, a.to);
    for (const l of v.legs ?? []) cs.push(l.from, l.to);
    cs.push(...(v.track ?? []), ...(v.points ?? []).map(p => p.at));
    for (const id of v.zones ?? []) { const z = zoneFeature(id); if (z) { const walk = (c: any) => (typeof c[0] === 'number' ? cs.push(c) : c.forEach(walk)); walk((z.geometry as any).coordinates); } }
    return cs;
  };
  let trailFramed = '';
  $effect(() => {
    if (!loaded) return;
    const _s = trail.seq, t = currentTrail();
    const steps = t?.steps ?? [];
    const drawn = steps.filter(st => st.status !== 'error' && Object.keys(st.viz).length);   // running steps show their intent and partial finds
    const cur = trail.focus ?? drawn.at(-1)?.i ?? -1;
    const lines: GeoJSON.Feature[] = [], pts: GeoJSON.Feature[] = [];
    const maxN = Math.max(1, ...drawn.flatMap(st => (st.viz.arcs ?? []).map(a => a.n ?? 0)));
    for (const st of drawn) {
      const isCur = st.i === cur;
      if (trail.focus != null && !isCur) continue;   // a clicked step is shown alone
      for (const a of st.viz.arcs ?? []) {
        const line = gc(a.from, a.to);
        lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { kind: 'arc', cur: isCur, w: (a.n ?? maxN) / maxN } });
        if (isCur && a.label) pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: line[Math.floor(line.length / 2)] }, properties: { kind: 'arclabel', label: a.label } });
      }
      for (const l of st.viz.legs ?? []) lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: gc(l.from, l.to, 24) }, properties: { kind: 'leg', cur: isCur, mil: !!l.mil, evidence: l.evidence ?? '' } });
      if (st.viz.track?.length) lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: st.viz.track }, properties: { kind: 'track', cur: isCur } });
      for (const p of st.viz.points ?? []) pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p.at }, properties: { kind: 'pt', cur: isCur } });
    }
    const atSpot = new Map<string, number>();   // several findings about one place: fan them out so each pin shows
    for (const pin of t?.pins ?? []) if (trail.focus == null || pin.step === trail.focus) {
      const k = pin.at.join(','), n = atSpot.get(k) ?? 0; atSpot.set(k, n + 1);
      const at: Pt = [pin.at[0] + n * 1.6, pin.at[1] - n * 1.1];
      pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties: { kind: 'pin', pin: pin.kind, step: pin.step, text: pin.text.length > 60 ? pin.text.slice(0, 58) + '…' : pin.text } });
    }
    (map.getSource('trail-lines') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: lines });
    (map.getSource('trail-points') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: pts });
    const curStep = steps.find(st => st.i === cur);
    const allZones = [...new Set(drawn.flatMap(st => st.viz.zones ?? []))];
    map.setFilter('trail-zone', ['in', ['get', 'id'], ['literal', trail.focus != null ? [] : allZones]]);
    map.setFilter('trail-zone-cur', ['in', ['get', 'id'], ['literal', curStep?.viz.zones ?? []]]);
    map.setFilter('trail-zone-cur-line', ['in', ['get', 'id'], ['literal', curStep?.viz.zones ?? []]]);
    // camera: glide to each new step (or to the step the user clicked), never while the user is drawing
    const key = `${app.map.activeChat}:${cur}:${trail.focus ?? ''}`;
    if (curStep && key !== trailFramed && (trail.follow || trail.focus != null) && !app.map.drawMode) {
      trailFramed = key;
      const cs = stepCoords(curStep);
      if (cs.length) untrack(() => fitCoords(cs, 5));
    }
  });

  // the selected live aircraft's past flights from the archive (last 60 days)
  let pastBusy = $state(false);
  async function pastFlights(a: LiveAc) {
    pastBusy = true;
    try {
      const from = new Date(Date.now() - 60 * 86400e3).toISOString().slice(0, 10);
      const r = await tool('aircraft_history', { aircraft: a.hex, date_from: from });
      const legs = Array.isArray(r) ? r : r.flights ?? [];
      showFlows(legs, `Past flights of ${a.callsign || a.reg || a.hex} · last 60 days`);
      if (!legs.length) app.status = 'No flights of this aircraft in the archive in the last 60 days';
    } catch (e) { app.status = String(e); }
    pastBusy = false;
  }
  const ago = (ms: number) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`; };
  let tick = $state(0);
  $effect(() => { if (!live.on) return; const t = setInterval(() => tick++, 1000); return () => clearInterval(t); });
  const fmtAlt = (x: LiveAc['alt']) => (x === 'ground' ? 'on the ground' : x == null ? '–' : `${x.toLocaleString()} ft`);
  $effect(() => { if (loaded) for (const id of ['flows', 'arcs']) map.setLayoutProperty(id, 'visibility', showFlowsLayer ? 'visible' : 'none'); });
  // highlighted countries are filled and always labelled
  $effect(() => {
    if (!loaded) return;
    const hl = app.map.highlight;
    map.setFilter('land-hl', ['any', ['in', ['get', 'ISO_A3'], ['literal', hl]], ['in', ['get', 'ADM0_A3'], ['literal', hl]]] as any);
    map.setFilter('clabels-hl', ['in', ['get', 'iso3'], ['literal', hl]] as any);
  });
  $effect(() => {
    if (!loaded) return;
    const f = ['==', ['get', 'id'], app.map.focusZone || ''] as any;
    map.setFilter('zone-focus-fill', f); map.setFilter('zone-focus-line', f);
  });
  // ONE camera rule: when the scene (or the selected track) changes, frame the most specific thing in it:
  // the selected track, else the drawn flights, else the focused zone, else the drawn area.
  $effect(() => {
    if (!loaded || !app.map.cameraSeq) return;
    untrack(frameScene);   // only cameraSeq triggers this; the scene contents are read untracked
  });
  function frameScene() {
    const j = app.map.journey;
    if (j) return fitCoords([...j.segs.flatMap(sg => sg.coords), ...j.stops.map(st => [st.lon, st.lat] as [number, number])], 5);
    const P = app.track?.points as { lat: number; lon: number }[] | undefined;
    if (P?.length) return fitCoords(P.map(p => [p.lon, p.lat] as [number, number]));
    const legs = app.map.flows.filter(l => l.from_lat != null && l.to_lat != null).slice(0, MAX_FLOWS);
    if (legs.length) return fitCoords(legs.flatMap(l => [[Number(l.from_lon), Number(l.from_lat)], [Number(l.to_lon), Number(l.to_lat)]] as [number, number][]), 5);
    const z = zoneFeature(app.map.focusZone);
    if (z) {
      const cs: [number, number][] = [];
      const walk = (c: any) => (typeof c[0] === 'number' ? cs.push(c) : c.forEach(walk));
      walk((z.geometry as any).coordinates);
      return fitCoords(cs, 5);
    }
    if (app.map.area) fitCoords(app.map.area, 6);
  }
  $effect(() => {
    if (!loaded) return;
    const sel = app.selected?.leg_id;
    const legs = app.map.flows.filter(l => l.from_lat != null && l.to_lat != null);
    const cap = app.mobile ? 1500 : MAX_FLOWS;
    const n = Math.min(legs.length, cap);
    const op = n > 2000 ? 0.14 : n > 800 ? 0.2 : n > 300 ? 0.28 : n > 80 ? 0.45 : 0.7;   // fade dense sets so structure stays readable
    // drawn by the arc layer (the GeoJSON 'flows' layer stays as the source of the selected flight's surface line)
    const MIL: [number, number, number] = [199 / 255, 166 / 255, 1], INF: [number, number, number] = [143 / 255, 184 / 255, 1], OBS: [number, number, number] = [242 / 255, 193 / 255, 78 / 255];
    const flights: ArcFlight[] = legs.slice(0, cap).map(l => ({ id: String(l.leg_id), from: [Number(l.from_lon), Number(l.from_lat)], to: [Number(l.to_lon), Number(l.to_lat)],
      color: l.mil == 1 ? MIL : l.evidence === 'inferred' ? INF : OBS, alpha: op }));
    untrack(() => arcs.setFlights(flights));
    (map.getSource('flows') as maplibregl.GeoJSONSource).setData(empty);
    void sel;
  });
  $effect(() => { if (loaded) arcs.setSelected(app.selected?.leg_id ?? null); });
  $effect(() => { if (app.inspectorOpen) app.chooser = null; });
  $effect(() => {
    if (!loaded) return;
    const tr = app.track, leg = app.selected;
    const src = map.getSource('track') as maplibregl.GeoJSONSource, ends = map.getSource('ends') as maplibregl.GeoJSONSource;
    if (!tr || !tr.points?.length) { src.setData(empty); ends.setData(empty); return; }
    const feats: GeoJSON.Feature[] = [];
    let cur: { coords: [number, number][]; inzone: number } | null = null;
    const P = tr.points as { t: number; lat: number; lon: number }[];
    const push = () => { if (cur && cur.coords.length > 1) feats.push({ type: 'Feature', properties: { kind: 'seg', inzone: cur.inzone }, geometry: { type: 'LineString', coordinates: cur.coords } }); };
    for (let i = 0; i < P.length; i++) {
      const p = P[i], iz = 0, c: [number, number] = [p.lon, p.lat];
      if (i > 0 && p.t - P[i - 1].t > 1200) {
        push();
        feats.push({ type: 'Feature', properties: { kind: 'gap' }, geometry: { type: 'LineString', coordinates: arc([P[i - 1].lon, P[i - 1].lat], c) } });
        cur = { coords: [c], inzone: iz };
        continue;
      }
      if (!cur) cur = { coords: [c], inzone: iz };
      else if (cur.inzone !== iz) { cur.coords.push(c); push(); cur = { coords: [c], inzone: iz }; }
      else cur.coords.push(c);
    }
    push();
    src.setData({ type: 'FeatureCollection', features: feats });
    const e: GeoJSON.Feature[] = [];
    const lab = (code: any, cert: any) => (cert === 'recorded' ? String(code || '') : code ? `${code}?` : '');
    if (leg?.from_lat != null) e.push({ type: 'Feature', properties: { name: lab(leg.from_code, leg.from_cert) }, geometry: { type: 'Point', coordinates: [Number(leg.from_lon), Number(leg.from_lat)] } });
    if (leg?.to_lat != null) e.push({ type: 'Feature', properties: { name: lab(leg.to_code, leg.to_cert) }, geometry: { type: 'Point', coordinates: [Number(leg.to_lon), Number(leg.to_lat)] } });
    ends.setData({ type: 'FeatureCollection', features: e });
  });
  $effect(() => {
    if (!loaded) return;
    const j = app.map.journey;
    const lines = map.getSource('journey') as maplibregl.GeoJSONSource, stops = map.getSource('journey-stops') as maplibregl.GeoJSONSource;
    if (!j) { lines.setData(empty); stops.setData(empty); return; }
    const hhmm = (t?: number) => (t == null ? '' : new Date(t * 1000).toISOString().slice(11, 16));
    lines.setData({ type: 'FeatureCollection', features: j.segs.map(sg => ({ type: 'Feature', properties: { kind: sg.kind }, geometry: { type: 'LineString', coordinates: sg.coords } })) });
    stops.setData({ type: 'FeatureCollection', features: j.stops.map((st, i) => {
      const times = st.arr != null && st.dep != null ? `${hhmm(st.arr)} → ${hhmm(st.dep)}Z` : st.arr != null ? `arr ${hhmm(st.arr)}Z` : `dep ${hhmm(st.dep)}Z`;
      const name = st.name.replace(/ (International )?Airport$/i, '').replace(/ Air Base$/i, ' AB');
      return { type: 'Feature', properties: { order: i, code: st.code + (st.source === 'opensky' ? ' ·OpenSky' : st.cert && !['recorded', 'unrecorded stop', 'opensky'].includes(st.cert) ? ' ?' : ''), sub: `${name.length > 22 ? name.slice(0, 20).trim() + '…' : name}\n${times}` }, geometry: { type: 'Point', coordinates: [st.lon, st.lat] } };
    }) });
  });
  $effect(() => { const f = app.map.flyTo; if (loaded && f) map.flyTo({ center: [f.lon, f.lat], zoom: f.zoom, duration: 1200 }); });
  $effect(() => { if (loaded && app.map.resetSeq) map.flyTo({ ...home(), duration: 900 }); });
  $effect(() => { if (loaded) for (let i = 1; i <= 4; i++) map.setLayoutProperty('clabels-' + i, 'visibility', showNames ? 'visible' : 'none'); });
  $effect(() => {
    if (!loaded) return;
    (map.getSource('area') as maplibregl.GeoJSONSource).setData(app.map.area ? { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [app.map.area] } } as any : empty);
  });
  $effect(() => { if (loaded) map.getCanvas().style.cursor = app.map.drawMode ? 'crosshair' : ''; });

  // assistant activity on the globe: tint the countries, outline the airspace, pulse the airport; frame it once per answer
  let pulseRaf = 0, framedFor = '';
  $effect(() => {
    if (!loaded) return;
    const act = app.map.activity;
    map.setFilter('act-countries', ['in', ['get', 'ISO_A2'], ['literal', act?.countries ?? []]] as any);
    map.setFilter('act-zone', ['==', ['get', 'id'], act?.zone ?? ''] as any);
    cancelAnimationFrame(pulseRaf);
    (map.getSource('act-point') as maplibregl.GeoJSONSource).setData(empty);
    if (!act) { framedFor = ''; return; }
    untrack(async () => {
      let pt: [number, number] | null = null;
      if (act.airport && app.ctx) {
        const [r] = await app.ctx.query(`SELECT lat, lon FROM airports WHERE ident = '${act.airport.toUpperCase().replace(/'/g, '')}' LIMIT 1`).catch(() => []);
        if (r) pt = [Number(r.lon), Number(r.lat)];
      }
      if (app.map.activity?.seq !== act.seq) return;
      if (pt) {
        (map.getSource('act-point') as maplibregl.GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: pt } });
        const t0 = performance.now();
        const tick = () => {   // ring grows and fades, repeating
          const f = ((performance.now() - t0) % 1600) / 1600;
          map.setPaintProperty('act-pulse', 'circle-radius', 6 + f * 22); map.setPaintProperty('act-pulse', 'circle-stroke-opacity', 0.9 * (1 - f));
          pulseRaf = requestAnimationFrame(tick);
        };
        tick();
      }
      // move the camera only if nothing is drawn yet (never fight a scene the user or assistant made)
      const key = act.zone || act.airport || '';
      if (key && key !== framedFor && !app.map.scene) {
        framedFor = key;
        if (pt) map.flyTo({ center: pt, zoom: 4.5, duration: 1200 });
        else { const z = zoneFeature(act.zone ?? null); if (z) { const cs: [number, number][] = []; const walk = (c: any) => (typeof c[0] === 'number' ? cs.push(c) : c.forEach(walk)); walk((z.geometry as any).coordinates); fitCoords(cs, 5); } }
      }
    });
  });

  const flowsCount = $derived(app.map.flows.length);
  const sceneMode = $derived(winMode('scene'));
  let listN = $state(200);   // flight rows shown in the maximised map card (more on demand)
  $effect(() => { app.map.flows; listN = 200; });
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && anyMax()) { setWin(dock.research === 'max' ? 'research' : 'scene', 'normal'); e.stopPropagation(); } };
  const resetAll = () => clearScene();
</script>

<div class="map" class:full={anyMax()} bind:this={el}></div>
{#if hoverLeg}
  <div class="archint" style="left: {hoverAt[0] + 16}px; top: {hoverAt[1] + 14}px">
    <b>{String(hoverLeg.callsigns || '').split(' ')[0] || hoverLeg.reg || hoverLeg.hex}</b>{#if hoverLeg.reg} <span>{hoverLeg.reg}</span>{/if}{#if hoverLeg.type} <span>· {hoverLeg.type}</span>{/if}
    <div class="r">{hoverLeg.from_code ?? '?'} → {hoverLeg.to_code ?? '?'} <span>· {hoverLeg.date}</span>{#if hoverLeg.evidence === 'inferred'} <i>estimated</i>{/if}{#if hoverLeg.mil == 1} <i class="m">military</i>{/if}</div>
    <small>click to open</small>
  </div>
{/if}

<div class="toolbar">
  <button class:on={showZones} title="Airspace boundaries (sovereign + FIR)" onclick={() => (showZones = !showZones)}>Boundaries</button>
  <button class:on={showFlowsLayer} title="Flight lines" onclick={() => (showFlowsLayer = !showFlowsLayer)}>Flights</button>
  <button class:on={showNames} title="Country names" onclick={() => (showNames = !showNames)}>Names</button>
  <button class:on={app.map.drawMode} title="Draw a rectangle to find flights through it" onclick={() => { app.map.drawMode = !app.map.drawMode; drawPts = []; }}>Draw area</button>
  <button class="livebtn" class:on={live.on} title="Military aircraft in the air right now (ADSB.lol live), plus aircraft you follow" onclick={() => setLive(!live.on)}><i class="dot"></i>Live</button>
  <button title="Clear the map and return to the start view" onclick={resetAll}>Reset</button>
</div>
{#if note && app.ready}
  <div class="betanote" role="status"><i></i>Early beta — some hangs may be expected<button class="x" aria-label="Dismiss" title="Dismiss" onclick={dismissNote}>✕</button></div>
{/if}

{#if live.on}
  <div class="livestat" role="status">
    {#if live.error && !live.aircraft.length}<span class="err">{live.error}</span>
    {:else if !live.at}<span>Connecting to live data…</span>
    {:else}{@const _ = tick}<b>{shown().length}</b> aircraft live <i>·</i> {FILTERS.find(f => f.id === live.filter)?.label.toLowerCase()}{live.watch.length ? ` + ${live.watch.length} followed` : ''} <i>·</i> {ago(live.at)}{#if live.error}<span class="err"> · {live.error}</span>{/if}{/if}
    <div class="lf">
      {#each FILTERS as f}<button class:on={live.filter === f.id} title={f.title} onclick={() => setFilter(f.id)}>{f.label}</button>{/each}
      <span class="sep"></span>
      <button class:on={live.trails} title="Each aircraft's path over the last hour" onclick={() => { live.trails = !live.trails; if (live.trails) loadTraces(); }}>Trails</button>
    </div>
    <div class="lk"><i style="background:#c7a6ff"></i>military <i style="background:#ffb454"></i>cargo <i style="background:#8d959c"></i>other <i style="background:#7fd1ff"></i>followed</div>
    {#if viewNote()}<div class="vn">{viewNote()}</div>{/if}
  </div>
{/if}

{#if live.selected}
  {@const a = live.selected}
  <div class="livecard">
    <div class="lh"><span class="label">Live{a.seen > 60 ? ` · last seen ${Math.round(a.seen)} s ago` : ''}</span><button class="x" aria-label="Close" onclick={() => (live.selected = null)}>✕</button></div>
    <div class="cs">{a.callsign || a.reg || a.hex}</div>
    <div class="ac">{#if a.reg}<span class="reg">{a.reg}</span>{/if}<span>{a.desc || a.type || 'Unknown type'}</span>{#if a.mil}<span class="mil">military</span>{/if}</div>
    {#if a.operator}<div class="op">{a.operator}</div>{/if}
    <dl>
      <dt>Altitude</dt><dd>{fmtAlt(a.alt)}</dd>
      <dt>Speed</dt><dd>{a.speed != null ? `${a.speed} kt` : '–'}</dd>
      <dt>Heading</dt><dd>{a.heading != null ? `${Math.round(a.heading)}°` : '–'}</dd>
      <dt>Squawk</dt><dd>{a.squawk || '–'}</dd>
      <dt>ICAO</dt><dd>{a.hex}</dd>
    </dl>
    <div class="acts">
      <button class="primary" disabled={pastBusy} onclick={() => pastFlights(a)}>{pastBusy ? 'Searching…' : 'Past flights'}</button>
      <button onclick={() => toggleWatch(a.hex)}>{live.watch.includes(a.hex) ? 'Unfollow' : 'Follow'}</button>
    </div>
    <p class="note">Position as broadcast and received by ADSB.lol volunteers. Outside receiver range an aircraft disappears; that is a coverage gap, not proof it is not flying.</p>
  </div>
{/if}

{#if app.map.drawMode}<div class="hint">Click two opposite corners of the area on the map</div>{/if}
{#if app.chooser}
  {@const legs = app.chooser.map(id => app.map.flows.find(l => String(l.leg_id) === id)).filter(Boolean) as Leg[]}
  <div class="chooser">
    <div class="ch"><span class="label">{legs.length} flights here</span><button class="x" aria-label="Close" onclick={() => (app.chooser = null)}>✕</button></div>
    <div class="cl">{#each legs as l (l.leg_id)}<FlightRow leg={l} />{/each}</div>
  </div>
{/if}

<svelte:window onkeydown={onKey} />
<!-- the dock: two fixed rows along the bottom of the map (research above, the map card below), always present and the
     map's full width. Each can be minimised to a footnote bar or maximised over the map; only the user changes that
     (dock.svelte.ts) — the assistant only changes what they show. -->
<div class="dock" class:full={anyMax()}>
  <ResearchTrail />
  {#if !app.map.scene && app.map.history.length <= 1}
    <div class="scene min empty">
      <div class="sh"><span class="label">On the map</span><span class="sum static"><span class="long">Nothing drawn yet — find flights on the left, or ask the assistant.</span><span class="short">Nothing drawn yet — search or ask</span></span></div>
    </div>
  {:else}
    <div class="scene {sceneMode}">
      <div class="sh">
        {#if sceneMode === 'min'}
          <span class="label">On the map</span>
          <button class="sum" title="Show the map card" onclick={() => setWin('scene', 'normal')}>{app.map.scene?.title || 'World map'}</button>
          {#if flowsCount}<span class="meta">{flowsCount.toLocaleString()} flights</span>{/if}
        {:else}
          <div class="st">
            <span class="label">On the map · {app.map.scene?.by === 'assistant' ? 'drawn by the assistant' : app.map.scene ? 'your search' : 'nothing selected'}</span>
            <b title={app.map.scene?.title}>{app.map.scene?.title || 'World map'}</b>
          </div>
          <div class="navs">
            <button class="nav" title="Previous map" aria-label="Previous map" disabled={app.map.histIdx <= 0} onclick={sceneBack}>←</button>
            <button class="nav" title="Next map" aria-label="Next map" disabled={app.map.histIdx >= app.map.history.length - 1} onclick={sceneForward}>→</button>
          </div>
        {/if}
        <WinCtl win="scene" name="map card" canMax={flowsCount > 0} />
        {#if app.map.scene}<button class="x" title="Clear what is drawn (the view stays)" aria-label="Clear the map" onclick={() => { clearScene(true); setWin('scene', 'normal'); }}>✕</button>{/if}
      </div>
      {#if sceneMode !== 'min' && app.map.scene && (app.map.journey || app.map.focusZone || flowsCount || app.selected || app.map.highlight.length || app.map.area)}
        <div class="items">
          {#if app.map.journey}<span class="big"><b>{app.map.journey.stops.length}</b> stops · {app.map.journey.legs.length} legs{app.map.journey.aircraft.type ? ` · ${app.map.journey.aircraft.type}` : ''}{app.map.journey.aircraft.operator ? ` · ${app.map.journey.aircraft.operator}` : ''}</span>{/if}
          {#if flowsCount}<span class="big"><b>{flowsCount.toLocaleString()}</b> flights{flowsCount > MAX_FLOWS ? ` (${MAX_FLOWS.toLocaleString()} drawn)` : ''}</span>{/if}
          {#if app.map.focusZone}<span><i class="sw zone"></i>{zoneName(app.map.focusZone).replace(/: sovereign airspace \(([^)]*)\)/, ' · sovereign airspace ($1)')}</span>{/if}
          {#if app.selected}<span><i class="sw trk"></i>Track {String(app.selected.callsigns || app.selected.reg || '').split(' ')[0]}<button class="unsel" title="Deselect this flight (the rest stays)" aria-label="Deselect" onclick={clearSelection}>✕</button></span>{/if}
          {#if app.map.highlight.length}<span><i class="sw hl"></i>{app.map.highlight.join(', ')}</span>{/if}
          {#if app.map.area}<span><i class="sw area"></i>Drawn area</span>{/if}
          {#if flowsCount || app.selected || app.map.journey}
            <span class="legend">
              {#if app.map.journey}<span><i style="background:#ffffff"></i>seen by receivers</span><span><i class="dash"></i>coverage gap</span>{#if app.map.journey.segs.some(x => x.kind === 'estimated') || app.map.journey.stops.some(x => x.source !== 'archive')}<span><i style="background:#8fb8ff"></i>OpenSky</span>{/if}<span><i class="sw trk"></i>stop</span>{/if}
              {#if flowsCount}<span><i style="background:#f2c14e"></i>seen by receivers</span><span><i style="background:#8fb8ff"></i>estimated (coverage gap)</span><span><i style="background:#c7a6ff"></i>military</span>{/if}
              {#if app.selected}<span><i style="background:#7fd1ff"></i>track</span><span><i class="dash"></i>coverage gap</span>{/if}
            </span>
          {/if}
        </div>
      {/if}
      {#if sceneMode === 'max' && flowsCount}
        <!-- picking a flight shows its track, so the card steps back to reveal the map -->
        <div class="flist" onclickcapture={() => setWin('scene', 'normal')} role="presentation">
          {#each app.map.flows.slice(0, listN) as l (l.leg_id)}<FlightRow leg={l} />{/each}
          {#if flowsCount > listN}<button class="more" onclick={(e) => { e.stopPropagation(); listN += 500; }}>Show more ({(flowsCount - listN).toLocaleString()} left)</button>{/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .map { position: absolute; inset: 0; }
  .toolbar { position: absolute; top: 14px; left: 14px; max-width: calc(100% - 80px); display: flex; flex-wrap: wrap; background: rgba(18,18,18,.92); border: 1px solid var(--line2); border-radius: var(--r); overflow: hidden; backdrop-filter: blur(6px); }
  .toolbar button { border: 0; border-left: 1px solid var(--line); border-radius: 0; font-size: 9.5px; padding: 8px 12px; color: var(--muted); }
  .toolbar button:first-child { border-left: 0; }
  .livebtn { display: inline-flex; align-items: center; gap: 6px; }
  .livebtn .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
  .livebtn.on .dot { background: #ff5a5a; box-shadow: 0 0 0 0 rgba(255,90,90,.6); animation: livepulse 1.6s ease-out infinite; }
  @keyframes livepulse { to { box-shadow: 0 0 0 7px rgba(255,90,90,0); } }
  .livestat { position: absolute; top: 54px; left: 14px; font-size: 11px; color: var(--muted); background: rgba(18,18,18,.92); border: 1px solid var(--line2); border-radius: var(--r); padding: 6px 10px; font-family: var(--mono); }
  .livestat b { color: var(--ink); font-weight: 500; }
  .livestat .lf { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; font-family: var(--font, inherit); }
  .livestat .lf button { font-size: 9px; padding: 4px 8px; border-radius: 3px; color: var(--muted); }
  .livestat .lf button.on { color: var(--ink); border-color: var(--ink); background: rgba(232,232,232,.08); }
  .livestat .lf .sep { width: 1px; background: var(--line2); margin: 2px 3px; }
  .livestat .lk { display: flex; align-items: center; gap: 5px; margin-top: 7px; font-size: 10px; color: var(--faint); }
  .livestat .lk i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-left: 4px; } .livestat .lk i:first-child { margin-left: 0; }
  .livestat .vn { font-size: 10.5px; color: var(--faint); margin-top: 6px; max-width: 300px; line-height: 1.45; font-family: var(--font, inherit); } .livestat i { font-style: normal; color: var(--faint); margin: 0 3px; } .livestat .err { color: var(--sov); }
  .archint { position: absolute; z-index: 6; pointer-events: none; background: rgba(14,14,14,.94); border: 1px solid var(--line2); border-radius: var(--r); padding: 7px 10px 6px; font-size: 12px; line-height: 1.4; color: var(--text); box-shadow: 0 10px 30px rgba(0,0,0,.5); white-space: nowrap; }
  .archint b { color: var(--ink); font-family: var(--mono); font-weight: 600; } .archint span { color: var(--muted); font-family: var(--mono); font-size: 11px; }
  .archint .r { font-family: var(--mono); font-size: 11.5px; } .archint i { font-style: normal; color: var(--inf); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; } .archint i.m { color: var(--mil); }
  .archint small { display: block; color: var(--faint); font-size: 9.5px; letter-spacing: 1.2px; text-transform: uppercase; margin-top: 3px; }
  .livecard { position: absolute; top: 150px; left: 14px; width: 270px; background: rgba(18,18,18,.96); border: 1px solid var(--line2); border-radius: var(--r); padding: 14px 16px; backdrop-filter: blur(6px); animation: lc .2s ease-out; }
  @keyframes lc { from { opacity: 0; transform: translateY(-4px); } }
  .livecard .lh { display: flex; justify-content: space-between; align-items: center; }
  .livecard .label { font-size: 9px; text-transform: uppercase; letter-spacing: 2px; color: #ff8080; }
  .livecard .x { width: 24px; height: 24px; padding: 0; font-size: 10px; letter-spacing: 0; border: 0; }
  .livecard .cs { font-size: 20px; font-weight: 600; margin-top: 4px; letter-spacing: -.2px; }
  .livecard .ac { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; font-size: 11.5px; color: var(--muted); margin-top: 4px; }
  .livecard .reg { font-family: var(--mono); color: var(--ink); border: 1px solid var(--line2); padding: 0 5px; border-radius: 3px; font-size: 11px; }
  .livecard .mil { color: #c7a6ff; } .livecard .op { font-size: 11.5px; color: var(--muted); margin-top: 3px; }
  .livecard dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 12px 0 0; font-size: 12px; }
  .livecard dt { color: var(--faint); } .livecard dd { margin: 0; font-family: var(--mono); text-align: right; }
  .livecard .acts { display: flex; gap: 6px; margin-top: 12px; } .livecard .acts button { flex: 1; font-size: 9.5px; }
  .livecard .note { font-size: 10.5px; color: var(--faint); line-height: 1.5; margin: 10px 0 0; }
  .toolbar button.on { color: var(--ink); }
  .toolbar button:hover { background: rgba(232,232,232,.08); color: var(--ink); }
  .hint { position: absolute; top: 58px; left: 14px; background: var(--ink); color: var(--bg); padding: 6px 12px; border-radius: var(--r); font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.5px; }
  .map { background: #0c0c0c; }
  .dock { position: absolute; left: 14px; right: 14px; bottom: 30px; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
  .dock > :global(*) { pointer-events: auto; }
  .dock.full { top: 60px; }
  .map.full :global(.maplibregl-ctrl-top-right) { visibility: hidden; }
  /* zoom and compass in the app's dark style (MapLibre's default is a white box) */
  .map :global(.maplibregl-ctrl-group) { background: rgba(18,18,18,.92); border: 1px solid var(--line2); border-radius: var(--r); box-shadow: none; overflow: hidden; backdrop-filter: blur(6px); }
  .map :global(.maplibregl-ctrl-group button) { width: 32px; height: 32px; background-color: transparent; border-radius: 0; }
  .map :global(.maplibregl-ctrl-group button + button) { border-top: 1px solid var(--line); }
  .map :global(.maplibregl-ctrl-group button:hover) { background-color: rgba(232,232,232,.08); }
  .map :global(.maplibregl-ctrl-group .maplibregl-ctrl-icon) { filter: invert(1); opacity: .62; }
  .map :global(.maplibregl-ctrl-group button:hover .maplibregl-ctrl-icon) { opacity: .95; }   /* the map is covered: no zoom buttons over the card */
  .scene.max { flex: 1; min-height: 0; padding: 14px 18px; }
  .scene.max .st b { font-size: 15px; white-space: normal; }
  .scene.min { padding: 6px 8px 6px 12px; }
  .scene.empty .label, .scene.min .label { font-size: 9.5px; text-transform: uppercase; letter-spacing: 2px; color: var(--ink); flex: none; }
  .scene .sum { flex: 1; min-width: 0; border: 0; padding: 2px 0; text-align: left; text-transform: none; letter-spacing: 0; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scene .sum:hover { color: var(--ink); background: none; }
  .scene .sum.static { cursor: default; } .scene .sum.static:hover { color: var(--muted); }
  .scene.empty { padding: 6px 12px; min-height: 36px; justify-content: center; }   /* the same height as the folded research bar */
  .scene .meta { font-size: 10.5px; color: var(--faint); font-family: var(--mono); white-space: nowrap; flex: none; }
  .scene .x { border: 0; padding: 3px 4px; font-size: 11px; color: var(--muted); letter-spacing: 0; flex: none; }
  .flist { flex: 1; min-height: 0; overflow: auto; border-top: 1px solid var(--line); margin: 0 -6px; }
  .more { width: 100%; margin: 8px 0; font-size: 9.5px; }
  .scene { background: rgba(16,16,16,.95); border: 1px solid var(--line2); border-radius: var(--r); padding: 10px 12px 11px; font-size: 12px; display: flex; flex-direction: column; gap: 8px; backdrop-filter: blur(8px); box-shadow: 0 16px 40px rgba(0,0,0,.45); }
  .sh { display: flex; align-items: center; gap: 8px; }
  .navs { display: flex; gap: 4px; flex: none; }
  .nav { width: 24px; height: 24px; padding: 0; font-size: 11px; letter-spacing: 0; color: var(--muted); }
  .nav:disabled { opacity: .35; }
  .st { min-width: 0; flex: 1; } .st .label { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: 2px; color: var(--muted); }
  .st b { display: block; font-weight: 500; font-size: 13px; margin-top: 2px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .items { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; color: var(--muted); padding-top: 8px; border-top: 1px solid var(--line); }
  .items .big b { color: var(--ink); font-family: var(--mono); font-weight: 500; font-size: 13px; margin-right: 3px; }
  .items span { display: inline-flex; align-items: center; }
  .sw { display: inline-block; width: 8px; height: 8px; margin-right: 6px; flex: none; }
  .sw.zone { border: 1.5px solid #ff6b6b; } .sw.flow { background: #f2c14e; } .sw.trk { background: #7fd1ff; } .sw.hl { background: #4b4b4b; border: 1px solid #c8c8c8; } .sw.area { border: 1.5px dashed #e8e8e8; }
  .legend { display: inline-flex; flex-wrap: wrap; gap: 4px 14px; color: var(--faint); font-size: 10.5px; margin-left: auto; padding-left: 14px; border-left: 1px solid var(--line); } .legend i { display: inline-block; width: 12px; height: 2px; margin-right: 6px; vertical-align: middle; } .legend i.dash { background: repeating-linear-gradient(90deg, #dfe6f0 0 3px, transparent 3px 6px); }
  .chooser { position: absolute; z-index: 8; left: 8px; right: 8px; bottom: 8px; max-height: 55%; display: flex; flex-direction: column; background: rgba(16,16,16,.97); border: 1px solid var(--line2); border-radius: 10px; box-shadow: 0 -10px 40px rgba(0,0,0,.5); }
  .chooser .ch { display: flex; justify-content: space-between; align-items: center; padding: 10px 6px 6px 14px; } .chooser .label { color: var(--ink); }
  .chooser .x { width: 36px; height: 36px; padding: 0; border: 0; font-size: 12px; letter-spacing: 0; }
  .chooser .cl { overflow-y: auto; padding: 0 10px 8px; }
  /* phones: a compact toolbar, no zoom buttons (pinch), the live card and dock as bottom sheets, no hover label */
  .scene .short { display: none; }   /* phones show the short text instead (below) */
  @media (max-width: 900px) {
    /* a 3 × 2 grid of equal cells, every label on one line */
    .toolbar { top: 8px; left: 8px; right: 8px; max-width: none; display: grid; grid-template-columns: repeat(3, 1fr); }
    .toolbar button { padding: 11px 4px; font-size: 9.5px; letter-spacing: 1.2px; white-space: nowrap; border-left: 1px solid var(--line); display: flex; align-items: center; justify-content: center; gap: 6px; }
    .toolbar button:nth-child(3n + 1) { border-left: 0; } .toolbar button:nth-child(n + 4) { border-top: 1px solid var(--line); }
    .map :global(.maplibregl-ctrl-top-right) { display: none; }
    .livestat { top: 88px; left: 8px; right: 8px; } .livestat .vn { max-width: none; }
    .livecard { top: auto; bottom: 8px; left: 8px; right: 8px; width: auto; z-index: 7; backdrop-filter: none; border-radius: 10px; }
    .archint { display: none; }
    .hint { top: 88px; left: 8px; right: 8px; text-align: center; }
    .dock { left: 8px; right: 8px; bottom: 30px; } .dock.full { top: 88px; }   /* a strip under the dock for the ⓘ, like the desktop */
    .scene .long { display: none; } .scene .short { display: inline; }
    .legend { margin-left: 0; padding-left: 0; border-left: 0; width: 100%; padding-top: 6px; border-top: 1px solid var(--line); }   /* its own line, no stray divider */
  }
  /* the amber beta note: below the zoom buttons on the desktop (nothing else uses that column), centred above the dock on phones */
  .betanote { position: absolute; z-index: 4; bottom: 4px; right: 36px; display: inline-flex; align-items: center; gap: 7px; padding: 4px 6px 4px 9px; background: rgba(18,18,18,.85); border: 1px solid rgba(242,193,78,.45); border-radius: 999px; color: var(--obs); font-size: 10px; letter-spacing: .4px; white-space: nowrap; }
  .betanote i { width: 6px; height: 6px; border-radius: 50%; background: var(--obs); flex: none; }
  .betanote .x { border: 0; background: none; padding: 0 3px; color: rgba(242,193,78,.7); font-size: 10px; cursor: pointer; line-height: 1; }
  .betanote .x:hover { color: var(--obs); background: none; }
  @media (max-width: 900px) { .betanote { top: auto; right: auto; left: 50%; transform: translateX(-50%); bottom: 136px; } }
  /* small laptops and tablets: tighter toolbar buttons (one row up to ~1280 px); where it still wraps, the live strip moves below it */
  @media (min-width: 901px) and (max-width: 1400px) { .toolbar button { padding: 8px 9px; letter-spacing: 1.3px; } }
  @media (min-width: 901px) and (max-width: 1200px) { .livestat { top: 92px; } .hint { top: 96px; } }
  /* the ⓘ: a small dark disc at the bottom right, under the dock; its text opens dark too */
  .map :global(.maplibregl-ctrl-bottom-right) { bottom: 3px; right: 4px; }
  .map :global(.maplibregl-ctrl-bottom-right .maplibregl-ctrl) { margin: 0; }
  /* folded: just the ⓘ disc (MapLibre's own), slightly dimmed; open: a dark text box with the ⓘ at its right end */
  /* folded: only the disc, no outline; the pill's stroke and fill fade in as it extends */
  .map :global(.maplibregl-ctrl-attrib.maplibregl-compact) { padding: 0; width: 24px; height: 24px; min-height: 0; background: rgba(18,18,18,0); border: 1px solid rgba(232,232,232,0); border-radius: 12px; box-shadow: none; position: relative; transition: background-color .25s, border-color .25s; }
  .map :global(.maplibregl-ctrl-attrib.maplibregl-compact-show) { width: auto; padding: 0 28px 0 10px; line-height: 22px; font-size: 10.5px; color: var(--muted); background: rgba(18,18,18,.92); border-color: var(--line2); }
  /* the ⓘ: the same dark disc with a light glyph in both states, anchored at the right end; the pill extends to the left of it */
  .map :global(.maplibregl-ctrl-attrib-button) { position: absolute; top: -1px; right: -1px; width: 24px; height: 24px; margin: 0; padding: 0; border: 0; border-radius: 12px; background-color: transparent; filter: invert(.78); outline: none; box-shadow: none; }
  .map :global(.maplibregl-ctrl-attrib.maplibregl-compact-show .maplibregl-ctrl-attrib-button) { background-color: transparent; }
  .map :global(.maplibregl-ctrl-attrib-button:focus-visible) { outline: none; }
  .map :global(.maplibregl-ctrl-attrib a) { color: var(--text); border: 0; }
  @media (hover: none) { .toolbar button:hover { background: transparent; color: var(--muted); } .toolbar button.on:hover { color: var(--ink); } .map :global(.maplibregl-ctrl-group button:hover) { background-color: transparent; } .scene .sum:hover { color: var(--muted); } .livestat .lf button:hover { background: transparent; color: var(--muted); } .livestat .lf button.on:hover { color: var(--ink); background: rgba(232,232,232,.08); } }
  .unsel { border: 0; padding: 0 4px; margin-left: 6px; font-size: 10px; color: var(--muted); letter-spacing: 0; line-height: 1; vertical-align: middle; } .unsel:hover { color: var(--ink); background: none; }
</style>
