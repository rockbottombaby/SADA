# SADA

**AI-powered research on the flights that carry weapons.**

A free, open-source research tool for journalists and researchers. Ask a question in plain language; SADA's AI searches
every flight tracked by the ADSB.lol volunteer network since March 2023 (over 120 million), shows its work on a map and
gives a source for every figure.

States use large-scale data and AI-assisted analysis to wage war. SADA turns the same kind of capability toward
accountability: tracing the flights that carry weapons, and holding the governments behind them to account.

**Use it:** [sadawatch.com](https://sadawatch.com)

SADA is named in memory of Sha'ban Ahmad al-Dalou (2004–2024): his initials, S.A.D., with A for Airwatch. *Sada* (صدى)
means "echo" in Arabic.

## What you can do

- **Ask the AI** a question in plain language. It searches the data, shows each step on the map, checks the press,
  and gives a source for every number. It runs on your own Anthropic API key.
- **Find flights** yourself between two countries or airports, through a country's airspace, or by aircraft, airline or callsign.
- **Open any flight** to see its route, which countries it flew over and when, and the aircraft's other flights.
- **Watch live traffic**, including military aircraft worldwide.
- **Save your work** to a file and open it again later.

## How to read the results

- **Observed:** a receiver saw the aircraft inside that airspace.
- **Inferred:** the aircraft was seen before and after a gap in coverage, and its path across the gap crosses the airspace.
  This is an estimate, not a sighting.
- **No data does not mean no flights.** Where there are no receivers, nothing is recorded. SADA shows where coverage is
  missing.
- **Flight data never shows cargo.** SADA shows you which flights to ask about. Records requests tell you what they carried.

## What it costs

- **Free:** searching, the map and live traffic.
- **The assistant** is billed to your own Anthropic account. A simple question costs a few cents; a long investigation
  costs a dollar or two.
- **Privacy:** there are no accounts, and SADA stores nothing about you. Your keys stay in your browser.

## How it works

1. **Every day:** the pipeline downloads the ADSB.lol flight archive, splits it into flights, and works out which
   countries' airspace each flight crossed.
2. **Storage:** the results are kept as files on Cloudflare R2.
3. **The app** runs in your browser and reads only the parts of those files that each question needs.
4. **Live data:** a small proxy server passes live flight data to the browser.

| Folder | What it is |
|---|---|
| `web/` | The app (Svelte, MapLibre, DuckDB in the browser) |
| `pipeline/` | Builds the flight archive (Python) |
| `worker/` | Serves the archive files (Cloudflare Worker) |
| `server/` | Scripts for the live-data proxy and for large rebuilds |
| `mcp/` | Lets Claude Desktop and Claude Code use the same tools |
| `docs/` | How the data, the assistant and the interface work |

## Run your own copy

The app:

```bash
cd web
npm install
npx vite
```

By default it uses the public archive at `data.sadawatch.com`. To publish it, run `npm run build && npx wrangler deploy`.

For the pipeline and server scripts:

- **Folder layout:** keep this repository in a folder named `oam`, with a Python virtual environment (`.venv`) and a
  `.env` file next to it.
- **Keys:** the `.env` holds your storage keys (`R2_*`) and, for build servers, `HCLOUD_TOKEN`.
- **First step:** run `pipeline/build_zones.py`. Every other step uses the airspace shapes it builds.

## Status

SADA is published as-is. This is the first version, and more will follow. There is no issue tracker and no support.
You are free to run your own copy and build on it.

If you run a copy:

- keys must only ever be sent to their own service;
- the file server must stay read-only;
- the proxy must only pass through its listed endpoints;
- web pages the assistant reads must never be treated as instructions.

## Licences

- **Code:** GNU AGPL-3.0 ([LICENSE](LICENSE)).
- **Flight data:** © ADSB.lol contributors, Open Database License (ODbL). Everything SADA builds from it is ODbL too.
- **Other sources:** OurAirports, Natural Earth, VATSpy, the Icelandic eAIP, the Icelandic Coast Guard, the OpenSky Network
  and the US Census Bureau. Details are in [NOTICE.md](NOTICE.md).
