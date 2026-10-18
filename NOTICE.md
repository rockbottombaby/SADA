# Notices and attribution

SADA's code is licensed under the GNU Affero General Public License v3.0 (see [LICENSE](LICENSE)).
The data it serves and derives is not covered by that licence; each source keeps its own terms, listed here.

## Flight data

- **ADSB.lol** — historical ADS-B traces (daily archives) and the live API. Open Database License (ODbL) 1.0.
  Every table SADA derives from them (positions, segments, flights, airspace crossings, indexes) is a derived database
  and is published under the ODbL as well. Attribution: "ADS-B data © ADSB.lol contributors, ODbL".
- **OpenSky Network** — aircraft registry (`registry.parquet`, built by `pipeline/build_registry.py`) and the optional
  OpenSky REST lookups a user makes with their own OpenSky account. OpenSky data is for research and non-commercial use
  with attribution (https://opensky-network.org/about/terms-of-use); SADA does not redistribute OpenSky's raw data.
- **ADS-B Exchange** — free monthly sample days, used only to validate inferred crossings (`pipeline/validate_iceland.py`);
  nothing from them is redistributed.

## Reference data

- **OurAirports** — airports (public domain).
- **Natural Earth** — country boundaries and labels (public domain).
- **VATSpy** community boundaries — flight information regions (approximate), used under their data licence.
- **Icelandic eAIP** (Isavia / Samgöngustofa) — Reykjavík FIR and CTA boundaries (official).
- **Landhelgisgæsla Íslands** (Icelandic Coast Guard) — the 12 nautical-mile territorial-sea line and straight baselines
  (law 41/1979, art. 1), from the national geoportal WFS (`LHG:landhelgi_12_milur_lina`, `LHG:grunnlina`).
- **US Census Bureau** — international trade statistics (USA Trade / API), public domain.

## Software

MapLibre GL JS (BSD-3), DuckDB and DuckDB-WASM (MIT), Svelte (MIT), Apache Arrow and Parquet (Apache-2.0), Caddy
(Apache-2.0), nginx (BSD-2). See each package's licence in `node_modules` or the Python environment.

## Photograph

The portrait of Sha'ban Ahmad al-Dalou (`web/public/shaban.webp`) is shown in his memory. If you hold rights to this
image and want it credited differently or removed, write to the author (the address is in the repository's commit history).
