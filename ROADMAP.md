# Roadmap

Directions that would add the most value. SADA is published as-is, so these are notes on where the software could go, not
commitments.

## Data

- **Official territorial seas for more countries** (Marine Regions), replacing the coastline approximation. A boundary
  change is a recompute from stored positions (`pipeline/recompute_zone.py`), not a re-ingest.
- **Historical coverage where ADSB.lol had none**, for example OpenSky's historical database or commercial ADS-B
  Exchange data.
- **Better inference across gaps**, tuned on validation days.
- **A precomputed departures table** (month × airport × destination country): the export cross-check reads every departure
  from the export airports in the browser today (about 2.5 minutes for the whole archive); with the table it would take seconds.
- **Worldwide live traffic without zooming in**, which needs a global feed agreement with ADSB.lol or a feeder receiver.

## Evidence layers

- **Freight statistics:** US DOT T-100 and Eurostat air-freight statistics by route and carrier.
- **Ownership chains:** registration → operator → lessor, from national registries and GLEIF.
- **Sanctions:** automatic screening of leads.
- **Trade data:** UN Comtrade mirror statistics, Eurostat Comext, and national arms-export licence reports.

## Assistant

- **An export-spike playbook:** customs ports → airports → flights → aircraft.
- **Transit detection:** an arrival linked to the same aircraft's next departure within 72 hours.
- **Lead scoring** with explicit, visible features.
- **Records requests:** drafts generated per jurisdiction from the case file.
- **Model routing:** a stronger model when a playbook runs or the case file has open hypotheses.
- **Evaluation:** a rubric graded by a model, calibrated on hand-graded runs.

## Interface

- **Phone layout.**
- **Replay** of an investigation, and export of a replay for publication.
- **Coverage shading** on the map.
