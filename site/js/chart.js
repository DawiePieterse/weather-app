// Dependency-free SVG line chart with a left and a right y-axis, ported from
// Boord Owner's shared/charts.js (dualAxisLineChart, legend, exportPDF).
//
// Added here, for the two-location comparison and the forecast:
//   - `dashed`     draws a series dashed (location B);
//   - `fadeFromX`  draws every point after that x faded (forecast days);
//   - `refLines`   horizontal reference lines (the zero line in A-B mode);
//   - a gap of more than a day in a series breaks the line instead of drawing
//     a straight segment across days that have no data.

const NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  children.forEach((c) => el.appendChild(c));
  return el;
}

function text(x, y, str, attrs = {}) {
  const t = svg("text", { x, y, ...attrs });
  t.textContent = str;
  return t;
}

// Nice rounded bounds for an axis that does NOT start at zero - a temperature
// line reads better bracketing its own range than squashed against a 0
// baseline it never goes near.
export function niceRange(min, max, steps = 4) {
  if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1, step: 1 / steps };
  if (max === min) {
    const pad = Math.abs(max) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / steps;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step };
}

// A series' points split into runs with no gap wider than a day.
export function splitRuns(points) {
  const runs = [];
  let cur = [];
  for (const p of points) {
    if (cur.length && p.x - cur[cur.length - 1].x > 1) { runs.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

function emptyState(container, msg) {
  container.innerHTML = `<div class="text-sm text-slate-400 p-8 text-center">${msg}</div>`;
}

// series: [{label, color, axis (0|1), unit, decimals, points:[{x,y}], emphasize, dashed, fadeFromX}]
// axisLabels: [{label, unit, decimals, color}] per axis.
export function dualAxisLineChart(container, { series, xLabel = (x) => x, height = 280, xMin, xMax,
                                               pointEvery = 1, axisLabels = [], refLines = [],
                                               emptyMessage = "No data for this selection" }) {
  const withPoints = series.filter((s) => s.points && s.points.length);
  if (!withPoints.length) return emptyState(container, emptyMessage);
  const allX = withPoints.flatMap((s) => s.points.map((p) => p.x));
  const x0 = xMin != null ? Math.min(xMin, ...allX) : Math.min(...allX);
  const x1 = xMax != null ? Math.max(xMax, ...allX) : Math.max(...allX);

  // One domain per axis, over every series on that axis - which is what makes
  // lines drawn against the same axis (two years, or two locations) directly
  // comparable.
  const Y_STEPS = 4;
  const domains = [0, 1].map((axis) => {
    const ys = withPoints.filter((s) => (s.axis || 0) === axis).flatMap((s) => s.points.map((p) => p.y));
    refLines.filter((r) => (r.axis || 0) === axis && ys.length).forEach((r) => ys.push(r.y));
    return ys.length ? niceRange(Math.min(...ys), Math.max(...ys), Y_STEPS) : null;
  });
  const hasRight = !!domains[1];

  const padL = 72, padB = 26, padT = 12, padR = hasRight ? 72 : 16;
  const width = Math.max(420, Math.min(1600, (x1 - x0 + 1) * 3 + padL + padR));
  const w = width - padL - padR, h = height - padT - padB;
  const sx = (x) => padL + (x1 > x0 ? ((x - x0) / (x1 - x0)) * w : w / 2);
  const sy = (axis, y) => {
    const d = domains[axis] || domains[0];
    return padT + h - ((y - d.min) / (d.max - d.min)) * h;
  };

  const children = [];
  for (let i = 0; i <= Y_STEPS; i++) {
    const y = padT + (h / Y_STEPS) * i;
    children.push(svg("line", { x1: padL, x2: padL + w, y1: y, y2: y, stroke: "#e2e8f0", "stroke-width": 1 }));
    [0, 1].forEach((axis) => {
      const d = domains[axis];
      if (!d) return;
      const meta = axisLabels[axis] || {};
      const val = d.max - ((d.max - d.min) / Y_STEPS) * i;
      children.push(text(axis === 0 ? padL - 8 : padL + w + 8, y + 4,
                          `${val.toFixed(meta.decimals ?? 1)}${meta.unit ? ` ${meta.unit}` : ""}`,
                          { "text-anchor": axis === 0 ? "end" : "start", fill: "#94a3b8", style: "font-size:10px" }));
    });
  }
  [0, 1].forEach((axis) => {
    const meta = axisLabels[axis];
    if (!domains[axis] || !meta || !meta.label) return;
    const tx = axis === 0 ? 12 : width - 12;
    const ty = padT + h / 2;
    children.push(text(tx, ty, meta.unit ? `${meta.label} (${meta.unit})` : meta.label,
                        { "text-anchor": "middle", fill: meta.color || "#64748b",
                          style: "font-size:11px;font-weight:600", transform: `rotate(-90 ${tx} ${ty})` }));
  });
  // Month ticks rather than evenly spaced days: the axis is always a calendar
  // year, and "Mar" reads faster than "Feb 29".
  const monthStarts = [1, 32, 61, 92, 122, 153, 183, 214, 245, 275, 306, 336];
  monthStarts.forEach((x, m) => {
    if (x < x0 || x > x1) return;
    const name = new Date(Date.UTC(2000, m, 1)).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
    children.push(svg("line", { x1: sx(x), x2: sx(x), y1: padT + h, y2: padT + h + 4, stroke: "#cbd5e1" }));
    children.push(text(sx(x) + 2, padT + h + 18, name,
                        { "text-anchor": "start", fill: "#94a3b8", style: "font-size:10px" }));
  });

  refLines.forEach((r) => {
    const d = domains[r.axis || 0];
    if (!d || r.y < d.min || r.y > d.max) return;
    const y = sy(r.axis || 0, r.y);
    children.push(svg("line", { x1: padL, x2: padL + w, y1: y, y2: y, stroke: r.color || "#475569",
                                 "stroke-width": 1, "stroke-dasharray": "3 3" }));
  });

  withPoints.forEach((s) => {
    const axis = s.axis || 0;
    const fade = s.fadeFromX;
    const dash = s.dashed ? "6 4" : null;
    const strokeW = s.emphasize ? 2.75 : 1.5;
    splitRuns(s.points).forEach((run) => {
      // Observed part solid, forecast part faded. The segment joining the
      // last observed day to the first forecast day belongs to the forecast.
      const cut = fade == null ? run.length : run.findIndex((p) => p.x > fade);
      const observed = cut === -1 ? run : run.slice(0, cut);
      const forecast = cut === -1 || cut === run.length ? [] : run.slice(Math.max(0, cut - 1));
      [[observed, 1], [forecast, 0.35]].forEach(([pts, opacity]) => {
        if (pts.length < 1) return;
        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(axis, p.y).toFixed(1)}`).join(" ");
        const attrs = { d, fill: "none", stroke: s.color, "stroke-width": strokeW, opacity,
                        "stroke-linejoin": "round" };
        if (dash) attrs["stroke-dasharray"] = dash;
        children.push(svg("path", attrs));
        if (pts.length === 1) {
          children.push(svg("circle", { cx: sx(pts[0].x), cy: sy(axis, pts[0].y), r: 2, fill: s.color, opacity }));
        }
      });
    });
    // Hover targets carrying the value, thinned out so a year of daily points
    // does not put 365 circles per line into the DOM.
    s.points.forEach((p, i) => {
      if (i % pointEvery !== 0 && i !== s.points.length - 1) return;
      const titleEl = svg("title");
      const forecast = fade != null && p.x > fade ? " · forecast" : "";
      titleEl.textContent = `${s.label}: ${p.y.toFixed(s.decimals ?? 1)}${s.unit ? ` ${s.unit}` : ""} (${xLabel(p.x)}${forecast})`;
      children.push(svg("circle", { cx: sx(p.x), cy: sy(axis, p.y), r: 4, fill: "transparent" }, [titleEl]));
    });
  });

  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height,
                             preserveAspectRatio: "xMinYMin meet", role: "img" }, children);
  container.innerHTML = "";
  container.appendChild(root);
}

// items: [{label, color, dashed, faded}]
export function legend(container, items) {
  container.innerHTML = items.map((it) => `
    <span class="inline-flex items-center gap-1.5 text-xs text-slate-600 mr-3 mb-1">
      <span style="display:inline-block;width:18px;height:0;border-top:${it.dashed ? "2px dashed" : "3px solid"} ${it.color};opacity:${it.faded ? 0.35 : 1}"></span>
      ${escapeHtml(it.label)}
    </span>`).join("");
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Renders the chart container to a canvas with html2canvas and puts it on a
// one-page PDF under a title. See Boord's charts.js for why html2canvas and
// not an SVG-to-image route (browsers taint the canvas), why the scroll
// offsets are negated, and why orientation is taken from the final page size.
export async function exportPDF(el, { title = "", subtitle = "", filename = "chart.pdf" } = {}) {
  if (!window.jspdf || !window.jspdf.jsPDF || !window.html2canvas) {
    alert("PDF export isn't available offline until this page has loaded online at least once.");
    return;
  }
  const canvas = await window.html2canvas(el, {
    backgroundColor: "#ffffff",
    scale: 2,
    scrollX: -window.scrollX,
    scrollY: -window.scrollY,
    windowWidth: document.documentElement.scrollWidth,
    windowHeight: document.documentElement.scrollHeight,
  });
  const width = canvas.width / 2, height = canvas.height / 2;
  const imgData = canvas.toDataURL("image/jpeg", 0.85);

  const { jsPDF } = window.jspdf;
  const marginX = 24, marginTop = 20, marginBottom = 24, lineHeight = 18;
  const headerLines = [];
  if (title) headerLines.push({ text: title, size: 14, color: [10, 47, 107], bold: true });
  if (subtitle) headerLines.push({ text: subtitle, size: 11, color: [71, 85, 105], bold: false });
  const headerH = headerLines.length ? headerLines.length * lineHeight + 8 : 0;
  const pageW = width + marginX * 2;
  const pageH = marginTop + headerH + height + marginBottom;
  const pdf = new jsPDF({ orientation: pageW > pageH ? "landscape" : "portrait", unit: "pt", format: [pageW, pageH] });
  let y = marginTop;
  headerLines.forEach((line) => {
    pdf.setFontSize(line.size);
    pdf.setTextColor(...line.color);
    pdf.setFont(undefined, line.bold ? "bold" : "normal");
    pdf.text(line.text, marginX, y);
    y += lineHeight;
  });
  pdf.addImage(imgData, "JPEG", marginX, marginTop + headerH, width, height);
  pdf.save(filename);
}
