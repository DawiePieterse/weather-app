// Calendar helpers. Dates are handled as plain "YYYY-MM-DD" strings in the
// location's own calendar (Open-Meteo is always asked for timezone=auto), and
// all arithmetic is done in UTC so a device's own timezone and DST never shift
// a date by one.

const DAY_MS = 86400000;

export function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fmtDate(dt) {
  return dt.toISOString().slice(0, 10);
}

export function addDays(s, n) {
  return fmtDate(new Date(parseDate(s).getTime() + n * DAY_MS));
}

export function minDate(a, b) { return a < b ? a : b; }
export function maxDate(a, b) { return a > b ? a : b; }

// "Today" as the device sees it - not toISOString(), which would give the UTC
// date and be a day out for part of every day away from Greenwich.
export function todayStr(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The chart's x value for a date: its day number within the leap year 2000,
// so 1 Mar is always x=61 whichever year it falls in and a leap year's 29 Feb
// has a slot of its own (x=60) that other years simply skip. Boord's tab used
// the plain day-of-year, which put every date from March onward one day out of
// line between leap and non-leap years.
export function refX(s) {
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return Math.round((Date.UTC(2000, m - 1, d) - Date.UTC(2000, 0, 1)) / DAY_MS) + 1;
}

export function xToMonthDay(x) {
  return new Date(Date.UTC(2000, 0, x));
}

export function xLabel(x) {
  return xToMonthDay(x).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function dateFromYearX(year, x) {
  const md = xToMonthDay(x);
  const pad = (n) => String(n).padStart(2, "0");
  return `${year}-${pad(md.getUTCMonth() + 1)}-${pad(md.getUTCDate())}`;
}

// 1990,1991,1992,2001 -> "1990–1992, 2001"
export function yearsText(years) {
  const runs = [];
  for (const y of [...years].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && y === last[1] + 1) last[1] = y; else runs.push([y, y]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
}
