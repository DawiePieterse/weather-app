// The model behind "Ask about this comparison". Free engines only:
//   - on-device: WebLLM running a small open model on the GPU (WebGPU). The
//     library comes from jsDelivr and the weights from Hugging Face on first
//     use; both are then kept in the browser's Cache Storage, so it works
//     offline from then on. Nothing leaves the device.
//   - cloud: a free tier the user brings their own key for - Gemini (Google
//     AI Studio), Groq - or any OpenAI-compatible endpoint, e.g. a Cloudflare
//     Workers AI proxy that keeps the key off the device. A static site has
//     nowhere to hide a shared key, so there is none.
//
// "auto" prefers on-device (once its model has been downloaded) and falls
// back to the cloud when the device can't run it or it fails and the user is
// online. Settings, including cloud keys, stay in this browser's
// localStorage and never go into the shareable URL.

// Pinned: service-worker.js caches this exact URL for offline use.
const WEBLLM_URL = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/lib/index.js";

// Base ids; "-q4f16_1-MLC" is used where the GPU supports 16-bit floats in
// shaders, "-q4f32_1-MLC" otherwise.
export const DEVICE_MODELS = [
  { id: "Qwen2.5-1.5B-Instruct", name: "Qwen 2.5 1.5B", size: "1 GB", label: "Qwen 2.5 1.5B (recommended, ~1 GB)" },
  { id: "Llama-3.2-1B-Instruct", name: "Llama 3.2 1B", size: "0.9 GB", label: "Llama 3.2 1B (smallest, ~0.9 GB)" },
  { id: "Qwen2.5-3B-Instruct", name: "Qwen 2.5 3B", size: "2 GB", label: "Qwen 2.5 3B (better, ~2 GB)" },
];

export const PROVIDERS = {
  gemini: { name: "Google Gemini", label: "Google Gemini (free tier)", model: "gemini-3.8-flash", keyUrl: "https://aistudio.google.com/apikey" },
  groq: { name: "Groq", label: "Groq (free tier)", model: "llama-3.3-70b-versatile", keyUrl: "https://console.groq.com/keys",
          endpoint: "https://api.groq.com/openai/v1/chat/completions" },
  custom: { name: "Custom endpoint", label: "OpenAI-compatible endpoint (e.g. Cloudflare Workers AI)", model: "@cf/meta/llama-3.1-8b-instruct" },
};

export function providerOf(s) {
  return PROVIDERS[s.provider] || PROVIDERS.custom;
}

export function deviceModelOf(s) {
  return DEVICE_MODELS.find((d) => d.id === s.deviceModel) || DEVICE_MODELS[0];
}

const SETTINGS_KEY = "wx_ai";
const READY_KEY = "wx_ai_device_ready";
const OFFER_KEY = "wx_ai_offer";

const DEFAULT_SETTINGS = {
  engine: "auto",               // auto | device | cloud | off
  deviceModel: DEVICE_MODELS[0].id,
  provider: "gemini",
  apiKey: "",
  endpoint: "",
  cloudModel: "",
};

export function loadAISettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveAISettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode: settings last this visit */ }
}

// Which on-device model (full id) has been downloaded, if any. Recorded by us
// on a successful load, so checking needs no 6 MB library download.
export function deviceModelReady() {
  try { return localStorage.getItem(READY_KEY) || null; } catch { return null; }
}
function setDeviceModelReady(id) {
  try { id ? localStorage.setItem(READY_KEY, id) : localStorage.removeItem(READY_KEY); } catch { /* ignore */ }
}

// The one-time "download the model?" offer on a capable device: shown until
// the user says "not now", or until the model is downloaded anyway.
export function offerDismissed() {
  try { return localStorage.getItem(OFFER_KEY) === "dismissed"; } catch { return false; }
}
export function dismissOffer() {
  try { localStorage.setItem(OFFER_KEY, "dismissed"); } catch { /* ignore */ }
}

// A metered or data-saver connection is no place to pull a 1 GB model
// unasked; the browser only says so where it knows.
export function dataSaver() {
  return !!globalThis.navigator?.connection?.saveData;
}

export function cloudConfigured(s) {
  if (s.provider === "custom") return !!s.endpoint;
  return !!s.apiKey;
}

// ---------------------------------------------------------------- on-device

let gpuCheck = null;
export function deviceSupport() {
  gpuCheck ||= (async () => {
    if (!globalThis.navigator?.gpu) return { ok: false, reason: "This browser has no WebGPU" };
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { ok: false, reason: "No suitable GPU found" };
      return { ok: true, f16: adapter.features.has("shader-f16") };
    } catch (err) {
      return { ok: false, reason: `WebGPU unavailable: ${err.message}` };
    }
  })();
  return gpuCheck;
}

export async function fullModelId(base) {
  const { f16 } = await deviceSupport();
  return `${base}-${f16 ? "q4f16_1" : "q4f32_1"}-MLC`;
}

let webllm = null;
let engine = null;
let engineModel = null;
let loading = null;

async function lib() {
  webllm ||= await import(/* @vite-ignore */ WEBLLM_URL);
  return webllm;
}

// Loads (downloading on first use) the chosen model. onProgress(0..1, text).
export async function loadDeviceModel(base, onProgress = () => {}) {
  const support = await deviceSupport();
  if (!support.ok) throw new Error(support.reason);
  const id = await fullModelId(base);
  if (engine && engineModel === id) return engine;
  if (loading?.id === id) return loading.promise;
  const promise = (async () => {
    onProgress(0, "Loading the AI library…");
    const { CreateMLCEngine } = await lib();
    if (engine) { await engine.unload().catch(() => {}); engine = null; engineModel = null; }
    const e = await CreateMLCEngine(id, { initProgressCallback: (r) => onProgress(r.progress ?? 0, r.text || "") });
    engine = e;
    engineModel = id;
    setDeviceModelReady(id);
    return e;
  })();
  loading = { id, promise };
  try {
    return await promise;
  } finally {
    loading = null;
  }
}

export async function removeDeviceModel() {
  const id = deviceModelReady();
  if (engine) { await engine.unload().catch(() => {}); engine = null; engineModel = null; }
  setDeviceModelReady(null);
  if (!id) return;
  const { deleteModelAllInfoInCache } = await lib();
  await deleteModelAllInfoInCache(id);
}

async function askDevice({ messages, settings, onToken, onProgress, signal }) {
  const e = await loadDeviceModel(settings.deviceModel, onProgress);
  const abort = () => e.interruptGenerate();
  signal?.addEventListener("abort", abort);
  try {
    const stream = await e.chat.completions.create({ messages, stream: true, temperature: 0.2, max_tokens: 400 });
    let text = "";
    for await (const chunk of stream) {
      const t = chunk.choices?.[0]?.delta?.content || "";
      if (t) { text += t; onToken(text); }
    }
    return text;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

// ---------------------------------------------------------------- cloud

// Server-sent events -> each data payload, parsed as JSON.
async function* sse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try { yield JSON.parse(data); } catch { /* keep-alive or partial */ }
    }
  }
}

async function failure(res, provider) {
  let detail = "";
  try {
    const j = await res.json();
    detail = j.error?.message || j.errors?.[0]?.message || j.message || "";
  } catch { /* not JSON */ }
  if (res.status === 429) return new Error(`${provider}: free-tier limit reached, try again shortly`);
  if (res.status === 401 || res.status === 403) return new Error(`${provider}: the API key was rejected${detail ? ` (${detail})` : ""}`);
  return new Error(`${provider}: ${detail || `HTTP ${res.status}`}`);
}

// Builds the request for the chosen provider. Exported for tests.
export function cloudRequest(messages, s) {
  if (s.provider === "gemini") {
    const model = s.cloudModel || PROVIDERS.gemini.model;
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": s.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
        }),
      },
      delta: (j) => j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "",
    };
  }
  const p = providerOf(s);
  const headers = { "Content-Type": "application/json" };
  if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
  return {
    url: s.provider === "custom" ? s.endpoint : p.endpoint,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ model: s.cloudModel || p.model, messages, stream: true, temperature: 0.2, max_tokens: 800 }),
    },
    delta: (j) => j.choices?.[0]?.delta?.content || "",
  };
}

// Providers retire model names ("gemini-2.5-flash is no longer available
// ... use models/gemini-3.8-flash"). When the refusal names a replacement,
// follow it: the default catches up on the next release, the user's answer
// arrives now. Exported for tests.
export function suggestedModel(message) {
  return /use (?:models\/)?([\w.-]+)/i.exec(message || "")?.[1] || null;
}

async function askCloud({ messages, settings, onToken, signal, retried = false }) {
  const { name } = providerOf(settings);
  const { url, init, delta } = cloudRequest(messages, settings);
  const res = await fetch(url, { ...init, signal });
  if (!res.ok) {
    const err = await failure(res, name);
    const next = !retried && /no longer available|not found|deprecated/i.test(err.message) && suggestedModel(err.message);
    if (next && next !== (settings.cloudModel || providerOf(settings).model)) {
      console.warn(`${name}: switching model to ${next} as the service suggested`);
      return askCloud({ messages, settings: { ...settings, cloudModel: next }, onToken, signal, retried: true });
    }
    throw err;
  }
  let text = "";
  for await (const j of sse(res)) {
    const t = delta(j);
    if (t) { text += t; onToken(text); }
  }
  return text;
}

// ---------------------------------------------------------------- choosing

// Whether the settings' on-device model is downloaded and this GPU can run
// it. The localStorage check comes first so no GPU is woken needlessly.
export async function deviceModelDownloaded(s) {
  const ready = deviceModelReady();
  return !!ready && (await deviceSupport()).ok && ready === await fullModelId(s.deviceModel);
}

// What the settings would use right now, without loading anything.
export async function plannedEngine(s, online = globalThis.navigator?.onLine !== false) {
  const cloud = cloudConfigured(s) && online;
  if (s.engine === "off") return null;
  if (s.engine === "cloud") return cloud ? "cloud" : null;
  if (await deviceModelDownloaded(s)) return "device";
  return s.engine === "auto" && cloud ? "cloud" : null;
}

// Answers `messages` with `engine` ("device" | "cloud"), streaming the text so
// far to onToken. With `fallback`, a failing on-device model hands over to
// the cloud when one is set up and reachable. Resolves {text, engine}.
export async function ask({ messages, settings, engine, fallback = false, onToken = () => {}, onProgress = () => {}, onFallback = () => {}, signal }) {
  if (engine === "cloud") {
    return { text: await askCloud({ messages, settings, onToken, signal }), engine: "cloud" };
  }
  try {
    return { text: await askDevice({ messages, settings, onToken, onProgress, signal }), engine: "device" };
  } catch (err) {
    const canFallBack = fallback && cloudConfigured(settings)
      && navigator.onLine !== false && !signal?.aborted;
    if (!canFallBack) throw err;
    onFallback(err);
    return { text: await askCloud({ messages, settings, onToken, signal }), engine: "cloud" };
  }
}
