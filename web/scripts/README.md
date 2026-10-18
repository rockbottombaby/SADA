# Browser test scripts

Each script runs the real app in headless Chrome against a dev server on port 5181
(`npx vite --port 5181 --strictPort`). Most take `DATA=<data service URL>`. Scripts that use the assistant also take
`KEY=` (Anthropic) and optionally `CENSUS=`, and spend real money on that key.

| Script | Checks |
|---|---|
| `eval.mjs` | The standard question set, graded on the path taken (see `../../eval/questions.json`) |
| `chat3.mjs "question" out.png` | One question end to end, logging every tool call and query; `SHOTS=dir` saves a screenshot every 20 s |
| `replay.mjs` | Replays an investigation's tool sequence without the model, timing each step |
| `playbooktest.mjs` | Both investigation playbooks over the whole archive, timed |
| `lookups-speed.mjs`, `dossier-timing.mjs`, `loadtime.mjs` | Cold timings of lookups, flight details and start-up |
| `canceltest.mjs`, `stoptest.mjs` | Stop cancels the running query and frees the database |
| `mapsearch.mjs`, `flowtest.mjs`, `scenetest.mjs`, `botscene.mjs` | Drawing searches and scenes on the map |
| `dockshot.mjs`, `livecheck.mjs`, `livetest2.mjs`, `livefilters.mjs` | Dock window states; live map, filters and trails |
| `keysetup.mjs`, `switch.mjs` | First-visit assistant setup; switching models |
| `memorial.mjs`, `memshot.mjs`, `brand.mjs`, `skeleton.mjs` | Memorial, branding, loading placeholders |
| `indextest.mjs`, `r2test.mjs`, `opensky-proxy-test.mjs` | Data service, indexes and proxy access |
| `sessiontest.mjs outdir` | Session save/load round trip; menu and About screenshots |
| `siteshot.mjs outdir [base]` | Screenshots of a deployed app and its information page |
