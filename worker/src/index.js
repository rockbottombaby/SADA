// Public, read-only access to the SADA data bucket (flight tables, indexes, day files: ODbL) for the browser app and the
// MCP server. URL: https://<worker host>/v1/<object key>, e.g. …/v1/manifest.json (an old-style /<ACCESS_KEY>/v1/… URL
// still works). GET/HEAD only, published prefixes only, HTTP Range (DuckDB reads Parquet footers and row groups this way)
// and CORS. Logs, claims and status files stay private.
// Cost guard: a per-address request budget (Workers rate-limiting binding, wrangler.toml); R2 egress itself is free.
const PUBLIC = ['v1/days/', 'v1/flights/', 'v1/meta/', 'v1/index/', 'v1/manifest.json'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-None-Match, If-Modified-Since',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified',
  'Access-Control-Max-Age': '86400',
};
const reply = (text, status, extra = {}) => new Response(text, { status, headers: { ...CORS, ...extra } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply('method not allowed', 405);
    const url = new URL(req.url);
    let parts = url.pathname.split('/').slice(1);
    if (env.ACCESS_KEY && parts[0] === env.ACCESS_KEY) parts = parts.slice(1);   // the pre-release keyed URL
    const key = decodeURIComponent(parts.join('/'));
    // /photo/reg/<registration> or /photo/hex/<icao>: one aircraft photo from Planespotters.net (their public API wants a
    // server User-Agent with a contact, which a browser cannot send). Cached a day; the response carries the credit.
    const ph = key.match(/^photo\/(reg|hex)\/([A-Za-z0-9-]{3,10})$/);
    if (ph) {
      if (env.RL) { const { success } = await env.RL.limit({ key: req.headers.get('cf-connecting-ip') || 'unknown' }); if (!success) return reply('too many requests', 429); }
      const cache = caches.default, ck = new Request(`https://photo.cache/${ph[1]}/${ph[2].toUpperCase()}`);
      const hit = await cache.match(ck);
      if (hit) return hit;
      let out = { photos: [] };
      try {
        const r = await fetch(`https://api.planespotters.net/pub/photos/${ph[1]}/${ph[1] === 'hex' ? ph[2].toLowerCase() : ph[2].toUpperCase()}`, { headers: { 'User-Agent': 'SADA airwatch/1.0 (+https://sadawatch.com/about/)' } });
        if (r.ok) { const j = await r.json(); out = { photos: (j.photos || []).slice(0, 1).map(x => ({ id: x.id, thumb: x.thumbnail_large?.src || x.thumbnail?.src, w: x.thumbnail_large?.size?.width, h: x.thumbnail_large?.size?.height, link: x.link, photographer: x.photographer })) }; }
      } catch { /* no photo */ }
      const res = reply(JSON.stringify(out), 200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
      await cache.put(ck, res.clone());
      return res;
    }
    if (!PUBLIC.some(p => key === p || key.startsWith(p))) return reply('not found', 404);
    if (env.RL) {
      const { success } = await env.RL.limit({ key: req.headers.get('cf-connecting-ip') || 'unknown' });
      if (!success) return reply('too many requests: slow down and try again', 429, { 'Retry-After': '15' });
    }

    const obj = req.method === 'HEAD' ? await env.BUCKET.head(key) : await env.BUCKET.get(key, { range: req.headers, onlyIf: req.headers });
    if (!obj) return reply('not found', 404);
    const h = new Headers(CORS);
    obj.writeHttpMetadata(h);
    h.set('ETag', obj.httpEtag);
    h.set('Accept-Ranges', 'bytes');
    h.set('Cache-Control', key.startsWith('v1/days/') ? 'public, max-age=86400' : 'public, max-age=60');
    if (req.method === 'HEAD') { h.set('Content-Length', String(obj.size)); return new Response(null, { status: 200, headers: h }); }
    if (!('body' in obj)) return new Response(null, { status: 304, headers: h });   // onlyIf precondition failed
    if (obj.range && req.headers.has('Range')) {
      const off = obj.range.offset ?? (obj.range.suffix != null ? obj.size - obj.range.suffix : 0);
      const len = obj.range.length ?? (obj.range.suffix ?? obj.size - off);
      h.set('Content-Range', `bytes ${off}-${off + len - 1}/${obj.size}`);
      h.set('Content-Length', String(len));
      return new Response(obj.body, { status: 206, headers: h });
    }
    h.set('Content-Length', String(obj.size));
    return new Response(obj.body, { status: 200, headers: h });
  },
};
