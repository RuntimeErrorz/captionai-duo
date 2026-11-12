"use strict";

// A reasoning model with thinking on can spend its whole output limit before
// writing anything (real DeepSeek replay: 0 characters, finish_reason
// "length", every request). Retrying sends the same request into the same
// limit, so the error is terminal and explains itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const shared = loadShared();

function sseResponse(lines) {
  const bytes = new TextEncoder().encode(lines.join("\n\n") + "\n\n");
  let sent = false;
  return {
    ok: true, status: 200,
    headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "text/event-stream" : null },
    body: { getReader: () => ({
      async read() { if (sent) return { done: true, value: new Uint8Array() }; sent = true; return { done: false, value: bytes }; },
      async cancel() {}, releaseLock() {}
    }) }
  };
}

function loadBackground(response) {
  const area = (seed) => ({
    data: seed,
    async get(keys) { return keys && typeof keys === "object" && !Array.isArray(keys) ? { ...keys, ...seed } : { ...seed }; },
    async set(values) { Object.assign(seed, values); }, async remove() {}
  });
  const context = {
    console, Date, Math, JSON, Map, Set, URL, AbortController, TextDecoder, TextEncoder, Uint8Array,
    setTimeout, clearTimeout, queueMicrotask, YTDS_SHARED: shared,
    fetch: async () => response,
    chrome: {
      runtime: { onMessage: { addListener: () => {} } },
      permissions: { contains: async () => true },
      storage: {
        sync: area({}), local: area({ aiApiKeys: { deepseek: "test-key-not-a-secret" } }),
        session: area({}), onChanged: { addListener: () => {} }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(read("background/state.js"), context, { filename: "background/state.js" });
  vm.runInContext(read("background/network.js"), context, { filename: "background/network.js" });
  vm.runInContext(read("background/http.js"), context, { filename: "background/http.js" });
  return context;
}

const CONFIG = {
  endpoint: "https://api.deepseek.com/chat/completions", baseUrl: "https://api.deepseek.com",
  endpointKind: "deepseek", model: "deepseek-v4-flash", extraBody: {}, rateLimitRpm: 0
};

test("an empty answer that hit the output limit is a terminal, explained error", async () => {
  const context = loadBackground(sseResponse([
    'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
    "data: [DONE]"
  ]));
  const aiRawCompletion = vm.runInContext("aiRawCompletion", context);
  await assert.rejects(aiRawCompletion(CONFIG, [], null, 256, 0), (error) => {
    assert.equal(error.errorCode, "AI_OUTPUT_EXHAUSTED", error.message);
    assert.match(error.message, /output limit/);
    return true;
  });
});

test("an empty answer for any other reason stays the retryable empty-response error", async () => {
  const context = loadBackground(sseResponse([
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]"
  ]));
  const aiRawCompletion = vm.runInContext("aiRawCompletion", context);
  await assert.rejects(aiRawCompletion(CONFIG, [], null, 256, 0), (error) => {
    assert.equal(error.errorCode, "AI_RESPONSE_EMPTY", error.message);
    return true;
  });
});

test("the content side stops retrying an exhausted output and shows the hint", () => {
  const painted = [];
  const timers = [];
  const context = {
    Map, Set, Date, YTDS_SHARED: shared, settings: {},
    AI_RATE_RETRY_LIMIT: 6, AI_COLD_RETRY_DELAYS_MS: [400, 1200, 2500],
    captionSession: {
      semanticRetryCounts: new Map(), semanticExhaustedRegions: new Map(), semanticGroupToCommitRegion: [0, 0, 0],
      activeGroupIdx: 1, activeCueIdx: 0, cueList: [{ text: "hello", start: 0, end: 1000 }],
      semanticRequestMeta: new Map(), transInflight: new Set(), semanticFocusGeneration: 0
    },
    setTimeout: (fn, ms) => timers.push(ms), emitDebug: () => {}, emitCaptionStateTransition: () => {},
    clearPendingTimer: () => {}, sourceForDisplayedCue: () => "hello",
    setTranslation: (text, _source, state) => painted.push({ text, state }),
    captureCaptionSession: () => ({}), t: (_key, fallback) => fallback
  };
  vm.createContext(context);
  vm.runInContext(read("content/semantic-requests.js"), context, { filename: "content/semantic-requests.js" });
  vm.runInContext(read("content/display.js").split("\n").filter((line) => !/^\s*(?:const|let) [a-z]\w* = document/.test(line)).join("\n"), context,
    { filename: "content/display.js" });
  const retry = vm.runInContext("scheduleAiBatchRetry", context);
  retry(1, 0, 2, "video", 1, "empty", { error: { errorCode: "AI_OUTPUT_EXHAUSTED", error: "The model used its whole output limit" } });
  assert.deepEqual(timers, [], "no retry is scheduled");
  assert.equal(context.captionSession.semanticExhaustedRegions.has(0), true);
  assert.equal(painted.length, 1);
  assert.equal(painted[0].state, "error");
  assert.match(painted[0].text, /AI_OUTPUT_EXHAUSTED/);
  assert.match(painted[0].text, /turn thinking off/);
});

test("an answer the provider's filter blocked entirely is terminal and named", async () => {
  for (const reason of ["content_filter", "RECITATION", "SAFETY"]) {
    const context = loadBackground(sseResponse([
      `data: {"choices":[{"delta":{},"finish_reason":"${reason}"}]}`,
      "data: [DONE]"
    ]));
    const aiRawCompletion = vm.runInContext("aiRawCompletion", context);
    await assert.rejects(aiRawCompletion(CONFIG, [], null, 256, 0), (error) => {
      assert.equal(error.errorCode, "AI_PROVIDER_FILTERED", reason);
      return true;
    });
  }
});
