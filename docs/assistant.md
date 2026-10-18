# The research assistant

The assistant helps journalists and researchers turn a broad claim into specific, checkable leads. Weapons shipments are
almost never labelled in public data, so it has to find, test and document connections. It does this under strict
evidentiary standards: every figure traces to a query, and every finding states how solid it is.

It runs in the user's browser on the user's own account: signed in with OpenRouter (any of a short list of frontier models) or
with an Anthropic API key (Claude). The same tools are available to MCP clients
through `mcp/`.

## Method

The system prompt (`web/src/lib/agent.ts`) sets out the method:

1. **Frame:** restate what would confirm or refute the claim.
2. **Plan:** say how the research will run before running it.
3. **Hypotheses:** keep several open, including innocent explanations.
4. **No dead ends:** an empty result is followed by a coverage check and the next angle, never a stop.
5. **Cross-reference:** trade statistics, contracts, registries and the press.
6. **Assess:** label each finding on an evidence ladder: verified, supported inference, hypothesis, speculation.
7. **Continue:** end with ranked leads, the test for each, and the records to request.

Angles it is told to consider:

- civil cargo, charter and ACMI operators;
- military airlift contracts;
- routing through third countries;
- coverage gaps;
- patterns across many flights rather than single flights.

## Tools

| Tool | Answers |
|---|---|
| `investigate_airspace_claim`, `investigate_airlift_base` | A whole first pass in one call. Coverage and its validation, exact totals, military and freight subsets, months, and ranked leads with what would confirm each. |
| `flights_through_zone`, `zone_overview`, `zone_coverage` | Which flights crossed an airspace, summaries, and receiver coverage per day. |
| `route_search`, `airport_movements`, `find_flights` | Flights between places, and activity at an airport or base. |
| `flight_dossier`, `aircraft_profile`, `aircraft_registry` | One flight in detail, one aircraft across the archive, and ownership. |
| `us_exports`, `export_flight_crosscheck`, `us_contracts` | US Census exports by HS code, month and customs port. The cross-check sets them against flights from the exporting port's airports. Federal contract awards. |
| `live_aircraft`, OpenSky tools | Live positions, and OpenSky lookups with the user's own account. |
| `case_file` | The investigation's memory: findings, hypotheses, leads, open questions and records requests. |
| `map_*` | Draw zones, flights and tracks on the user's map. |
| `run_sql` | Read-only SQL for what the other tools cannot express. Time-limited. |
| Web search and fetch | Press, official statements and documents. |

## Evidence and checking

- **Evidence ids.** Every data result carries an id (`E1`, `E2`, …). The answer cites them after each figure, and the
  interface links each citation to the step on the map that produced it.
- **Coverage.** An empty airspace result is returned together with that airspace's receiver coverage. Where an
  independent validation exists, its precision and recall travel with the result and must be quoted.
- **Independent check.** After the answer, `web/src/lib/verify.ts` checks it without a model:
  - every flight id, callsign and registration must appear in a tool result;
  - every count of 1,000 or more and every money figure must match a result, within 1%;
  - airspace claims must name the right kind of airspace.

  Anything it cannot find is shown to the user.

## Reliability

- **One query at a time.** Database queries are serialised and can be cancelled.
- **Time budgets.** Every query and every tool call has one, so a stuck step becomes an error the model can work around
  rather than a hang.
- **Silent model.** A model stream that stays silent is retried once, with a notice.
- **Stop always works.**
- **Visible progress.** The interface shows each step as it runs: which files are being read, live progress for long
  tools, and the model's current phase.

## Evaluation

`eval/questions.json` holds investigation questions with checks on the path as well as the answer:

- were the right tools used?
- was coverage checked?
- were the numbers verified?
- did it stay within budget?

`web/scripts/eval.mjs` runs them through the real app and records time and cost.

## Profiles

| Profile | Model | Use |
|---|---|---|
| Fast | Claude Haiku | Lookups and follow-ups; cents per question |
| Balanced | Claude Sonnet | Most investigations |
| Deep | Claude Opus | Long, multi-source research |

Prompt caching, compact tool results (the full results go to the interface, not the model) and the playbooks keep costs
low.
