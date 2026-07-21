"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const root = path.resolve(__dirname, "..");
const httpSource = fs.readFileSync(path.join(root, "background/http.js"), "utf8");
const semanticSource = fs.readFileSync(path.join(root, "content/semantic.js"), "utf8");
const playbackSource = fs.readFileSync(path.join(root, "content/cue-playback.js"), "utf8");
const fallbackSource = fs.readFileSync(path.join(root, "content/fallback.js"), "utf8");
const networkSource = fs.readFileSync(path.join(root, "background/network.js"), "utf8");
const translationSource = fs.readFileSync(path.join(root, "background/translation.js"), "utf8");

function abortableNeverFetch(_url, options) {
  return new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
}

function loadHttp(fetchImpl) {
  const context = {
    AbortController,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    YTDS_SHARED: loadShared(),
    DEEPSEEK_STREAM_COMPLETION_GRACE_MS: 750
  };
  vm.createContext(context);
  vm.runInContext(httpSource, context, { filename: "background/http.js" });
  return vm.runInContext("fetchAiStreamWithTimeout", context);
}

function giantSemanticResponse(withAlignedChunks) {
  const unitId = "semantic-0-159";
  const translations = Array.from({ length: 160 }, (_value, id) => ({
    id: String(id), unitId, translation: "整段译文"
  }));
  if (withAlignedChunks) {
    translations[0].alignedChunks = Array.from({ length: 4 }, (_value, chunkIndex) => {
      const start = chunkIndex * 40;
      return {
        ids: Array.from({ length: 40 }, (_item, offset) => String(start + offset)),
        translation: `分段${chunkIndex + 1}`
      };
    });
  }
  return translations;
}

function loadSemanticCommitHarness(translations, retryAttempt) {
  const debug = [];
  const timers = [];
  const messages = [];
  const painted = [];
  const retryKey = "video:1:0:159";
  const groups = Array.from({ length: 501 }, (_value, id) => ({
    startIdx: 0,
    endIdx: 0,
    text: `w${id}`,
    start: id * 10,
    end: id * 10 + 10,
    pauseAfterMs: 0,
    softAfter: false,
    hardAfter: id === 500
  }));
  const state = {
    cursor: 0,
    commitFloor: 0,
    limitEnd: 500,
    targetThrough: 100,
    urgentTarget: 100,
    windowItems: 160
  };
  const sessionToken = Object.freeze({ revision: 1 });
  let activeSessionToken = sessionToken;
  const context = {
    Map,
    Set,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    queueMicrotask,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout: () => {},
    YTDS_SHARED: loadShared(),
    captionSession: {
      cueVideoId: "video",
      currentVideoId: "video",
      cueEpoch: 1,
      cueSourceLang: "en",
      cueList: [{ text: "source", start: 0, end: 1000 }],
      sentGroups: groups,
      deepseekCommitRegions: [{ start: 0, end: 500 }],
      deepseekGroupToCommitRegion: new Array(501).fill(0),
      deepseekCommitStateByRegion: new Map([[0, state]]),
      deepseekGroupToBatch: new Array(501).fill(0),
      deepseekBatchWindows: [{ start: 0, end: 100 }],
      deepseekRequestMeta: new Map(),
      transInflight: new Set(),
      deepseekRetryCounts: new Map([[retryKey, retryAttempt]]),
      deepseekExhaustedRegions: new Map(),
      transCache: new Map(),
      deepseekUnitCache: new Map(),
      deepseekSourceCache: new Map(),
      deepseekAlignedChunksCache: new Map(),
      deepseekDisplayCache: new Map(),
      deepseekRequestSerial: 0,
      deepseekFocusGeneration: 0,
      deepseekFocusedBatchIndex: -1,
      deepseekSeekSettling: false,
      semanticLayoutWidth: 0,
      pendingTimer: null,
      pendingIndicatorKey: "",
      activeGroupIdx: 10,
      activeCueIdx: 0
    },
    settings: { targetLang: "zh-CN", debugEnabled: true },
    DEEPSEEK_INITIAL_REQUEST_ITEMS: 48,
    DEEPSEEK_REQUEST_ITEMS: 80,
    DEEPSEEK_URGENT_REQUEST_ITEMS: 96,
    DEEPSEEK_MAX_REQUEST_ITEMS: 160,
    DEEPSEEK_MAX_CURRENT_CHARS: 18000,
    DEEPSEEK_COMMIT_GUARD_ITEMS: 16,
    DEEPSEEK_URGENT_TARGET_TAIL_ITEMS: 48,
    DEEPSEEK_SEEK_BACKTRACK_ITEMS: 64,
    DEEPSEEK_SEEK_LEFT_GUARD_ITEMS: 16,
    DEEPSEEK_CONTEXT_GROUPS: 20,
    DEEPSEEK_COLD_RETRY_DELAYS_MS: Object.freeze([400, 1200, 2500]),
    DEEPSEEK_RATE_RETRY_LIMIT: 6,
    emitDebug: (event, data) => debug.push({ event, data }),
    mergeCueTexts: (items) => items.map((item) => item.text).join(" "),
    cacheDeepseekDisplayNeighborhood: () => {},
    semanticDisplayWidth: () => 1000,
    repaintActiveDeepseekTranslation: () => {},
    clearPendingTimer: () => {},
    sourceForDisplayedCue: () => "source",
    setTranslation: (text) => painted.push(text),
    t: (_key, fallback) => fallback,
    getVideo: () => ({ currentTime: 509 }),
    sendRuntimeMessage: (message, callback) => {
      messages.push(message);
      callback({ ok: true, translations, deferredIds: [], httpDiagnostics: { attempts: [] } });
    },
    captureCaptionSession: () => sessionToken,
    isCaptionSessionCurrent: (token) => token === activeSessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  return {
    context, state, debug, timers, messages, painted, retryKey,
    invalidateSession: () => { activeSessionToken = Object.freeze({ revision: 2 }); }
  };
}

test("connect deadline aborts a request before the full body deadline", async () => {
  const fetchWithTimeout = loadHttp(abortableNeverFetch);
  await assert.rejects(
    fetchWithTimeout("https://api.deepseek.com/v1/chat/completions", {}, 500, 60),
    (error) => error.name === "AbortError" && error.phase === "connect" &&
      error.connectTimedOut === true && error.timedOut === false
  );
});

test("connect deadline is cleared as soon as response headers arrive", async () => {
  const response = {
    ok: false,
    headers: { get: () => "application/json" },
    text: () => new Promise((resolve) => setTimeout(() => resolve("slow body"), 100))
  };
  const fetchWithTimeout = loadHttp(async () => response);
  const result = await fetchWithTimeout(
    "https://api.deepseek.com/v1/chat/completions", {}, 300, 50
  );
  assert.equal(result.response, response);
  assert.equal(result.text, "slow body");
  assert.ok(result.totalMs >= 90);
});

test("an external cancellation is not mislabeled as a connect timeout", async () => {
  const fetchWithTimeout = loadHttp(abortableNeverFetch);
  const external = new AbortController();
  setTimeout(() => external.abort(), 30);
  await assert.rejects(
    fetchWithTimeout(
      "https://api.deepseek.com/v1/chat/completions", {}, 500, 200, external.signal
    ),
    (error) => error.name === "AbortError" && error.phase === "connect" &&
      error.connectTimedOut === false && error.timedOut === false
  );
});

test("Gemini usage metadata is retained from a usage-only SSE event", async () => {
  const bytes = new TextEncoder().encode([
    'data: {"choices":[{"delta":{"content":"hello"}}]}',
    "",
    'data: {"choices":[],"usageMetadata":{"promptTokenCount":31,"candidatesTokenCount":7,"totalTokenCount":38}}',
    "",
    "data: [DONE]",
    ""
  ].join("\n"));
  let delivered = false;
  const response = {
    ok: true,
    headers: { get: () => "text/event-stream" },
    body: { getReader: () => ({
      async read() {
        if (delivered) return { done: true, value: new Uint8Array() };
        delivered = true;
        return { done: false, value: bytes };
      },
      async cancel() {}
    }) }
  };
  const result = await loadHttp(async () => response)(
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    {}, 500, 200
  );
  assert.equal(result.text, "hello");
  assert.equal(result.usage.promptTokenCount, 31);
  assert.equal(result.usage.totalTokenCount, 38);
});

test("promoting a live prefetch reuses it instead of cancelling it", () => {
  const messages = [];
  const context = {
    Map,
    Set,
    Date,
    captionSession: {
      deepseekRequestMeta: new Map(),
      transInflight: new Set(),
      deepseekFocusGeneration: 4,
      deepseekRequestSerial: 10,
      cueVideoId: "video"
    },
    sendRuntimeMessage: (message) => messages.push(message),
    emitDebug: () => {}
  };
  const existing = { requestId: "commit:4:10:1-80", urgent: false };
  context.captionSession.deepseekRequestMeta.set("dsb:1", existing);
  context.captionSession.transInflight.add("dsb:1");
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const begin = vm.runInContext("beginDeepseekRequest", context);
  assert.equal(begin("dsb:1", "commit", 1, 80, true), "");
  assert.equal(existing.urgent, true);
  assert.equal(messages.length, 0);
  assert.equal(context.captionSession.transInflight.has("dsb:1"), true);
});

test("nearby playback overrun defers reseeding until the live prefix commits", () => {
  const request = {
    requestId: "commit:4:10:5793-5872",
    requestEnd: 5872,
    reqEpoch: 2,
    focusGeneration: 4
  };
  const sessionToken = Object.freeze({ revision: 1 });
  request.sessionToken = sessionToken;
  const context = {
    Map,
    Set,
    captionSession: {
      deepseekRequestMeta: new Map([["dsb:1", request]]),
      cueEpoch: 2,
      deepseekFocusGeneration: 4
    },
    DEEPSEEK_URGENT_TARGET_TAIL_ITEMS: 48,
    isCaptionSessionCurrent: (token) => token === sessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const canContinue = vm.runInContext("canContinueDeepseekInflight", context);
  assert.equal(canContinue(1, { cursor: 5793 }, 5873), true);
  assert.equal(canContinue(1, { cursor: 5793 }, 5921), false);
  request.focusGeneration = 3;
  assert.equal(canContinue(1, { cursor: 5793 }, 5873), false);
});

test("a maximum-window mega-unit commits through its model-aligned chunks", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(true), 2);
  const pump = vm.runInContext("pumpDeepseekCommitRegion", harness.context);
  pump(0, true);

  assert.equal(harness.state.cursor, 120);
  assert.equal(harness.context.captionSession.transCache.get("video g10"), "分段1");
  assert.equal(harness.context.captionSession.deepseekRetryCounts.has(harness.retryKey), false);
  assert.equal(harness.debug.some((entry) =>
    entry.event === "semantic-aligned-chunk-recovery" && entry.data.nextCursor === 120
  ), true);
  assert.equal(harness.debug.some((entry) => entry.event === "batch-retry"), false);
});

test("an unrecoverable no-progress response keeps a bounded budget and bypasses cache", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 2);
  const pump = vm.runInContext("pumpDeepseekCommitRegion", harness.context);
  pump(0, true);

  const retry = harness.debug.find((entry) => entry.event === "batch-retry");
  assert.equal(retry.data.attempt, 3);
  assert.equal(harness.context.captionSession.deepseekRetryCounts.get(harness.retryKey), 3);
  assert.equal(harness.timers.length, 1);

  const retried = [];
  harness.context.deepseekRequestBatch = (...args) => retried.push(args);
  harness.timers[0].callback();
  assert.equal(retried[0][3].bypassCache, true);

  const schedule = vm.runInContext("scheduleDeepSeekBatchRetry", harness.context);
  schedule(0, 0, 159, "video", 1, "no immutable semantic prefix", {
    urgent: true, bypassCache: true
  });
  assert.equal(harness.debug.at(-1).event, "batch-retry-exhausted");
  assert.equal(harness.context.captionSession.deepseekExhaustedRegions.has(0), true);
  assert.equal(harness.painted.at(-1), "Translation temporarily unavailable");
});

test("an invalidated semantic retry timer cannot resurrect its request", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0);
  const pump = vm.runInContext("pumpDeepseekCommitRegion", harness.context);
  pump(0, true);
  assert.equal(harness.timers.length, 1);

  const retried = [];
  harness.context.deepseekRequestBatch = (...args) => retried.push(args);
  harness.invalidateSession();
  harness.timers[0].callback();

  assert.deepEqual(retried, []);
  assert.equal(
    harness.context.captionSession.deepseekRetryCounts.has(harness.retryKey),
    false
  );
});

test("a no-progress retry bypasses a cached semantic response and replaces it", async () => {
  let cacheReads = 0;
  let cacheWrites = 0;
  let freshRequests = 0;
  const cached = [{ id: "0", unitId: "cached", translation: "旧响应" }];
  const fresh = [{ id: "0", unitId: "fresh", translation: "新响应" }];
  const context = {
    Map,
    Set,
    Date,
    Object,
    Promise,
    YTDS_SHARED: loadShared(),
    AI_PROMPT_CACHE_VERSION: "test",
    DEEPSEEK_BATCH_INFLIGHT: new Map(),
    getAiConfig: async () => ({ model: "model", endpointKind: "compatible", extraBody: {} }),
    aiResponseCacheId: () => "cache-id",
    readAiResponseCache: async () => { cacheReads++; return cached; },
    writeAiResponseCache: async () => { cacheWrites++; },
    appendDebug: () => {},
    deepseekSegmentBatchFetch: async () => fresh
  };
  vm.createContext(context);
  vm.runInContext(translationSource, context, { filename: "background/translation.js" });
  context.deepseekSegmentBatchFetch = async () => { freshRequests++; return fresh; };
  const translate = vm.runInContext("deepseekTranslateBatch", context);
  const items = [{ id: "0", text: "source" }];

  const ordinary = await translate(items, "zh-CN", "en", [], [], false, "scope", null, {});
  assert.equal(ordinary[0].translation, "旧响应");
  assert.equal(cacheReads, 1);
  assert.equal(freshRequests, 0);

  const retried = await translate(items, "zh-CN", "en", [], [], false, "scope", null, {
    bypassCache: true
  });
  assert.equal(retried[0].translation, "新响应");
  assert.equal(cacheReads, 1);
  assert.equal(freshRequests, 1);
  assert.equal(cacheWrites, 1);
});

test("seeking and seeked only schedule a trailing-edge focus change", () => {
  const timers = [];
  const messages = [];
  const context = {
    captionSession: {
      deepseekSeekSettleTimer: null,
      deepseekSeekSettling: false,
      deepseekPendingSeekTimeMs: 0,
      deepseekFocusGeneration: 7
    },
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
    sendRuntimeMessage: (message) => messages.push(message),
    DEEPSEEK_SEEK_SETTLE_MS: 140
  };
  vm.createContext(context);
  vm.runInContext(playbackSource, context, { filename: "content/cue-playback.js" });
  const begin = vm.runInContext("beginDeepseekSeek", context);
  const finish = vm.runInContext("finishDeepseekSeek", context);
  begin(1000);
  finish(2000);
  finish(3000);
  assert.equal(context.captionSession.deepseekFocusGeneration, 7);
  assert.equal(messages.length, 0);
  assert.equal(context.captionSession.deepseekSeekSettling, true);
  assert.equal(context.captionSession.deepseekPendingSeekTimeMs, 3000);
  assert.equal(timers.length, 3);
});

test("an invalidated fallback session cannot repaint unchanged source text", () => {
  const timers = [];
  const callbacks = [];
  const painted = [];
  let sessionToken = Object.freeze({ revision: 1 });
  const context = {
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
    captionSession: {
      debounceTimer: null,
      fallbackRequestId: "",
      fallbackSessionToken: null,
      lastReqToken: 0,
      lastSource: "same caption",
      lastTransSource: "",
      currentVideoId: "video",
      cueSourceLang: "en",
      deepseekFocusGeneration: 0
    },
    settings: { targetLang: "zh-CN" },
    DEBOUNCE_MS: 450,
    captureCaptionSession: () => sessionToken,
    isCaptionSessionCurrent: (token) => token === sessionToken,
    sendRuntimeMessage: (_message, callback) => callbacks.push(callback),
    setTranslation: (translation) => painted.push(translation)
  };
  vm.createContext(context);
  vm.runInContext(fallbackSource, context, { filename: "content/fallback.js" });
  const schedule = vm.runInContext("scheduleTranslate", context);

  schedule("same caption");
  timers[0]();
  assert.equal(callbacks.length, 1);

  // Configuration/navigation invalidation may leave the native caption text
  // unchanged. Its old provider response must still lose repaint authority.
  sessionToken = Object.freeze({ revision: 2 });
  callbacks[0]({
    ok: true,
    translations: [{ id: "0", translation: "stale translation" }]
  }, null);

  assert.deepEqual(painted, []);
});

test("webRequest diagnostics preserve Chromium's underlying net error", () => {
  const listeners = {};
  const event = (name) => ({
    addListener: (listener) => { listeners[name] = listener; }
  });
  const debug = [];
  const context = {
    Map,
    Date,
    chrome: { webRequest: {
      onBeforeSendHeaders: event("before"),
      onErrorOccurred: event("error"),
      onCompleted: event("completed")
    } },
    appendDebug: (...args) => debug.push(args)
  };
  vm.createContext(context);
  vm.runInContext(networkSource, context, { filename: "background/network.js" });
  listeners.before({
    requestId: "chrome-request-1",
    requestHeaders: [{ name: "X-CaptionAI-Trace", value: "commit:1:2:3-4.1" }],
    timeStamp: Date.now(),
    url: "https://api.deepseek.com/chat/completions"
  });
  listeners.error({
    requestId: "chrome-request-1",
    error: "net::ERR_HTTP2_PROTOCOL_ERROR",
    timeStamp: Date.now(),
    fromCache: false,
    tabId: -1,
    type: "xmlhttprequest"
  });
  const lookup = vm.runInContext("aiNetworkFailureForTrace", context);
  assert.equal(lookup("commit:1:2:3-4.1").error, "net::ERR_HTTP2_PROTOCOL_ERROR");
  assert.equal(debug[0][1], "ai-network-error");
});
