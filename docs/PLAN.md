# Weather Compare — plan

Starting point: pull just the Weather tab out of Boord Owner into its own
PWA, add a map for choosing a location, add a second location to compare
against, and open up every Open-Meteo field instead of the eight Boord
tracks.

Decided up front: GitHub Pages (fully static, no backend — only two people
use it), all five Open-Meteo API families in scope from the start, and the
current year's line continues into the 16-day forecast, drawn faded.

## What carried over from Boord Owner and what changed

Boord's Weather tab (`boordowner/frontend/shared/weather-tab.js` +
`backend/weather.py` + `backend/routers/weather.py`) downloads hourly data
from Open-Meteo into SQLite for one fixed farm location, aggregates it to a
daily figure per metric, and charts up to two metrics overlaid by calendar
year on a shared 1 Jan–31 Dec axis.

The backend disappears entirely: Open-Meteo's APIs allow direct browser
calls, and the "one fixed farm location from a database" model is replaced
by the user placing pins on a map. SQLite becomes IndexedDB. Everything else
— the year-overlay chart, the hue/shade colour scheme, the offline shell
pattern, PDF export — carried over and was extended for two locations and a
much larger field catalog.

## Field catalog

Open-Meteo publishes no machine-readable variable list, so `site/js/fields.js`
is hand-built from its documentation (the docs site itself is blocked from
this sandbox, so this used training knowledge of the API rather than a live
fetch — see **Risk** below):

- **Weather** — hourly (temperature, humidity, wind at multiple heights,
  precipitation, radiation, soil at two different depth conventions
  depending on era, pressure-level/upper-air data, atmospheric stability)
  and daily-native fields, split across the archive (ERA5, 1940–), the
  historical-forecast API (2016–, for fields the archive lacks) and the live
  forecast (recent days + 16 ahead).
- **Air quality** — particulates, gases, pollen (Europe), AQI indices.
- **Marine** — waves, sea surface temperature, currents, tides.
- **Flood** — GloFAS river discharge, ensemble statistics.
- **Climate projections** — CMIP6 downscaled daily fields, 1950–2050, one of
  seven models at a time.

Each field records its unit, which day-aggregations make sense for it
(summing temperature is meaningless; averaging rainfall isn't "how much rain
fell"), and which APIs carry it. A field the catalog gets wrong (renamed,
dropped) is handled at request time, not treated as fatal: `fetchSegment` in
`openmeteo.js` reads Open-Meteo's own rejection reason, drops just that
variable, and retries — the field is then greyed out in the picker rather
than breaking the whole chart.

## Two locations

Leaflet + OpenStreetMap tiles (both vendored so the shell works offline),
search via Open-Meteo's geocoding API, "use my location" via the browser.
Location A is solid, B dashed. A "Difference (A − B)" mode draws one line
per measurement/year instead of two overlaid ones, with a zero reference
line; the summary table underneath adds each location's mean/min/max/total
and the A−B difference, counting only days both locations actually have
data for.

## State and sharing

The whole comparison — both locations, chosen fields and their
aggregations, years, comparison mode, units — lives in the URL hash and in
`localStorage`. Sending the link reproduces the exact chart; reopening the
app without a link restores the last session.

## Caching and request budget

IndexedDB, keyed by location (rounded to ~11 m)/field/aggregation/units/year.
A finished year is cached permanently; the current year (or any year still
inside a field's forecast window) is refreshed at most once an hour.
Requests for the same date range and API are batched across every selected
field, and consecutive years are fetched in one call (5-year chunks for
hourly data, 25-year chunks for daily) — matching Boord's own
`ARCHIVE_CHUNK_YEARS` reasoning for staying within Open-Meteo's free-tier
request weight.

## Build order (as built)

1. Repo scaffold, vendored assets (Leaflet, Font Awesome, html2canvas, jsPDF,
   Tailwind), manifest/service worker/icons.
2. Field catalog (`fields.js`), date helpers (`dates.js`), the Open-Meteo
   client with retry/clip-on-rejection (`openmeteo.js`), the aggregation
   math (`hourlyToDaily`/`aggregate`).
3. IndexedDB cache (`cache.js`) and the loader that batches requests and
   fills it (`data.js`).
4. URL-hash state (`state.js`).
5. Chart (`chart.js`, ported from Boord's `charts.js` with dashed lines,
   faded-forecast segments, and a zero reference line added) and the pure
   data→series/summary logic (`series.js`).
6. Map picker (`map-picker.js`) and the page/controller (`index.html` +
   `app.js`) wiring locations, the field picker dialog, years, options,
   the chart and the summary table together.
7. Tests: 57 unit tests over the pure logic (dates, request planning,
   aggregation, state round-tripping, chart/series math), a Playwright
   smoke test driving the real page with Open-Meteo/Nominatim/OSM mocked.
8. GitHub Pages workflow (test, then deploy `site/` on push to `main`).

## Known gaps / risk

- **The field catalog was built from documentation knowledge, not a live
  fetch** — this sandbox's network egress blocks `open-meteo.com` entirely
  (confirmed: WebFetch and curl both refused with `EGRESS_BLOCKED`/403), so
  the variable names, units and coverage dates could not be checked against
  the live docs before shipping. `fetchSegment`'s drop-and-retry behaviour
  is the safety net for this — a wrong or renamed field degrades to "greyed
  out", not a broken chart — but the catalog is worth spot-checking against
  https://open-meteo.com/en/docs once this deploys somewhere with real
  network access.
- Reverse geocoding (naming a tapped point) uses Nominatim directly from the
  browser, which is fine at this app's usage (two people, occasional taps)
  but would need a proper key/proxy if usage ever grew.
- No air-quality/marine/flood/climate smoke-tested end-to-end against real
  Open-Meteo responses (the e2e test mocks the shape of a normal weather
  response) — worth a manual pass once deployed.
