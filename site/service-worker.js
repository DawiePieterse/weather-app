// App-shell cache, same stale-while-revalidate strategy as Boord Owner's
// service worker: answer instantly from cache so the app opens with no
// signal, and refresh the cached copy in the background whenever the network
// is there - so a device is never pinned to old code until CACHE changes.
//
// Only this origin's files are handled. Open-Meteo, the geocoders and the map
// tiles are cross-origin and pass straight through: weather data is cached by
// the app itself in IndexedDB (js/cache.js), where it can be keyed by year.
// The one exception is the on-device AI library (js/ai.js), loaded from
// jsDelivr on first use: it is pinned to a version, so it is kept cache-first
// in a cache named for that version (older ones are cleared like old shells)
// - the model weights are cached by the library itself.
const CACHE_PREFIX = "weather-compare-";
const CACHE = "weather-compare-v2";
const LIB_PATH = "/npm/@mlc-ai/web-llm@0.2.85/";   // keep in step with js/ai.js
const LIB_CACHE = "weather-compare-lib-0.2.85";
const REVALIDATE_TIMEOUT_MS = 10000;
const SHELL = [
  "./",
  "./css/styles.css",
  "./icons/icon-192.png",
  "./index.html",
  "./js/ai.js",
  "./js/app.js",
  "./js/cache.js",
  "./js/chart.js",
  "./js/data.js",
  "./js/dates.js",
  "./js/fields.js",
  "./js/insights.js",
  "./js/map-picker.js",
  "./js/openmeteo.js",
  "./js/series.js",
  "./js/state.js",
  "./js/ui.js",
  "./manifest.json",
  "./vendor/fontawesome/css/all.min.css",
  "./vendor/fontawesome/webfonts/fa-solid-900.woff2",
  "./vendor/html2canvas/html2canvas.min.js",
  "./vendor/jspdf/jspdf.umd.min.js",
  "./vendor/leaflet/leaflet.css",
  "./vendor/leaflet/leaflet.js",
  "./vendor/tailwind.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE && k !== LIB_CACHE).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "GET" && url.origin === "https://cdn.jsdelivr.net" && url.pathname.startsWith(LIB_PATH)) {
    event.respondWith(caches.open(LIB_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const res = await fetch(event.request);
      if (res.ok) event.waitUntil(cache.put(event.request, res.clone()));
      return res;
    }));
    return;
  }
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Page loads are cached by path only: the app keeps its state in the URL
  // hash (never sent) but a query string would otherwise miss the cache.
  const isPageLoad = event.request.mode === "navigate";
  const cacheKey = isPageLoad ? url.origin + url.pathname : event.request;

  // Registered with waitUntil so the worker lives until the new copy is
  // written, and given a deadline so hung requests on a dead network don't
  // pile up and starve the app's own requests of sockets.
  const revalidateAbort = new AbortController();
  const revalidateTimer = setTimeout(() => revalidateAbort.abort(), REVALIDATE_TIMEOUT_MS);
  const update = fetch(event.request, { signal: revalidateAbort.signal })
    .then(async (res) => {
      if (res.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(cacheKey, res.clone());
      }
      return res;
    })
    .catch(() => null)
    .finally(() => clearTimeout(revalidateTimer));
  event.waitUntil(update);

  event.respondWith(
    caches.open(CACHE)
      .then((cache) => cache.match(cacheKey))
      .then((cached) => cached || update.then((res) => res || Response.error()))
  );
});
