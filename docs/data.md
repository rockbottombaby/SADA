# Data model and method

## Source

ADSB.lol publishes one archive per day of every aircraft trace its volunteer receivers collected (Open Database
License). SADA processes every day from 11 March 2023 onward and adds each new day automatically.

ADS-B only exists where receivers are. Oceans, deserts and conflict zones have few or none, and some periods had no
coverage over a whole country. SADA therefore records coverage explicitly and never treats missing data as absence.

## Processing

**Per day** (`pipeline/ingest_day.py`)

1. Positions are resampled to one per minute per aircraft.
2. GNSS-spoofed positions are removed: points implying impossible speeds, and the airports at known spoofing hotspots
   (Beirut OLBA, Amman OJAI), which spoofed receivers report as positions.
3. Airborne segments are cut at take-offs and landings (at or below 1,500 ft), and at silences far longer than the
   flight time across them (an unrecorded stop).
4. Each segment is tested against 684 airspace polygons. The test points are the observed one-minute positions, plus
   great-circle points across every silence longer than five minutes at altitude. A crossing made only of the latter is
   **inferred**; one with received positions inside is **observed**.
5. Receiver coverage is recorded as H3 cells (resolution 3) by hour.

**Per month** (`pipeline/build_legs.py`, `pipeline/build_month.py`)

- Segments are stitched into flights across midnight.
- Each end is matched to an airport (OurAirports, with military fields flagged). Large airports are preferred; small
  strips are used only when very close. Ends at spoofing hotspots are marked rather than trusted.
- Ends are labelled **recorded** (take-off or landing seen) or **probable** (inferred from the last position).
- A flight appearing in more than one day file is kept once.

**Indexes** (`pipeline/build_index.py`)

Search indexes are built so a browser can answer most questions by reading a few small files:

- routes per country and year;
- airspace crossings per zone and quarter;
- per-aircraft and per-airport files by year;
- point-lookup copies of each month, sorted by airport, by aircraft and by flight.

Every rebuild is verified: the indexes must match the monthly tables row for row.

## Airspace

- **Sovereign airspace** is land plus the 12 nautical-mile territorial sea.
  - For most countries it is approximated by buffering the Natural Earth coastline by 12 nm. This understates
    territorial seas drawn from straight baselines.
  - Where an official boundary is available it replaces the approximation. Iceland uses the Icelandic Coast Guard's
    official 12 nm line (law 41/1979, art. 1).
- **Flight information regions** come from VATSpy community boundaries (approximate). Iceland's Reykjavík FIR and its
  control area over Greenland come from the Icelandic eAIP (official).

A boundary change does not need a re-ingest: `pipeline/recompute_zone.py` recomputes one zone's crossings from the
stored positions.

## Validation

Inferred crossings are checked against an independent network where one is available. Over Iceland, ADSB.lol had no
receivers from March 2023 to October 2024, while ADS-B Exchange did. Its free sample days (the first of each month)
make a direct comparison possible (`pipeline/validate_iceland.py`):

| Measure | Value |
|---|---|
| Sample days in the gap | 20 |
| Precision: inferred crossings that were real | 0.92 |
| Recall: real crossings found | 0.52 |
| Control day after coverage returned | 0.99 / 0.98 |

An inferred crossing over Iceland in that period is strong evidence; "none found" there is weak. The assistant quotes
these figures whenever it reports on the zone.

## Published files

All under `v1/` on the data service, described by `v1/manifest.json`.

| Path | Content |
|---|---|
| `flights/legs/YYYY-MM.parquet` | One row per flight: aircraft, callsigns, ends with certainty, times |
| `flights/leg_zones/YYYY-MM.parquet` | Airspace crossings per flight: entry, exit, observed and inferred points |
| `flights/coverage/YYYY-MM.parquet` | Aircraft and hours received per zone and day |
| `index/…` | Search indexes and point-lookup copies (see above) |
| `days/{positions,segments,crossings,h3}/DATE.parquet` | Per-day tiers, including one-minute positions |
| `meta/` | Airports, zones (GeoJSON), aircraft registry, validation results |

## Limits

- ADS-B says nothing about cargo. SADA identifies the flights worth asking about; records requests do the rest.
- Some state and military aircraft fly without ADS-B or with changing identities. Absence is not evidence.
- Approximate sovereign boundaries are not legal charts.
- "Military" comes from registration databases and airfield matches, not from what an aircraft carried.
