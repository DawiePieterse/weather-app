// Weather Compare: Boord Owner's Weather tab as a standalone app, for any two
// places on a map and any Open-Meteo field. Startup, state, and the wiring
// between the location card, the chart card and the dialogs.

import { addDays, refX, todayStr, xLabel, yearsText } from "./dates.js";
import { AGGS, CLIMATE_MODELS, COVERAGE, FIELDS, SOURCE_LABEL, defaultAgg, fieldById, firstYear,
         isUnavailable, lastYear, unitLabel } from "./fields.js";
import { MAX_FIELDS, MAX_QUESTION, loadState, roundCoord, saveState } from "./state.js";
import { WEATHER_HORIZON_DAYS, fetchCurrent, searchPlaces, RateLimitError } from "./openmeteo.js";
import { loadLocation } from "./data.js";
import { cacheClear, cacheCount } from "./cache.js";
import { buildSeries, summaryRows } from "./series.js";
import { dualAxisLineChart, escapeHtml, exportPDF, legend } from "./chart.js";
import { MapPicker, PIN_COLORS, coordName, reverseGeocode } from "./map-picker.js";
import { bindOffline, describeWeather, isNetworkError, renderMarkdown, setOffline, toast } from "./ui.js";
import { MAX_YEARS, PROSE_REMINDER, buildMessages, buildSummary, checkAnswer, describeAsk, followUps, quickQuestions,
         quickSummary } from "./insights.js";
import { DEVICE_MODELS, PROVIDERS, ask, cloudConfigured, dataSaver, deviceModelDownloaded, deviceModelOf, deviceModelReady,
         deviceSupport, dismissOffer, loadAISettings, loadDeviceModel, offerDismissed, plannedEngine, providerOf,
         removeDeviceModel, saveAISettings } from "./ai.js";

export const VERSION = "1.1.0";

const $ = (id) => document.getElementById(id);
const today = (() => {
  const str = todayStr();
  return { str, year: Number(str.slice(0, 4)), x: refX(str) };
})();

let state = loadState(today.year);
let picker = null;
let settingId = "A";          // which pin a map tap / search result places
let refreshSeq = 0;
let lastDrawn = null;
let showAllYears = false;
let fieldSlot = 0;
let sourceFilter = "all";
let ai = loadAISettings();
let askAbort = null;          // AbortController of the question being answered
let answeredFor = null;       // the lastDrawn the visible answer is about
let askHistory = [];          // {q, a, engine} answered about lastDrawn, newest last
let askCurrent = null;        // the answer on screen, also the last of askHistory
// A question that arrived in the link (q=) is asked once the chart is up. Only
// from the link: a question remembered from last time should not fire itself.
let pendingQuestion = location.hash ? state.question : "";

// ---------------------------------------------------------------- helpers

function specs() {
  return state.fields.map((f) => {
    const field = fieldById(f.id);
    return field && { field, agg: f.agg, key: `${field.id}|${f.agg || "-"}` };
  }).filter(Boolean);
}

function locList() {
  return ["A", "B"].filter((id) => state.locs[id]).map((id) => ({ id, ...state.locs[id] }));
}

function forecastReachesNextYear() {
  return addDays(today.str, WEATHER_HORIZON_DAYS).slice(0, 4) !== String(today.year);
}

// The years the chosen fields can have data for, which is what the year
// picker offers: from the earliest any of them reaches back to, to this year
// - or 2050 once a climate projection is on the chart.
function yearRange() {
  const ss = specs();
  const min = Math.min(...ss.map((s) => firstYear(s.field)));
  let max = Math.max(...ss.map((s) => lastYear(s.field, today.year)));
  if (state.showForecast && forecastReachesNextYear() && ss.some((s) => s.field.source !== "climate")) {
    max = Math.max(max, today.year + 1);
  }
  return { min, max };
}

function chartYears() {
  const { min, max } = yearRange();
  return state.years.filter((y) => y >= min && y <= max);
}

function update({ reload = true } = {}) {
  saveState(state);
  renderLocations();
  renderSlots();
  renderOptions();
  renderYears();
  if (reload) refresh();
  else draw();
}

// ---------------------------------------------------------------- locations

function renderLocations() {
  const rows = ["A", "B"].map((id) => {
    const loc = state.locs[id];
    if (!loc) return "";
    return `
      <div class="loc-row flex items-center gap-2 flex-wrap rounded-lg p-1.5 ${settingId === id ? "setting" : ""}">
        <span class="loc-dot" style="background:${PIN_COLORS[id]}">${id}</span>
        <input class="loc-name border border-slate-200 rounded px-2 py-1 text-sm flex-1 min-w-[8rem]" data-id="${id}"
               value="${escapeHtml(loc.name || "")}" aria-label="Name for location ${id}">
        <span class="text-xs text-slate-500">${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}</span>
        <button class="btn !py-1 !text-xs" data-move="${id}"><i class="fa-solid fa-location-dot"></i> Move</button>
        ${id === "B" ? `<button class="btn !py-1 !text-xs" data-remove="B" title="Stop comparing"><i class="fa-solid fa-xmark"></i></button>` : ""}
      </div>`;
  }).join("");
  const addB = state.locs.A && !state.locs.B
    ? `<button id="addBBtn" class="btn ${settingId === "B" ? "btn-primary" : ""}"><i class="fa-solid fa-code-compare"></i>
         ${settingId === "B" ? "Now tap the map or search to place B" : "Compare with a second location"}</button>` : "";
  $("locList").innerHTML = rows + addB;

  const hint = !state.locs.A
    ? "Tap the map, search, or use your location to choose a place."
    : `Tapping the map ${state.locs[settingId] ? "moves" : "places"} <b style="color:${PIN_COLORS[settingId]}">${settingId}</b>. Pins can be dragged.`;
  $("mapHint").innerHTML = hint;

  // Which location the search bar sets. Once there is an A, show an A/B
  // switch in front of the bar so either one can be searched for.
  const targets = state.locs.A ? ["A", "B"] : [];
  $("searchTarget").innerHTML = targets.map((id) => `<button type="button" class="loc-dot ${settingId === id ? "active" : ""}"
      style="background:${PIN_COLORS[id]}" data-target="${id}" aria-pressed="${settingId === id}"
      title="Search sets location ${id}">${id}</button>`).join("");
  $("searchTarget").classList.toggle("hidden", !targets.length);
  $("placeSearch").placeholder = state.locs.A
    ? `Search for a place for ${settingId}…` : "Search for a place…";
  $("placeSearch").setAttribute("aria-label", `Search for a place for location ${settingId}`);
  picker?.setActive(settingId);
  picker?.sync(state.locs);
}

async function placeLocation(id, { lat, lon, name }) {
  const firstPlacement = !state.locs[id];
  lat = roundCoord(lat);
  lon = roundCoord(lon);
  state.locs[id] = { lat, lon, name: name || coordName(lat, lon) };
  settingId = id;
  update();
  if (firstPlacement) picker?.fit(state.locs);
  if (!name) {
    const found = await reverseGeocode(lat, lon);
    const cur = state.locs[id];
    // Only if the pin has not moved again while the lookup was out.
    if (cur && cur.lat === lat && cur.lon === lon) {
      cur.name = found;
      update({ reload: false });
    }
  }
}

function bindLocations() {
  $("locList").addEventListener("click", (e) => {
    const move = e.target.closest("[data-move]");
    if (move) { settingId = move.dataset.move; renderLocations(); return; }
    if (e.target.closest("[data-remove]")) {
      state.locs.B = null;
      state.mode = "overlay";
      settingId = "A";
      update();
      return;
    }
    if (e.target.closest("#addBBtn")) {
      settingId = "B";
      if ($("mapPanel").classList.contains("hidden")) toggleMap(true);
      renderLocations();
    }
  });
  $("locList").addEventListener("change", (e) => {
    if (!e.target.classList.contains("loc-name")) return;
    const loc = state.locs[e.target.dataset.id];
    if (loc) { loc.name = e.target.value.trim() || coordName(loc.lat, loc.lon); update({ reload: false }); }
  });

  $("searchTarget").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-target]");
    if (!btn) return;
    settingId = btn.dataset.target;
    renderLocations();
    $("placeSearch").focus();
  });

  let timer = null;
  $("placeSearch").addEventListener("input", (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (q.length < 2) { $("placeResults").classList.add("hidden"); return; }
    timer = setTimeout(async () => {
      try {
        const results = await searchPlaces(q);
        $("placeResults").innerHTML = results.length
          ? results.map((r, i) => `<li><button class="w-full text-left px-3 py-2 hover:bg-slate-100" data-i="${i}">
              <b>${escapeHtml(r.name)}</b> <span class="text-slate-500">${escapeHtml(r.detail)}</span></button></li>`).join("")
          : `<li class="px-3 py-2 text-slate-500">No places found</li>`;
        $("placeResults")._results = results;
        $("placeResults").classList.remove("hidden");
      } catch (err) {
        if (isNetworkError(err)) setOffline(true);
      }
    }, 300);
  });
  $("placeResults").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-i]");
    if (!btn) return;
    const r = $("placeResults")._results[Number(btn.dataset.i)];
    $("placeResults").classList.add("hidden");
    $("placeSearch").value = "";
    placeLocation(settingId, { lat: r.lat, lon: r.lon, name: r.name })
      .then(() => picker?.fit(state.locs));
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#placeResults") && e.target !== $("placeSearch")) $("placeResults").classList.add("hidden");
  });

  $("myLocationBtn").addEventListener("click", () => {
    if (!navigator.geolocation) { toast("This device can't share its location"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => placeLocation(settingId, { lat: pos.coords.latitude, lon: pos.coords.longitude }).then(() => picker?.fit(state.locs)),
      () => toast("Couldn't get your location - check the browser's location permission"),
      { enableHighAccuracy: false, timeout: 10000 });
  });

  $("toggleMapBtn").addEventListener("click", () => toggleMap($("mapPanel").classList.contains("hidden")));
}

function toggleMap(show) {
  $("mapPanel").classList.toggle("hidden", !show);
  $("toggleMapBtn").querySelector("span").textContent = show ? "Hide map" : "Show map";
  try { localStorage.setItem("wx_map_hidden", show ? "0" : "1"); } catch { /* ignore */ }
  if (show) picker?.invalidate();
}

// ---------------------------------------------------------------- measurements

function sourceBadge(field) {
  return `<span class="badge">${SOURCE_LABEL[field.source]}</span>`;
}

function renderSlots() {
  const html = state.fields.map((f, i) => {
    const field = fieldById(f.id);
    if (!field) return "";
    const aggSel = field.res === "hourly" && field.aggs.length > 1
      ? `<select class="agg-select border border-slate-300 rounded p-1 text-xs" data-slot="${i}">
           ${field.aggs.map((a) => `<option value="${a}" ${a === f.agg ? "selected" : ""}>${AGGS[a]}</option>`).join("")}
         </select>`
      : field.res === "hourly" ? `<span class="text-xs text-slate-500">${AGGS[f.agg]}</span>`
        : `<span class="text-xs text-slate-500">Daily value</span>`;
    return `
      <div class="slot">
        <span class="text-xs font-semibold text-slate-500 w-16">${i === 0 ? "Left axis" : "Right axis"}</span>
        <button class="field-btn text-sm font-medium text-left hover:underline" data-slot="${i}">
          ${escapeHtml(field.label)} <span class="text-slate-500 font-normal">${unitLabel(field, state.units) ? `(${escapeHtml(unitLabel(field, state.units))})` : ""}</span>
          <i class="fa-solid fa-chevron-down text-xs text-slate-400"></i></button>
        ${sourceBadge(field)}
        ${aggSel}
        ${state.fields.length > 1 ? `<button class="text-slate-400 hover:text-slate-600 ml-auto" data-remove-slot="${i}" title="Remove"><i class="fa-solid fa-xmark"></i></button>` : ""}
      </div>`;
  }).join("");
  const add = state.fields.length < MAX_FIELDS
    ? `<button class="btn !text-xs" id="addFieldBtn"><i class="fa-solid fa-plus"></i> Add a second measurement</button>` : "";
  $("fieldSlots").innerHTML = html + add;
}

function bindSlots() {
  $("fieldSlots").addEventListener("click", (e) => {
    const btn = e.target.closest(".field-btn");
    if (btn) return openFieldDialog(Number(btn.dataset.slot));
    if (e.target.closest("#addFieldBtn")) return openFieldDialog(state.fields.length);
    const rm = e.target.closest("[data-remove-slot]");
    if (rm) {
      state.fields.splice(Number(rm.dataset.removeSlot), 1);
      update();
    }
  });
  $("fieldSlots").addEventListener("change", (e) => {
    if (!e.target.classList.contains("agg-select")) return;
    state.fields[Number(e.target.dataset.slot)].agg = e.target.value;
    update();
  });
}

function openFieldDialog(slot) {
  fieldSlot = slot;
  $("fieldDialogTitle").textContent = slot === 0 ? "Measurement on the left axis" : "Measurement on the right axis";
  $("fieldSearch").value = "";
  renderSourceChips();
  renderFieldList();
  $("fieldDialog").showModal();
  $("fieldSearch").focus();
}

function renderSourceChips() {
  const chips = [["all", "All"], ...Object.entries(SOURCE_LABEL)];
  $("sourceChips").innerHTML = `<div class="seg flex-wrap">${chips.map(([k, label]) =>
    `<button data-source="${k}" class="${sourceFilter === k ? "active" : ""}">${label}</button>`).join("")}</div>`;
}

function fieldEndpoints(field) {
  return field.source === "weather" ? field.apis : [field.source];
}

function coverageText(field) {
  if (field.source === "climate") return `${COVERAGE.climate}–${COVERAGE.climateEnd}`;
  const from = firstYear(field);
  return field.source === "weather" && !field.apis.includes("fc") ? `${from} – ~a week ago` : `${from} – forecast`;
}

function renderFieldList() {
  const terms = $("fieldSearch").value.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = FIELDS.filter((f) => (sourceFilter === "all" || f.source === sourceFilter)
    && terms.every((t) => `${f.label} ${f.key} ${f.group} ${f.source}`.toLowerCase().replace(/_/g, " ").includes(t.replace(/_/g, " "))));
  if (!matches.length) { $("fieldList").innerHTML = `<div class="text-sm text-slate-500 p-3">No fields match.</div>`; return; }
  const groups = new Map();
  for (const f of matches) {
    const g = `${SOURCE_LABEL[f.source]} · ${f.group}${f.res === "daily" ? " (daily values)" : ""}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  $("fieldList").innerHTML = [...groups].map(([g, fs]) => `
    <div class="mt-2">
      <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide px-2 py-1 sticky top-0 bg-white">${escapeHtml(g)}</div>
      ${fs.map((f) => {
        const off = fieldEndpoints(f).every((ep) => isUnavailable(ep, f.key));
        return `<button class="field-row ${off ? "unavailable" : ""}" data-id="${f.id}" ${off ? 'title="Open-Meteo did not recognise this field last time it was asked"' : ""}>
          <span><span class="text-sm">${escapeHtml(f.label)}</span>
            <span class="block text-[11px] text-slate-400 font-mono">${f.key}</span></span>
          <span class="flex flex-col items-end gap-0.5">
            <span class="badge">${escapeHtml(unitLabel(f, state.units) || "–")}</span>
            <span class="text-[10px] text-slate-400">${coverageText(f)}</span></span>
        </button>`;
      }).join("")}
    </div>`).join("");
}

function bindFieldDialog() {
  $("fieldSearch").addEventListener("input", renderFieldList);
  $("sourceChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-source]");
    if (!b) return;
    sourceFilter = b.dataset.source;
    renderSourceChips();
    renderFieldList();
  });
  $("fieldList").addEventListener("click", (e) => {
    const row = e.target.closest("[data-id]");
    if (!row) return;
    const field = fieldById(row.dataset.id);
    const entry = { id: field.id, agg: defaultAgg(field) };
    state.fields[fieldSlot] = entry;
    state.fields = state.fields.slice(0, MAX_FIELDS);
    // A field whose years don't overlap the current selection would open onto
    // an empty chart; fall back to the most recent year it has.
    if (!chartYears().length) state.years = [Math.min(yearRange().max, today.year)];
    $("fieldDialog").close();
    update();
  });
  document.querySelectorAll("dialog [data-close]").forEach((b) =>
    b.addEventListener("click", () => b.closest("dialog").close()));
}

// ---------------------------------------------------------------- options & years

function renderOptions() {
  const hasB = !!state.locs.B;
  $("modeWrap").classList.toggle("hidden", !hasB);
  $("modeWrap").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.mode));
  $("forecastCb").checked = state.showForecast;
  const climate = specs().some((s) => s.field.source === "climate");
  $("climateModelWrap").classList.toggle("hidden", !climate);
  if (!$("climateModel").options.length) {
    $("climateModel").innerHTML = CLIMATE_MODELS.map(([k, label]) => `<option value="${k}">${label}</option>`).join("");
  }
  $("climateModel").value = state.climateModel;
}

function renderYears() {
  const { min, max } = yearRange();
  const selected = new Set(state.years);
  const decades = [];
  for (let d = Math.floor(min / 10) * 10; d <= max; d += 10) decades.push(d);
  // Collapsed, the picker shows the last two decades plus any decade holding a
  // ticked year; "Show all years" opens the whole 1940-2050 range.
  const recent = (d) => d + 9 >= today.year - 19 && d <= today.year;
  const shown = decades.filter((d) => showAllYears || recent(d) || state.years.some((y) => y >= d && y < d + 10));
  $("yearPicker").innerHTML = shown.map((d) => {
    const years = [];
    for (let y = Math.max(d, min); y <= Math.min(d + 9, max); y++) years.push(y);
    return `<div class="flex items-center gap-1 flex-wrap">
      <span class="text-[11px] text-slate-400 w-10">${d}s</span>
      ${years.map((y) => `<button class="year-chip ${selected.has(y) ? "active" : ""} ${y === today.year ? "current" : ""}" data-year="${y}"
          title="${y === today.year ? "This year" : y > today.year ? "Future (forecast / projection)" : ""}">${y}</button>`).join("")}
    </div>`;
  }).join("");
  $("yearsToggle").textContent = showAllYears ? "Show recent years" : `Show all years (${min}–${max})`;
  $("yearsToggle").classList.toggle("hidden", shown.length === decades.length && !showAllYears);
}

function bindOptions() {
  $("modeWrap").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    state.mode = b.dataset.mode;
    update({ reload: false });
  });
  $("forecastCb").addEventListener("change", (e) => { state.showForecast = e.target.checked; update(); });
  $("climateModel").addEventListener("change", (e) => { state.climateModel = e.target.value; update(); });
  $("yearPicker").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-year]");
    if (!chip) return;
    const y = Number(chip.dataset.year);
    state.years = state.years.includes(y) ? state.years.filter((v) => v !== y) : [...state.years, y].sort((a, b) => a - b);
    update();
  });
  document.querySelectorAll("[data-years]").forEach((b) => b.addEventListener("click", () => {
    const y = today.year;
    state.years = { this: [y], last: [y - 1], last5: [y - 4, y - 3, y - 2, y - 1, y], clear: [] }[b.dataset.years];
    update();
  }));
  $("yearsToggle").addEventListener("click", () => { showAllYears = !showAllYears; renderYears(); });
}

// ---------------------------------------------------------------- loading & drawing

function setStatus(html) { $("loadStatus").innerHTML = html; }

function showEmpty(html) {
  lastDrawn = null;
  $("chart").innerHTML = `<div class="text-sm text-slate-400 p-8 text-center">${html}</div>`;
  $("legend").innerHTML = ""; $("summary").innerHTML = ""; $("chartSubtitle").textContent = "";
  setStatus("");
  renderAskChips();
}

async function refresh() {
  const seq = ++refreshSeq;
  const ss = specs();
  const locs = locList();
  const years = chartYears();
  $("warnings").innerHTML = "";

  if (!locs.length) {
    return showEmpty(`<i class="fa-solid fa-map-location-dot text-2xl mb-2 block"></i>Choose a location on the map to begin`);
  }
  if (!years.length) return showEmpty("Pick at least one year below");

  const progress = {};
  const showProgress = () => {
    const done = Object.values(progress).reduce((a, p) => a + p[0], 0);
    const total = Object.values(progress).reduce((a, p) => a + p[1], 0);
    if (total) setStatus(`<i class="fa-solid fa-spinner fa-spin"></i> Downloading from Open-Meteo… ${done} of ${total}`);
  };
  setStatus(`<i class="fa-solid fa-spinner fa-spin"></i> Loading…`);

  const results = await Promise.all(locs.map((loc) => loadLocation({
    loc, specs: ss, years, units: state.units, model: state.climateModel, today: today.str,
    onProgress: (d, t) => { if (seq === refreshSeq) { progress[loc.id] = [d, t]; showProgress(); } },
  })));
  if (seq !== refreshSeq) return;   // superseded by a newer change

  const data = {};
  locs.forEach((l, i) => { data[l.id] = results[i].points; });
  lastDrawn = { specs: ss, years, locs, data };
  draw();

  // What could not be shown, and why - said rather than left as a blank line.
  const notes = [];
  const errors = results.flatMap((r) => r.errors);
  const requested = Object.values(progress).some((p) => p[1] > 0);
  if (errors.some((e) => isNetworkError(e))) {
    setOffline(true);
    notes.push(["amber", "Couldn't reach Open-Meteo - showing only what is already saved on this device."]);
  } else if (requested) {
    setOffline(false);
  }
  if (errors.some((e) => e instanceof RateLimitError)) notes.push(["amber", new RateLimitError().message]);
  [...new Set(errors.filter((e) => !isNetworkError(e) && !(e instanceof RateLimitError)).map((e) => e.message))]
    .forEach((m) => notes.push(["red", `Open-Meteo: ${m}`]));
  const dropped = new Map();
  results.forEach((r) => r.dropped.forEach((ep, id) => dropped.set(id, ep)));
  dropped.forEach((ep, id) => notes.push(["amber",
    `${fieldById(id).label} isn't available from Open-Meteo's ${ep === "fc" ? "forecast" : ep === "hf" ? "historical forecast" : ep} API${ep === "fc" ? " (no recent or forecast days)" : ""}.`]));
  for (const spec of ss) {
    for (const loc of locs) {
      const empty = years.filter((y) => !(data[loc.id].get(spec.key)?.get(y) || []).length);
      if (empty.length && !errors.length) {
        notes.push(["slate", `No ${spec.field.label.toLowerCase()} data${locs.length > 1 ? ` for ${escapeHtml(loc.name)}` : ""} in ${yearsText(empty)}${
          spec.field.source === "marine" ? " - marine data only exists over the sea" :
          spec.field.source === "flood" ? " - is there a river near this point?" : ""}.`]);
      }
    }
  }
  const colors = { amber: "text-amber-700", red: "text-red-700", slate: "text-slate-500" };
  $("warnings").innerHTML = notes.map(([c, m]) => `<div class="text-xs ${colors[c]}">${m}</div>`).join("");
  setStatus(`Updated ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    + ` · ${locs.map((l) => escapeHtml(l.name)).join(" vs ")}`);
}

function draw() {
  if (!lastDrawn) return;
  const { specs: ss, years, locs, data } = lastDrawn;
  const mode = locs.length === 2 ? state.mode : "overlay";
  const { series, axisLabels, refLines, legendItems } = buildSeries({
    specs: ss, years, locs, data, mode, today, showForecast: state.showForecast, units: state.units,
  });
  const pointEvery = Math.max(1, Math.ceil(Math.max(1, ...series.map((s) => s.points.length)) / 120));
  dualAxisLineChart($("chart"), { series, xLabel, xMin: 1, xMax: 366, pointEvery, axisLabels, refLines });
  legend($("legend"), legendItems);
  $("chartSubtitle").textContent = `${locs.map((l) => `${l.id}: ${l.name}`).join("  ·  ")}${mode === "diff" ? "  ·  showing A − B" : ""}`;
  renderSummary(summaryRows({ specs: ss, years, locs, data, today, units: state.units }), locs);
  renderAskChips();
}

function fmt(v, decimals) {
  return v == null ? "–" : v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function renderSummary(rows, locs) {
  if (!rows.length) { $("summary").innerHTML = `<div class="text-slate-400 text-sm">Nothing to summarise yet.</div>`; return; }
  const anyTotal = rows.some((r) => r.total);
  const cols = ["Mean", "Min", "Max", ...(anyTotal ? ["Total"] : [])];
  const two = locs.length === 2;
  const head1 = `<tr><th></th><th></th>${locs.map((l) => `<th colspan="${cols.length}" class="!text-center">
      <span class="loc-dot" style="background:${PIN_COLORS[l.id]}">${l.id}</span> ${escapeHtml(l.name)}</th>`).join("")}
      ${two ? `<th colspan="${anyTotal ? 2 : 1}" class="!text-center">A − B</th>` : ""}</tr>`;
  const head2 = `<tr><th>Measurement</th><th>Year</th>${locs.map(() => cols.map((c) => `<th>${c}</th>`).join("")).join("")}
      ${two ? `<th>Mean</th>${anyTotal ? "<th>Total</th>" : ""}` : ""}</tr>`;
  const body = rows.map((r) => {
    const u = r.unit ? ` ${escapeHtml(r.unit)}` : "";
    const cells = r.stats.map((s) => [s?.mean, s?.min, s?.max, ...(anyTotal ? [s?.total] : [])]
      .map((v) => `<td>${fmt(v, r.decimals)}</td>`).join("")).join("");
    const diff = two ? `<td>${fmt(r.diff?.mean, r.decimals)}</td>${anyTotal ? `<td>${fmt(r.diff?.total, r.decimals)}</td>` : ""}` : "";
    return `<tr><td>${escapeHtml(r.label)}<span class="text-slate-400">${u}</span></td><td>${r.year}${r.partial ? "*" : ""}</td>${cells}${diff}</tr>`;
  }).join("");
  const partial = rows.some((r) => r.partial)
    ? `<div class="text-xs text-slate-400 mt-1">* ${today.year} so far.</div>` : "";
  $("summary").innerHTML = `<table class="summary w-full"><thead>${head1}${head2}</thead><tbody>${body}</tbody></table>${partial}`;
}

// ---------------------------------------------------------------- ask about this comparison

function engineLabel(engine) {
  if (engine === "device") return `On this device · ${deviceModelOf(ai).name}`;
  if (engine === "cloud") return `Cloud · ${providerOf(ai).name}`;
  return "Not set up";
}

function askBusy(busy) {
  $("askBtn").classList.toggle("hidden", busy);
  $("askStopBtn").classList.toggle("hidden", !busy);
  $("askInput").disabled = busy;
  $("askChips").querySelectorAll("button").forEach((b) => { b.disabled = busy; });
}

function askProgress(p, text) {
  if (p == null) { $("askProgress").classList.add("hidden"); return; }
  const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
  $("askProgress").classList.remove("hidden");
  $("askProgressBar").style.width = `${pct}%`;
  $("askProgressText").textContent = `${pct}% · ${text}`;
}

// The answer box before the first word arrives: what is happening and what
// is being looked at, rather than an empty box.
function askWaiting(text, { detail, engine }) {
  $("askAnswer").classList.remove("streaming", "ask-unavailable");
  $("askAnswer").innerHTML = `<div class="ask-waiting">
    <div class="font-semibold"><i class="fa-solid fa-hourglass-half fa-spin"></i> ${escapeHtml(text)}</div>
    <div>${escapeHtml(detail)}</div>
    <div class="text-xs">Using free AI model · ${escapeHtml(engine)}</div></div>`;
}

// No engine can answer: offline, the free tier refused, or nothing set up
// to fall back to. The chart and summary are unaffected, so say so.
function unavailableHtml(detail) {
  return `<div class="font-semibold"><i class="fa-solid fa-triangle-exclamation"></i> Free AI is currently unavailable</div>
    <div>You can still view the chart and summary table. Try again when you have a connection, or use the on-device
      model if it is already downloaded.</div>${detail ? `<div class="text-xs mt-1">${escapeHtml(detail)}</div>` : ""}`;
}
function askUnavailable(detail) {
  $("askAnswer").classList.remove("streaming");
  $("askAnswer").classList.add("ask-unavailable");
  $("askAnswer").innerHTML = unavailableHtml(detail);
}

// Chips depend only on what is drawn, so they are rebuilt only when that
// changes - and an answer about an earlier view is put away then too.
let askQuestions = [];
let chipsFor;
function renderAskChips() {
  if (chipsFor === lastDrawn) return;
  chipsFor = lastDrawn;
  askQuestions = lastDrawn ? quickQuestions({ ...lastDrawn, today }) : [];
  $("askChipsWrap").classList.toggle("hidden", !askQuestions.length);
  $("askChips").innerHTML = askQuestions.map((q, i) =>
    `<button type="button" class="ask-chip" data-i="${i}"${askAbort ? " disabled" : ""}>${escapeHtml(q)}</button>`).join("");
  renderQuickRead();
  if (answeredFor && answeredFor !== lastDrawn && !askAbort) {
    $("askAnswerWrap").classList.add("hidden");
    answeredFor = null;
    askHistory = [];
    askCurrent = null;
    renderAskHistory();
  }
  if (pendingQuestion && lastDrawn && !askAbort) {
    const q = pendingQuestion;
    pendingQuestion = "";
    $("askInput").value = q;
    runAsk(q);
  }
}

// The quick read: what the summary says in words, with no model involved.
function renderQuickRead() {
  const lines = lastDrawn ? quickSummary(buildSummary({ ...lastDrawn, mode: state.mode, today, units: state.units })) : [];
  $("askQuick").classList.toggle("hidden", !lines.length);
  $("askQuick").innerHTML = lines.length
    ? `<div class="ask-quick-title"><i class="fa-solid fa-bolt"></i> Quick read</div>${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}`
    : "";
}

// Earlier answers about this chart, folded up under the current one.
function renderAskHistory() {
  const earlier = askHistory.filter((h) => h !== askCurrent).reverse();
  $("askHistory").classList.toggle("hidden", !earlier.length);
  $("askHistory").innerHTML = earlier.map((h, i) => `<details class="ask-history" data-i="${i}">
    <summary><i class="fa-regular fa-comment"></i> ${escapeHtml(h.q)}</summary>
    <div class="ask-answer text-sm">${renderMarkdown(h.a)}</div>
    <div class="text-xs text-slate-400 mt-1">${escapeHtml(engineLabel(h.engine))}</div></details>`).join("");
}

function renderFollowUps(question) {
  const qs = lastDrawn ? followUps({ question, years: lastDrawn.years }) : [];
  $("askFollowUps").classList.toggle("hidden", !qs.length);
  $("askFollowUps").innerHTML = qs.map((q) => `<button type="button" class="ask-chip follow" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join("");
}

// The engine badge and, when nothing can answer, what to do about it.
// Depends on the AI settings, the connection and the downloaded model.
async function renderAskEngine() {
  $("askCard").classList.toggle("hidden", ai.engine === "off");
  if (ai.engine === "off") return;
  const planned = await plannedEngine(ai);
  $("askEngine").textContent = engineLabel(planned);
  const setup = $("askSetup");
  const offline = ai.engine !== "device" && cloudConfigured(ai) && !navigator.onLine;
  setup.classList.toggle("hidden", !!planned);
  setup.classList.toggle("ask-unavailable", !planned && offline);
  if (planned) return;
  if (offline) { setup.innerHTML = unavailableHtml(""); return; }

  const dev = await deviceSupport();
  const auto = ai.engine === "auto";
  const keyBtn = (text) => `<button type="button" class="btn" data-act="settings"><i class="fa-solid fa-key"></i> ${text}</button>`;
  let message;
  let buttons;
  if (dev.ok && ai.engine !== "cloud" && offerDismissed()) {
    // "Not now" was pressed: one quiet line instead of the offer.
    message = "AI answers are off until the on-device model is downloaded or a cloud key is added.";
    buttons = keyBtn("Set up");
  } else if (dev.ok && ai.engine !== "cloud") {
    const { size } = deviceModelOf(ai);
    message = `This device can answer privately, offline, with a model that downloads once (about ${size}).${
      dataSaver() ? " This connection is set to save data, so you may want to wait for Wi-Fi." : ""}${
      auto ? " Or add a free Gemini or Groq key to use the cloud instead." : ""}`;
    buttons = `<button type="button" class="btn btn-primary" data-act="download"><i class="fa-solid fa-download"></i> Download (${size})</button>${
      auto ? keyBtn("Use a cloud key") : ""}<button type="button" class="btn" data-act="dismiss">Not now</button>`;
  } else {
    const reason = dev.reason || "On-device AI is unavailable";
    message = ai.engine === "device" ? `${reason}.`
      : `${dev.ok ? "" : `${reason}, so answers need a free cloud key. `}Add a free Gemini or Groq key${navigator.onLine ? "" : " (and a connection)"} in Settings.`;
    buttons = keyBtn("AI settings");
  }
  setup.innerHTML = `<div>${escapeHtml(message)}</div><div class="flex gap-2 flex-wrap">${buttons}</div>`;
}

async function downloadDeviceModel() {
  $("askSetup").classList.add("hidden");
  try {
    await loadDeviceModel(ai.deviceModel, (p, text) => askProgress(p, text));
    toast("On-device model ready");
  } catch (err) {
    console.error("On-device model failed to load:", err);
    toast(`Couldn't load the on-device model: ${err.message}`);
  } finally {
    askProgress(null);
    renderAskEngine();
  }
}

// `force` ("cloud") asks that engine with no fallback: the "ask the cloud
// model instead" button. `followUp` sends the earlier answers about this
// chart along, so "why?" has something to refer to.
async function runAsk(question, force, { followUp = false } = {}) {
  question = (question || "").trim().slice(0, MAX_QUESTION);
  if (!question || askAbort) return;
  if (!lastDrawn) { toast("Choose a location and a year first"); return; }
  const engine = force || await plannedEngine(ai);
  if (!engine) {
    renderAskEngine();
    if (cloudConfigured(ai) && !navigator.onLine) {
      $("askAnswerWrap").classList.remove("hidden");
      $("askQuestion").textContent = question;
      $("askMeta").textContent = "";
      askUnavailable("");
    } else {
      toast("Set up the AI assistant first");
    }
    return;
  }

  const drawn = lastDrawn;
  const summary = buildSummary({ ...drawn, mode: state.mode, today, units: state.units,
    maxYears: engine === "device" ? MAX_YEARS.device : MAX_YEARS.cloud, monthly: engine === "cloud" });
  const history = followUp ? askHistory.slice(-3) : [];
  const view = { detail: describeAsk(drawn), engine: engineLabel(engine) };
  let loadingModel = false;
  askAbort = new AbortController();
  if (answeredFor !== drawn) { askHistory = []; askCurrent = null; }
  answeredFor = drawn;
  askBusy(true);
  state.question = question;
  saveState(state);
  $("askAnswerWrap").classList.remove("hidden");
  $("askQuestion").textContent = question;
  $("askAnswerWrap").setAttribute("aria-busy", "true");
  askWaiting("Thinking…", view);
  $("askMeta").textContent = "";
  $("askNote").classList.add("hidden");
  $("askCloudBtn").classList.add("hidden");
  $("askTools").classList.add("hidden");
  $("askFollowUps").classList.add("hidden");
  renderAskHistory();
  const onToken = (text) => {
    $("askAnswer").classList.add("streaming");
    $("askAnswer").innerHTML = renderMarkdown(text);
  };
  try {
    const options = { settings: ai, engine, fallback: !force && ai.engine === "auto", signal: askAbort.signal, onToken };
    let res = await ask({
      ...options, messages: buildMessages(summary, question, history),
      onProgress: (p, text) => {
        askProgress(p < 1 ? p : null, text);
        // Only redraw the box when the phase changes, not on every one of
        // the hundreds of progress events a model load sends.
        if (loadingModel !== p < 1) {
          loadingModel = p < 1;
          askWaiting(loadingModel ? "Loading the on-device model…" : "Thinking…", view);
        }
      },
      onFallback: (err) => {
        console.warn("On-device model failed, using the cloud:", err);
        askProgress(null);
        view.engine = `${engineLabel("cloud")} (on-device model unavailable)`;
        askWaiting("Thinking…", view);
      },
    });
    // A small model sometimes echoes the JSON instead of answering: one
    // more go, told not to. A year that isn't on the chart gets a warning.
    let check = checkAnswer(res.text, summary);
    if (check.retry) {
      askWaiting("Trying again…", view);
      res = await ask({ ...options, engine: res.engine, fallback: false,
        messages: buildMessages(summary, `${question}\n\n${PROSE_REMINDER}`, history) });
      check = checkAnswer(res.text, summary);
    }
    if (!res.text.trim()) $("askAnswer").textContent = "(No answer came back.)";
    $("askNote").classList.toggle("hidden", !check.note);
    $("askNote").textContent = check.note || "";
    $("askMeta").textContent = `Source: free AI, ${engineLabel(res.engine)} • Based on current chart data`;
    $("askCloudBtn").classList.toggle("hidden", !(res.engine === "device" && cloudConfigured(ai) && navigator.onLine));
    $("askCloudBtn").onclick = () => runAsk(question, "cloud", { followUp });
    $("askTools").classList.remove("hidden");
    askCurrent = { q: question, a: res.text, engine: res.engine };
    askHistory = [...askHistory.filter((h) => h.q !== question), askCurrent].slice(-6);
    renderAskHistory();
    renderFollowUps(question);
  } catch (err) {
    if (askAbort.signal.aborted) {
      if ($("askAnswer").querySelector(".ask-waiting")) $("askAnswer").textContent = "";
      $("askMeta").textContent = "Stopped";
    } else {
      console.error("Ask failed:", err);
      askUnavailable(isNetworkError(err) ? "" : err.message);
    }
  } finally {
    askProgress(null);
    $("askAnswer").classList.remove("streaming");
    $("askAnswerWrap").setAttribute("aria-busy", "false");
    askAbort = null;
    askBusy(false);
  }
}

function bindAsk() {
  $("askForm").addEventListener("submit", (e) => { e.preventDefault(); runAsk($("askInput").value); });
  $("askStopBtn").addEventListener("click", () => askAbort?.abort());
  $("askSettingsBtn").addEventListener("click", openAISettings);
  $("askChips").addEventListener("click", (e) => {
    const q = askQuestions[Number(e.target.closest("[data-i]")?.dataset.i)];
    if (q) { $("askInput").value = q; runAsk(q); }
  });
  $("askSetup").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "download") downloadDeviceModel();
    if (act === "settings") openAISettings();
    if (act === "dismiss") { dismissOffer(); renderAskEngine(); }
  });
  $("askFollowUps").addEventListener("click", (e) => {
    const q = e.target.closest("[data-q]")?.dataset.q;
    if (q) { $("askInput").value = q; runAsk(q, undefined, { followUp: true }); }
  });
  const answerText = () => `${askCurrent.q}\n\n${askCurrent.a}\n\n${$("chartSubtitle").textContent} · ${engineLabel(askCurrent.engine)}`;
  $("askCopyBtn").addEventListener("click", async () => {
    if (!askCurrent) return;
    try { await navigator.clipboard.writeText(answerText()); toast("Answer copied"); } catch { toast("Couldn't copy"); }
  });
  $("askShareBtn").classList.toggle("hidden", !navigator.share);
  $("askShareBtn").addEventListener("click", async () => {
    if (!askCurrent) return;
    try { await navigator.share({ title: "Weather Compare", text: answerText(), url: location.href }); } catch { /* cancelled */ }
  });
  window.addEventListener("online", renderAskEngine);
  window.addEventListener("offline", renderAskEngine);
}

// AI part of the settings dialog.
async function openAISettings() {
  await openSettings();
  $("aiSettings").scrollIntoView({ block: "nearest" });
}

async function renderAISettings() {
  const p = providerOf(ai);
  $("aiEngine").value = ai.engine;
  $("aiDeviceModel").value = ai.deviceModel;
  $("aiProvider").value = ai.provider;
  $("aiKey").value = ai.apiKey;
  $("aiEndpoint").value = ai.endpoint;
  $("aiCloudModel").value = ai.cloudModel;
  $("aiCloudModel").placeholder = p.model;
  $("aiKeyLink").classList.toggle("hidden", !p.keyUrl);
  $("aiKeyLink").href = p.keyUrl || "#";
  $("aiEndpointWrap").classList.toggle("hidden", ai.provider !== "custom");
  $("aiDeviceBox").classList.toggle("hidden", ai.engine === "cloud" || ai.engine === "off");
  $("aiCloudBox").classList.toggle("hidden", ai.engine === "device" || ai.engine === "off");
  const dev = await deviceSupport();
  const ready = deviceModelReady();
  const readyHere = await deviceModelDownloaded(ai);
  $("aiDownloadBtn").disabled = !dev.ok || readyHere;
  $("aiRemoveBtn").disabled = !ready;
  $("aiDeviceInfo").textContent = !dev.ok ? dev.reason : readyHere ? "Downloaded - works offline" : ready ? `${ready} is downloaded` : "Not downloaded";
}

function bindAISettings() {
  $("aiDeviceModel").innerHTML = DEVICE_MODELS.map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join("");
  $("aiProvider").innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${escapeHtml(p.label)}</option>`).join("");
  const onChange = () => {
    const provider = $("aiProvider").value;
    ai = { ...ai, engine: $("aiEngine").value, deviceModel: $("aiDeviceModel").value, provider,
           apiKey: $("aiKey").value.trim(), endpoint: $("aiEndpoint").value.trim(),
           // A model name belongs to its provider: start blank after a switch.
           cloudModel: provider === ai.provider ? $("aiCloudModel").value.trim() : "" };
    saveAISettings(ai);
    renderAISettings();
    renderAskEngine();
  };
  ["aiEngine", "aiDeviceModel", "aiProvider", "aiKey", "aiEndpoint", "aiCloudModel"]
    .forEach((id) => $(id).addEventListener("change", onChange));
  $("aiDownloadBtn").addEventListener("click", () => { $("settingsDialog").close(); downloadDeviceModel(); });
  $("aiRemoveBtn").addEventListener("click", async () => {
    try { await removeDeviceModel(); toast("On-device model removed"); } catch (err) { toast(`Couldn't remove the model: ${err.message}`); }
    renderAISettings();
    renderAskEngine();
  });
}

// ---------------------------------------------------------------- header, settings, PDF

async function renderHeaderWeather() {
  const locs = locList();
  const lines = await Promise.all(locs.map(async (loc) => {
    try {
      const c = await fetchCurrent({ lat: loc.lat, lon: loc.lon, units: state.units });
      const w = describeWeather(c.weather_code, c.is_day);
      return `<div class="flex items-center justify-end gap-1.5"><span class="loc-dot !w-4 !h-4 !text-[9px]" style="background:${PIN_COLORS[loc.id]}">${loc.id}</span>
        <i class="fa-solid ${w.icon}"></i> ${Math.round(c.temperature_2m)}${escapeHtml(c.units?.temperature_2m || "°")}
        <span class="hidden sm:inline">· ${w.text} · ${c.relative_humidity_2m}%</span></div>`;
    } catch {
      return "";
    }
  }));
  $("headerWeather").innerHTML = lines.join("");
}

async function openSettings() {
  $("unitTemp").value = state.units.temperature;
  $("unitWind").value = state.units.wind;
  $("unitPrecip").value = state.units.precipitation;
  renderAISettings();
  $("cacheInfo").textContent = `${await cacheCount()} year-series saved`;
  $("settingsDialog").showModal();
}

function bindSettings() {
  $("settingsBtn").addEventListener("click", openSettings);
  const onUnits = () => {
    state.units = { temperature: $("unitTemp").value, wind: $("unitWind").value, precipitation: $("unitPrecip").value };
    update();
    renderHeaderWeather();
  };
  ["unitTemp", "unitWind", "unitPrecip"].forEach((id) => $(id).addEventListener("change", onUnits));
  $("clearCacheBtn").addEventListener("click", async () => {
    await cacheClear();
    $("cacheInfo").textContent = "Cleared";
    refresh();
  });
  $("refreshBtn").addEventListener("click", () => { refresh(); renderHeaderWeather(); });
  $("pdfBtn").addEventListener("click", async () => {
    if (!lastDrawn) return;
    const icon = $("pdfBtn").querySelector("i");
    icon.className = "fa-solid fa-spinner fa-spin";
    try {
      const title = lastDrawn.specs.map((s) => s.field.label).join(" & ");
      const subtitle = `${lastDrawn.locs.map((l) => l.name).join(" vs ")} · ${yearsText(lastDrawn.years)}`;
      // The AI answer lives outside the chart card; when asked for, a copy
      // rides along at the bottom of the export and is removed afterwards.
      if ($("pdfIncludeAnswer").checked && askCurrent && answeredFor === lastDrawn) {
        const block = document.createElement("div");
        block.className = "pdf-answer";
        block.innerHTML = `<div class="font-semibold">AI answer: ${escapeHtml(askCurrent.q)}</div>
          <div class="ask-answer">${renderMarkdown(askCurrent.a)}</div>
          <div class="text-xs text-slate-400 mt-1">Free AI, ${escapeHtml(engineLabel(askCurrent.engine))} - check against the figures above.</div>`;
        $("chartExport").appendChild(block);
      }
      try {
        await exportPDF($("chartExport"), { title, subtitle, filename: `${`${title} ${subtitle}`.replace(/[^a-zA-Z0-9]+/g, "_")}.pdf` });
      } finally {
        $("chartExport").querySelector(".pdf-answer")?.remove();
      }
    } catch (err) {
      console.error("PDF export failed:", err);
      toast("Could not create PDF");
    } finally {
      icon.className = "fa-solid fa-file-pdf";
    }
  });
}

// ---------------------------------------------------------------- startup

function start() {
  $("headerDate").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  $("appVersion").textContent = `v${VERSION}`;
  bindOffline();
  bindLocations();
  bindSlots();
  bindFieldDialog();
  bindOptions();
  bindSettings();
  bindAsk();
  bindAISettings();
  renderAskEngine();

  try {
    picker = new MapPicker($("map"), { onPlace: (id, ll) => placeLocation(id, ll) });
    picker.sync(state.locs);
    picker.fit(state.locs);
  } catch (err) {
    // Leaflet missing (first visit offline): the rest of the app still works
    // with locations already saved.
    console.error("Map failed to start:", err);
    $("map").innerHTML = `<div class="text-sm text-slate-400 p-8 text-center">The map needs a connection the first time.</div>`;
  }
  let hideMap = false;
  try { hideMap = localStorage.getItem("wx_map_hidden") === "1"; } catch { /* ignore */ }
  if (hideMap && state.locs.A) toggleMap(false);

  update();
  renderHeaderWeather();
  setInterval(renderHeaderWeather, 10 * 60 * 1000);

  window.addEventListener("hashchange", () => {
    const next = loadState(today.year);
    if (next.question && next.question !== askCurrent?.q) pendingQuestion = next.question;
    state = next;
    update();
    picker?.fit(state.locs);
  });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./service-worker.js").catch(() => { /* offline shell is a nice-to-have */ });
  }
}

start();
