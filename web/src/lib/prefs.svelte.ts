// Per-browser settings. Keys are stored only in this browser's localStorage and sent only to their own service
// (Anthropic key -> api.anthropic.com, Census key -> api.census.gov, OpenSky client -> opensky-network.org or the proxy set here).

const read = (k: string, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };

export const settings = $state({
  apiKey: read('oam.apiKey'),
  profile: read('oam.profile', 'fast'),            // chat: fast (Haiku) by default
  researchProfile: read('oam.researchProfile', 'balanced'),
  dataUrl: read('oam.dataUrl', import.meta.env.VITE_DATA_URL || 'http://127.0.0.1:8790'),
  censusKey: read('oam.censusKey'),
  openskyId: read('oam.openskyId'),
  openskySecret: read('oam.openskySecret'),
  openskyBase: read('oam.openskyBase'),
  // the SADA proxy (oam/server/proxy.sh): live ADSB.lol data and OpenSky, which browsers cannot reach directly
  proxyBase: read('oam.proxyBase', import.meta.env.VITE_PROXY_BASE || ''),
});

export function saveSettings() {
  try {
    localStorage.setItem('oam.apiKey', settings.apiKey);
    localStorage.setItem('oam.profile', settings.profile);
    localStorage.setItem('oam.researchProfile', settings.researchProfile);
    localStorage.setItem('oam.dataUrl', settings.dataUrl);
    for (const k of ['censusKey', 'openskyId', 'openskySecret', 'openskyBase', 'proxyBase'] as const) localStorage.setItem('oam.' + k, settings[k]);
  } catch { /* storage unavailable: settings last for this session only */ }
}
