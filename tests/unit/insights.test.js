import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_YEARS, PROSE_REMINDER, SYSTEM_PROMPT, buildMessages, buildSummary, checkAnswer, describeAsk, followUps,
         quickQuestions, quickSummary } from "../../site/js/insights.js";
import { PROVIDERS, cloudRequest, modelGone, pickModel, plannedEngine, suggestedModel } from "../../site/js/ai.js";
import { fieldById } from "../../site/js/fields.js";
import { refX } from "../../site/js/dates.js";

const units = { temperature: "celsius", wind: "kmh", precipitation: "mm" };
const today = { year: 2024, x: refX("2024-03-01") };

function specOf(id, agg) {
  return { field: fieldById(id), agg, key: `${id}|${agg || "-"}` };
}
const pts = (entries) => entries.map(([d, v]) => [refX(d), v]);

const temp = specOf("wd.temperature_2m_mean");
const rain = specOf("wd.precipitation_sum");
const locs = [{ id: "A", name: "Alpha", lat: 1, lon: 2 }, { id: "B", name: "Beta", lat: 3, lon: 4 }];
const data = {
  A: new Map([
    [temp.key, new Map([[2023, pts([["2023-01-10", 10], ["2023-07-01", 30]])],
                        [2024, pts([["2024-01-10", 12], ["2024-03-05", 20]])]])],
    [rain.key, new Map([[2023, pts([["2023-01-10", 5], ["2023-01-11", 7]])]])],
  ]),
  B: new Map([
    [temp.key, new Map([[2023, pts([["2023-01-10", 8], ["2023-07-01", 25], ["2023-08-01", 40]])]])],
    [rain.key, new Map([[2023, pts([["2023-01-10", 1]])]])],
  ]),
};

test("buildSummary: context, summaryRows-based rows with like-for-like A − B, per the spec's shape", () => {
  const j = buildSummary({ specs: [temp, rain], years: [2023], locs, data, mode: "overlay", today, units });
  assert.deepEqual(j.context.locations, { A: { name: "Alpha", lat: 1, lon: 2 }, B: { name: "Beta", lat: 3, lon: 4 } });
  assert.equal(j.context.mode, "overlay");
  assert.deepEqual(j.context.years, [2023]);
  assert.deepEqual(j.context.fields[1], { id: "wd.precipitation_sum", label: rain.field.label, unit: "mm", aggregation: null });
  assert.equal(j.context.today, "2024-03-01");
  assert.match(j.context.note, /^Only observed days are included\. Forecast days are excluded from statistics\./);
  // B's 1 Aug has no A counterpart, so only the two shared days count.
  assert.deepEqual(j.summary[0], { field: temp.field.label, unit: "°C", year: 2023, days: 2,
    A: { mean: 20, min: 10, max: 30, min_date: "2023-01-10", max_date: "2023-07-01" },
    B: { mean: 16.5, min: 8, max: 25, min_date: "2023-01-10", max_date: "2023-07-01" },
    diff: { mean: 3.5, max: { value: 5, date: "2023-07-01" }, min: { value: 2, date: "2023-01-10" } } });
  assert.deepEqual(j.summary[1], { field: rain.field.label, unit: "mm", year: 2023, days: 1,
    A: { mean: 5, min: 5, max: 5, total: 5, min_date: "2023-01-10", max_date: "2023-01-10" },
    B: { mean: 1, min: 1, max: 1, total: 1, min_date: "2023-01-10", max_date: "2023-01-10" },
    diff: { mean: 4, total: 4, max: { value: 4, date: "2023-01-10" }, min: { value: 4, date: "2023-01-10" } } });
  assert.equal(j.summary[0].A.monthly, undefined);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(j)));
});

test("buildSummary: highlights skip the year in progress; forecast days stay out", () => {
  const d = {
    A: new Map([[temp.key, new Map([
      [2022, pts([["2022-06-01", 15]])], [2023, pts([["2023-06-01", 18]])],
      [2024, pts([["2024-01-01", 30], ["2024-03-10", 99]])]])]]),
    B: new Map([[temp.key, new Map([
      [2022, pts([["2022-06-01", 10]])], [2023, pts([["2023-06-01", 17]])],
      [2024, pts([["2024-01-01", 29]])]])]]),
  };
  const j = buildSummary({ specs: [temp], years: [2022, 2023, 2024], locs, data: d, mode: "diff", today, units });
  assert.equal(j.highlights.warmest_year_A, 2023);  // 2024 is partial
  assert.equal(j.highlights.warmest_year_B, 2023);
  assert.deepEqual(j.highlights.largest_temp_diff, { year: 2022, value: 5, unit: "°C" });
  const y2024 = j.summary.find((r) => r.year === 2024);
  assert.equal(y2024.partial, true);
  assert.equal(y2024.A.max, 30);                     // 10 Mar is a forecast day
  assert.equal(j.context.mode, "diff");
});

test("buildSummary: one location has no B or diff; years are capped to the most recent", () => {
  const years = [2018, 2019, 2020, 2021, 2022, 2023];
  const j = buildSummary({ specs: [temp], years, locs: [locs[0]], data, mode: "diff", today, units, maxYears: 2 });
  assert.equal(j.context.mode, "overlay");
  assert.deepEqual(j.context.years, years);
  assert.match(j.context.note, /covers only 2022–2023/);
  assert.ok(j.summary.every((r) => r.year >= 2022 && !("B" in r) && !("diff" in r)));
  assert.ok(MAX_YEARS.device < MAX_YEARS.cloud);
});

test("buildSummary: monthly figures on request - means, or totals for amounts, null for empty months", () => {
  const j = buildSummary({ specs: [temp, rain], years: [2023], locs: [locs[0]], data, mode: "overlay", today, units, monthly: true });
  const t = j.summary[0].A.monthly;
  assert.equal(t.length, 12);
  assert.equal(t[0], 10); assert.equal(t[6], 30); assert.equal(t[1], null);
  assert.equal(j.summary[1].A.monthly[0], 12);   // 5 + 7 mm in January
  assert.match(j.context.note, /monthly is Jan\.\.Dec/);
});

test("quickSummary: sentences from the summary alone", () => {
  const two = quickSummary(buildSummary({ specs: [temp, rain], years: [2023], locs, data, mode: "overlay", today, units }));
  assert.deepEqual(two, [
    "Alpha had higher temperature than Beta in 2023, by 3.5 °C on average.",
    "Alpha had more precipitation than Beta in 2023, by 4 mm in total.",
  ]);
  const d = {
    A: new Map([[temp.key, new Map([[2022, pts([["2022-06-01", 15]])], [2023, pts([["2023-06-01", 18]])], [2024, pts([["2024-01-01", 30]])]])]]),
  };
  const one = quickSummary(buildSummary({ specs: [temp], years: [2022, 2023, 2024], locs: [locs[0]], data: d, mode: "overlay", today, units }));
  assert.deepEqual(one, [
    "2023 had the highest temperature (mean 18 °C) and 2022 the lowest (15 °C).",
    "2024 is still in progress, so its figures cover the year so far.",
  ]);
});

test("buildMessages: earlier turns ride along for a follow-up, the data only once", () => {
  const m = buildMessages({ a: 1 }, "Why?", [{ q: "Which was warmer?", a: "A, by 2 °C." }]);
  assert.deepEqual(m.map((x) => x.role), ["system", "user", "assistant", "user"]);
  assert.match(m[1].content, /{"a":1}[\s\S]*User question: Which was warmer\?/);
  assert.equal(m[2].content, "A, by 2 °C.");
  assert.equal(m[3].content, "User question: Why?");
});

test("followUps and checkAnswer", () => {
  assert.deepEqual(followUps({ question: "Which was warmer?", years: [2023, 2024] }),
    ["Why?", "Say that in fewer words", "Break that down year by year", "Show the numbers behind that"]);
  assert.deepEqual(followUps({ question: "Is there a trend?", years: [2023, 2024] }),
    ["Why?", "Say that in fewer words", "Show the numbers behind that"]);
  const summary = { context: { years: [2023, 2024] } };
  assert.deepEqual(checkAnswer("In 2024 A was warmer.", summary), { retry: false, note: null });
  assert.deepEqual(checkAnswer('{"mean": 17.8}', summary), { retry: true, note: null });
  assert.equal(checkAnswer("Unlike 2019 and 2021, 2024 was warm.", summary).note,
    "Mentions 2019, 2021, which aren't on the chart - check this against the table.");
  assert.ok(PROSE_REMINDER.length);
});

test("buildMessages: the spec's system prompt and user template, JSON inlined compactly", () => {
  const m = buildMessages({ a: 1 }, "  Why $& ?  ");
  assert.equal(m[0].content, SYSTEM_PROMPT);
  assert.match(SYSTEM_PROMPT, /^You are a precise weather comparison assistant\./);
  assert.equal(m[1].content, 'Here is the weather comparison data:\n\n{"a":1}\n\nUser question: Why $& ?\n\nPlease answer the question based only on the data above.');
});

test("quickQuestions: fit what is on the chart", () => {
  const one = quickQuestions({ specs: [temp], years: [2023], locs: [locs[0]], today });
  assert.ok(!one.some((q) => /Which place|Summarise/.test(q)));
  assert.ok(!one.some((q) => /trend|unusual/.test(q)));
  const two = quickQuestions({ specs: [temp, rain], years: [2022, 2023], locs, today });
  assert.deepEqual(two.slice(0, 4), ["Which place was warmer?", "Which place was wetter?", "Summarise the differences", "Was 2023 unusual?"]);
  assert.ok(two.length <= 6);
  const thisYear = quickQuestions({ specs: [temp], years: [2023, 2024], locs, today });
  assert.ok(!thisYear.includes("Which place was wetter?"));
  assert.ok(thisYear.includes("Is 2024 unusual so far?"));
});

test("cloudRequest: Gemini gets a system instruction and key header; OpenAI-style providers get bearer auth", () => {
  const messages = buildMessages({}, "Q");
  const g = cloudRequest(messages, { provider: "gemini", apiKey: "k1", cloudModel: "" });
  assert.match(g.url, /gemini-3\.8-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(g.init.headers["x-goog-api-key"], "k1");
  const gb = JSON.parse(g.init.body);
  assert.equal(gb.systemInstruction.parts[0].text, SYSTEM_PROMPT);
  assert.deepEqual(gb.contents.map((c) => c.role), ["user"]);
  assert.equal(g.delta({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }), "hi");

  const q = cloudRequest(messages, { provider: "groq", apiKey: "k2", cloudModel: "" });
  assert.equal(q.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(q.init.headers.Authorization, "Bearer k2");
  assert.equal(JSON.parse(q.init.body).stream, true);
  assert.equal(q.delta({ choices: [{ delta: { content: "yo" } }] }), "yo");

  const c = cloudRequest(messages, { provider: "custom", endpoint: "https://w.example/v1", apiKey: "", cloudModel: "m" });
  assert.equal(c.url, "https://w.example/v1");
  assert.equal(c.init.headers.Authorization, undefined);
  assert.equal(JSON.parse(c.init.body).model, "m");
});

test("suggestedModel: the replacement a provider names in a refusal", () => {
  assert.equal(suggestedModel("This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features."), "gemini-3.8-flash");
  assert.equal(suggestedModel("Use llama-3.3-70b-versatile instead"), "llama-3.3-70b-versatile");
  assert.equal(suggestedModel("free-tier limit reached"), null);
  assert.ok(modelGone("The model `llama-3.3-70b-versatile` does not exist or you do not have access to it."));
  assert.ok(!modelGone("free-tier limit reached"));
});

test("pickModel: a provider's list, by preference, newest name first, skipping the odd ones", () => {
  const groq = ["whisper-large-v3", "llama-guard-4-12b", "llama-3.1-8b-instant", "meta-llama/llama-4-maverick-17b", "openai/gpt-oss-120b", "llama-4-scout-70b"];
  assert.equal(pickModel(groq, PROVIDERS.groq), "llama-4-scout-70b");
  assert.equal(pickModel(groq.filter((m) => !m.includes("70b")), PROVIDERS.groq), "meta-llama/llama-4-maverick-17b");
  assert.equal(pickModel(["whisper-large-v3"], PROVIDERS.groq), null);
  const gemini = ["gemini-3.5-flash-image", "gemini-3.8-flash-lite", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-4.0-pro", "gemini-embedding-2"];
  assert.equal(pickModel(gemini, PROVIDERS.gemini), "gemini-3.8-flash");
  assert.equal(pickModel(["gemini-4.1-flash-lite", "gemini-4.0-pro"], PROVIDERS.gemini), "gemini-4.1-flash-lite");
});

test("plannedEngine: with no WebGPU (as in Node), auto uses the cloud only when a key is set", async () => {
  const base = { engine: "auto", deviceModel: "Qwen2.5-1.5B-Instruct", provider: "gemini", apiKey: "", endpoint: "", cloudModel: "" };
  assert.equal(await plannedEngine(base, true), null);
  assert.equal(await plannedEngine({ ...base, apiKey: "k" }, true), "cloud");
  assert.equal(await plannedEngine({ ...base, apiKey: "k" }, false), null);
  assert.equal(await plannedEngine({ ...base, engine: "device" }, true), null);
  assert.equal(await plannedEngine({ ...base, engine: "off", apiKey: "k" }, true), null);
});

test("describeAsk: the loading line names measurements, places and years", () => {
  assert.equal(describeAsk({ specs: [temp, rain], years: [2024], locs: [{ name: "Cape Town" }, { name: "Johannesburg" }] }),
    "Analysing temperature and precipitation differences between Cape Town and Johannesburg for 2024");
  assert.equal(describeAsk({ specs: [temp], years: [2020, 2021, 2022], locs: [{ name: "X" }] }), "Analysing temperature for X for 2020–2022");
  assert.equal(describeAsk({ specs: [temp], years: [2024, 2001, 2002], locs: [{ name: "X" }] }), "Analysing temperature for X for 2001–2002, 2024");
});
