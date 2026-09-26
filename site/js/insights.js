// The "Ask about this comparison" layer, minus the model: turns what is on the
// chart into the compact JSON summary the model is given (section 5 of the AI
// plan), and builds the prompt and the quick-question chips. Pure functions
// (no DOM, no network) so what the model is told can be unit-tested.
//
// The summary is built from series.js's summaryRows() - the same figures as
// the Summary table, observed days only, A - B over days both places have -
// plus a few precomputed highlights, because small models compare numbers
// poorly and pick out a stated fact well.

import { dateFromYearX, xToMonthDay, yearsText } from "./dates.js";
import { specLabel, summaryRows } from "./series.js";
import { isTotal, unitLabel } from "./fields.js";

// Summary rows are one per measurement x year, so the years kept bound the
// prompt size: the most recent ones, since that is what people ask about.
// On-device models get fewer to stay inside their 4k-token window.
export const MAX_YEARS = { device: 8, cloud: 30 };

function round(v, decimals) {
  return v == null || !isFinite(v) ? null : Number(v.toFixed(decimals));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The day a line was lowest / highest, so "when was the hottest day" has an
// answer. Ties go to the first day.
function extremes(points, year) {
  let lo = null;
  let hi = null;
  for (const p of points) {
    if (p[1] == null || !isFinite(p[1])) continue;
    if (!lo || p[1] < lo[1]) lo = p;
    if (!hi || p[1] > hi[1]) hi = p;
  }
  return lo ? { min_date: dateFromYearX(year, lo[0]), max_date: dateFromYearX(year, hi[0]) } : {};
}

// Twelve figures, a mean (or total, for amounts) per calendar month; null
// for a month with no data.
function monthly(points, total, decimals) {
  const sums = Array(12).fill(0);
  const counts = Array(12).fill(0);
  for (const [x, v] of points) {
    if (v == null || !isFinite(v)) continue;
    const m = xToMonthDay(x).getUTCMonth();
    sums[m] += v;
    counts[m]++;
  }
  return sums.map((sum, m) => (counts[m] ? round(total ? sum : sum / counts[m], decimals) : null));
}

function statsJSON(st, r, points, withMonthly) {
  if (!st) return null;
  const o = { mean: round(st.mean, r.decimals), min: round(st.min, r.decimals), max: round(st.max, r.decimals) };
  if (r.total) o.total = round(st.total, r.decimals);
  Object.assign(o, extremes(points, r.year));
  if (withMonthly) o.monthly = monthly(points, r.total, r.decimals);
  return o;
}

// A minus B, day by day: mean and total as in the Summary table, plus the
// days the gap was widest either way.
function diffJSON(r) {
  const o = { mean: round(r.diff.mean, r.decimals) };
  if (r.total) o.total = round(r.diff.total, r.decimals);
  const b = new Map(r.points[1]);
  const gaps = r.points[0].filter(([x, v]) => v != null && b.get(x) != null).map(([x, v]) => [x, v - b.get(x)]);
  const ex = extremes(gaps, r.year);
  if (ex.max_date) {
    const at = (date) => gaps.find(([x]) => dateFromYearX(r.year, x) === date)[1];
    o.max = { value: round(at(ex.max_date), r.decimals), date: ex.max_date };
    o.min = { value: round(at(ex.min_date), r.decimals), date: ex.min_date };
  }
  return o;
}

// Year with the largest value of pick(row), among whole years only - a year
// in progress is not comparable - and only when there is a choice.
function bestYear(rows, pick) {
  const whole = rows.filter((r) => !r.partial && pick(r) != null);
  if (whole.length < 2) return null;
  return whole.reduce((a, b) => (pick(b) > pick(a) ? b : a)).year;
}

function largestDiff(rows, key) {
  const withDiff = rows.filter((r) => r.diff?.[key] != null);
  if (!withDiff.length) return null;
  const r = withDiff.reduce((a, b) => (Math.abs(b.diff[key]) > Math.abs(a.diff[key]) ? b : a));
  return { year: r.year, value: r.diff[key], unit: r.unit };
}

// `monthly` adds twelve figures per line; worth it for a cloud model, too
// much for an on-device one's window.
export function buildSummary({ specs, years, locs, data, mode, today, units, maxYears = MAX_YEARS.cloud, monthly: withMonthly = false }) {
  const allYears = [...years].sort((a, b) => a - b);
  const kept = allYears.slice(-maxYears);
  const rows = summaryRows({ specs, years: kept, locs, data, today, units });
  const two = locs.length === 2;

  const summary = rows.map((r) => {
    const o = { field: r.label, unit: r.unit, year: r.year, days: r.days };
    if (r.partial) o.partial = true;
    locs.forEach((l, i) => { o[l.id] = statsJSON(r.stats[i], r, r.points[i], withMonthly); });
    if (two && r.diff) o.diff = diffJSON(r);
    return o;
  });

  // Highlights for temperature and precipitation (the first of each on the
  // chart), the two things people ask "which was warmer / wetter" about.
  const tempSpec = specs.find((s) => s.field.unit === "T");
  const rainSpec = specs.find((s) => s.field.unit === "P" && isTotal(s.field, s.agg));
  const tempRows = summary.filter((o, i) => rows[i].spec === tempSpec);
  const rainRows = summary.filter((o, i) => rows[i].spec === rainSpec);
  const highlights = {};
  for (const l of locs) {
    const w = bestYear(tempRows, (r) => r[l.id]?.mean);
    if (w != null) highlights[`warmest_year_${l.id}`] = w;
    const d = bestYear(rainRows, (r) => r[l.id]?.total);
    if (d != null) highlights[`wettest_year_${l.id}`] = d;
  }
  if (two) {
    const t = largestDiff(tempRows, "mean");
    if (t) highlights.largest_temp_diff = t;
    const p = largestDiff(rainRows, "total");
    if (p) highlights.largest_precip_diff = p;
  }

  const notes = ["Only observed days are included. Forecast days are excluded from statistics.",
    "min_date/max_date are the days of each year's lowest and highest value."];
  if (two) notes.push("diff is A minus B over the days both locations have (days); diff.max/min are the days the gap was widest each way.");
  if (withMonthly) notes.push("monthly is Jan..Dec, a mean per month (a total per month for amounts), null where there is no data.");
  if (rows.some((r) => r.partial)) notes.push(`partial: the year is still in progress (to ${dateFromYearX(today.year, today.x)}).`);
  if (specs.some((s) => s.field.source === "climate")) notes.push("Climate-projection fields are model output, not observations.");
  if (specs.some((s) => s.field.unit === "°")) notes.push("Compass-direction fields are not summarised.");
  if (kept.length < allYears.length) notes.push(`summary covers only ${yearsText(kept)} of the years on the chart.`);

  const locations = {};
  for (const l of locs) locations[l.id] = { name: l.name || l.id, lat: l.lat ?? null, lon: l.lon ?? null };
  return {
    context: {
      locations,
      mode: two ? mode : "overlay",
      years: allYears,
      fields: specs.map((s) => ({ id: s.field.id, label: specLabel(s), unit: unitLabel(s.field, units), aggregation: s.agg || null })),
      today: dateFromYearX(today.year, today.x),
      note: notes.join(" "),
    },
    summary,
    highlights,
  };
}

// ---------------------------------------------------------------- the quick read (no model)

function fmtNum(v, unit) {
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`.trim();
}

function range(vals, unit) {
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return lo === hi ? fmtNum(lo, unit) : `${lo.toLocaleString(undefined, { maximumFractionDigits: 1 })}–${fmtNum(hi, unit)}`;
}

// Plain sentences from the summary alone - instant, offline and always right,
// so there is something to read before (or instead of) asking a model.
export function quickSummary(summary) {
  const { context, summary: rows } = summary;
  const ids = Object.keys(context.locations);
  const name = (id) => context.locations[id].name;
  const two = ids.length === 2;
  const out = [];
  const byField = new Map();
  for (const r of rows) (byField.get(r.field) || byField.set(r.field, []).get(r.field)).push(r);

  for (const [field, rs] of byField) {
    const unit = rs[0].unit;
    const amount = rs.some((r) => r[ids[0]]?.total != null);
    const key = amount ? "total" : "mean";
    const word = amount ? "more" : "higher";
    const short = field.split(/[,(]/)[0].trim().toLowerCase();
    if (two) {
      const withDiff = rs.filter((r) => r.diff?.[key] != null);
      if (!withDiff.length) continue;
      const aUp = withDiff.filter((r) => r.diff[key] > 0);
      const bUp = withDiff.filter((r) => r.diff[key] < 0);
      const lead = aUp.length >= bUp.length ? { id: ids[0], rows: aUp, sign: 1 } : { id: ids[1], rows: bUp, sign: -1 };
      const other = lead.id === ids[0] ? ids[1] : ids[0];
      if (!lead.rows.length) { out.push(`${name(ids[0])} and ${name(ids[1])} had the same ${amount ? "total" : "mean"} ${short}.`); continue; }
      const gaps = lead.rows.map((r) => Math.abs(r.diff[key]));
      const when = lead.rows.length === withDiff.length
        ? (withDiff.length === 1 ? `in ${withDiff[0].year}` : `in all ${withDiff.length} years`)
        : `in ${lead.rows.length} of ${withDiff.length} years (${lead.rows.map((r) => r.year).join(", ")})`;
      out.push(`${name(lead.id)} had ${word} ${short} than ${name(other)} ${when}, by ${range(gaps, unit)}${amount ? " in total" : " on average"}.`);
    } else {
      const whole = rs.filter((r) => !r.partial && r[ids[0]]?.[key] != null);
      if (whole.length < 2) {
        const r = rs[0];
        if (r?.[ids[0]]) out.push(`${field}${r.partial ? ` so far in ${r.year}` : ` in ${r.year}`}: ${amount ? "total" : "mean"} ${fmtNum(r[ids[0]][key], unit)}, from ${fmtNum(r[ids[0]].min, unit)} to ${fmtNum(r[ids[0]].max, unit)}.`);
        continue;
      }
      const hi = whole.reduce((a, b) => (b[ids[0]][key] > a[ids[0]][key] ? b : a));
      const lo = whole.reduce((a, b) => (b[ids[0]][key] < a[ids[0]][key] ? b : a));
      out.push(`${hi.year} had the ${amount ? "most" : "highest"} ${short} (${amount ? "total" : "mean"} ${fmtNum(hi[ids[0]][key], unit)}) and ${lo.year} the ${amount ? "least" : "lowest"} (${fmtNum(lo[ids[0]][key], unit)}).`);
    }
  }
  const partial = rows.find((r) => r.partial);
  if (partial) out.push(`${partial.year} is still in progress, so its figures cover the year so far.`);
  return out;
}

export const SYSTEM_PROMPT = `You are a precise weather comparison assistant.

You will receive a structured JSON summary of weather data for one or two locations across one or more years. The data contains:

- context (locations, fields, years, mode)
- summary (mean, min, max, total, and differences per field and year)
- highlights (notable facts)

Rules:
- Answer using ONLY the numbers and facts in the provided JSON.
- Be clear, concise, and helpful.
- Always mention units.
- If the data is insufficient to answer the question, say so politely.
- Prefer short paragraphs or bullet points.
- Do not invent or estimate missing values.
- When comparing locations, clearly state which is higher/lower and by how much.`;

const USER_TEMPLATE = `Here is the weather comparison data:

{{JSON_SUMMARY}}

User question: {{USER_QUESTION}}

Please answer the question based only on the data above.`;

// `history` is earlier question/answer pairs about the same chart, so a
// follow-up like "why?" has something to follow. The data goes once, with the
// first question; later turns carry only their text.
export function buildMessages(summary, question, history = []) {
  const turns = [...history, { q: question }];
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  turns.forEach((t, i) => {
    messages.push({ role: "user", content: i === 0
      ? USER_TEMPLATE.replace("{{JSON_SUMMARY}}", () => JSON.stringify(summary)).replace("{{USER_QUESTION}}", () => t.q.trim())
      : `User question: ${t.q.trim()}` });
    if (t.a != null) messages.push({ role: "assistant", content: t.a });
  });
  return messages;
}

// Follow-up chips after an answer: a conversation, not a series of lookups.
export function followUps({ question, years }) {
  const qs = ["Why?", "Say that in fewer words", "Show the numbers behind that"];
  if (years.length > 1 && !/year by year|each year|trend/i.test(question)) qs.splice(2, 0, "Break that down year by year");
  return qs.slice(0, 4);
}

// Cheap checks on what a small model wrote. `retry` when it echoed the data
// instead of answering; `note` when it names a year that isn't on the chart,
// which is the usual sign of an invented figure.
export function checkAnswer(text, summary) {
  const retry = /[{}]/.test(text) || /"(mean|min|max|total)"\s*:/.test(text);
  const onChart = new Set(summary.context.years);
  const strays = [...new Set((text.match(/\b(19|20)\d\d\b/g) || []).map(Number))].filter((y) => !onChart.has(y));
  const note = strays.length
    ? `Mentions ${strays.join(", ")}, which ${strays.length === 1 ? "isn't" : "aren't"} on the chart - check this against the table.`
    : null;
  return { retry, note };
}

export const PROSE_REMINDER = "Please answer in plain prose or a short bullet list, not JSON or code.";

// "Temperature (2 m), daily mean" -> "temperature": the label before any
// comma or bracket, for use in a sentence.
function shortName(spec) {
  return specLabel(spec).split(/[,(]/)[0].trim().toLowerCase();
}

// Quick-question chips that fit what is actually on the chart, worded as in
// the design mockup: warmer / wetter / summarise / was <year> unusual.
export function quickQuestions({ specs, years, locs, today }) {
  const qs = [];
  const main = specs[0] ? shortName(specs[0]) : "this";
  const two = locs.length === 2;
  const has = (unit) => specs.some((s) => s.field.unit === unit);
  if (two) {
    if (has("T")) qs.push("Which place was warmer?");
    if (has("P")) qs.push("Which place was wetter?");
    if (!has("T") && !has("P")) qs.push(`Which place had higher ${main}?`);
    qs.push("Summarise the differences");
  } else {
    qs.push("What stands out in this chart?");
  }
  if (years.length > 1) {
    const latest = Math.max(...years);
    qs.push(latest === today.year ? `Is ${latest} unusual so far?` : `Was ${latest} unusual?`);
    qs.push("Is there a trend across the years?");
  }
  qs.push(`What were the highest and lowest ${main} values?`);
  if (!two && specs.length === 2) qs.push(`How do ${specLabel(specs[0]).toLowerCase()} and ${specLabel(specs[1]).toLowerCase()} relate?`);
  return qs.slice(0, 6);
}

// The loading line under "Thinking…", e.g. "Analysing temperature and rain
// differences between Cape Town and Johannesburg for 2024". Measurements are
// named by the part of their label before any comma or bracket.
export function describeAsk({ specs, years, locs }) {
  const names = [...new Set(specs.map(shortName))];
  const what = names.join(" and ") || "the chart";
  const when = years.length ? ` for ${yearsText(years)}` : "";
  const where = locs.length === 2
    ? ` differences between ${locs[0].name || "A"} and ${locs[1].name || "B"}`
    : locs.length ? ` for ${locs[0].name || "A"}` : "";
  return `Analysing ${what}${where}${when}`;
}
