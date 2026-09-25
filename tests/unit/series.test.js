import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSeries, fadeFromX, specLabel, summarize, summaryRows } from "../../site/js/series.js";
import { fieldById } from "../../site/js/fields.js";

const units = { temperature: "celsius", wind: "kmh", precipitation: "mm" };
const today = { year: 2024, x: 100 };

function specOf(id, agg) {
  const field = fieldById(id);
  return { field, agg, key: `${id}|${agg || "-"}` };
}

test("fadeFromX: past years never fade, this year fades from today, future years fade entirely", () => {
  const field = fieldById("wh.temperature_2m");
  assert.equal(fadeFromX(field, 2020, today), null);
  assert.equal(fadeFromX(field, 2024, today), 100);
  assert.equal(fadeFromX(field, 2025, today), 0);
});

test("fadeFromX: climate projections never fade, even for a 'future' year", () => {
  const field = fieldById("cd.temperature_2m_mean");
  assert.equal(fadeFromX(field, 2045, today), null);
});

test("buildSeries: single measurement -> hue per year; two measurements -> hue per measurement, shade per year", () => {
  const oneMetric = buildSeries({
    specs: [specOf("wd.temperature_2m_mean")], years: [2023, 2024], locs: [{ id: "A", name: "X" }],
    data: { A: new Map([["wd.temperature_2m_mean|-", new Map([[2023, [[1, 10]]], [2024, [[1, 12]]]])]]) },
    mode: "overlay", today, showForecast: true, units,
  });
  const colors = oneMetric.series.map((s) => s.color);
  assert.equal(new Set(colors).size, 2); // distinct hue per year

  const twoMetrics = buildSeries({
    specs: [specOf("wd.temperature_2m_mean"), specOf("wd.precipitation_sum")], years: [2023, 2024],
    locs: [{ id: "A", name: "X" }],
    data: {
      A: new Map([
        ["wd.temperature_2m_mean|-", new Map([[2023, [[1, 10]]], [2024, [[1, 12]]]])],
        ["wd.precipitation_sum|-", new Map([[2023, [[1, 1]]], [2024, [[1, 2]]]])],
      ]),
    },
    mode: "overlay", today, showForecast: true, units,
  });
  // axis 0 series should all share a hue family regardless of year.
  const axis0 = twoMetrics.series.filter((s) => s.axis === 0);
  assert.equal(axis0.length, 2);
});

test("buildSeries: location B is dashed, A is not", () => {
  const data = {
    A: new Map([["wd.temperature_2m_mean|-", new Map([[2024, [[1, 10]]]])]]),
    B: new Map([["wd.temperature_2m_mean|-", new Map([[2024, [[1, 8]]]])]]),
  };
  const { series } = buildSeries({
    specs: [specOf("wd.temperature_2m_mean")], years: [2024],
    locs: [{ id: "A", name: "Here" }, { id: "B", name: "There" }],
    data, mode: "overlay", today, showForecast: true, units,
  });
  assert.ok(!series.find((s) => s.label.includes("Here")).dashed);
  assert.equal(series.find((s) => s.label.includes("There")).dashed, true);
});

test("buildSeries: diff mode computes A minus B only where both have a point", () => {
  const data = {
    A: new Map([["wd.temperature_2m_mean|-", new Map([[2024, [[1, 10], [2, 20]]]])]]),
    B: new Map([["wd.temperature_2m_mean|-", new Map([[2024, [[1, 4], [3, 99]]]])]]), // x=2,3 don't overlap
  };
  const { series, refLines } = buildSeries({
    specs: [specOf("wd.temperature_2m_mean")], years: [2024],
    locs: [{ id: "A", name: "Here" }, { id: "B", name: "There" }],
    data, mode: "diff", today, showForecast: true, units,
  });
  assert.equal(series.length, 1);
  assert.deepEqual(series[0].points, [{ x: 1, y: 6 }]); // only x=1 is shared
  assert.deepEqual(refLines, [{ axis: 0, y: 0 }]);
});

test("buildSeries: diff mode on wind direction uses circular difference", () => {
  const data = {
    A: new Map([["wh.wind_direction_10m|circmean", new Map([[2024, [[1, 350]]]])]]),
    B: new Map([["wh.wind_direction_10m|circmean", new Map([[2024, [[1, 10]]]])]]),
  };
  const { series } = buildSeries({
    specs: [specOf("wh.wind_direction_10m", "circmean")], years: [2024],
    locs: [{ id: "A", name: "Here" }, { id: "B", name: "There" }],
    data, mode: "diff", today, showForecast: true, units,
  });
  // 350 - 10 the naive way is 340; the circular difference should be -20.
  assert.equal(series[0].points[0].y, -20);
});

test("buildSeries: forecast days are faded, and dropped entirely when showForecast is false", () => {
  const data = { A: new Map([["wd.temperature_2m_mean|-", new Map([[2024, [[90, 1], [100, 2], [110, 3]]]])]]) };
  const withForecast = buildSeries({
    specs: [specOf("wd.temperature_2m_mean")], years: [2024], locs: [{ id: "A", name: "X" }],
    data, mode: "overlay", today, showForecast: true, units,
  });
  assert.equal(withForecast.series[0].points.length, 3);
  assert.equal(withForecast.series[0].fadeFromX, 100);

  const without = buildSeries({
    specs: [specOf("wd.temperature_2m_mean")], years: [2024], locs: [{ id: "A", name: "X" }],
    data, mode: "overlay", today, showForecast: false, units,
  });
  assert.deepEqual(without.series[0].points.map((p) => p.x), [90, 100]); // x=110 (>today) dropped
});

test("specLabel names the aggregation for hourly fields but not daily ones", () => {
  assert.match(specLabel(specOf("wh.temperature_2m", "max")), /max/);
  assert.doesNotMatch(specLabel(specOf("wd.temperature_2m_mean")), /mean\)/);
});

test("summarize: mean/min/max, and total only when asked for", () => {
  assert.equal(summarize([1, 2, 3], false).total, null);
  assert.deepEqual(summarize([1, 2, 3], true), { n: 3, mean: 2, min: 1, max: 3, total: 6 });
  assert.equal(summarize([null, null], false), null);
});

test("summaryRows: excludes forecast days and compass-direction fields, computes A-B on shared days only", () => {
  const data = {
    A: new Map([["wd.temperature_2m_mean|-", new Map([[2024, [[90, 10], [100, 20], [110, 999]]]])]]), // 110 is forecast
    B: new Map([["wd.temperature_2m_mean|-", new Map([[2024, [[90, 5]]]])]]), // only x=90 shared
  };
  const rows = summaryRows({
    specs: [specOf("wd.temperature_2m_mean")], years: [2024],
    locs: [{ id: "A", name: "Here" }, { id: "B", name: "There" }],
    data, today, units,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].days, 1);
  assert.equal(rows[0].diff.mean, 5); // 10 - 5, x=100 excluded (B has no data there)

  const dirRows = summaryRows({
    specs: [specOf("wh.wind_direction_10m", "circmean")], years: [2024],
    locs: [{ id: "A", name: "Here" }], data: { A: new Map() }, today, units,
  });
  assert.equal(dirRows.length, 0);
});
