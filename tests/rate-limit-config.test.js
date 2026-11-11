"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";

function storageArea(seed = {}) {
  const data = structuredClone(seed);
  return {
    data,
    async get(keys) {
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]));
      }
      if (keys && typeof keys === "object") return { ...keys, ...structuredClone(data) };
      return structuredClone(data);
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; }
  };
}

// state.js + http.js with real shared helpers; network is never reached.
function loadBackground(syncSeed = {}, localSeed = {}) {
  const sync = storageArea(syncSeed);
  const local = storageArea(localSeed);
  const context = {
    console, Date, Math, JSON, Map, Set, URL, AbortController, TextDecoder, Uint8Array,
    setTimeout, clearTimeout, queueMicrotask,
    YTDS_SHARED: loadShared(),
    fetch: async () => { throw new Error("network must not be reached"); },
    chrome: {
      runtime: { onMessage: { addListener: () => {} } },
      storage: {
        sync, local,
        session: storageArea(),
        onChanged: { addListener: () => {} }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(read("background/state.js"), context, { filename: "background/state.js" });
  vm.runInContext(read("background/http.js"), context, { filename: "background/http.js" });
  return { context, sync, local };
}

test("connect deadlines follow the measured time to first byte", () => {
  const { context } = loadBackground();
  const timeout = vm.runInContext("aiConnectTimeoutMs", context);
  const record = vm.runInContext("recordAiFirstByte", context);
  const fast = { endpoint: "https://api.deepseek.com/chat/completions", model: "a", rateLimitRpm: 0 };
  const slow = { endpoint: `${GEMINI}/chat/completions`, model: "g", rateLimitRpm: 15 };

  assert.equal(timeout(fast, true), 8000);
  assert.equal(timeout(fast, false), 12000);
  assert.equal(timeout(slow, true), 20000, "a request-limited profile starts with a wide deadline");

  for (const firstByteMs of [7723, 8545, 7550]) record(slow, firstByteMs);
  assert.equal(timeout(slow, true), 20000, "1.5 x 8.5 s stays inside the limited base");
  record(slow, 16000);
  assert.equal(timeout(slow, true), 24000, "a slower provider widens its own deadline");
  for (const firstByteMs of [9000, 9500]) record(fast, firstByteMs);
  assert.equal(timeout(fast, true), Math.ceil(9500 * 1.5),
    "an 8 s urgent deadline grows past a measured 9.5 s first byte");
  record(fast, 25000);
  assert.equal(timeout(fast, true), 30000, "the adaptive deadline is capped");
});

test("the RPM setting, not the provider, selects request-limited scheduling", () => {
  const load = (settings) => {
    const context = { YTDS_SHARED: loadShared(), settings, getVideo: () => ({ playbackRate: 1 }) };
    vm.createContext(context);
    vm.runInContext(read("content/state-ui.js").split("\n").filter((line) =>
      /^const (AI_|SEMANTIC_|DEEPSEEK_|COMPATIBLE_)\w+ = [^;]*;/.test(line)).join("\n"), context);
    vm.runInContext(read("content/semantic-policy.js"), context);
    return (expr) => vm.runInContext(expr, context);
  };
  const limitedCompatible = load({
    aiBaseUrl: "https://gateway.example/v1", aiModel: "m", aiRateLimitRpm: 10, aiRequestItems: 256
  });
  assert.equal(limitedCompatible("aiRequestLimited()"), true);
  assert.equal(limitedCompatible("aiMaxSpeculativeRequests()"), 1);
  assert.equal(limitedCompatible("aiUrgentRequestItems()"), 256);

  const unlimitedGemini = load({
    aiBaseUrl: GEMINI, aiModel: "gemini-3.5-flash-lite-preview", aiRateLimitRpm: 0, aiRequestItems: 128
  });
  assert.equal(unlimitedGemini("aiRequestLimited()"), false);
  assert.equal(unlimitedGemini("aiSteadyRequestItems()"), 128,
    "the request-items setting applies to every provider");
});
