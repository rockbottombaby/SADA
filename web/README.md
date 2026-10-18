# SADA web app

The browser app: globe, flight finder, flight details, live traffic and the research assistant. Svelte 5, MapLibre GL,
DuckDB-WASM. There is no application server: the browser reads Parquet from the data service over HTTP Range requests and does
the querying itself, and the assistant calls the Anthropic API directly with the user's own key.

```bash
npm install
npx vite                      # dev server
npm run build                 # static site in dist/
npx wrangler deploy           # publish dist/ as Cloudflare static assets (wrangler.toml); the info page is public/about/
npx svelte-check              # type check
```

Configuration is in `.env` (public defaults: data worker and proxy URLs; `VITE_REPO_URL` for the About page) and may be overridden in `.env.local` (not committed). Users can change both in Settings; keys live only in their browser.

Layout: `src/lib/` holds the app — `agent.ts` (the research harness), `tools.ts` and `sources.ts` (what the assistant can
query), `playbooks.ts`, `verify.ts` (the answer checker), `db.ts` (DuckDB), `MapView.svelte` and the panels. The design
rules are in `../docs/interface.md`, the assistant's in `../docs/assistant.md`. Headless test and screenshot scripts are in
`scripts/` (see `scripts/README.md`).
