# Interface

SADA is designed for investigative journalists, NGO researchers and fact-checkers, not aviation specialists. People arrive
with a plain-language question and usually some of: a country, an airport or base, a company, a tail number from a photo,
an airspace, and a period.

## Layout

```
┌ top bar: name · Session ▾ · About · Support · data coverage · settings ──────────────────┐
│ Find flights (left)       │ Map (centre)                          │ Assistant (right)      │
│ • four starting questions │ toolbar: boundaries · flights ·       │ chat tabs              │
│ • one search form         │   draw area · live · reset            │ case file              │
│ • results: overview,      │ flight details over the map           │ messages with cards    │
│   actions, list           │ dock: research row · map card         │ composer, model, cost  │
└───────────────────────────┴───────────────────────────────────────┴────────────────────────┘
```

## Sessions

The top bar works like a desktop application's menu. **Session** saves everything built in the browser — the chat tabs with
their answers, case files and research trails — to a JSON file (⌘S / Ctrl+S), loads one back (⌘O / Ctrl+O), or starts
afresh. The browser also keeps the current session by itself; the file is the copy that survives a cleared browser, moves
between machines and can be shared with a colleague. **About** opens a full page over the app — mission, what it does,
evidence rules, architecture, pipeline, assistant, privacy, data and licences, support, memorial — with a sidebar and a
"Back to session" button; the session underneath is untouched. **Buy me a coffee** opens a short note — the author has
plenty of coffee — with links to the fundraisers for Sha'ban al-Dalou's family; About's Support section shows the same links.

## Principles

- **Task first.** The search form asks for From, To, Through airspace and Aircraft/airline/callsign. Every field is
  optional and autocompletes, so no codes are needed. The period is always chosen by the user; nothing is preloaded.
- **One job per region.** Left is manual search, the centre is the map, right is the conversation. Flight details float
  over the map, so they never displace the chat or the results.
- **Results lead somewhere.** Results open with an overview: totals, observed and estimated, flights per month, and top
  routes, operators and aircraft, each clickable to narrow the search. Then come the actions (ask the assistant, export
  CSV with a source line), then the list.
- **Uncertainty is compact and exact.** An uncertain airport end shows as `?`, with the reason on hover. The evidence words
  never change: observed or inferred, sovereign airspace or flight information region.
- **The map stays readable.** Country names are on, large flight sets are drawn thin and faint, and the selection is
  highlighted.

## The assistant's work is visible

- **Research row.** Docked under the map, it shows:
  - the current step with a timer and live progress (for example "Month 2 of 3 · 2026-04: 35,848 departures, 85 to IL");
  - numbered steps that show the map as it was at that point;
  - case-file pins coloured by kind.
- **Map card.** Docked below the research row: what is on the map, who drew it, the flight count, the legend, and back and
  forward through earlier maps.
- **Window controls.** Each dock row can be minimised to a one-line footnote or maximised over the map. Maximised, the
  research row lists every step and the map card lists every drawn flight. The assistant changes what the rows show,
  never their state.
- **In the chat.** Results appear as interactive cards, figures carry evidence chips that focus the step on the map, a
  working line shows the current phase, and the verification line reports what was checked.

## Live map

- **Filters:** military aircraft worldwide, transports and tankers, cargo airlines, or all traffic in view.
- **Display:** aircraft are coloured by kind, with each aircraft's last hour of track drawn as soon as Live is switched on.
- **Aircraft card:** past flights from the archive and a follow option.

## First visit

- A memorial opens after the loading screen and can be reopened from the logo.
- A guided assistant setup explains what the assistant does and why it needs an API key, walks through creating one, and
  checks it with plain-language errors.
