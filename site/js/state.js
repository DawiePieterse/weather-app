// What the screen is showing, and how that is saved: in the URL hash (so a
// comparison can be bookmarked or sent to the other user as a link) and in
// localStorage (so the app reopens where it was left).
//
// Hash format, every part optional:
//   #a=-33.9249,18.4241,Cape%20Town&b=...&f=wd.temperature_2m_mean,wh.wind_gusts_10m:max
//    &y=2024,2025&m=diff&u=celsius,kmh,mm&cm=MRI_AGCM3_2_S&fc=0&q=Which%20place%20was%20wetter%3F
//
// q is a question for the AI assistant, so a link opens with it already
// asked. It is the only part that is not about the chart.

import { UNIT_TOKENS, defaultAgg, fieldById } from "./fields.js";

export const MAX_FIELDS = 2;
export const MAX_QUESTION = 500;
const STORAGE_KEY = "wx_state_v1";

export function defaultState(currentYear) {
  return {
    locs: { A: null, B: null },
    fields: [{ id: "wd.temperature_2m_mean", agg: null }],
    years: [currentYear],
    mode: "overlay",          // or "diff" (A minus B), only with two locations
    units: { temperature: "celsius", wind: "kmh", precipitation: "mm" },
    climateModel: "MRI_AGCM3_2_S",
    showForecast: true,
    question: "",
  };
}

// 4 decimals is ~11 m - Boord's COORD_TOLERANCE. Rounded when a pin is placed
// so the cache key for a location never changes by a re-typed last digit.
export function roundCoord(v) {
  return Math.round(v * 10000) / 10000;
}

function encLoc(l) {
  return l ? `${l.lat},${l.lon},${encodeURIComponent(l.name || "")}` : "";
}
function decLoc(s) {
  if (!s) return null;
  const [lat, lon, ...rest] = s.split(",");
  const la = Number(lat), lo = Number(lon);
  if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return { lat: roundCoord(la), lon: roundCoord(lo), name: rest.join(",") };   // URLSearchParams has already decoded it
}

export function encodeState(st) {
  const p = [];
  if (st.locs.A) p.push(`a=${encLoc(st.locs.A)}`);
  if (st.locs.B) p.push(`b=${encLoc(st.locs.B)}`);
  p.push(`f=${st.fields.map((f) => (f.agg ? `${f.id}:${f.agg}` : f.id)).join(",")}`);
  p.push(`y=${st.years.join(",")}`);
  if (st.mode !== "overlay") p.push(`m=${st.mode}`);
  const u = st.units;
  const d = defaultState(0).units;
  if (u.temperature !== d.temperature || u.wind !== d.wind || u.precipitation !== d.precipitation) {
    p.push(`u=${u.temperature},${u.wind},${u.precipitation}`);
  }
  if (st.fields.some((f) => fieldById(f.id)?.source === "climate")) p.push(`cm=${st.climateModel}`);
  if (!st.showForecast) p.push("fc=0");
  if (st.question) p.push(`q=${encodeURIComponent(st.question)}`);
  return p.join("&");
}

// Anything unrecognised is dropped rather than rejected: a link from an older
// version of the app should still open onto something sensible.
export function decodeState(hash, currentYear) {
  const st = defaultState(currentYear);
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (!params.toString()) return null;
  st.locs.A = decLoc(params.get("a"));
  st.locs.B = decLoc(params.get("b"));
  if (params.has("f")) {
    const fields = params.get("f").split(",").map((s) => {
      const [id, agg] = s.split(":");
      const field = fieldById(id);
      if (!field) return null;
      return { id, agg: field.res === "hourly" ? (field.aggs.includes(agg) ? agg : defaultAgg(field)) : null };
    }).filter(Boolean).slice(0, MAX_FIELDS);
    if (fields.length) st.fields = fields;
  }
  if (params.has("y")) {
    const years = params.get("y").split(",").map(Number).filter((y) => Number.isInteger(y) && y >= 1900 && y <= 2100);
    if (years.length) st.years = [...new Set(years)].sort((a, b) => a - b);
  }
  if (params.get("m") === "diff") st.mode = "diff";
  if (params.has("u")) {
    const [t, w, p] = params.get("u").split(",");
    if (Object.hasOwn(UNIT_TOKENS.T, t)) st.units.temperature = t;
    if (Object.hasOwn(UNIT_TOKENS.W, w)) st.units.wind = w;
    if (Object.hasOwn(UNIT_TOKENS.P, p)) st.units.precipitation = p;
  }
  if (params.has("cm")) st.climateModel = params.get("cm");
  if (params.get("fc") === "0") st.showForecast = false;
  st.question = (params.get("q") || "").trim().slice(0, MAX_QUESTION);
  if (!st.locs.B) st.mode = "overlay";
  return st;
}

export function loadState(currentYear) {
  const fromHash = typeof location !== "undefined" && location.hash ? decodeState(location.hash, currentYear) : null;
  if (fromHash) return fromHash;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return decodeState(saved, currentYear) || defaultState(currentYear);
  } catch { /* storage blocked */ }
  return defaultState(currentYear);
}

export function saveState(st) {
  const enc = encodeState(st);
  try { localStorage.setItem(STORAGE_KEY, enc); } catch { /* storage blocked */ }
  if (typeof history !== "undefined") history.replaceState(null, "", `#${enc}`);
}
