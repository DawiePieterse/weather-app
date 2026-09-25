import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, dailyToMap, hourlyToDaily } from "../../site/js/openmeteo.js";

test("aggregate: mean/min/max/sum ignore nulls", () => {
  assert.equal(aggregate([1, null, 3], "mean"), 2);
  assert.equal(aggregate([1, 5, 3], "min"), 1);
  assert.equal(aggregate([1, 5, 3], "max"), 5);
  assert.equal(aggregate([1, 2, 3], "sum"), 6);
  assert.equal(aggregate([null, null], "mean"), null);
});

test("aggregate: circmean averages compass bearings as vectors, not scalars", () => {
  // 350 and 10 degrees are both "roughly north" - the plain mean (180, due
  // south) would be exactly backwards.
  const result = aggregate([350, 10], "circmean");
  assert.ok(result < 5 || result > 355, `expected near 0/360, got ${result}`);
});

test("hourlyToDaily groups by the LOCAL calendar day already in the timestamp", () => {
  const times = ["2024-03-01T23:00", "2024-03-02T00:00", "2024-03-02T01:00"];
  const values = [10, 20, 30];
  const map = hourlyToDaily(times, values, "mean");
  assert.equal(map.get("2024-03-01"), 10);
  assert.equal(map.get("2024-03-02"), 25);
});

test("hourlyToDaily applies scale before aggregating (sunshine seconds -> hours)", () => {
  const times = ["2024-01-01T00:00", "2024-01-01T01:00"];
  const values = [3600, 1800];
  const map = hourlyToDaily(times, values, "sum", 1 / 3600);
  assert.equal(map.get("2024-01-01"), 1.5);
});

test("dailyToMap keeps null as null and applies scale", () => {
  const map = dailyToMap(["2024-01-01", "2024-01-02"], [10, null], 2);
  assert.equal(map.get("2024-01-01"), 20);
  assert.equal(map.get("2024-01-02"), null);
});
