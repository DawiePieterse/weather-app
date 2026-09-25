# Weather Compare

A small, static PWA: pick any two places on a map and chart any Open-Meteo
field for them, year against year. It started as a fork of [Boord
Owner](../boordowner)'s Weather tab — same year-overlay chart, same offline
shell — rebuilt to run entirely in the browser, for any location, with the
full Open-Meteo catalog and a second location to compare against.

Two people use this. There is no account system and no backend: everything
lives in the URL (so a comparison can be sent as a link) and in the browser's
own storage (so downloaded years don't have to be re-fetched).

## Layout

```
site/                  the whole deployed app (this is what GitHub Pages serves)
  index.html
  manifest.json, service-worker.js, icons/
  css/styles.css
  js/
    app.js             startup, state wiring, all DOM handling
    fields.js          the catalog of every Open-Meteo field this app knows
    openmeteo.js        request planning (which API, which date range) + retries
    data.js            IndexedDB-backed loader: cache first, fetch what's missing
    cache.js           the IndexedDB wrapper itself
    dates.js           calendar-day arithmetic, leap-year-safe chart x-values
    state.js           URL hash <-> app state (locations, fields, years, units)
    series.js          loaded data -> chart series/legend/summary (no DOM, unit-tested)
    chart.js           dependency-free SVG line chart + legend + PDF export
    map-picker.js       Leaflet wrapper: pins, search, reverse geocoding
    ui.js              toast/offline banner/weather-code icons
  vendor/              Leaflet, Font Awesome, html2canvas, jsPDF, Tailwind (all vendored)
scripts/
  serve.js             tiny static server for local testing (`npm run serve`)
  make-icons.js        renders icons/icon.svg to the PNG sizes the manifest needs
tests/
  unit/                node:test - pure logic (dates, request planning, aggregation,
                        state encoding, chart series/summary math)
  e2e/                 Playwright smoke test against a real page, with Open-Meteo/
                        Nominatim/OSM tiles mocked (this environment has no route to them)
docs/PLAN.md           the original design plan
```

## Running it locally

```sh
npm install
npm run serve        # serves site/ on http://127.0.0.1:8080/
npm test             # unit tests
npm run test:e2e     # Playwright smoke test (installs its own Chromium if needed)
```

## How it works

- **No backend.** Open-Meteo's APIs allow direct browser calls (CORS, no key
  for non-commercial use), so `js/openmeteo.js` calls them straight from the
  page.
- **Everything Open-Meteo has.** `js/fields.js` catalogs the weather, air
  quality, marine, flood and climate-projection APIs — daily fields as-is,
  hourly fields reduced to a day with whichever aggregation (mean/min/max/
  total) makes sense for that field. If Open-Meteo has renamed or dropped a
  field the catalog still lists, the request is retried without it and it's
  greyed out in the picker rather than breaking the chart (`fetchSegment` in
  `openmeteo.js`).
- **Two locations.** A is solid, B is dashed; a "Difference (A − B)" mode
  draws one line per measurement/year instead of two. Only days both
  locations actually have data for count toward the difference or the
  summary table.
- **Caching.** Downloaded days are kept in IndexedDB, per location/field/
  aggregation/units/year. A finished year never needs fetching twice; the
  current year (and any year still inside a field's forecast window) is
  refreshed at most once an hour.
- **Sharing.** The whole comparison — both locations, fields, years, mode,
  units — lives in the URL hash. Sending the link reproduces the exact chart.
- **Offline.** The app shell (HTML/CSS/JS/vendor files) is cached by a
  service worker; already-downloaded weather years still show with no
  connection.

## Data

Weather, air quality, marine, flood and climate data: [Open-Meteo](https://open-meteo.com/)
(CC BY 4.0, free for non-commercial use). Map tiles: © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors. Place search and reverse geocoding use Open-Meteo's geocoding
API and OpenStreetMap's Nominatim respectively.
