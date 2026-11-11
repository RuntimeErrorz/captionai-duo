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

test("connect deadlines follow the measured time to first byte, not the RPM", () => {
  const { context } = loadBackground();
  const timeout = vm.runInContext("aiConnectTimeoutMs", context);
  const record = vm.runInContext("recordAiFirstByte", context);
  const fast = { endpoint: "https://api.deepseek.com/chat/completions", model: "a", rateLimitRpm: 0 };
  const slow = { endpoint: `${GEMINI}/chat/completions`, model: "g", rateLimitRpm: 15 };

  // Until four first bytes are known, every provider gets the wide deadline.
  assert.equal(timeout(fast, true), 20000);
  assert.equal(timeout(slow, true), 20000);
  for (const firstByteMs of [700, 900, 1100]) record(fast, firstByteMs);
  assert.equal(timeout(fast, true), 20000, "three samples are not enough");
  record(fast, 1000);
  assert.equal(timeout(fast, true), 8000, "a fast provider tightens to the urgent floor");
  assert.equal(timeout(fast, false), 12000);

  for (const firstByteMs of [7723, 8545, 7550, 16000]) record(slow, firstByteMs);
  assert.equal(timeout(slow, true), 24000, "a slower provider widens its own deadline");
  record(fast, 25000);
  assert.equal(timeout(fast, true), 30000, "the adaptive deadline is capped");
});

test("one request policy for every RPM and provider", () => {
  const load = (settings) => {
    const context = { YTDS_SHARED: loadShared(), settings, getVideo: () => ({ playbackRate: 1 }) };
    vm.createContext(context);
    vm.runInContext(read("content/state-ui.js").split("\n").filter((line) =>
      /^const (AI_|SEMANTIC_)\w+ = [^;]*;/.test(line)).join("\n"), context);
    vm.runInContext(read("content/semantic-policy.js"), context);
    return (expr) => vm.runInContext(expr, context);
  };
  const lanes = ["aiInitialRequestItems()", "aiUrgentRequestItems()", "aiAcceleratedUrgentRequestItems()",
    "aiSteadyRequestItems()", "aiMaxRequestItems()", "aiMaxSpeculativeRequests()"];
  const limited = load({ aiBaseUrl: "https://gateway.example/v1", aiModel: "m", aiRateLimitRpm: 10, aiRequestItems: 256 });
  const unlimited = load({ aiBaseUrl: GEMINI, aiModel: "gemini-3.5-flash-lite-preview", aiRateLimitRpm: 0, aiRequestItems: 256 });
  for (const lane of lanes) assert.equal(limited(lane), unlimited(lane), lane);
  assert.equal(limited("aiUrgentRequestItems()"), 256, "every lane uses the request-items setting");
  assert.equal(load({})("aiSteadyRequestItems()"), loadShared().DEFAULTS.aiRequestItems);
  assert.equal(typeof loadShared().aiRequestLimited, "undefined");
});
