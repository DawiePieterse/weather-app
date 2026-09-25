import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheKey, isFinalYear, loadLocation, unitSig, yearRuns } from "../../site/js/data.js";
import { cacheClear, cacheGet } from "../../site/js/cache.js";
import { fieldById } from "../../site/js/fields.js";

const units = { temperature: "celsius", wind: "kmh", precipitation: "mm" };
const loc = { lat: -33.9249, lon: 18.4241, name: "Cape Town" };

test("yearRuns groups consecutive years and respects the chunk cap", () => {
  assert.deepEqual(yearRuns([1990, 1991, 1992, 2001], 5), [[1990, 1992], [2001, 2001]]);
  assert.deepEqual(yearRuns([2000, 2001, 2002, 2003, 2004, 2005], 5), [[2000, 2004], [2005, 2005]]);
  assert.deepEqual(yearRuns([], 5), []);
});

test("unitSig / cacheKey vary with the unit actually used by that field", () => {
  const temp = fieldById("wh.temperature_2m");
  const humidity = fieldById("wh.relative_humidity_2m");
  assert.equal(unitSig(temp, units), "celsius");
  assert.equal(unitSig(humidity, units), "-");
  const k1 = cacheKey(loc, temp, "mean", units, null, 2024);
  const k2 = cacheKey(loc, temp, "mean", { ...units, temperature: "fahrenheit" }, null, 2024);
  assert.notEqual(k1, k2);
  const k3 = cacheKey(loc, humidity, "mean", { ...units, temperature: "fahrenheit" }, null, 2024);
  const k4 = cacheKey(loc, humidity, "mean", units, null, 2024);
  assert.equal(k3, k4); // humidity is unaffected by the temperature unit
});

test("isFinalYear: a climate projection is always final; a weather year needs the archive lag", () => {
  const climate = fieldById("cd.temperature_2m_mean");
  assert.equal(isFinalYear(climate, 2045, "2024-06-15"), true);
  const wx = fieldById("wh.temperature_2m");
  assert.equal(isFinalYear(wx, 2024, "2024-06-15"), false); // current year, not settled
  assert.equal(isFinalYear(wx, 2020, "2024-06-15"), true);  // long past
});

test("loadLocation: a year already cached and final is served without a fetch", async () => {
  await cacheClear();
  const field = fieldById("wh.temperature_2m");
  const spec = { field, agg: null, key: `${field.id}|-` };
  let calls = 0;
  const fetchImpl = async () => { calls++; return { status: 200, ok: true, json: async () => ({}) }; };

  // Prime the cache directly, as a previous session's fetch would have.
  const key = cacheKey(loc, field, null, units, null, 2020);
  const { cachePut } = await import("../../site/js/cache.js");
  await cachePut({ k: key, points: [[1, 15]], fetchedAt: Date.now(), final: true });

  const out = await loadLocation({
    loc, specs: [spec], years: [2020], units, model: null, today: "2024-06-15", fetchImpl,
  });
  assert.equal(calls, 0);
  assert.deepEqual(out.points.get(spec.key).get(2020), [[1, 15]]);
});

test("loadLocation: fetches, aggregates and caches a missing year", async () => {
  await cacheClear();
  const field = fieldById("wh.temperature_2m");
  const spec = { field, agg: "mean", key: `${field.id}|mean` };
  const fetchImpl = async (url) => {
    // Two hours on Jan 1, one on Jan 2.
    return {
      status: 200, ok: true,
      json: async () => ({
        hourly: {
          time: ["2020-01-01T00:00", "2020-01-01T12:00", "2020-01-02T00:00"],
          temperature_2m: [10, 20, 5],
        },
      }),
    };
  };
  const out = await loadLocation({
    loc, specs: [spec], years: [2020], units, model: null, today: "2024-06-15", fetchImpl,
  });
  const pts = out.points.get(spec.key).get(2020);
  assert.equal(pts.length, 2);
  // Jan 1 mean = 15, Jan 2 mean = 5.
  assert.deepEqual(pts.map((p) => p[1]), [15, 5]);

  // And it's now cached: a second call with a fetch that throws should still work.
  const out2 = await loadLocation({
    loc, specs: [spec], years: [2020], units, model: null, today: "2024-06-15",
    fetchImpl: async () => { throw new Error("should not be called"); },
  });
  assert.deepEqual(out2.points.get(spec.key).get(2020), pts);
});

test("loadLocation: a failed request is not cached (no false 'no data' forever)", async () => {
  await cacheClear();
  const field = fieldById("wh.temperature_2m");
  const spec = { field, agg: "mean", key: `${field.id}|mean` };
  const fetchImpl = async () => { throw new TypeError("network down"); };
  const out = await loadLocation({
    loc, specs: [spec], years: [2020], units, model: null, today: "2024-06-15", fetchImpl,
  });
  assert.equal(out.errors.length > 0, true);
  const cached = await cacheGet(cacheKey(loc, field, "mean", units, null, 2020));
  assert.equal(cached, undefined);
});
