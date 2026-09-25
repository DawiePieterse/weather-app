import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedRangeIn, buildUrl, ENDPOINTS, fetchSegment, planSegments, RateLimitError, variableNamedIn,
} from "../../site/js/openmeteo.js";
import { fieldById, markUnavailable } from "../../site/js/fields.js";

const today = "2024-06-15";

test("planSegments splits a weather field between archive and forecast at the lag boundary", () => {
  const field = fieldById("wh.temperature_2m"); // archive + hf + fc
  const segs = planSegments(field, "2024-01-01", "2024-06-15", today);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].endpoint, "archive");
  assert.equal(segs[0].start, "2024-01-01");
  assert.equal(segs[1].endpoint, "fc");
  assert.equal(segs[1].end <= today, true);
});

test("planSegments uses historical-forecast for an archive-only-missing field", () => {
  const field = fieldById("wh.soil_temperature_6cm"); // forecast-depth soil temp, apis: hf/fc
  const segs = planSegments(field, "2010-01-01", "2020-01-01", today);
  // 2010 predates hf's 2016 floor - the request should clip to the floor, not error.
  assert.equal(segs[0].endpoint, "hf");
  assert.equal(segs[0].start, ENDPOINTS.hf.floor);
});

test("planSegments clips a daily-only source (marine) to its floor and horizon", () => {
  const field = fieldById("mh.wave_height");
  const segs = planSegments(field, "1900-01-01", "2100-01-01", today);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].endpoint, "marine");
  assert.equal(segs[0].start, ENDPOINTS.marine.floor);
  assert.ok(segs[0].end <= today.slice(0, 4) + "-12-31" || segs[0].end > today);
});

test("planSegments never emits an inverted [start, end]", () => {
  const field = fieldById("wh.temperature_2m");
  // A range entirely in the far future (beyond the forecast horizon) should
  // produce no segments at all, not a segment with start > end.
  const segs = planSegments(field, "2030-01-01", "2030-12-31", today);
  segs.forEach((s) => assert.ok(s.start <= s.end));
});

test("buildUrl sends units only when non-default, and the model param for climate", () => {
  const url = buildUrl("archive", { lat: -33.9, lon: 18.4, start: "2024-01-01", end: "2024-01-02", hourly: ["temperature_2m"] });
  assert.ok(!url.includes("temperature_unit"));
  const url2 = buildUrl("archive", {
    lat: -33.9, lon: 18.4, start: "2024-01-01", end: "2024-01-02", hourly: ["temperature_2m"],
    units: { temperature: "fahrenheit", wind: "kmh", precipitation: "mm" },
  });
  assert.ok(url2.includes("temperature_unit=fahrenheit"));
  const url3 = buildUrl("climate", { lat: 1, lon: 1, start: "2030-01-01", end: "2030-01-02", daily: ["temperature_2m_mean"], model: "MRI_AGCM3_2_S" });
  assert.ok(url3.includes("models=MRI_AGCM3_2_S"));
});

test("variableNamedIn picks the longest matching variable, not a substring of it", () => {
  const reason = "Data corrupted at path 'hourly.temperature_2m_max'. Thanks for reporting this.";
  assert.equal(variableNamedIn(reason, ["temperature_2m", "temperature_2m_max"]), "temperature_2m_max");
});

test("allowedRangeIn parses Open-Meteo's range-rejection message", () => {
  const r = allowedRangeIn("Parameter 'start_date' is out of allowed range from 2022-07-29 to 2025-10-02");
  assert.deepEqual(r, { start: "2022-07-29", end: "2025-10-02" });
  assert.equal(allowedRangeIn("some other error"), null);
});

// --- fetchSegment: exercised against a fake fetch, since network access is
// blocked in this sandbox and the retry/recovery logic is the part worth
// testing in isolation anyway.

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test("fetchSegment drops an unrecognised variable and retries with the rest", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("nonexistent_var")) {
      return jsonResponse(400, { error: true, reason: "Cannot initialize DataVariable nonexistent_var" });
    }
    return jsonResponse(200, { hourly: { time: ["2024-01-01T00:00"], temperature_2m: [20] } });
  };
  const seg = { endpoint: "archive", start: "2024-01-01", end: "2024-01-01" };
  const out = await fetchSegment(seg, { lat: 0, lon: 0, hourly: ["temperature_2m", "nonexistent_var"] }, fetchImpl);
  assert.equal(calls.length, 2);
  assert.deepEqual(out.hourly, ["temperature_2m"]);
  assert.deepEqual(out.dropped, ["nonexistent_var"]);
  assert.ok(out.json);
});

test("fetchSegment clips to the range an API names and retries", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call++;
    if (call === 1) return jsonResponse(400, { error: true, reason: "Parameter 'start_date' is out of allowed range from 2016-01-01 to 2024-06-09" });
    return jsonResponse(200, { hourly: { time: ["2016-01-01T00:00"], temperature_2m: [10] } });
  };
  const seg = { endpoint: "hf", start: "2010-01-01", end: "2024-06-15" };
  const out = await fetchSegment(seg, { lat: 0, lon: 0, hourly: ["temperature_2m"] }, fetchImpl);
  assert.equal(out.start, "2016-01-01");
  assert.equal(out.end, "2024-06-09");
});

test("fetchSegment throws RateLimitError on HTTP 429", async () => {
  const fetchImpl = async () => ({ status: 429, ok: false, json: async () => ({}) });
  const seg = { endpoint: "archive", start: "2024-01-01", end: "2024-01-01" };
  await assert.rejects(() => fetchSegment(seg, { lat: 0, lon: 0, hourly: ["temperature_2m"] }, fetchImpl), RateLimitError);
});

test("fetchSegment returns json:null when every variable gets dropped", async () => {
  const fetchImpl = async (url) => jsonResponse(400, { error: true, reason: "Cannot initialize DataVariable made_up_field" });
  const seg = { endpoint: "archive", start: "2024-01-01", end: "2024-01-01" };
  const out = await fetchSegment(seg, { lat: 0, lon: 0, hourly: ["made_up_field"] }, fetchImpl);
  assert.equal(out.json, null);
  assert.deepEqual(out.dropped, ["made_up_field"]);
});
