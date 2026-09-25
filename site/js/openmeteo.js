// Open-Meteo client: which API answers which dates, the request itself, and
// reducing hourly data to one value per day.
//
// There is no server in this app - the browser calls Open-Meteo directly
// (its APIs send CORS headers and need no key for non-commercial use). The
// era split below is the one Boord's backend/weather.py fetch_hourly_range()
// drew between the reanalysis archive and the historical-forecast API, with
// the live forecast added for the days the archive has not caught up with yet
// and for the 16 days ahead.

import { addDays, maxDate, minDate } from "./dates.js";
import { isUnavailable, markUnavailable } from "./fields.js";

export const ENDPOINTS = {
  // ERA5 / ERA5-Land reanalysis. Complete from 1940 but lags real time by
  // about five days, see ARCHIVE_LAG_DAYS.
  archive: { url: "https://archive-api.open-meteo.com/v1/archive", floor: "1940-01-01", tz: true, units: true },
  // Archived forecast-model output: the variables the reanalysis lacks (UV,
  // pressure levels, forecast soil depths...), 2016 onward.
  hf: { url: "https://historical-forecast-api.open-meteo.com/v1/forecast", floor: "2016-01-01", tz: true, units: true },
  // The live forecast. Answers start_date/end_date for roughly the last three
  // months as well as the days ahead.
  fc: { url: "https://api.open-meteo.com/v1/forecast", tz: true, units: true },
  air: { url: "https://air-quality-api.open-meteo.com/v1/air-quality", floor: "2013-01-01", horizon: 4, tz: true },
  marine: { url: "https://marine-api.open-meteo.com/v1/marine", floor: "1940-01-01", horizon: 7, tz: true },
  // Flood and climate are daily-only and take no timezone.
  flood: { url: "https://flood-api.open-meteo.com/v1/flood", floor: "1984-01-01", horizon: 15 },
  climate: { url: "https://climate-api.open-meteo.com/v1/climate", floor: "1950-01-01", ceil: "2050-12-31",
             units: true, model: true },
};

export const ARCHIVE_LAG_DAYS = 6;
// Open-Meteo's forecast_days maxes out at 16 COUNTING TODAY, so the furthest
// day ahead is today + 15 (the same off-by-one Boord's risk.py keeps explicit
// as FORECAST_API_DAYS vs FORECAST_HORIZON_DAYS).
export const WEATHER_HORIZON_DAYS = 15;
export const REQUEST_TIMEOUT_MS = 60000;

// The furthest date any data can exist for a field: the end of its forecast,
// or 2050 for the climate projections. Also used to decide when a cached year
// is final.
export function horizonFor(field, today) {
  if (field.source === "weather") {
    return field.apis.includes("fc") ? addDays(today, WEATHER_HORIZON_DAYS) : addDays(today, -ARCHIVE_LAG_DAYS - 1);
  }
  const ep = ENDPOINTS[field.source];
  return ep.ceil || addDays(today, ep.horizon);
}

// [start, end] for one field -> the requests that cover it, each
// {endpoint, start, end}. Weather is split at `today - ARCHIVE_LAG_DAYS`: the
// archive (or the historical-forecast API, for a field the archive lacks)
// before, the live forecast from there on. The other sources are one API each.
export function planSegments(field, start, end, today) {
  const segs = [];
  const push = (endpoint, s, e) => { if (s <= e) segs.push({ endpoint, start: s, end: e }); };
  const e = minDate(end, horizonFor(field, today));

  if (field.source === "weather") {
    const recent = addDays(today, -ARCHIVE_LAG_DAYS);
    const past = field.apis.includes("archive") ? "archive" : "hf";
    push(past, maxDate(start, ENDPOINTS[past].floor), minDate(e, addDays(recent, -1)));
    if (field.apis.includes("fc")) push("fc", maxDate(start, recent), e);
    return segs;
  }
  push(field.source, maxDate(start, ENDPOINTS[field.source].floor), e);
  return segs;
}

export function buildUrl(endpoint, { lat, lon, start, end, hourly = [], daily = [], units, model }) {
  const ep = ENDPOINTS[endpoint];
  const p = new URLSearchParams({ latitude: String(lat), longitude: String(lon), start_date: start, end_date: end });
  if (hourly.length) p.set("hourly", hourly.join(","));
  if (daily.length) p.set("daily", daily.join(","));
  if (ep.tz) p.set("timezone", "auto");
  // Only the non-default units are sent: shorter URLs, and nothing for an
  // API to object to in the common case.
  if (ep.units && units) {
    if (units.temperature && units.temperature !== "celsius") p.set("temperature_unit", units.temperature);
    if (units.wind && units.wind !== "kmh") p.set("wind_speed_unit", units.wind);
    if (units.precipitation && units.precipitation !== "mm") p.set("precipitation_unit", units.precipitation);
  }
  if (ep.model && model) p.set("models", model);
  return `${ep.url}?${p}`;
}

export class RateLimitError extends Error {
  constructor() { super("Open-Meteo's rate limit was reached - wait a minute and try again."); this.name = "RateLimitError"; }
}
export class ApiError extends Error {
  constructor(reason) { super(reason); this.name = "ApiError"; }
}

// The variable a rejection names, if any. Longest first and bounded on both
// sides, so a complaint about temperature_2m_max is not pinned on
// temperature_2m.
export function variableNamedIn(reason, vars) {
  return [...vars].sort((a, b) => b.length - a.length)
    .find((v) => new RegExp(`(^|[^a-z0-9_])${v}([^a-z0-9_]|$)`).test(reason)) || null;
}

// "... out of allowed range from 2022-07-29 to 2025-10-02" -> the range.
export function allowedRangeIn(reason) {
  const m = /from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(reason || "");
  return m ? { start: m[1], end: m[2] } : null;
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// One request, made to succeed where it honestly can. Open-Meteo answers a
// bad request with HTTP 400 and {"error": true, "reason": "..."}; two of
// those are recoverable and are retried rather than failing the whole chart:
//   - a variable this API does not have (the catalog is hand-kept and will
//     drift): dropped, remembered as unavailable, and the rest re-requested;
//   - a date outside what this API holds: clipped to the range it names.
// Returns {json, hourly, daily, start, end, dropped} - the variables and
// dates actually fetched - or json:null if nothing was left to ask for.
export async function fetchSegment(seg, { hourly = [], daily = [], ...opts }, fetchImpl = fetch) {
  let h = hourly.filter((v) => !isUnavailable(seg.endpoint, v));
  let d = daily.filter((v) => !isUnavailable(seg.endpoint, v));
  const dropped = [...hourly, ...daily].filter((v) => !h.includes(v) && !d.includes(v));
  let { start, end } = seg;

  for (let attempt = 0; attempt < 8; attempt++) {
    if ((!h.length && !d.length) || start > end) break;
    const url = buildUrl(seg.endpoint, { ...opts, start, end, hourly: h, daily: d });
    const res = await fetchWithTimeout(fetchImpl, url, REQUEST_TIMEOUT_MS);
    if (res.status === 429) throw new RateLimitError();
    const body = await res.json().catch(() => null);
    if (res.ok && body && !body.error) return { json: body, hourly: h, daily: d, start, end, dropped };

    const reason = (body && body.reason) || `HTTP ${res.status}`;
    const bad = variableNamedIn(reason, [...h, ...d]);
    if (bad) {
      markUnavailable(seg.endpoint, bad);
      dropped.push(bad);
      h = h.filter((v) => v !== bad);
      d = d.filter((v) => v !== bad);
      continue;
    }
    const range = allowedRangeIn(reason);
    if (range && (range.start > start || range.end < end)) {
      start = maxDate(start, range.start);
      end = minDate(end, range.end);
      continue;
    }
    throw new ApiError(reason);
  }
  return { json: null, hourly: h, daily: d, start, end, dropped };
}

// ---------------------------------------------------------------- reducing to days

function round(v) {
  return v == null || !isFinite(v) ? null : Number(v.toPrecision(6));
}

export function aggregate(values, agg) {
  const vs = values.filter((v) => v != null && isFinite(v));
  if (!vs.length) return null;
  switch (agg) {
    case "sum": return vs.reduce((a, b) => a + b, 0);
    case "min": return Math.min(...vs);
    case "max": return Math.max(...vs);
    // Compass bearings average as vectors: the plain mean of 350° and 10° is
    // 180°, due south, for two winds that were both roughly northerly.
    case "circmean": {
      const rad = Math.PI / 180;
      const s = vs.reduce((a, v) => a + Math.sin(v * rad), 0);
      const c = vs.reduce((a, v) => a + Math.cos(v * rad), 0);
      return ((Math.atan2(s, c) / rad) + 360) % 360;
    }
    default: return vs.reduce((a, b) => a + b, 0) / vs.length;
  }
}

// Hourly series -> Map("YYYY-MM-DD" -> value). Times are location-local
// ("2024-03-01T13:00", from timezone=auto), so the first ten characters are
// already the local calendar day.
export function hourlyToDaily(times, values, agg, scale = 1) {
  const byDay = new Map();
  for (let i = 0; i < times.length; i++) {
    const day = times[i].slice(0, 10);
    const v = values[i];
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(v == null ? null : v * scale);
  }
  const out = new Map();
  for (const [day, vs] of byDay) out.set(day, round(aggregate(vs, agg)));
  return out;
}

export function dailyToMap(times, values, scale = 1) {
  const out = new Map();
  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    out.set(times[i], v == null ? null : round(v * scale));
  }
  return out;
}

// Current conditions for the header strip.
export async function fetchCurrent({ lat, lon, units }, fetchImpl = fetch) {
  const p = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), timezone: "auto",
    current: "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation,is_day",
  });
  if (units?.temperature && units.temperature !== "celsius") p.set("temperature_unit", units.temperature);
  if (units?.wind && units.wind !== "kmh") p.set("wind_speed_unit", units.wind);
  if (units?.precipitation && units.precipitation !== "mm") p.set("precipitation_unit", units.precipitation);
  const res = await fetchWithTimeout(fetchImpl, `${ENDPOINTS.fc.url}?${p}`, 10000);
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`);
  const body = await res.json();
  return { ...body.current, units: body.current_units };
}

export async function searchPlaces(query, fetchImpl = fetch) {
  const p = new URLSearchParams({ name: query, count: "8", language: "en", format: "json" });
  const res = await fetchWithTimeout(fetchImpl, `https://geocoding-api.open-meteo.com/v1/search?${p}`, 10000);
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`);
  const body = await res.json();
  return (body.results || []).map((r) => ({
    name: r.name,
    detail: [r.admin1, r.country].filter(Boolean).join(", "),
    lat: r.latitude, lon: r.longitude,
  }));
}
