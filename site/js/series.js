// Loaded data -> chart series, legend and summary figures. Pure functions (no
// DOM) so the colour and comparison rules can be unit-tested.
//
// A line is one measurement x one year x one location. The encoding is
// Boord's Weather tab plus one dimension:
//   - hue says WHICH measurement and shade says WHICH year - or, with a single
//     measurement on the chart, each year gets its own hue (Boord's rule);
//   - line style says WHICH location: A solid, B dashed;
//   - opacity says observed vs forecast: days after today are drawn faded.
// The current year is drawn thicker, as in Boord.

import { isTotal, unitLabel } from "./fields.js";

export const HUE_FAMILIES = [
  ["#fca5a5", "#f87171", "#dc2626", "#991b1b"], // red
  ["#bfdbfe", "#60a5fa", "#2563eb", "#1e40af"], // blue
  ["#bbf7d0", "#4ade80", "#16a34a", "#166534"], // green
  ["#fde68a", "#fbbf24", "#d97706", "#92400e"], // amber
  ["#ddd6fe", "#a78bfa", "#7c3aed", "#5b21b6"], // violet
  ["#99f6e4", "#2dd4bf", "#0d9488", "#115e59"], // teal
  ["#fbcfe8", "#f472b6", "#db2777", "#9d174d"], // magenta
  ["#cbd5e1", "#94a3b8", "#64748b", "#334155"], // slate
];
const SHADES = HUE_FAMILIES[0].length;
const SHADE_CYCLE = [2, 0, 3, 1];

function shadeIndex(rank, count) {
  if (count <= 1) return SHADES - 1;
  return Math.round((rank / (count - 1)) * (SHADES - 1));
}

export function decimalsFor(field) {
  if (field.unit === "m³/m³") return 3;
  if (field.unit === "kPa" || field.key === "aerosol_optical_depth") return 2;
  if (["%", "hPa", "m", "J/kg", "°", "grains/m³"].includes(field.unit) && field.source !== "marine") return 0;
  return 1;
}

export function specLabel(spec) {
  const f = spec.field;
  return f.res === "hourly" && spec.agg ? `${f.label} (${aggWord(spec.agg)})` : f.label;
}
function aggWord(agg) {
  return { mean: "mean", min: "min", max: "max", sum: "total", circmean: "mean" }[agg] || agg;
}

// Where the forecast starts on a given year's line: null for a year entirely
// in the past, today's x for this year, 0 for a year entirely in the future.
// Climate projections are never "forecast" - a 2045 line is the whole point.
export function fadeFromX(field, year, today) {
  if (field.source === "climate") return null;
  if (year < today.year) return null;
  return year === today.year ? today.x : 0;
}

function isForecast(field, year, x, today) {
  const f = fadeFromX(field, year, today);
  return f != null && x > f;
}

// Angle difference folded into -180..180, so north-west minus north-east reads
// as -90, not 270.
function angleDiff(a, b) {
  return ((a - b + 540) % 360) - 180;
}

// data: { A: Map(specKey -> Map(year -> [[x, v]])), B: ... }
// locs: [{id: "A", name}, {id: "B", name}?]
// today: {year, x}
export function buildSeries({ specs, years, locs, data, mode, today, showForecast, units }) {
  const series = [];
  const legendItems = [];
  const hueByYear = specs.length === 1;
  const hueOf = (mi, yi) => HUE_FAMILIES[(hueByYear ? yi : mi) % HUE_FAMILIES.length];
  const shadeOf = (yi) => (hueByYear ? SHADE_CYCLE[Math.floor(yi / HUE_FAMILIES.length) % SHADES] : shadeIndex(yi, years.length));
  const diff = mode === "diff" && locs.length === 2;

  specs.forEach((spec, mi) => {
    const f = spec.field;
    const unit = unitLabel(f, units);
    const decimals = decimalsFor(f);
    const label = specLabel(spec);
    const keep = (year) => ([x]) => showForecast || !isForecast(f, year, x, today);

    years.forEach((year, yi) => {
      const color = hueOf(mi, yi)[shadeOf(yi)];
      const base = { color, axis: mi, unit, decimals, emphasize: year === today.year,
                     fadeFromX: showForecast ? fadeFromX(f, year, today) : null };
      if (diff) {
        const a = new Map((data.A?.get(spec.key)?.get(year) || []).filter(keep(year)));
        const b = new Map((data.B?.get(spec.key)?.get(year) || []).filter(keep(year)));
        const points = [...a.keys()].filter((x) => b.has(x)).sort((p, q) => p - q)
          .map((x) => ({ x, y: unit === "°" ? angleDiff(a.get(x), b.get(x)) : a.get(x) - b.get(x) }));
        series.push({ ...base, label: `${label} — ${year} — A − B`, points });
        legendItems.push({ label: `${label} — ${year}`, color });
        return;
      }
      locs.forEach((loc, li) => {
        const raw = (data[loc.id]?.get(spec.key)?.get(year) || []).filter(keep(year));
        const points = raw.map(([x, y]) => ({ x, y }));
        const where = locs.length > 1 ? ` — ${loc.name || loc.id}` : "";
        series.push({ ...base, dashed: li === 1, label: `${label} — ${year}${where}`, points });
      });
      legendItems.push({ label: `${label} — ${year}`, color });
    });
  });

  if (!diff && locs.length > 1) {
    locs.forEach((loc, li) => legendItems.push({ label: `${loc.id}: ${loc.name || loc.id}`, color: "#475569", dashed: li === 1 }));
  }
  if (showForecast && specs.some((s) => s.field.source !== "climate") && years.some((y) => y >= today.year)) {
    legendItems.push({ label: "Forecast (faded)", color: "#475569", faded: true });
  }

  const axisLabels = specs.map((spec, mi) => ({
    label: diff ? `${spec.field.label} difference` : spec.field.label,
    unit: unitLabel(spec.field, units),
    decimals: decimalsFor(spec.field),
    color: hueByYear ? "#64748b" : HUE_FAMILIES[mi % HUE_FAMILIES.length][2],
  }));
  const refLines = diff ? specs.map((_, mi) => ({ axis: mi, y: 0 })) : [];
  return { series, axisLabels, refLines, legendItems };
}

export function summarize(values, total) {
  const vs = values.filter((v) => v != null && isFinite(v));
  if (!vs.length) return null;
  const sum = vs.reduce((a, b) => a + b, 0);
  return { n: vs.length, mean: sum / vs.length, min: Math.min(...vs), max: Math.max(...vs), total: total ? sum : null };
}

// One row per measurement x year: each location's mean/min/max (and total,
// for amounts like rain), plus A minus B. Observed days only - a forecast is
// not a record - and only days both locations have, when comparing, so the
// difference is like for like. `points` keeps those shared days per location
// ([x, value] pairs) for anything that needs dates, like the AI summary.
export function summaryRows({ specs, years, locs, data, today, units }) {
  const rows = [];
  for (const spec of specs) {
    // A compass bearing has no meaningful mean/min/max in this table.
    if (spec.field.unit === "°") continue;
    const total = isTotal(spec.field, spec.agg);
    for (const year of years) {
      const perLoc = locs.map((loc) => new Map(
        (data[loc.id]?.get(spec.key)?.get(year) || []).filter(([x]) => !isForecast(spec.field, year, x, today))));
      const shared = locs.length > 1
        ? [...perLoc[0].keys()].filter((x) => perLoc[1].has(x))
        : [...perLoc[0].keys()];
      const stats = perLoc.map((m) => summarize(shared.map((x) => m.get(x)), total));
      if (stats.every((s) => !s)) continue;
      const points = perLoc.map((m) => shared.map((x) => [x, m.get(x)]));
      rows.push({
        points,
        spec, label: specLabel(spec), year, partial: fadeFromX(spec.field, year, today) != null, unit: unitLabel(spec.field, units), decimals: decimalsFor(spec.field),
        total, stats, days: shared.length,
        diff: stats.length === 2 && stats[0] && stats[1] ? {
          mean: stats[0].mean - stats[1].mean,
          total: total ? stats[0].total - stats[1].total : null,
        } : null,
      });
    }
  }
  return rows;
}
