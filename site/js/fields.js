// Catalog of every Open-Meteo field this app can chart.
//
// Open-Meteo publishes no machine-readable list of its variables, so this is
// hand-built from its API documentation. It will drift as Open-Meteo adds and
// renames variables, which is why openmeteo.js treats a rejected variable as
// data rather than as a failure: the request is retried without it and the
// field is marked unavailable for that API (see markUnavailable below), so a
// stale entry here costs one greyed-out option, never a broken chart.
//
// A field is charted as ONE VALUE PER DAY, because the chart overlays years on
// a shared 1 Jan - 31 Dec axis (the same design as Boord Owner's Weather tab).
// Two kinds of field get there differently:
//   - res "daily":  Open-Meteo already computes the daily value; used as-is.
//   - res "hourly": fetched per hour and reduced to a day in the browser with
//                   the aggregation the user picks (see AGGS). This is the
//                   generalised form of Boord's _METRICS "agg" column.
//
// Field ids are "<source><res>.<api name>" - e.g. "wh.temperature_2m" is the
// weather API's hourly temperature and "cd.temperature_2m_mean" the climate
// API's daily mean. The prefix is needed because the same API name appears in
// several places (sunshine_duration is both hourly and daily; uv_index is in
// both the weather and air-quality APIs).

// Units that follow the user's unit settings. Anything else is a literal.
//   T temperature, W wind speed, P precipitation depth, S snowfall, D snow depth
export const UNIT_TOKENS = {
  T: { celsius: "°C", fahrenheit: "°F" },
  W: { kmh: "km/h", ms: "m/s", mph: "mph", kn: "kn" },
  P: { mm: "mm", inch: "in" },
  S: { mm: "cm", inch: "in" },
  D: { mm: "m", inch: "ft" },
};

export function unitLabel(field, units) {
  const tok = UNIT_TOKENS[field.unit];
  if (!tok) return field.unit;
  const setting = field.unit === "T" ? units.temperature : field.unit === "W" ? units.wind : units.precipitation;
  return tok[setting] || Object.values(tok)[0];
}

export const AGGS = {
  mean: "Daily mean",
  min: "Daily minimum",
  max: "Daily maximum",
  sum: "Daily total",
  circmean: "Daily mean (vector)",
};

export const SOURCES = {
  w: { key: "weather", label: "Weather" },
  a: { key: "air", label: "Air quality" },
  m: { key: "marine", label: "Marine" },
  f: { key: "flood", label: "Flood (river discharge)" },
  c: { key: "climate", label: "Climate projections" },
};

// How a field behaves when reduced to a day. `aggs` lists what makes sense
// for it (summing temperatures is meaningless; averaging rainfall is not what
// anyone means by "how much rain"), the first entry being the default.
const STATE = ["mean", "min", "max"];         // instantaneous values
const ACCUM = ["sum", "max", "mean"];         // amounts per hour
const DIR = ["circmean"];                     // compass directions
const PEAK = ["max", "mean", "min"];          // where the peak is the point

const fields = [];

// Adds fields. `apis` (weather only) says which of the three weather APIs
// carry the field: "archive" (ERA5 reanalysis, 1940 onward), "hf" (the
// historical-forecast API, 2016 onward) and "fc" (the live forecast, which
// also covers the last few days the archive has not caught up with yet).
function add(source, res, group, list, defaults = {}) {
  for (const f of list) {
    const [key, label, unit, aggs, extra] = f;
    fields.push({
      id: `${source}${res === "daily" ? "d" : "h"}.${key}`,
      key, label, unit, group, res,
      source: SOURCES[source].key,
      aggs: res === "daily" ? [] : (aggs || STATE),
      ...defaults,
      ...(extra || {}),
    });
  }
}

const ALL = ["archive", "hf", "fc"];
const FCST = ["hf", "fc"];
const ARCH = ["archive"];

// ---------------------------------------------------------------- weather, hourly
add("w", "hourly", "Temperature", [
  ["temperature_2m", "Temperature (2 m)", "T"],
  ["apparent_temperature", "Feels-like temperature", "T"],
  ["dew_point_2m", "Dew point (2 m)", "T"],
  ["wet_bulb_temperature_2m", "Wet-bulb temperature (2 m)", "T"],
  ["temperature_80m", "Temperature (80 m)", "T", STATE, { apis: FCST }],
  ["temperature_120m", "Temperature (120 m)", "T", STATE, { apis: FCST }],
  ["temperature_180m", "Temperature (180 m)", "T", STATE, { apis: FCST }],
], { apis: ALL });

add("w", "hourly", "Humidity & pressure", [
  ["relative_humidity_2m", "Relative humidity (2 m)", "%"],
  ["vapour_pressure_deficit", "Vapour pressure deficit", "kPa"],
  ["pressure_msl", "Sea-level pressure", "hPa"],
  ["surface_pressure", "Surface pressure", "hPa"],
  ["total_column_integrated_water_vapour", "Total column water vapour", "kg/m²"],
], { apis: ALL });

add("w", "hourly", "Cloud & visibility", [
  ["cloud_cover", "Cloud cover (total)", "%"],
  ["cloud_cover_low", "Cloud cover (low)", "%"],
  ["cloud_cover_mid", "Cloud cover (mid)", "%"],
  ["cloud_cover_high", "Cloud cover (high)", "%"],
  ["visibility", "Visibility", "m", STATE, { apis: FCST }],
], { apis: ALL });

add("w", "hourly", "Precipitation", [
  ["precipitation", "Precipitation (total)", "P", ACCUM],
  ["rain", "Rain", "P", ACCUM],
  ["showers", "Showers", "P", ACCUM, { apis: FCST }],
  ["snowfall", "Snowfall", "S", ACCUM],
  ["snow_depth", "Snow depth", "D", PEAK],
  ["precipitation_probability", "Precipitation probability", "%", PEAK, { apis: FCST }],
  ["freezing_level_height", "Freezing level height", "m", STATE, { apis: FCST }],
], { apis: ALL });

add("w", "hourly", "Wind", [
  ["wind_speed_10m", "Wind speed (10 m)", "W"],
  ["wind_speed_80m", "Wind speed (80 m)", "W", STATE, { apis: FCST }],
  ["wind_speed_100m", "Wind speed (100 m)", "W"],
  ["wind_speed_120m", "Wind speed (120 m)", "W", STATE, { apis: FCST }],
  ["wind_speed_180m", "Wind speed (180 m)", "W", STATE, { apis: FCST }],
  ["wind_gusts_10m", "Wind gusts (10 m)", "W", PEAK],
  ["wind_direction_10m", "Wind direction (10 m)", "°", DIR],
  ["wind_direction_80m", "Wind direction (80 m)", "°", DIR, { apis: FCST }],
  ["wind_direction_100m", "Wind direction (100 m)", "°", DIR],
  ["wind_direction_120m", "Wind direction (120 m)", "°", DIR, { apis: FCST }],
  ["wind_direction_180m", "Wind direction (180 m)", "°", DIR, { apis: FCST }],
], { apis: ALL });

add("w", "hourly", "Sun & radiation", [
  ["shortwave_radiation", "Shortwave (global) radiation", "W/m²"],
  ["direct_radiation", "Direct radiation", "W/m²"],
  ["diffuse_radiation", "Diffuse radiation", "W/m²"],
  ["direct_normal_irradiance", "Direct normal irradiance", "W/m²"],
  ["terrestrial_radiation", "Terrestrial (top-of-atmosphere) radiation", "W/m²"],
  // Seconds of sunshine per hour, charted in hours: a daily total of these is
  // "hours of sunshine that day", the figure Boord's Sunshine line showed.
  ["sunshine_duration", "Sunshine duration", "h", ["sum"], { scale: 1 / 3600 }],
  ["is_day", "Daylight hours (from is_day)", "h", ["sum"]],
  ["uv_index", "UV index", "", PEAK, { apis: FCST }],
  ["uv_index_clear_sky", "UV index (clear sky)", "", PEAK, { apis: FCST }],
], { apis: ALL });

add("w", "hourly", "Evapotranspiration", [
  ["et0_fao_evapotranspiration", "Reference evapotranspiration (ET₀)", "P", ACCUM],
  ["evapotranspiration", "Evapotranspiration (actual)", "P", ACCUM, { apis: FCST }],
], { apis: ALL });

add("w", "hourly", "Atmospheric stability", [
  ["boundary_layer_height", "Boundary layer height", "m"],
  ["cape", "CAPE", "J/kg", PEAK, { apis: FCST }],
  ["lifted_index", "Lifted index", "", STATE, { apis: FCST }],
  ["convective_inhibition", "Convective inhibition", "J/kg", STATE, { apis: FCST }],
], { apis: ALL });

// Two different depth sets exist, and neither API carries the other's: the
// ERA5-Land reanalysis behind the archive uses layers of 0-7 / 7-28 / 28-100 /
// 100-255 cm, the forecast models use point depths and thinner layers. Boord's
// "Soil Temp (6cm)" was the forecast-model one, which is why its line stopped
// at 2020 - the archive simply has no 6 cm reading.
add("w", "hourly", "Soil (reanalysis depths, 1940 onward)", [
  ["soil_temperature_0_to_7cm", "Soil temperature 0–7 cm", "T"],
  ["soil_temperature_7_to_28cm", "Soil temperature 7–28 cm", "T"],
  ["soil_temperature_28_to_100cm", "Soil temperature 28–100 cm", "T"],
  ["soil_temperature_100_to_255cm", "Soil temperature 100–255 cm", "T"],
  ["soil_moisture_0_to_7cm", "Soil moisture 0–7 cm", "m³/m³"],
  ["soil_moisture_7_to_28cm", "Soil moisture 7–28 cm", "m³/m³"],
  ["soil_moisture_28_to_100cm", "Soil moisture 28–100 cm", "m³/m³"],
  ["soil_moisture_100_to_255cm", "Soil moisture 100–255 cm", "m³/m³"],
], { apis: ARCH });

add("w", "hourly", "Soil (forecast depths, 2016 onward)", [
  ["soil_temperature_0cm", "Soil temperature 0 cm (surface)", "T"],
  ["soil_temperature_6cm", "Soil temperature 6 cm", "T"],
  ["soil_temperature_18cm", "Soil temperature 18 cm", "T"],
  ["soil_temperature_54cm", "Soil temperature 54 cm", "T"],
  ["soil_moisture_0_to_1cm", "Soil moisture 0–1 cm", "m³/m³"],
  ["soil_moisture_1_to_3cm", "Soil moisture 1–3 cm", "m³/m³"],
  ["soil_moisture_3_to_9cm", "Soil moisture 3–9 cm", "m³/m³"],
  ["soil_moisture_9_to_27cm", "Soil moisture 9–27 cm", "m³/m³"],
  ["soil_moisture_27_to_81cm", "Soil moisture 27–81 cm", "m³/m³"],
], { apis: FCST });

// Upper-air variables on pressure levels - only the forecast models carry
// them, hence 2016 onward. Generated rather than listed: it is the same seven
// variables at each of nineteen levels.
const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30];
const LEVEL_VARS = [
  ["temperature", "Temperature", "T", STATE],
  ["relative_humidity", "Relative humidity", "%", STATE],
  ["dew_point", "Dew point", "T", STATE],
  ["cloud_cover", "Cloud cover", "%", STATE],
  ["wind_speed", "Wind speed", "W", STATE],
  ["wind_direction", "Wind direction", "°", DIR],
  ["geopotential_height", "Geopotential height", "m", STATE],
];
add("w", "hourly", "Pressure levels (upper air)",
  LEVELS.flatMap((lvl) => LEVEL_VARS.map(([k, label, unit, aggs]) =>
    [`${k}_${lvl}hPa`, `${label} at ${lvl} hPa`, unit, aggs])),
  { apis: FCST });

// ---------------------------------------------------------------- weather, daily
add("w", "daily", "Temperature", [
  ["temperature_2m_mean", "Temperature (2 m), daily mean", "T"],
  ["temperature_2m_max", "Temperature (2 m), daily maximum", "T"],
  ["temperature_2m_min", "Temperature (2 m), daily minimum", "T"],
  ["apparent_temperature_mean", "Feels-like temperature, daily mean", "T"],
  ["apparent_temperature_max", "Feels-like temperature, daily maximum", "T"],
  ["apparent_temperature_min", "Feels-like temperature, daily minimum", "T"],
], { apis: ALL });

add("w", "daily", "Precipitation", [
  ["precipitation_sum", "Precipitation, daily total", "P"],
  ["rain_sum", "Rain, daily total", "P"],
  ["showers_sum", "Showers, daily total", "P", null, { apis: FCST }],
  ["snowfall_sum", "Snowfall, daily total", "S"],
  ["precipitation_hours", "Hours with precipitation", "h"],
  ["precipitation_probability_max", "Precipitation probability, daily maximum", "%", null, { apis: FCST }],
  ["precipitation_probability_mean", "Precipitation probability, daily mean", "%", null, { apis: FCST }],
  ["weather_code", "Weather code (most severe, WMO)", ""],
], { apis: ALL });

add("w", "daily", "Wind", [
  ["wind_speed_10m_max", "Wind speed (10 m), daily maximum", "W"],
  ["wind_gusts_10m_max", "Wind gusts (10 m), daily maximum", "W"],
  ["wind_direction_10m_dominant", "Wind direction (10 m), dominant", "°"],
], { apis: ALL });

add("w", "daily", "Sun & radiation", [
  ["sunshine_duration", "Sunshine duration, daily total", "h", null, { scale: 1 / 3600 }],
  ["daylight_duration", "Daylight duration", "h", null, { scale: 1 / 3600 }],
  ["shortwave_radiation_sum", "Shortwave radiation, daily total", "MJ/m²"],
  ["uv_index_max", "UV index, daily maximum", "", null, { apis: FCST }],
  ["uv_index_clear_sky_max", "UV index (clear sky), daily maximum", "", null, { apis: FCST }],
], { apis: ALL });

add("w", "daily", "Evapotranspiration", [
  ["et0_fao_evapotranspiration", "Reference evapotranspiration (ET₀), daily total", "P"],
], { apis: ALL });

// ---------------------------------------------------------------- air quality (hourly only)
// CAMS data. The global domain reaches back to 2022 and the European one
// (which alone has pollen and ammonia) to 2013 - outside those, Open-Meteo
// returns nulls, which the chart reports as "no data" for that year.
add("a", "hourly", "Particulates & aerosols", [
  ["pm10", "PM10", "μg/m³"],
  ["pm2_5", "PM2.5", "μg/m³"],
  ["dust", "Dust", "μg/m³"],
  ["aerosol_optical_depth", "Aerosol optical depth", ""],
]);
add("a", "hourly", "Gases", [
  ["carbon_monoxide", "Carbon monoxide", "μg/m³"],
  ["carbon_dioxide", "Carbon dioxide", "ppm"],
  ["nitrogen_dioxide", "Nitrogen dioxide", "μg/m³"],
  ["sulphur_dioxide", "Sulphur dioxide", "μg/m³"],
  ["ozone", "Ozone", "μg/m³"],
  ["ammonia", "Ammonia (Europe)", "μg/m³"],
  ["methane", "Methane", "μg/m³"],
]);
add("a", "hourly", "Pollen (Europe)", [
  ["alder_pollen", "Alder pollen", "grains/m³", PEAK],
  ["birch_pollen", "Birch pollen", "grains/m³", PEAK],
  ["grass_pollen", "Grass pollen", "grains/m³", PEAK],
  ["mugwort_pollen", "Mugwort pollen", "grains/m³", PEAK],
  ["olive_pollen", "Olive pollen", "grains/m³", PEAK],
  ["ragweed_pollen", "Ragweed pollen", "grains/m³", PEAK],
]);
add("a", "hourly", "Indices", [
  ["european_aqi", "European AQI", "", PEAK],
  ["us_aqi", "US AQI", "", PEAK],
  ["uv_index", "UV index (CAMS)", "", PEAK],
  ["uv_index_clear_sky", "UV index, clear sky (CAMS)", "", PEAK],
]);

// ---------------------------------------------------------------- marine
// Only meaningful over the sea: a point inland comes back all-null.
add("m", "hourly", "Waves", [
  ["wave_height", "Wave height (significant)", "m"],
  ["wave_direction", "Wave direction", "°", DIR],
  ["wave_period", "Wave period", "s"],
  ["wave_peak_period", "Wave peak period", "s"],
  ["wind_wave_height", "Wind-wave height", "m"],
  ["wind_wave_direction", "Wind-wave direction", "°", DIR],
  ["wind_wave_period", "Wind-wave period", "s"],
  ["wind_wave_peak_period", "Wind-wave peak period", "s"],
  ["swell_wave_height", "Swell height", "m"],
  ["swell_wave_direction", "Swell direction", "°", DIR],
  ["swell_wave_period", "Swell period", "s"],
  ["swell_wave_peak_period", "Swell peak period", "s"],
  ["secondary_swell_wave_height", "Secondary swell height", "m"],
  ["secondary_swell_wave_direction", "Secondary swell direction", "°", DIR],
  ["secondary_swell_wave_period", "Secondary swell period", "s"],
]);
add("m", "hourly", "Ocean", [
  ["sea_surface_temperature", "Sea surface temperature", "°C"],
  ["sea_level_height_msl", "Sea level height (incl. tides)", "m"],
  ["ocean_current_velocity", "Ocean current velocity", "km/h"],
  ["ocean_current_direction", "Ocean current direction", "°", DIR],
]);
add("m", "daily", "Waves", [
  ["wave_height_max", "Wave height, daily maximum", "m"],
  ["wave_direction_dominant", "Wave direction, dominant", "°"],
  ["wave_period_max", "Wave period, daily maximum", "s"],
  ["wind_wave_height_max", "Wind-wave height, daily maximum", "m"],
  ["wind_wave_direction_dominant", "Wind-wave direction, dominant", "°"],
  ["wind_wave_period_max", "Wind-wave period, daily maximum", "s"],
  ["wind_wave_peak_period_max", "Wind-wave peak period, daily maximum", "s"],
  ["swell_wave_height_max", "Swell height, daily maximum", "m"],
  ["swell_wave_direction_dominant", "Swell direction, dominant", "°"],
  ["swell_wave_period_max", "Swell period, daily maximum", "s"],
  ["swell_wave_peak_period_max", "Swell peak period, daily maximum", "s"],
]);

// ---------------------------------------------------------------- flood (daily only)
// GloFAS river discharge for the nearest river cell (5 km grid). The
// statistical variants describe the forecast ensemble, so they only exist for
// forecast days.
add("f", "daily", "River discharge", [
  ["river_discharge", "River discharge", "m³/s"],
  ["river_discharge_mean", "River discharge (ensemble mean)", "m³/s"],
  ["river_discharge_median", "River discharge (ensemble median)", "m³/s"],
  ["river_discharge_max", "River discharge (ensemble maximum)", "m³/s"],
  ["river_discharge_min", "River discharge (ensemble minimum)", "m³/s"],
  ["river_discharge_p25", "River discharge (25th percentile)", "m³/s"],
  ["river_discharge_p75", "River discharge (75th percentile)", "m³/s"],
]);

// ---------------------------------------------------------------- climate (daily only)
// CMIP6 HighResMIP downscaled projections, 1950-2050, one model at a time (the
// model is a setting, see CLIMATE_MODELS). These are what the climate of a
// year like that looks like, not a record of any actual day - which is why a
// 2045 line can be charted at all.
add("c", "daily", "Projected climate", [
  ["temperature_2m_mean", "Temperature, daily mean (projection)", "T"],
  ["temperature_2m_max", "Temperature, daily maximum (projection)", "T"],
  ["temperature_2m_min", "Temperature, daily minimum (projection)", "T"],
  ["relative_humidity_2m_mean", "Relative humidity, daily mean (projection)", "%"],
  ["relative_humidity_2m_max", "Relative humidity, daily maximum (projection)", "%"],
  ["relative_humidity_2m_min", "Relative humidity, daily minimum (projection)", "%"],
  ["dew_point_2m_mean", "Dew point, daily mean (projection)", "T"],
  ["dew_point_2m_max", "Dew point, daily maximum (projection)", "T"],
  ["dew_point_2m_min", "Dew point, daily minimum (projection)", "T"],
  ["precipitation_sum", "Precipitation, daily total (projection)", "P"],
  ["rain_sum", "Rain, daily total (projection)", "P"],
  ["snowfall_sum", "Snowfall, daily total (projection)", "S"],
  ["wind_speed_10m_mean", "Wind speed, daily mean (projection)", "W"],
  ["wind_speed_10m_max", "Wind speed, daily maximum (projection)", "W"],
  ["cloud_cover_mean", "Cloud cover, daily mean (projection)", "%"],
  ["shortwave_radiation_sum", "Shortwave radiation, daily total (projection)", "MJ/m²"],
  ["pressure_msl_mean", "Sea-level pressure, daily mean (projection)", "hPa"],
  ["soil_moisture_0_to_10cm_mean", "Soil moisture 0–10 cm, daily mean (projection)", "m³/m³"],
  ["et0_fao_evapotranspiration_sum", "Reference evapotranspiration, daily total (projection)", "P"],
]);

export const CLIMATE_MODELS = [
  ["MRI_AGCM3_2_S", "MRI-AGCM3-2-S (Japan, 20 km)"],
  ["EC_Earth3P_HR", "EC-Earth3P-HR (Europe, 29 km)"],
  ["MPI_ESM1_2_XR", "MPI-ESM1-2-XR (Germany, 51 km)"],
  ["CMCC_CM2_VHR4", "CMCC-CM2-VHR4 (Italy, 30 km)"],
  ["FGOALS_f3_H", "FGOALS-f3-H (China, 28 km)"],
  ["HiRAM_SIT_HR", "HiRAM-SIT-HR (Taiwan, 25 km)"],
  ["NICAM16_8S", "NICAM16-8S (Japan, 31 km)"],
];

export const FIELDS = fields;
const BY_ID = new Map(fields.map((f) => [f.id, f]));
export function fieldById(id) { return BY_ID.get(id) || null; }

// The earliest and latest year a field can have data for. Used to build the
// year picker, which spans whatever the ticked fields can actually show.
export const COVERAGE = {
  archive: 1940, hf: 2016, air: 2013, marine: 1940, flood: 1984, climate: 1950, climateEnd: 2050,
};
export function firstYear(field) {
  if (field.source === "weather") return field.apis.includes("archive") ? COVERAGE.archive : COVERAGE.hf;
  return COVERAGE[field.source];
}
export function lastYear(field, currentYear) {
  return field.source === "climate" ? COVERAGE.climateEnd : currentYear;
}

// A reduced day's value is a total when summed, and only then is a yearly
// total a sensible figure to show next to the mean (see weather-view.js's
// summary table). Daily-native fields ending in _sum, or counted in hours, are
// totals too.
export function isTotal(field, agg) {
  if (field.res === "hourly") return agg === "sum";
  return /_sum$|_hours$|duration$/.test(field.key);
}

export function defaultAgg(field) {
  return field.res === "hourly" ? field.aggs[0] : null;
}

// Runtime record of fields Open-Meteo refused, per API endpoint. Kept in
// localStorage so a rejected field is not retried (and greyed out) on every
// visit; cleared when the catalog version changes.
const UNAVAILABLE_KEY = "wx_unavailable_v1";
let _unavailable = null;
function loadUnavailable() {
  if (_unavailable) return _unavailable;
  try { _unavailable = JSON.parse(globalThis.localStorage?.getItem(UNAVAILABLE_KEY) || "{}"); }
  catch { _unavailable = {}; }
  return _unavailable;
}
export function markUnavailable(endpoint, key) {
  const u = loadUnavailable();
  (u[endpoint] = u[endpoint] || []).includes(key) || u[endpoint].push(key);
  try { globalThis.localStorage?.setItem(UNAVAILABLE_KEY, JSON.stringify(u)); } catch { /* private mode */ }
}
export function isUnavailable(endpoint, key) {
  return (loadUnavailable()[endpoint] || []).includes(key);
}
