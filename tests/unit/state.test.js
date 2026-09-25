import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeState, defaultState, encodeState, roundCoord } from "../../site/js/state.js";

test("roundCoord keeps ~11m precision", () => {
  assert.equal(roundCoord(-33.92493333), -33.9249);
});

test("encodeState / decodeState round-trip a two-location comparison", () => {
  const st = defaultState(2024);
  st.locs.A = { lat: -33.9249, lon: 18.4241, name: "Cape Town" };
  st.locs.B = { lat: 51.5072, lon: -0.1276, name: "London" };
  st.fields = [{ id: "wd.temperature_2m_mean", agg: null }, { id: "wh.wind_gusts_10m", agg: "max" }];
  st.years = [2023, 2024];
  st.mode = "diff";
  st.units = { temperature: "fahrenheit", wind: "mph", precipitation: "inch" };

  const decoded = decodeState(`#${encodeState(st)}`, 2024);
  assert.deepEqual(decoded.locs, st.locs);
  assert.deepEqual(decoded.fields, st.fields);
  assert.deepEqual(decoded.years, st.years);
  assert.equal(decoded.mode, "diff");
  assert.deepEqual(decoded.units, st.units);
});

test("decodeState drops an unknown field id instead of throwing", () => {
  const decoded = decodeState("#f=totally.bogus,wd.temperature_2m_mean&y=2024", 2024);
  assert.equal(decoded.fields.length, 1);
  assert.equal(decoded.fields[0].id, "wd.temperature_2m_mean");
});

test("decodeState falls back to default fields when nothing survives", () => {
  const decoded = decodeState("#f=nope,nada&y=2024", 2024);
  assert.equal(decoded.fields.length, 1);
  assert.equal(decoded.fields[0].id, defaultState(2024).fields[0].id);
});

test("decodeState rejects out-of-range coordinates", () => {
  const decoded = decodeState("#a=200,18,Nowhere&y=2024", 2024);
  assert.equal(decoded.locs.A, null);
});

test("decodeState forces overlay mode when there is no second location", () => {
  const decoded = decodeState("#a=-33.9,18.4,X&m=diff&y=2024", 2024);
  assert.equal(decoded.mode, "overlay");
});

test("decodeState returns null for an empty hash (caller falls back to storage/default)", () => {
  assert.equal(decodeState("", 2024), null);
  assert.equal(decodeState("#", 2024), null);
});

test("encodeState round-trips a location name containing a comma and special characters", () => {
  const st = defaultState(2024);
  st.locs.A = { lat: 1, lon: 2, name: "Winston-Salem, NC" };
  const decoded = decodeState(`#${encodeState(st)}`, 2024);
  assert.equal(decoded.locs.A.name, "Winston-Salem, NC");
});
