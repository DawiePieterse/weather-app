import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, dateFromYearX, fmtDate, maxDate, minDate, parseDate, refX, todayStr, xLabel } from "../../site/js/dates.js";

test("parseDate/fmtDate round-trip", () => {
  assert.equal(fmtDate(parseDate("2024-03-01")), "2024-03-01");
});

test("addDays crosses month and year boundaries", () => {
  assert.equal(addDays("2024-02-28", 1), "2024-02-29"); // leap year
  assert.equal(addDays("2023-02-28", 1), "2023-03-01"); // non-leap year
  assert.equal(addDays("2024-12-31", 1), "2025-01-01");
  assert.equal(addDays("2024-01-01", -1), "2023-12-31");
});

test("min/maxDate compare as strings (ISO dates sort lexically)", () => {
  assert.equal(minDate("2024-01-05", "2024-02-01"), "2024-01-05");
  assert.equal(maxDate("2024-01-05", "2024-02-01"), "2024-02-01");
});

test("refX gives leap-year-safe day slots", () => {
  assert.equal(refX("2000-01-01"), 1);
  assert.equal(refX("2001-03-01"), refX("2000-03-01")); // same slot regardless of leap year
  assert.equal(refX("2000-02-29"), 60);
  assert.equal(refX("2000-03-01"), 61);
  // A non-leap year's March 1 lands on the SAME x as a leap year's March 1 -
  // this is the whole point: Boord's plain day-of-year put them one apart.
  assert.equal(refX("2023-03-01"), refX("2024-03-01"));
});

test("dateFromYearX / xLabel are refX's inverse for month+day", () => {
  const x = refX("2024-07-15");
  assert.equal(dateFromYearX(2024, x), "2024-07-15");
  assert.equal(dateFromYearX(2001, x), "2001-07-15");
  assert.match(xLabel(x), /Jul/);
});

test("todayStr uses local calendar fields, not UTC", () => {
  const d = new Date(2024, 0, 15, 3, 0, 0); // local Jan 15
  assert.equal(todayStr(d), "2024-01-15");
});
