// Small UI helpers, trimmed from Boord's shared/api.js: toast, offline
// banner, and weather-code icons.

export function toast(message) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 3200);
}

// navigator.onLine only reflects the radio, not whether Open-Meteo is actually
// reachable, so requests also report their own failures through setOffline().
let _offline = false;
export function setOffline(val) {
  _offline = !!val;
  document.getElementById("offlineBanner")?.classList.toggle("hidden", !_offline);
}
export function bindOffline() {
  window.addEventListener("offline", () => setOffline(true));
  window.addEventListener("online", () => setOffline(false));
  if (!navigator.onLine) setOffline(true);
}

export function isNetworkError(e) {
  return e instanceof TypeError || (!!e && (e.name === "AbortError" || e.name === "TimeoutError"));
}

// WMO weather interpretation codes (what Open-Meteo's weather_code is) ->
// words and a Font Awesome icon.
const WMO = [
  [[0], "Clear", "fa-sun", "fa-moon"],
  [[1, 2], "Partly cloudy", "fa-cloud-sun", "fa-cloud-moon"],
  [[3], "Overcast", "fa-cloud"],
  [[45, 48], "Fog", "fa-smog"],
  [[51, 53, 55, 56, 57], "Drizzle", "fa-cloud-rain"],
  [[61, 63, 66, 80, 81], "Rain", "fa-cloud-rain"],
  [[65, 67, 82], "Heavy rain", "fa-cloud-showers-heavy"],
  [[71, 73, 77, 85], "Snow", "fa-snowflake"],
  [[75, 86], "Heavy snow", "fa-snowflake"],
  [[95, 96, 99], "Thunderstorm", "fa-bolt"],
];
export function describeWeather(code, isDay = 1) {
  const hit = WMO.find(([codes]) => codes.includes(code));
  if (!hit) return { text: "", icon: "fa-cloud" };
  return { text: hit[1], icon: (!isDay && hit[3]) || hit[2] };
}

// The little Markdown a language model uses in a short answer - headings,
// bullet and numbered lists, bold, italic, inline code - rendered to HTML with
// everything escaped first, so an answer can never inject markup. Anything
// fancier (tables, links) is left as its text.
export function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_(\S(?:[^_\n]*\S)?)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  const out = [];
  let list = null;           // "ul" | "ol" while inside a list
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join(" ")}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const bullet = /^([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!line) { flushPara(); closeList(); continue; }
    if (bullet) {
      flushPara();
      const kind = /^\d/.test(bullet[1]) ? "ol" : "ul";
      if (list !== kind) { closeList(); list = kind; out.push(`<${kind}>`); }
      out.push(`<li>${inline(bullet[2])}</li>`);
      continue;
    }
    closeList();
    if (heading) { flushPara(); out.push(`<h4>${inline(heading[1])}</h4>`); continue; }
    para.push(line);
  }
  flushPara();
  closeList();
  return out.join("");
}
