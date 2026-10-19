# Documented shipments: the case library

A list of weapons movements that have been reported publicly since 2023, with what the SADA flight archive shows for each.
It is read by the app (Find flights → Documented shipments, and the flight sheet) and by the assistant (`known_cases`).

**The claims are the sources', not SADA findings.** Every case carries its source, an evidence status and a delivery
outcome, and the operator's or government's response where one was reported. The list is not exhaustive: most arms
shipments are never reported, so absence from this list means nothing.

## Files

- `cases.csv`: one row per reported movement, delivery batch or blocked/contested lead (61 at the first snapshot, 19 Oct 2026).
- `aggregates.csv`: cumulative statements ("1,000 aircraft since October 2023"). Never add these to the cases.
- `queries.json`: how each air case is looked up in the flight archive (a `find_flights` query and the callsigns that belong to it).
- `matches.json`: the result of that lookup, written by `web/scripts/cases-match.mjs` (needs the dev server on :5181).
- `web/scripts/cases-build.mjs` turns the three into `web/public/cases.json`, which the app serves at `/cases.json`.

## Fields

- `evidence_status`: `official_confirmation` (a relevant agency acknowledged the specific movement), `records_supported`
  (a journalist cited documents such as waybills or export records; SADA has not seen them), `reported`, `alleged`, `disputed`.
- `delivery_outcome`: `delivered_confirmed`, `delivered_reported`, `delivery_unverified`, `transit_only` (one leg documented, the
  end not), `blocked` (port call or loading refused), `disputed_destination`. The two fields are independent: an officially
  confirmed port refusal is `official_confirmation` + `blocked`.
- `sada.match` (built): `exact` = the reported flight is in the archive; `nearby` = the aircraft or operator is seen on the
  route that day but the report names no flight; `dark` = seen leaving (typically Dover AFB) under a changed callsign with no
  recorded destination; `none` = not found. `sada.legs` lists the flights (leg ids open in the app).

## Rules for adding a case

- Published journalism, official releases and public research only. No bulk scraping of flight trackers or airline cargo
  portals. No pilots, crew or other private individuals.
- Record facts, a brief attribution and the link; do not republish articles.
- Keep the source's wording for the cargo. Mixed civil, police and military goods are not all "IDF materiel".
- One consignment carried over several legs or vessels is one case (`linked_case` points to the other leg).
- Keep the response of the company or government beside the allegation. A blocked port call is not a delivery.
- Lufthansa, El Al and the like fly under ICAO callsigns in the data (DLH, ELY), not the IATA flight numbers in the press.

Licence: CC BY 4.0 for the compilation. The underlying reports belong to their publishers.
