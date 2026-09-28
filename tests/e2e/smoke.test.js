// End-to-end smoke test: loads the real page in Chromium and drives it
// through placing two locations, comparing a field, and toggling difference
// mode - with every external host (Open-Meteo, Nominatim, OSM tiles) mocked,
// since this sandbox has no route to them. Run with `npm run test:e2e`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startServer } from "../../scripts/serve.js";
import { launchOptions } from "./browser.js";

// A gently wandering series rather than a flat or purely-linear one, so two
// locations' lines (and their difference, in diff mode) have actual shape -
// a perfectly flat line is visually correct but has a zero-height bounding
// box, which would make Playwright's default visibility wait never settle.
function dailyRange(startDate, endDate, tempStart = 10, phase = 0) {
  const time = [];
  const values = [];
  const d = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  let i = 0;
  while (d <= end) {
    time.push(d.toISOString().slice(0, 10));
    values.push(Math.round((tempStart + 6 * Math.sin(i / 5 + phase) + (i % 3)) * 10) / 10);
    i++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { time, values };
}

function hourlyFromDaily(startDate, endDate, tempStart, phase) {
  const { time: days, values } = dailyRange(startDate, endDate, tempStart, phase);
  const time = [];
  const out = [];
  days.forEach((day, i) => {
    for (let h = 0; h < 24; h++) {
      time.push(`${day}T${String(h).padStart(2, "0")}:00`);
      out.push(values[i]);
    }
  });
  return { time, values: out };
}

async function mockOpenMeteo(page) {
  // Archive/historical-forecast/forecast: answer with plausible data in
  // whichever shape (hourly or daily) the request actually asked for, for
  // whichever variable name it named - so the mock works for any field the
  // test drives the picker to, not just the app's default.
  await page.route(/(archive-api|historical-forecast-api|api)\.open-meteo\.com\/v1\/(archive|forecast)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("current")) {
      return route.fulfill({
        json: {
          current: { temperature_2m: 18.4, relative_humidity_2m: 55, weather_code: 1, is_day: 1, wind_speed_10m: 12, precipitation: 0 },
          current_units: { temperature_2m: "°C" },
        },
      });
    }
    const start = url.searchParams.get("start_date") || "2024-01-01";
    const end = url.searchParams.get("end_date") || start;
    const hourlyVars = (url.searchParams.get("hourly") || "").split(",").filter(Boolean);
    const dailyVars = (url.searchParams.get("daily") || "").split(",").filter(Boolean);
    // A different phase per location (not just a constant offset), so A-B in
    // diff mode has real shape rather than being a flat line.
    const lat = Number(url.searchParams.get("latitude") || 0);
    const phase = lat / 10;
    const body = {};
    if (hourlyVars.length) {
      const { time, values } = hourlyFromDaily(start, end, 10, phase);
      body.hourly = { time };
      hourlyVars.forEach((v) => { body.hourly[v] = values; });
    }
    if (dailyVars.length) {
      const { time, values } = dailyRange(start, end, 10, phase);
      body.daily = { time };
      dailyVars.forEach((v) => { body.daily[v] = values; });
    }
    return route.fulfill({ json: body });
  });
  await page.route(/geocoding-api\.open-meteo\.com/, (route) => route.fulfill({
    json: { results: [{ name: "Paris", admin1: "Ile-de-France", country: "France", latitude: 48.8566, longitude: 2.3522 }] },
  }));
  await page.route(/nominatim\.openstreetmap\.org/, (route) => route.fulfill({
    json: { address: { city: "Testville" }, display_name: "Testville" },
  }));
  await page.route(/tile\.openstreetmap\.org/, (route) => route.fulfill({
    status: 200, contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  }));
}

test("place two locations, compare a field, and see a difference chart", { timeout: 30000 }, async () => {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => { throw e; });
    await mockOpenMeteo(page);
    await page.goto(base);

    // Place A by tapping the map.
    await page.waitForSelector("#map.leaflet-container");
    const map = await page.$("#map");
    const box = await map.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('.loc-row .loc-name[data-id="A"]');

    // Chart should render an SVG for the default field (temperature) once
    // data loads. `attached` rather than the default `visible`: a genuinely
    // flat line is drawn correctly but has a zero-height bounding box, which
    // Playwright's visibility check would never consider "visible".
    await page.waitForSelector("#chart svg path", { state: "attached", timeout: 15000 });

    // Add B via search.
    await page.click("#addBBtn");
    await page.fill("#placeSearch", "Paris");
    await page.waitForSelector('#placeResults button[data-i="0"]');
    await page.click('#placeResults button[data-i="0"]');
    await page.waitForSelector('.loc-row .loc-name[data-id="B"]');

    // The first location stays searchable: switch the bar to A and search.
    await page.click('#searchTarget button[data-target="A"]');
    assert.match(await page.getAttribute("#placeSearch", "placeholder"), /for A/);
    await page.fill("#placeSearch", "Paris");
    await page.waitForSelector('#placeResults button[data-i="0"]');
    await page.click('#placeResults button[data-i="0"]');
    await page.waitForFunction(() => document.querySelector('.loc-name[data-id="A"]').value === "Paris");
    assert.equal(await page.inputValue('.loc-name[data-id="B"]'), "Paris");

    // Two locations -> the comparison mode toggle appears, and both a solid
    // and a dashed line should be present once data for B loads too.
    await page.waitForSelector("#modeWrap:not(.hidden)");
    await page.waitForFunction(() => {
      const paths = document.querySelectorAll("#chart svg path");
      return [...paths].some((p) => p.getAttribute("stroke-dasharray"));
    }, { timeout: 15000 });

    // Switch to difference mode; the zero reference line should appear.
    await page.click('#modeWrap button[data-mode="diff"]');
    await page.waitForFunction(() => {
      const lines = document.querySelectorAll("#chart svg line[stroke-dasharray]");
      return lines.length > 0;
    }, { timeout: 15000 });

    // The summary table should have populated with real numbers.
    const summaryText = await page.textContent("#summary");
    assert.match(summaryText, /\d/);

    // The URL hash should now carry both locations, so the comparison is shareable.
    const hash = await page.evaluate(() => location.hash);
    assert.match(hash, /a=/);
    assert.match(hash, /b=/);
    assert.match(hash, /m=diff/);

    // Reloading from that hash should restore the same comparison without re-placing pins.
    await page.reload();
    await page.waitForSelector('.loc-row .loc-name[data-id="B"]');
    await page.waitForSelector("#chart svg path", { state: "attached", timeout: 15000 });
  } finally {
    await browser.close();
    server.close();
  }
});

test("the field picker filters by search text and source", { timeout: 30000 }, async () => {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => { throw e; });
    await mockOpenMeteo(page);
    await page.goto(base);
    await page.waitForSelector("#map.leaflet-container");

    await page.click(".field-btn");
    await page.waitForSelector("#fieldDialog[open]");
    await page.fill("#fieldSearch", "soil moisture");
    await page.waitForFunction(() => document.querySelectorAll("#fieldList [data-id]").length > 0);
    const rows = await page.$$eval("#fieldList [data-id]", (els) => els.map((e) => e.dataset.id));
    assert.ok(rows.every((id) => id.includes("soil_moisture")));

    await page.click('#sourceChips [data-source="marine"]');
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll("#fieldList [data-id]");
      return rows.length === 0 || [...rows].every((r) => r.textContent.toLowerCase().includes(""));
    });
    const marineCount = await page.$$eval("#fieldList [data-id]", (els) => els.length);
    assert.equal(marineCount, 0); // "soil moisture" text filter still applied, and marine has none
  } finally {
    await browser.close();
    server.close();
  }
});

test("ask about the comparison: a chip question streams an answer from the cloud fallback", { timeout: 30000 }, async () => {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => { throw e; });
    await mockOpenMeteo(page);
    // Headless Chromium has no WebGPU, so "auto" falls to the cloud key.
    await page.addInitScript(() => {
      localStorage.setItem("wx_ai", JSON.stringify({ engine: "auto", provider: "gemini", apiKey: "test-key" }));
      Object.defineProperty(navigator, "gpu", { value: undefined });
    });
    const sent = [];
    let release;
    const held = new Promise((r) => { release = r; });
    let reply = ["A was ", "warmer."];
    await page.route(/generativelanguage\.googleapis\.com/, async (route) => {
      await held;   // hold the reply so the loading state can be seen
      sent.push({ headers: route.request().headers(), body: JSON.parse(route.request().postData()) });
      const chunk = (t) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`;
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: reply.map(chunk).join("") });
    });
    await page.goto(base);

    await page.waitForSelector("#map.leaflet-container");
    const box = await (await page.$("#map")).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector("#chart svg path", { state: "attached", timeout: 15000 });

    await page.waitForSelector("#askChips .ask-chip:not([disabled])");
    assert.match(await page.textContent("#askEngine"), /Cloud · Google Gemini/);
    // The quick read needs no model at all.
    assert.match(await page.textContent("#askQuick"), /Quick read.*Temperature.*mean/s);
    await page.click("#askChips .ask-chip");
    // Loading state: spinner naming the engine, input locked, Stop offered.
    await page.waitForSelector("#askAnswer .ask-waiting");
    const waiting = await page.textContent("#askAnswer");
    assert.match(waiting, /Thinking…/);
    assert.match(waiting, /Analysing temperature for .+ for \d{4}/);
    assert.match(waiting, /Using free AI model · Cloud · Google Gemini/);
    assert.equal(await page.getAttribute("#askAnswerWrap", "aria-busy"), "true");
    assert.ok(await page.isDisabled("#askInput"));
    assert.ok(await page.isVisible("#askStopBtn"));
    release();
    await page.waitForFunction(() => document.querySelector("#askAnswer")?.textContent === "A was warmer.", null, { timeout: 15000 });

    assert.equal(await page.getAttribute("#askAnswerWrap", "aria-busy"), "false");
    assert.ok(!(await page.isDisabled("#askInput")));
    assert.equal(sent[0].headers["x-goog-api-key"], "test-key");
    const prompt = sent[0].body.contents[0].parts[0].text;
    assert.match(prompt, /^Here is the weather comparison data:/);
    const json = JSON.parse(prompt.split("\n\n")[1]);
    assert.ok(json.context.locations.A && json.summary.length > 0);
    assert.match(prompt, /User question: What stands out/);
    assert.match(sent[0].body.systemInstruction.parts[0].text, /precise weather comparison assistant/);
    assert.equal(json.summary[0].A.min_date.length, 10);
    // The question is in the shareable URL; the key never is.
    const hash1 = await page.evaluate(() => location.hash);
    assert.match(hash1, /q=What%20stands%20out/);
    assert.ok(!hash1.includes("test-key"));
    assert.ok(await page.isVisible("#askCopyBtn"));

    // A follow-up chip sends the earlier answer along, and the answer's
    // Markdown is rendered; the previous answer folds into the history.
    reply = ["- **Because** A is hotter\n- and drier"];
    await page.click('#askFollowUps [data-q="Why?"]');
    await page.waitForFunction(() => document.querySelector("#askAnswer li strong")?.textContent === "Because", null, { timeout: 15000 });
    const turns = sent[1].body.contents.map((c) => `${c.role}: ${c.parts[0].text}`);
    assert.equal(turns.length, 3);
    assert.match(turns[1], /^model: A was warmer\.$/);
    assert.equal(turns[2], "user: User question: Why?");
    await page.waitForSelector("#askHistory details");
    assert.match(await page.textContent("#askHistory summary"), /What stands out/);

    // A retired model: the app asks Gemini for its list, picks a flash
    // model, retries with it, and remembers the pick.
    await page.unroute(/generativelanguage\.googleapis\.com/);
    const models = [];
    await page.route(/generativelanguage\.googleapis\.com/, (route) => {
      const url = route.request().url();
      if (/\/v1beta\/models(\?|$)/.test(url)) {
        return route.fulfill({ json: { models: [
          { name: "models/gemini-9.0-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-9.0-flash-image", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-embedding-3", supportedGenerationMethods: ["embedContent"] }] } });
      }
      models.push(/models\/([^:]+):/.exec(url)[1]);
      if (models.length === 1) return route.fulfill({ status: 404, json: { error: { message: "models/gemini-3.8-flash is not found for API version v1beta" } } });
      return route.fulfill({ status: 200, contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Picked." }] } }] })}\n\n` });
    });
    await page.click("#askChips .ask-chip");
    await page.waitForFunction(() => document.querySelector("#askAnswer")?.textContent === "Picked.", null, { timeout: 15000 });
    assert.deepEqual(models, ["gemini-3.8-flash", "gemini-9.0-flash"]);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("wx_ai_models")).gemini), "gemini-9.0-flash");

    // Service unreachable: the answer says so, and that the chart still works.
    await page.unroute(/generativelanguage\.googleapis\.com/);
    await page.route(/generativelanguage\.googleapis\.com/, (route) => route.abort("internetdisconnected"));
    await page.click("#askChips .ask-chip");
    await page.waitForSelector("#askAnswer.ask-unavailable");
    const down = await page.textContent("#askAnswer");
    assert.match(down, /Free AI is currently unavailable/);
    assert.match(down, /You can still view the chart and summary table/);
    assert.ok(!(await page.isDisabled("#askInput")));

    // A link with q= asks its question as soon as the chart is up.
    await page.unroute(/generativelanguage\.googleapis\.com/);
    await page.route(/generativelanguage\.googleapis\.com/, (route) => route.fulfill({ status: 200, contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "From the link." }] } }] })}\n\n` }));
    await page.goto(`${base}#a=48.85,2.35,Paris&f=wd.temperature_2m_mean&y=2024&q=Was%20it%20wet%3F`);
    await page.waitForFunction(() => document.querySelector("#askAnswer")?.textContent === "From the link.", null, { timeout: 15000 });
    assert.equal(await page.inputValue("#askInput"), "Was it wet?");
  } finally {
    await browser.close();
    server.close();
  }
});
