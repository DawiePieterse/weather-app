// Gets the daily points the chart needs for one location: from the cache
// where it can, from Open-Meteo for the rest, with as few requests as
// possible.
//
// Few requests matters because Open-Meteo's free tier is metered by weight -
// roughly one "call" per variable per two weeks of data - with a daily cap of
// about 10,000. So every selected field that goes to the same API for the same
// dates rides in one request, consecutive years are fetched together (see
// CHUNK_YEARS), and a finished year is never fetched twice.

import { addDays, refX } from "./dates.js";
import { ARCHIVE_LAG_DAYS, dailyToMap, fetchSegment, horizonFor, hourlyToDaily, planSegments,
         RateLimitError } from "./openmeteo.js";
import { cacheGet, cachePut } from "./cache.js";
import { unitSetting } from "./fields.js";

// Years per request: hourly data is ~8,760 values per variable per year, so
// hourly requests stay at five years (the chunk Boord's archive import used);
// daily data is 365 values a year and goes in bigger bites.
export const CHUNK_YEARS = { hourly: 5, daily: 25 };
// An unfinished year (this one, or one whose last days are still forecast) is
// re-fetched once it is this old - the upstream models update hourly at most.
export const FRESH_MS = 60 * 60 * 1000;

export function unitSig(field, units) {
  return unitSetting(field, units) ?? "-";
}

export function cacheKey(loc, field, agg, units, model, year) {
  return [`${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`, field.id, agg || "-", unitSig(field, units),
          field.source === "climate" ? model : "-", year].join("|");
}

// A year whose data can no longer change: every day of it is either before
// the field's coverage starts or settled in its source's archive. Climate
// projections never change at all.
export function isFinalYear(field, year, today) {
  if (field.source === "climate") return true;
  const settled = field.source === "weather" ? addDays(today, -ARCHIVE_LAG_DAYS - 1) : addDays(today, -30);
  return `${year}-12-31` <= settled;
}

// Consecutive years in runs of at most `max`: [1990, 1991, 1992, 2001] ->
// [[1990, 1992], [2001, 2001]].
export function yearRuns(years, max) {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  const runs = [];
  for (const y of sorted) {
    const last = runs[runs.length - 1];
    if (last && y === last[1] + 1 && y - last[0] < max) last[1] = y;
    else runs.push([y, y]);
  }
  return runs;
}

// specs: [{field, agg, key}]. Returns
//   { points: Map(spec.key -> Map(year -> [[x, value], ...])), errors: [], dropped: Map(fieldId -> endpoint) }
// where x is dates.refX().
export async function loadLocation({ loc, specs, years, units, model, today, onProgress, fetchImpl }) {
  const points = new Map();
  const errors = [];
  const dropped = new Map();
  const missing = new Map();   // spec.key -> [years]
  const now = Date.now();

  const hits = await Promise.all(specs.flatMap((spec) =>
    years.map((year) => cacheGet(cacheKey(loc, spec.field, spec.agg, units, model, year)))));
  specs.forEach((spec, si) => {
    points.set(spec.key, new Map());
    years.forEach((year, yi) => {
      const hit = hits[si * years.length + yi];
      if (hit && (hit.final || now - hit.fetchedAt < FRESH_MS)) {
        points.get(spec.key).set(year, hit.points);
      } else {
        if (!missing.has(spec.key)) missing.set(spec.key, []);
        missing.get(spec.key).push(year);
      }
    });
  });
  if (!missing.size) return { points, errors, dropped };

  // Plan: one request per (endpoint, resolution, date range), carrying every
  // variable that needs exactly that.
  const requests = new Map();
  for (const spec of specs) {
    const years_ = missing.get(spec.key);
    if (!years_) continue;
    for (const [y0, y1] of yearRuns(years_, CHUNK_YEARS[spec.field.res])) {
      for (const seg of planSegments(spec.field, `${y0}-01-01`, `${y1}-12-31`, today)) {
        const rk = `${seg.endpoint}|${spec.field.res}|${seg.start}|${seg.end}`;
        if (!requests.has(rk)) requests.set(rk, { seg, res: spec.field.res, specs: [] });
        requests.get(rk).specs.push(spec);
      }
    }
  }

  // Reduced days per spec, across every request that touched it.
  const days = new Map([...missing.keys()].map((k) => [k, new Map()]));
  const failedSpecs = new Set();
  let done = 0;
  const total = requests.size;
  onProgress?.(done, total);

  for (const { seg, res, specs: rSpecs } of requests.values()) {
    const vars = [...new Set(rSpecs.map((s) => s.field.key))];
    try {
      const out = await fetchSegment(seg, {
        lat: loc.lat, lon: loc.lon, units, model,
        hourly: res === "hourly" ? vars : [], daily: res === "daily" ? vars : [],
      }, fetchImpl);
      out.dropped.forEach((v) => rSpecs.filter((s) => s.field.key === v)
        .forEach((s) => dropped.set(s.field.id, seg.endpoint)));
      const block = out.json && out.json[res];
      if (block) {
        for (const spec of rSpecs) {
          const values = block[spec.field.key];
          if (!values) continue;
          const scale = spec.field.scale || 1;
          const map = res === "hourly"
            ? hourlyToDaily(block.time, values, spec.agg, scale)
            : dailyToMap(block.time, values, scale);
          const target = days.get(spec.key);
          for (const [d, v] of map) target.set(d, v);
        }
      }
    } catch (e) {
      rSpecs.forEach((s) => failedSpecs.add(s.key));
      errors.push(e);
      if (e instanceof RateLimitError) break;
    }
    onProgress?.(++done, total);
  }

  // Split back into years and cache. A spec whose request failed is not
  // cached - an empty year written now would read as "no data" for good.
  const writes = [];
  for (const spec of specs) {
    const key = spec.key;
    if (!missing.has(key)) continue;
    const last = horizonFor(spec.field, today);
    const byYear = new Map();
    for (const [d, v] of days.get(key)) {
      if (v == null || d > last) continue;
      const y = Number(d.slice(0, 4));
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push([refX(d), v]);
    }
    for (const year of missing.get(key)) {
      const pts = (byYear.get(year) || []).sort((a, b) => a[0] - b[0]);
      points.get(key).set(year, pts);
      if (failedSpecs.has(key)) continue;
      writes.push(cachePut({
        k: cacheKey(loc, spec.field, spec.agg, units, model, year),
        points: pts, fetchedAt: now, final: isFinalYear(spec.field, year, today),
      }));
    }
  }
  await Promise.all(writes);
  return { points, errors, dropped };
}
