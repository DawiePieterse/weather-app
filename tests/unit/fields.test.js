import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELDS, fieldById, firstYear, isTotal, lastYear, unitLabel } from "../../site/js/fields.js";

test("every field has a unique id and a non-empty label", () => {
  const ids = new Set();
  for (const f of FIELDS) {
    assert.ok(f.id, "field missing id");
    assert.ok(!ids.has(f.id), `duplicate id ${f.id}`);
    ids.add(f.id);
    assert.ok(f.label && f.label.length > 0, `${f.id} missing label`);
  }
});

test("every hourly field lists at least one aggregation with a valid default", () => {
  for (const f of FIELDS.filter((f) => f.res === "hourly")) {
    assert.ok(f.aggs.length > 0, `${f.id} has no aggregations`);
  }
});

test("fieldById resolves catalog ids and returns null for unknown ones", () => {
  assert.equal(fieldById("wh.temperature_2m").label, "Temperature (2 m)");
  assert.equal(fieldById("nope"), null);
});

test("firstYear/lastYear give sane bounds per source", () => {
  const climate = fieldById("cd.temperature_2m_mean");
  assert.equal(firstYear(climate), 1950);
  assert.equal(lastYear(climate, 2024), 2050);
  const archiveField = fieldById("wh.temperature_2m");
  assert.equal(firstYear(archiveField), 1940);
  assert.equal(lastYear(archiveField, 2024), 2024);
  const airField = fieldById("ah.pm10");
  assert.equal(firstYear(airField), 2013);
});

test("unitLabel follows the user's unit choice for temperature/wind/precip only", () => {
  const units = { temperature: "fahrenheit", wind: "mph", precipitation: "inch" };
  assert.equal(unitLabel(fieldById("wh.temperature_2m"), units), "°F");
  assert.equal(unitLabel(fieldById("wh.wind_speed_10m"), units), "mph");
  assert.equal(unitLabel(fieldById("wd.precipitation_sum"), units), "in");
  assert.equal(unitLabel(fieldById("wh.relative_humidity_2m"), units), "%");
});

test("isTotal identifies summed hourly aggregations and daily _sum/_hours/duration fields", () => {
  assert.equal(isTotal(fieldById("wh.precipitation"), "sum"), true);
  assert.equal(isTotal(fieldById("wh.precipitation"), "mean"), false);
  assert.equal(isTotal(fieldById("wd.precipitation_sum"), null), true);
  assert.equal(isTotal(fieldById("wd.precipitation_hours"), null), true);
  assert.equal(isTotal(fieldById("wd.sunshine_duration"), null), true);
  assert.equal(isTotal(fieldById("wd.temperature_2m_mean"), null), false);
});
