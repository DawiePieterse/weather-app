import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, niceRange, splitRuns } from "../../site/js/chart.js";

test("niceRange pads a flat series instead of returning a zero-width domain", () => {
  const r = niceRange(10, 10);
  assert.ok(r.max > r.min);
});

test("niceRange brackets data without forcing a zero baseline", () => {
  const r = niceRange(18, 22, 4);
  assert.ok(r.min <= 18 && r.max >= 22);
});

test("splitRuns breaks a series at a gap of more than one day", () => {
  const points = [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 10 }, { x: 11 }];
  const runs = splitRuns(points);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].length, 3);
  assert.equal(runs[1].length, 2);
});

test("splitRuns keeps a single unbroken run intact", () => {
  const points = [{ x: 1 }, { x: 2 }, { x: 3 }];
  assert.equal(splitRuns(points).length, 1);
});

test("escapeHtml neutralizes tags and quotes from a user-typed location name", () => {
  assert.equal(escapeHtml(`<img src=x onerror=alert(1)>`), "&lt;img src=x onerror=alert(1)&gt;");
  assert.equal(escapeHtml(`Café "north" & south's edge`), "Café &quot;north&quot; &amp; south&#39;s edge");
});
