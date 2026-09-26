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
export function setOffline(val) {
  document.getElementById("offlineBanner")?.classList.toggle("hidden", !val);
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
