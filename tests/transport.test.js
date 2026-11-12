"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared, contentConstants } = require("./helpers");

const root = path.resolve(__dirname, "..");
const httpSource = fs.readFileSync(path.join(root, "background/http.js"), "utf8");
const semanticSource = [
  "content/semantic-policy.js", "content/semantic-requests.js",
  "content/semantic-results.js", "content/semantic-lookahead.js", "content/semantic.js",
  "content/cue-indicator.js"
].map((file) =>
  fs.readFileSync(path.join(root, file), "utf8")).join("\n");
const displaySource = fs.readFileSync(path.join(root, "content/display.js"), "utf8");
const playbackSource = fs.readFileSync(path.join(root, "content/cue-playback.js"), "utf8");
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

function loadHttpContext(fetchImpl, overrides = {}) {
  const context = {
    AbortController,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    YTDS_SHARED: loadShared(),
    AI_STREAM_COMPLETION_GRACE_MS: 750
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(httpSource, context, { filename: "background/http.js" });
  return context;
}

function loadHttp(fetchImpl) {
  const context = loadHttpContext(fetchImpl);
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

function rangeSemanticResponse(start, end) {
  return Array.from({ length: Math.max(0, end - start + 1) }, (_value, offset) => ({
    id: String(start + offset),
    unitId: `semantic-${start + offset}`,
    translation: "range translation"
  }));
}

function unitSemanticResponse(start, end, unitId, translation = "unit translation") {
  return Array.from({ length: Math.max(0, end - start + 1) }, (_value, offset) => ({
    id: String(start + offset), unitId, translation
  }));
}

function loadSemanticCommitHarness(translations, retryAttempt, options = {}) {
  const debug = [];
  const timers = [];
  const messages = [];
  const pendingCallbacks = [];
  const painted = [];
  const retryKey = "video:1:0:159";
  const groupCount = Number.isInteger(options.groupCount) && options.groupCount > 0
    ? options.groupCount : 501;
  const limitEnd = Number.isInteger(options.limitEnd) && options.limitEnd >= 0
    ? Math.min(groupCount - 1, options.limitEnd) : groupCount - 1;
  const groups = Array.from({ length: groupCount }, (_value, id) => ({
    startIdx: 0,
    endIdx: 0,
    text: `w${id}`,
    start: id * 10,
    end: id * 10 + 10,
    pauseAfterMs: 0,
    softAfter: false,
    hardAfter: id === groupCount - 1
  }));
  const batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0
    ? options.batchSize : 0;
  const batchWindows = batchSize
    ? Array.from({ length: Math.ceil(groups.length / batchSize) }, (_value, index) => {
      const start = index * batchSize;
      return { start, end: Math.min(groups.length - 1, start + batchSize - 1) };
    })
    : [{ start: 0, end: 100 }];
  const state = {
    cursor: 0,
    commitFloor: 0,
    limitEnd,
    targetThrough: Number.isInteger(options.targetThrough) ? options.targetThrough : 100,
    urgentTarget: Number.isInteger(options.urgentTarget) ? options.urgentTarget : 100,
    windowItems: Number.isInteger(options.windowItems) ? options.windowItems : 160
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
      cueSourceLang: options.sourceLang || "en",
      cueList: [{ text: "source", start: 0, end: 1000 }],
      cueToGroup: [0],
      cueToGroups: [[0]],
      sentGroups: groups,
      semanticCommitRegions: [{ start: 0, end: limitEnd }],
      semanticCommitRegions: [{ start: 0, end: limitEnd }],
      semanticGroupToCommitRegion: new Array(groupCount).fill(0),
      semanticGroupToCommitRegion: new Array(groupCount).fill(0),
      semanticCommitStateByRegion: new Map([[0, state]]),
      semanticCommitStateByRegion: new Map([[0, state]]),
      semanticGroupToBatch: batchSize
        ? groups.map((_group, id) => Math.floor(id / batchSize))
        : new Array(groupCount).fill(0),
      semanticGroupToBatch: batchSize
        ? groups.map((_group, id) => Math.floor(id / batchSize))
        : new Array(groupCount).fill(0),
      semanticBatchWindows: batchWindows,
      semanticBatchWindows: batchWindows,
      semanticRequestMeta: new Map(),
      semanticRequestMeta: new Map(),
      transInflight: new Set(),
      semanticRetryCounts: new Map([[retryKey, retryAttempt]]),
      semanticRetryCounts: new Map([[retryKey, retryAttempt]]),
      semanticExhaustedRegions: new Map(),
      semanticExhaustedRegions: new Map(),
      semanticVisibleErrors: new Map(),
      semanticVisibleErrors: new Map(),
      transCache: new Map(),
      semanticUnitCache: new Map(),
      semanticUnitCache: new Map(),
      semanticSourceCache: new Map(),
      semanticSourceCache: new Map(),
      semanticAlignedChunksCache: new Map(),
      semanticAlignedChunksCache: new Map(),
      semanticDisplayCache: new Map(),
      semanticDisplayCache: new Map(),
      semanticRequestSerial: 0,
      semanticRequestSerial: 0,
      semanticFocusGeneration: 0,
      semanticFocusGeneration: 0,
      semanticFocusedBatchIndex: -1,
      semanticFocusedBatchIndex: -1,
      semanticSeekSettling: false,
      semanticSeekSettling: false,
      semanticLayoutWidth: 0,
      pendingTimer: null,
      pendingIndicatorKey: "",
      activeGroupIdx: 10,
      activeCueIdx: 0
    },
    settings: {
      targetLang: options.targetLang || "zh-CN", debugEnabled: true,
      aiBaseUrl: options.aiBaseUrl || "https://api.deepseek.com",
      aiModel: options.aiModel || "test-model",
      ...(options.prefetchBatches == null
        ? {} : { aiPrefetchBatches: options.prefetchBatches }),
      ...(options.aiRateLimitRpm == null
        ? {} : { aiRateLimitRpm: options.aiRateLimitRpm }),
      ...(options.aiRequestItems == null
        ? {} : { aiRequestItems: options.aiRequestItems })
    },
    ...contentConstants(),
    // Scenario overrides: 16-item batch scopes keep the fixtures small, and a
    // test may cap the window to recreate a geometry.
    SEMANTIC_CORE_ITEMS: 16,
    AI_CORE_ITEMS: 16,
    ...(Number.isInteger(options.maxRequestItems) ? { AI_MAX_REQUEST_ITEMS: options.maxRequestItems } : {}),
    emitDebug: (event, data) => debug.push({ event, data }),
    emitCaptionStateTransition: (machine, transition, data) =>
      debug.push({ event: "state-transition", data: { machine, transition, ...data } }),
    mergeCueTexts: (items) => items.map((item) => item.text).join(" "),
    cacheAiDisplayNeighborhood: () => {},
    semanticDisplayWidth: () => 1000,
    repaintActiveAiTranslation: () => {},
    aiTranslationErrorText: (value) => {
      const details = loadShared().aiErrorDescriptor(value);
      return `Translation failed [${[details.code, details.providerCode].filter(Boolean).join(" / ")}]`;
    },
    clearPendingTimer: () => {},
    sourceForDisplayedCue: () => "source",
    manualTranslationSelected: () => false,
    manualTranslationTextAt: () => "",
    setTranslation: (text) => painted.push(text),
    t: (_key, fallback) => fallback,
    getVideo: () => ({
      currentTime: 509,
      playbackRate: Number(options.playbackRate) || 1
    }),
    sendRuntimeMessage: (message, callback) => {
      messages.push(message);
      if (options.deferResponses && typeof callback === "function") {
        pendingCallbacks.push({ message, callback });
        return true;
      }
      callback({ ok: true, translations, deferredIds: [], httpDiagnostics: { attempts: [] } });
    },
    captureCaptionSession: () => sessionToken,
    isCaptionSessionCurrent: (token) => token === activeSessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  return {
    context, state, debug, timers, messages, pendingCallbacks, painted, retryKey,
    invalidateSession: () => { activeSessionToken = Object.freeze({ revision: 2 }); }
  };
}

function loadPlaybackPrefetchHarness(options = {}) {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: options.windowItems ?? 80,
    targetThrough: options.targetThrough ?? 40,
    urgentTarget: options.urgentTarget ?? 0,
    playbackRate: options.playbackRate ?? 3,
    batchSize: options.batchSize ?? 64,
    deferResponses: true,
    groupCount: options.groupCount ?? 801,
    limitEnd: options.limitEnd ?? 800,
    aiBaseUrl: options.aiBaseUrl,
    aiModel: options.aiModel,
    prefetchBatches: options.prefetchBatches,
    aiRequestItems: options.aiRequestItems,
    aiRateLimitRpm: options.aiRateLimitRpm
  });
  harness.context.settings.enabled = true;
  for (const [name, value] of Object.entries({
    AI_MAX_PREFETCH_BATCHES: options.maxPrefetchBatches,

  })) {
    if (value != null) harness.context[name] = value;
  }
  harness.context.captionSession.activeGroupIdx = 0;
  vm.runInContext(playbackSource, harness.context, { filename: "content/cue-playback.js" });
  vm.runInContext("prefetchFrom(0)", harness.context);
  return {
    harness,
    requests: harness.messages.filter((message) => message.type === "translateBatch")
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

test("AI response protocol failures expose a stable diagnostic code", async () => {
  const response = {
    ok: true,
    headers: { get: () => "application/json" },
    text: async () => "not json"
  };
  const fetchWithTimeout = loadHttp(async () => response);
  await assert.rejects(
    fetchWithTimeout("https://api.deepseek.com/chat/completions", {}, 500, 200),
    (error) => error.errorCode === "AI_RESPONSE_INVALID_JSON"
  );
});

test("HTTP failures retain provider codes without exposing the provider body", async () => {
  const context = loadHttpContext(async () => ({
    ok: false,
    status: 400,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify({
      error: { code: "invalid_request_error", message: "secret provider detail" }
    })
  }), {
    chrome: { storage: { local: { get: async () => ({ aiApiKeys: {} }) } } },
    AI_NETWORK_TRACE_HEADER: "X-Test-Trace",
    AI_MAX_ATTEMPTS: 3,
    AI_TIMEOUT_FAST_MS: 500,
    AI_TIMEOUT_THINKING_MS: 500,
    AI_CONNECT_TIMEOUT_PREFETCH_MS: 200,
    AI_CONNECT_TIMEOUT_URGENT_MS: 200,
    aiNetworkAttemptTraceId: (_requestId, attempt) => `trace-${attempt}`
  });
  const aiRawCompletion = vm.runInContext("aiRawCompletion", context);
  await assert.rejects(
    aiRawCompletion({
      endpoint: "https://provider.example/v1/chat/completions",
      baseUrl: "https://provider.example/v1",
      endpointKind: "compatible",
      model: "test-model",
      extraBody: {}
    }, [], null, 256, 0),
    (error) => {
      assert.equal(error.errorCode, "HTTP_400");
      assert.equal(error.httpStatus, 400);
      assert.equal(error.providerCode, "invalid_request_error");
      assert.doesNotMatch(error.message, /secret provider detail/);
      return true;
    }
  );
});

test("subtitle-safe AI error descriptors retain HTTP/provider codes", () => {
  const shared = loadShared();
  const descriptor = shared.aiErrorDescriptor({
    errorCode: "HTTP_400",
    providerCode: "invalid_request_error"
  });
  assert.equal(descriptor.code, "HTTP_400");
  assert.equal(descriptor.providerCode, "invalid_request_error");
  assert.equal(
    shared.aiErrorDescriptor({ netError: "net::ERR_NAME_NOT_RESOLVED" }).code,
    "net::ERR_NAME_NOT_RESOLVED"
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

// A virtual clock for the background rate limiter: timers fire only when the
// test advances time to them.
function loadRateHarness() {
  let now = 0;
  const timers = [];
  const context = loadHttpContext(async () => {
    throw new Error("network should not be reached");
  }, {
    Date: { now: () => now },
    setTimeout: (callback, delay) => {
      const timer = { id: timers.length + 1, at: now + delay, delay, callback, cleared: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout: (id) => { const timer = timers.find((t) => t.id === id); if (timer) timer.cleared = true; }
  });
  const waitForSlot = vm.runInContext("waitForAiRequestSlot", context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // Run pending timers in time order until `until`.
  const advance = async (until) => {
    for (;;) {
      await settle();
      const due = timers.filter((t) => !t.cleared && !t.fired && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.fired = true;
      due.callback();
    }
    now = Math.max(now, until);
    await settle();
  };
  // Start one request and return the virtual time it was allowed to start.
  const start = async (config, urgent) => {
    let started = null;
    waitForSlot(config, null, urgent).then(() => { started = now; }, () => { started = "rejected"; });
    await settle(); // a request allowed at once resolves on the next microtask
    for (let guard = 0; started === null && guard < 400; guard++) {
      const next = timers.filter((t) => !t.cleared && !t.fired).sort((a, b) => a.at - b.at)[0];
      await advance(next ? next.at : now);
    }
    return started;
  };
  return { waitForSlot, timers, advance, start, now: () => now, set: (t) => { now = t; } };
}

const RATE_15 = { endpointKind: "compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  model: "gemini-3.1-flash-lite-preview", rateLimitRpm: 15 };

test("an RPM setting allows at most that many starts in any 63 s window", async () => {
  const rate = loadRateHarness();
  const starts = [];
  for (let i = 0; i < 16; i++) starts.push(await rate.start(RATE_15, true));
  // A burst starts at once (250 ms apart), the way providers count a minute.
  assert.deepEqual(starts.slice(0, 15), Array.from({ length: 15 }, (_v, i) => i * 250));
  // The 16th waits until the first start leaves the 63 s window.
  assert.equal(starts[15], 63000);
  for (let i = 15; i < starts.length; i++) {
    const inWindow = starts.filter((t) => t > starts[i] - 63000 && t <= starts[i]).length;
    assert.ok(inWindow <= 15, `start ${i}`);
  }
});

test("speculative requests leave a reserve of the RPM budget for visible ones", async () => {
  const rate = loadRateHarness();
  const speculative = [];
  for (let i = 0; i < 12; i++) speculative.push(await rate.start(RATE_15, false));
  assert.equal(speculative[11], 11 * 250, "12 speculative starts fit the 15 RPM budget minus a 3 request reserve");
  // The 13th speculative request must wait for the window...
  let thirteenth = null;
  rate.waitForSlot(RATE_15, null, false).then(() => { thirteenth = rate.now(); }, () => { thirteenth = "rejected"; });
  await rate.advance(rate.now() + 5000);
  assert.equal(thirteenth, null);
  // ...while a visible request uses the reserve: it preempts the waiting one.
  const visible = await rate.start(RATE_15, true);
  assert.ok(visible - 11 * 250 <= 5250, `visible started at ${visible}`);
  assert.equal(thirteenth, "rejected", "the waiting speculative request is preempted");
});

test("an unlimited profile is never delayed", async () => {
  const rate = loadRateHarness();
  const config = { ...RATE_15, rateLimitRpm: 0 };
  for (let i = 0; i < 40; i++) assert.equal(await rate.start(config, i % 2 === 0), 0);
});


test("promoting a live prefetch reuses it instead of cancelling it", () => {
  const messages = [];
  const context = {
    Map,
    Set,
    Date,
    captionSession: {
      semanticRequestMeta: new Map(),
      transInflight: new Set(),
      semanticFocusGeneration: 4,
      semanticRequestSerial: 10,
      cueVideoId: "video"
    },
    sendRuntimeMessage: (message) => messages.push(message),
    emitDebug: () => {},
    emitCaptionStateTransition: () => {}
  };
  const existing = { requestId: "commit:4:10:1-80", urgent: false };
  context.captionSession.semanticRequestMeta.set("dsb:1", existing);
  context.captionSession.transInflight.add("dsb:1");
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const begin = vm.runInContext("beginAiRequest", context);
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
      semanticRequestMeta: new Map([["dsb:1", request]]),
      cueEpoch: 2,
      semanticFocusGeneration: 4
    },
    AI_URGENT_TARGET_TAIL_ITEMS: 224,
    AI_MAX_REQUEST_ITEMS: 320,
    getVideo: () => null,
    isCaptionSessionCurrent: (token) => token === sessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const canContinue = vm.runInContext("canContinueAiInflight", context);
  assert.equal(canContinue(1, { cursor: 5793 }, 5873), true);
  assert.equal(canContinue(1, { cursor: 5793 }, 5872 + 224 + 1), false, "beyond the runway reach");
  // Ownership is the session token. A request adopted across a seek keeps its
  // older transport focusGeneration; a revoked token always ends ownership.
  request.focusGeneration = 3;
  assert.equal(canContinue(1, { cursor: 5793 }, 5873), true);
  request.sessionToken = Object.freeze({ revision: 2 });
  assert.equal(canContinue(1, { cursor: 5793 }, 5873), false);
});

test("3x playback keeps a nearby live request instead of reseeding at the old tail", () => {
  const request = {
    requestEnd: 5872,
    reqEpoch: 2,
    focusGeneration: 4,
    sessionToken: Object.freeze({ revision: 1 })
  };
  const context = {
    Map,
    Set,
    captionSession: {
      semanticRequestMeta: new Map([["dsb:1", request]]),
      cueEpoch: 2,
      semanticFocusGeneration: 4
    },
    AI_URGENT_TARGET_TAIL_ITEMS: 224,
    AI_MAX_REQUEST_ITEMS: 320,
    getVideo: () => ({ playbackRate: 3 }),
    isCaptionSessionCurrent: (token) => token === request.sessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const canContinue = vm.runInContext("canContinueAiInflight", context);
  assert.equal(canContinue(1, { cursor: 5793 }, 6016), true);
  assert.equal(canContinue(1, { cursor: 5793 }, 6097), false);
});

test("an accelerated target abandons stale prefetch after its range has been passed", () => {
  const sessionToken = Object.freeze({ revision: 1 });
  const request = {
    requestStart: 5793,
    requestEnd: 5872,
    startedAt: Date.now() - 3000,
    urgent: false,
    reqEpoch: 2,
    focusGeneration: 4,
    sessionToken,
    progressCursor: 5793,
    progressTranslations: [],
    progressRecoveryTranslations: []
  };
  const context = {
    Map,
    Set,
    Date,
    captionSession: {
      semanticRequestMeta: new Map([["dsb:1", request]]),
      cueEpoch: 2,
      semanticFocusGeneration: 4
    },
    AI_URGENT_TARGET_TAIL_ITEMS: 224,
    AI_MAX_REQUEST_ITEMS: 320,
    getVideo: () => ({ playbackRate: 3 }),
    isCaptionSessionCurrent: (token) => token === sessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const isStale = vm.runInContext("aiRequestIsStaleForTarget", context);
  const canContinue = vm.runInContext("canContinueAiInflight", context);
  assert.equal(isStale(request, 5873), true);
  assert.equal(canContinue(1, { cursor: 5793 }, 5873), false);
  request.progressTranslations.push({ id: "5793" });
  // Buffered output alone is not committed playback progress.
  assert.equal(isStale(request, 5873), true);
  request.progressCursor = 5794;
  request.lastProgressAt = Date.now() - 3000;
  assert.equal(isStale(request, 5873), true);
  request.lastProgressAt = Date.now();
  assert.equal(isStale(request, 5873), false);
  assert.equal(canContinue(1, { cursor: 5793 }, 5873), true);
});

test("a future request with a buffered safe prefix is not discarded as stale", () => {
  const sessionToken = Object.freeze({ revision: 1 });
  const request = {
    requestStart: 5793,
    requestEnd: 5872,
    startedAt: Date.now() - 3000,
    urgent: false,
    prefetch: true,
    reqEpoch: 2,
    focusGeneration: 4,
    sessionToken,
    progressCursor: 5793,
    progressTranslations: [{ id: "5793", unitId: "semantic-5793", translation: "safe" }],
    progressRecoveryTranslations: []
  };
  const context = {
    Map,
    Set,
    Date,
    captionSession: {
      semanticRequestMeta: new Map([["dsp:1:5793", request]]),
      cueEpoch: 2,
      semanticFocusGeneration: 4
    },
    AI_URGENT_TARGET_TAIL_ITEMS: 224,
    AI_MAX_REQUEST_ITEMS: 320,
    getVideo: () => ({ playbackRate: 3 }),
    isCaptionSessionCurrent: (token) => token === sessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const isStale = vm.runInContext("aiRequestIsStaleForTarget", context);

  assert.equal(isStale(request, 5873), false);
});

test("an overlapping live prefetch remains the single writer after its start is passed", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 80, urgentTarget: 50, playbackRate: 1
  });
  const sessionToken = harness.context.captureCaptionSession();
  const request = {
    requestId: "prefetch:0:1:0-100", prefetch: true, regionIndex: 0,
    requestStart: 0, requestEnd: 100, reqEpoch: 1, reqVid: "video",
    sessionToken, focusGeneration: 0, progressTranslations: [],
    progressRecoveryTranslations: []
  };
  harness.context.captionSession.semanticRequestMeta.set("dsp:0:0", request);
  harness.context.captionSession.transInflight.add("dsp:0:0");
  harness.state.cursor = 50;
  const keep = vm.runInContext("aiPrefetchAtCursor", harness.context);

  assert.equal(keep(0, 50), true);
  assert.equal(request.urgent, true);
  assert.deepEqual(harness.messages, []);
  assert.equal(harness.context.captionSession.semanticRequestMeta.has("dsp:0:0"), true);
});

test("an urgent target cancels a stale same-region speculative writer", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 48, targetThrough: 40, urgentTarget: 40, playbackRate: 3
  });
  const sessionToken = harness.context.captureCaptionSession();
  const stale = {
    requestId: "prefetch:0:1:0-47",
    prefetch: true,
    regionIndex: 0,
    requestStart: 0,
    requestEnd: 47,
    startedAt: Date.now() - 3000,
    urgent: false,
    reqEpoch: 1,
    reqVid: "video",
    sessionToken,
    focusGeneration: 0,
    progressCursor: 0,
    progressTranslations: [],
    progressRecoveryTranslations: []
  };
  harness.context.captionSession.semanticRequestMeta.set("dsp:0:0", stale);
  harness.context.captionSession.transInflight.add("dsp:0:0");
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    if (typeof callback === "function") callback({ ok: true });
  };

  const request = vm.runInContext("aiRequestBatch", harness.context);
  request(60, true, true);

  assert.equal(harness.messages[0].type, "cancelAiTranslationRequest");
  assert.equal(harness.messages[0].requestId, stale.requestId);
  assert.equal(harness.context.captionSession.semanticRequestMeta.has("dsp:0:0"), false);
  assert.equal(harness.context.captionSession.transInflight.has("dsp:0:0"), false);
  assert.equal(harness.messages.some((message) => message.type === "translateBatch"), true);
  assert.equal(harness.debug.some((entry) =>
    entry.event === "state-transition" &&
    entry.data.reason === "stale-prefetch-target-passed"
  ), true);
});

test("accelerated playback rebuilds a live urgent request after its safe cursor falls behind", () => {
  const sessionToken = Object.freeze({ revision: 1 });
  const request = {
    requestStart: 0,
    requestEnd: 160,
    startedAt: Date.now() - 7000,
    urgent: true,
    reqEpoch: 2,
    focusGeneration: 4,
    sessionToken,
    progressCursor: 0,
    progressTranslations: [{ id: "0" }],
    progressRecoveryTranslations: []
  };
  const context = {
    Map,
    Set,
    Date,
    captionSession: {
      semanticRequestMeta: new Map([["dsb:1", request]]),
      cueEpoch: 2,
      semanticFocusGeneration: 4
    },
    getVideo: () => ({ playbackRate: 3 }),
    isCaptionSessionCurrent: (token) => token === sessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const isLagging = vm.runInContext("aiRequestIsPlaybackLagging", context);
  const canContinue = vm.runInContext("canContinueAiInflight", context);
  // One rule for every speed: 48 items behind after a 14 s startup grace
  // (4 s once the stream has made progress).
  request.startedAt = Date.now() - 15000;
  assert.equal(isLagging(request, { cursor: 96 }, 160), true);
  assert.equal(canContinue(1, { cursor: 96 }, 160), false);
  assert.equal(isLagging(request, { cursor: 96 }, 128), false, "fewer than 48 items behind");
  request.startedAt = Date.now() - 13000;
  assert.equal(isLagging(request, { cursor: 96 }, 160), false, "still inside the startup grace");
  request.startedAt = Date.now() - 15000;
  request.lastProgressAt = Date.now() - 1000;
  // A timestamp from a provisional/left-guard fragment must not reset the
  // startup grace period.
  assert.equal(isLagging(request, { cursor: 96 }, 160), true);
  request.progressCursor = 96;
  assert.equal(isLagging(request, { cursor: 96 }, 160), false);
  request.lastProgressAt = Date.now() - 5000;
  assert.equal(isLagging(request, { cursor: 96 }, 160), true);
});

test("Gemini playback lag preserves full startup grace and accounts for cached targets", () => {
  const request = {
    urgent: true,
    requestStart: 0,
    requestEnd: 319,
    startedAt: Date.now() - 4000,
    progressCursor: -1,
    lastProgressAt: 0
  };
  const context = {
    YTDS_SHARED: loadShared(),
    getVideo: () => ({ playbackRate: 2.6 }),
    captionSession: {
      transCache: new Map(),
      cueVideoId: "video",
      cueEpoch: 1
    },
    settings: {
      aiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", aiRateLimitRpm: 15,
      aiModel: "gemini-2.5-flash"
    },
    AI_PLAYBACK_PROGRESS_GRACE_MS: 4000,
    AI_PLAYBACK_STARTUP_GRACE_MS: 6000,
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const groupKey = context.groupKey;
  context.captionSession.transCache.set(groupKey(128), "cached translation");
  const isLagging = vm.runInContext("aiRequestIsPlaybackLagging", context);

  // At 4000ms with rate 2.6, Gemini has 14000ms startup grace so it is not lagging yet:
  assert.equal(isLagging(request, { cursor: 0 }, 100), false);

  // If targetGroup 128 is already cached, it is never lagging:
  request.startedAt = Date.now() - 15000;
  assert.equal(isLagging(request, { cursor: 0 }, 128), false);

  // At 7000ms (e.g. rate-limit queue + fallback attempt), it is protected from premature abort:
  request.startedAt = Date.now() - 7000;
  assert.equal(isLagging(request, { cursor: 0 }, 100), false);

  // But if targetGroup is uncached and past 14000ms, it is lagging:
  request.startedAt = Date.now() - 15000;
  assert.equal(isLagging(request, { cursor: 0 }, 100), true);
});

test("reseedAiCommitState advances past already cached items", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 160, targetThrough: 128, urgentTarget: 128, playbackRate: 1
  });
  const groupKey = harness.context.groupKey;
  // Simulate item 100 and 101 being already cached
  harness.context.captionSession.transCache.set(groupKey(100), "already translated");
  harness.context.captionSession.transCache.set(groupKey(101), "already translated");
  const reseed = vm.runInContext("reseedAiCommitState", harness.context);

  // Reseeding with targetGroup 100 should advance effectiveTarget to 102
  const state = reseed(0, 100);
  assert.ok(state.cursor >= 102);
  assert.ok(state.commitFloor >= 102);
});

test("playback-lag reseed cancels the old urgent writer before rebuilding", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 160, targetThrough: 128, urgentTarget: 128, playbackRate: 3
  });
  const sessionToken = harness.context.captureCaptionSession();
  const oldRequest = {
    requestId: "commit:0:1:0-159",
    requestStart: 0,
    requestEnd: 159,
    startedAt: Date.now() - 15000,
    urgent: true,
    reqEpoch: 1,
    reqVid: "video",
    focusGeneration: 0,
    sessionToken,
    progressTranslations: [],
    progressRecoveryTranslations: []
  };
  harness.context.captionSession.semanticRequestMeta.set("dsb:0", oldRequest);
  harness.context.captionSession.transInflight.add("dsb:0");
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    return true;
  };

  const request = vm.runInContext("aiRequestBatch", harness.context);
  request(80, true, true);

  assert.equal(harness.messages[0].type, "cancelAiTranslationRequest");
  assert.equal(harness.messages[0].requestId, oldRequest.requestId);
  assert.equal(harness.messages[1].type, "translateBatch");
  assert.equal(harness.messages[1].requestStart, 80 - Math.round(64 / 3), "backtrack shrinks with speed");
  assert.equal(harness.messages[1].urgent, true);
  assert.equal(harness.debug.some((entry) =>
    entry.event === "semantic-playback-lag-reseed"
  ), true);
});

test("playback-lag reseed preserves a valid future runway", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 48, targetThrough: 100, urgentTarget: 100, playbackRate: 3
  });
  const sessionToken = harness.context.captureCaptionSession();
  const future = {
    requestId: "prefetch:0:2:48-143",
    prefetch: true,
    regionIndex: 0,
    requestStart: 48,
    requestEnd: 143,
    reqEpoch: 1,
    reqVid: "video",
    sessionToken,
    focusGeneration: 0,
    startedAt: Date.now() - 1000,
    commitFloor: 76,
    limitEnd: 500,
    effectiveGuardItems: 16,
    progressTranslations: rangeSemanticResponse(76, 100),
    progressRecoveryTranslations: rangeSemanticResponse(76, 100)
  };
  const stalled = {
    requestId: "commit:0:1:0-47",
    urgent: true,
    regionIndex: 0,
    requestStart: 0,
    requestEnd: 47,
    reqEpoch: 1,
    reqVid: "video",
    sessionToken,
    focusGeneration: 0,
    startedAt: Date.now() - 15000,
    lastProgressAt: 0,
    progressCursor: 0,
    progressTranslations: [],
    progressRecoveryTranslations: []
  };
  harness.context.captionSession.semanticRequestMeta.set("dsb:0", stalled);
  harness.context.captionSession.semanticRequestMeta.set("dsp:0:48", future);
  harness.context.captionSession.transInflight.add("dsb:0");
  harness.context.captionSession.transInflight.add("dsp:0:48");
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    if (message.type === "cancelAiTranslationRequest" && typeof callback === "function") {
      callback({ ok: true });
    }
    return true;
  };

  vm.runInContext("aiRequestBatch(100, true, true)", harness.context);

  assert.equal(harness.messages[0].type, "cancelAiTranslationRequest");
  assert.equal(harness.messages[0].requestId, stalled.requestId);
  assert.equal(harness.messages.some((message) => message.requestId === future.requestId), false);
  assert.equal(harness.context.captionSession.semanticRequestMeta.get("dsp:0:48"), future);
  assert.equal(future.urgent, true);
  // The preserved future request already covers the reseeded cursor, so it
  // becomes the single visible writer instead of creating a duplicate call.
  assert.equal(harness.messages.some((message) =>
    message.type === "translateBatch" && message.urgent
  ), false);
});

test("stale prefetch is cancelled before an urgent request is rebuilt", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    aiRequestItems: 128,
    windowItems: 48, targetThrough: 40, urgentTarget: 40, playbackRate: 3
  });
  const sessionToken = harness.context.captureCaptionSession();
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    if (typeof callback === "function") {
      callback({ ok: true, translations: giantSemanticResponse(false), deferredIds: [] });
    }
  };
  harness.context.captionSession.semanticRequestMeta.set("dsb:0", {
    requestId: "commit:0:1:0-47",
    requestEnd: 47,
    startedAt: Date.now() - 3000,
    urgent: false,
    reqEpoch: 1,
    reqVid: "video",
    focusGeneration: 0,
    sessionToken,
    progressTranslations: [],
    progressRecoveryTranslations: []
  });
  harness.context.captionSession.transInflight.add("dsb:0");

  const request = vm.runInContext("aiRequestBatch", harness.context);
  request(60, true, true);

  assert.equal(harness.messages[0].type, "cancelAiTranslationRequest");
  assert.equal(harness.messages[1].type, "translateBatch");
  assert.equal(harness.messages[1].urgent, true);
  // The accelerated visible window (also never below twice the runway).
  assert.equal(harness.messages[1].items.length, 128);
  assert.equal(harness.debug.some((entry) =>
    entry.event === "semantic-stale-prefetch-reseed"
  ), true);
});

test("the semantic runway is the same at every playback speed", () => {
  const request = {
    requestEnd: 5872,
    reqEpoch: 2,
    focusGeneration: 4,
    sessionToken: Object.freeze({ revision: 1 })
  };
  const context = {
    Map,
    Set,
    captionSession: {
      semanticRequestMeta: new Map([["dsb:1", request]]),
      cueEpoch: 2,
      semanticFocusGeneration: 4
    },
    AI_URGENT_TARGET_TAIL_ITEMS: 224,
    AI_MAX_REQUEST_ITEMS: 320,
    getVideo: () => ({ playbackRate: 2 }),
    isCaptionSessionCurrent: (token) => token === request.sessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const tailItems = vm.runInContext("aiUrgentTargetTailItems", context);
  const canContinue = vm.runInContext("canContinueAiInflight", context);
  for (const rate of [1, 1.5, 2, 3]) {
    context.getVideo = () => ({ playbackRate: rate });
    assert.equal(tailItems(), 224, `${rate}x`);
  }
  assert.equal(canContinue(1, { cursor: 5793 }, 5872 + 224), true);
  assert.equal(canContinue(1, { cursor: 5793 }, 5872 + 225), false);
});

test("a maximum-window mega-unit commits through its model-aligned chunks", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(true), 2, { maxRequestItems: 160 });
  const pump = vm.runInContext("pumpAiCommitRegion", harness.context);
  pump(0, true);

  assert.equal(harness.state.cursor, 120);
  assert.equal(harness.context.captionSession.transCache.get("video g10"), "分段1");
  assert.equal(harness.context.captionSession.semanticRetryCounts.has(harness.retryKey), false);
  assert.equal(harness.debug.some((entry) =>
    entry.event === "semantic-aligned-chunk-recovery" && entry.data.nextCursor === 120
  ), true);
  assert.equal(harness.debug.some((entry) => entry.event === "batch-retry"), false);
});

test("malformed JSONL falls back to a bounded prefix and exposes the suffix", async () => {
  const calls = [];
  const context = {
    YTDS_SHARED: loadShared(),
    MAX_PROMPT_SOURCE_CHARS: 28000,
    AI_STREAM_COMPLETION_GRACE_MS: 750,
    AI_PROMPT_CACHE_VERSION: "test",
    AI_BATCH_INFLIGHT: new Map(),
    getAiConfig: async () => ({
      model: "model", baseUrl: "https://api.example.test", endpointKind: "compatible",
      extraBody: {}, contextPast: 0, contextFuture: 0
    }),
    aiResponseCacheId: () => "fallback-cache",
    readAiResponseCache: async () => null,
    writeAiResponseCache: async () => {},
    aiRawCompletion: async (_config, _messages, _signal, _maxTokens, _temperature, trace) => {
      calls.push(!!(trace && trace.jsonLines));
      if (trace && trace.jsonLines) {
        return { raw: "not valid JSONL", diagnostics: { attempts: [] } };
      }
      return {
        raw: JSON.stringify({
          segments: Array.from({ length: 96 }, (_value, id) => ({
            start: id, end: id, translation: "译文"
          }))
        }),
        diagnostics: { attempts: [] }
      };
    }
  };
  vm.createContext(context);
  vm.runInContext(translationSource, context, { filename: "background/translation.js" });
  const items = Array.from({ length: 160 }, (_value, id) => ({
    id: String(id), startMs: id * 200, endMs: id * 200 + 150,
    pauseAfterMs: 0, softAfter: false, hardAfter: false, text: "s"
  }));
  const result = await context.aiTranslateBatch(
    items, "zh-CN", "en", [], [], false, "test-scope", null,
    { debug: false, requestId: "test-fallback", urgent: true }
  );
  assert.deepEqual(calls, [true, false]);
  assert.equal(result.length, 96);
  assert.equal(result.deferredIds.length, 64);
  assert.equal(result.streamPartial, true);
  const longItems = Array.from({ length: 96 }, (_value, id) => ({
    id: String(id), startMs: id * 1500, endMs: id * 1500 + 1400,
    text: "a deliberately long subtitle atom that consumes the source budget"
  }));
  assert.equal(context.aiFallbackPrefixItems(longItems).length, 12);
});

test("urgent and speculative lanes share one exact in-flight provider request", async () => {
  let completionResolve;
  let networkCalls = 0;
  const context = {
    AbortController,
    Array, Date, Map, Math, Number, Object, Promise, Set, String,
    YTDS_SHARED: loadShared(),
    MAX_PROMPT_SOURCE_CHARS: 28000,
    AI_STREAM_COMPLETION_GRACE_MS: 750,
    AI_PROMPT_CACHE_VERSION: "test",
    AI_BATCH_INFLIGHT: new Map(),
    getAiConfig: async () => ({
      model: "model", baseUrl: "https://api.example.test", endpointKind: "deepseek",
      extraBody: {}, contextPast: 0, contextFuture: 0
    }),
    aiResponseCacheId: () => "same-request",
    readAiResponseCache: async () => null,
    writeAiResponseCache: async () => {},
    aiRawCompletion: async (_config, _messages, _signal, _maxTokens, _temperature, trace) => {
      networkCalls++;
      return new Promise((resolve) => {
        completionResolve = () => {
          trace.onTextDelta(
            '[[0,0,"译文"]]\n' +
            '[]\n', true
          );
          resolve({ raw: "", diagnostics: { attempts: [] } });
        };
      });
    }
  };
  vm.createContext(context);
  vm.runInContext(translationSource, context, { filename: "background/translation.js" });
  const translate = vm.runInContext("aiTranslateBatch", context);
  const items = [{
    id: "0", cueId: "0", startMs: 0, endMs: 500, pauseAfterMs: 0,
    softAfter: false, hardAfter: false, text: "source"
  }];
  const urgent = translate(items, "zh-CN", "en", [], [], false, "same-scope", null, {
    urgent: true, requestId: "urgent"
  });
  const speculative = translate(items, "zh-CN", "en", [], [], false, "same-scope", null, {
    fastPath: true, requestId: "prefetch"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(networkCalls, 1);
  completionResolve();
  const [urgentResult, speculativeResult] = await Promise.all([urgent, speculative]);
  assert.equal(urgentResult[0].translation, "译文");
  assert.equal(speculativeResult[0].translation, "译文");
});

test("a guard-touching unit expands directly to the maximum recovery window", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    aiRequestItems: 96,
    windowItems: 80, targetThrough: 40, urgentTarget: 40
  });
  const pump = vm.runInContext("pumpAiCommitRegion", harness.context);
  pump(0, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.messages.map((message) => message.items.length), [96, 320],
    "expands straight to the window cap");
  assert.equal(harness.debug.filter((entry) =>
    entry.event === "semantic-commit-window-expanded"
  ).length, 1);
  assert.equal(harness.debug.find((entry) =>
    entry.event === "semantic-commit-window-expanded"
  ).data.reason, "leading-unit-reaches-window-end");
});

test("3x urgent playback keeps the visible request short while runway prefetch fills ahead", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    aiRequestItems: 128, maxRequestItems: 160,
    windowItems: 80, targetThrough: 40, urgentTarget: 80, playbackRate: 3
  });
  const pump = vm.runInContext("pumpAiCommitRegion", harness.context);
  pump(0, true);
  await new Promise((resolve) => setImmediate(resolve));

  // The visible request stays bounded so distinct speculative ranges can run
  // beside it; the active writer still preserves its planned runway.
  assert.deepEqual(harness.messages.map((message) => message.items.length), [128, 160]);
  assert.ok(harness.messages.every((message) => message.items.length <= 160));
});

test("urgent giant units wait for a full runway before aligned-chunk recovery", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(true), 2, {
    aiRequestItems: 128,
    windowItems: 48, targetThrough: 40, urgentTarget: 40, playbackRate: 3
  });
  const pump = vm.runInContext("pumpAiCommitRegion", harness.context);
  pump(0, true);
  await new Promise((resolve) => setImmediate(resolve));

  // One accelerated window already reaches past the giant unit's runway.
  assert.deepEqual(harness.messages.map((message) => message.items.length), [128]);
  assert.ok(harness.messages.every((message) => message.urgent));
  // Aligned chunks commit only before the runway: 0-39 and 40-79 end before
  // the guard at 96, chunk 80-119 does not; the visible target 40 is covered.
  assert.equal(harness.state.cursor, 80);
  assert.equal(harness.context.captionSession.transCache.get("video g10"), "分段1");
});

test("urgent streamed progress recovers aligned chunks before the final response", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(true), 2, {
    windowItems: 48, targetThrough: 40, urgentTarget: 40, playbackRate: 3
  });
  const request = {
    requestId: "commit:0:1:0-159",
    urgent: true,
    regionIndex: 0,
    requestStart: 0,
    requestEnd: 159,
    commitFloor: 0,
    limitEnd: 500,
    effectiveGuardItems: 16,
    reqVid: "video",
    reqEpoch: 1,
    sessionToken: harness.context.captureCaptionSession(),
    focusGeneration: 0,
    progressTranslations: [],
    progressRecoveryTranslations: []
  };
  harness.context.captionSession.semanticRequestMeta.set("dsb:0", request);
  const handle = vm.runInContext("handleAiTranslationProgress", harness.context);
  assert.equal(handle({
    type: "translationBatchProgress",
    requestId: request.requestId,
    videoId: "video",
    focusGeneration: 0,
    translations: giantSemanticResponse(true)
  }), true);

  assert.equal(harness.state.cursor, 120);
  assert.equal(
    harness.context.captionSession.transCache.get("video g10"),
    giantSemanticResponse(true)[0].alignedChunks[0].translation
  );
  assert.equal(request.progressRecoveryTranslations.length, 160);
  assert.equal(harness.debug.some((entry) =>
    entry.event === "semantic-aligned-chunk-progress-recovery" && entry.data.nextCursor === 120
  ), true);
});

test("uncommitted left-guard progress does not refresh playback lag grace", () => {
  const harness = loadSemanticCommitHarness(
    Array.from({ length: 8 }, (_value, id) => ({
      id: String(id), unitId: "semantic-0-7", translation: "left guard"
    })),
    0,
    { playbackRate: 3 }
  );
  harness.state.commitFloor = 8;
  const request = {
    requestId: "commit:0:1:0-31",
    requestStart: 0,
    requestEnd: 31,
    urgent: true,
    regionIndex: 0,
    commitFloor: 8,
    limitEnd: 500,
    effectiveGuardItems: 16,
    reqVid: "video",
    reqEpoch: 1,
    sessionToken: harness.context.captureCaptionSession(),
    focusGeneration: 0,
    startedAt: Date.now() - 7000,
    lastProgressAt: 0,
    progressCursor: 0,
    progressTranslations: [],
    progressRecoveryTranslations: []
  };
  harness.context.captionSession.semanticRequestMeta.set("dsb:0", request);
  const handle = vm.runInContext("handleAiTranslationProgress", harness.context);

  assert.equal(handle({
    type: "translationBatchProgress",
    requestId: request.requestId,
    videoId: "video",
    focusGeneration: 0,
    translations: Array.from({ length: 8 }, (_value, id) => ({
      id: String(id), unitId: "semantic-0-7", translation: "left guard"
    }))
  }), false);
  assert.equal(request.lastProgressAt, 0);
  assert.equal(request.progressCursor, 0);
});

test("accelerated prefetch starts with enough runway before urgent promotion", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    maxRequestItems: 160,
    windowItems: 48, targetThrough: 40, urgentTarget: -1, playbackRate: 3
  });
  const pump = vm.runInContext("pumpAiCommitRegion", harness.context);
  pump(0, false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.messages.map((message) => message.items.length), [160]);
  assert.ok(harness.messages.every((message) => message.items.length <= 160));
});

test("same semantic region prefetches distinct future ranges concurrently", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    aiRequestItems: 96,
    windowItems: 48, targetThrough: 40, urgentTarget: 0, playbackRate: 3
  });
  const callbacks = [];
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    callbacks.push(callback);
  };
  const queue = vm.runInContext("queueAiSpeculativeRequest", harness.context);
  queue(0, 64);
  queue(0, 160);
  queue(0, 256);

  assert.deepEqual(harness.messages.map((message) => message.requestStart), [64, 160, 256]);
  assert.ok(harness.messages.every((message) => message.urgent === false));
  assert.equal(callbacks.length, 3);

  callbacks[0]({ ok: false, error: "temporary prefetch failure", netfail: true });
  assert.equal(harness.messages[2].requestStart, 256);
});

test("an active speculative range cannot be queued again while the runway is full", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    playbackRate: 3, deferResponses: true
  });
  const queue = vm.runInContext("queueAiSpeculativeRequest", harness.context);
  queue(0, 64);

  // Fill the remaining speculative slots. The duplicate enqueue below must
  // be rejected while the original 64-range is still the single writer.
  for (const start of [160, 256, 352]) {
    harness.context.captionSession.semanticRequestMeta.set(`dsp:0:${start}`, {
      requestId: `prefetch:${start}`, prefetch: true, urgent: false,
      regionIndex: 0, requestStart: start, requestEnd: start + 95
    });
  }
  queue(0, 64);
  assert.equal(harness.state.prefetchQueue.length, 0);

  // Simulate all four requests settling, then pump the scheduler as their
  // callbacks do. The old implementation launches the same 64-range again.
  harness.context.captionSession.semanticRequestMeta.clear();
  harness.context.captionSession.transInflight.clear();
  vm.runInContext("pumpAiSpeculativeRequests(0, captionSession.semanticCommitStateByRegion.get(0))", harness.context);
  assert.deepEqual(
    harness.messages.map((message) => message.requestStart),
    [64]
  );
});

test("a malformed prefetch keeps its diagnostic when promoted to the visible writer", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0);
  const sessionToken = harness.context.captureCaptionSession();
  const request = {
    requestId: "prefetch:0:1:64-159", prefetch: true, regionIndex: 0,
    requestStart: 64, requestEnd: 159, commitFloor: 64, limitEnd: 500,
    effectiveGuardItems: 16, reqEpoch: 1, reqVid: "video", sessionToken,
    focusGeneration: 0, progressTranslations: [], progressRecoveryTranslations: []
  };
  const translations = rangeSemanticResponse(64, 95);
  const response = { ok: true, translations, partial: true, streamPartial: true };
  Object.defineProperties(response, {
    error: { value: "invalid JSONL line" },
    errorCode: { value: "AI_JSONL_INVALID" }
  });
  const handle = vm.runInContext("handleAiBatchResult", harness.context);
  handle(request, response, null);
  harness.state.cursor = 64;

  const take = vm.runInContext("takeAiPrefetchedResponse", harness.context);
  const promoted = take(harness.state);
  assert.equal(promoted.request.prefetch, false);
  assert.equal(promoted.response.errorCode, "AI_JSONL_INVALID");
  assert.equal(promoted.response.error, "invalid JSONL line");
});

test("terminal translation errors retain their code and original safe message", () => {
  const context = {
    String,
    YTDS_SHARED: loadShared(),
    t: (_key, fallback) => fallback
  };
  vm.createContext(context);
  vm.runInContext(displaySource, context, { filename: "content/display.js" });
  const format = vm.runInContext("aiTranslationErrorText", context);

  assert.equal(
    format({
      errorCode: "HTTP_400", providerCode: "invalid_request_error",
      errorMessage: "AI HTTP 400"
    }),
    "Translation failed [HTTP_400 / invalid_request_error] — AI HTTP 400"
  );
  assert.equal(
    format({ errorMessage: "provider connection closed before a response" }),
    "Translation failed [AI_REQUEST_FAILED] — provider connection closed before a response"
  );
  assert.match(
    format({ errorMessage: "Bearer secret-value" }),
    /Bearer \[REDACTED\]/
  );
});

test("a live JSONL error replaces the pending ellipsis with its diagnostic", () => {
  const painted = [];
  const context = {
    Map,
    Number,
    String,
    YTDS_SHARED: loadShared(),
    captionSession: {
      activeGroupIdx: 0,
      activeCueIdx: 0,
      cueList: [{ text: "source", start: 0, end: 1000 }],
      semanticGroupToCommitRegion: [0],
      semanticExhaustedRegions: new Map(),
      semanticVisibleErrors: new Map([[0, {
        errorCode: "AI_JSONL_INVALID",
        errorMessage: "invalid JSONL line"
      }]]),
      transCache: new Map(),
      semanticDisplayCache: new Map()
    },
    groupKey: (id) => `video g${id}`,
    manualTranslationSelected: () => false,
    sourceForDisplayedCue: () => "source",
    clearPendingTimer: () => {},
    armPendingTranslationIndicator: () => {},
    setTranslation: (text, _source, kind) => painted.push({ text, kind }),
    t: (_key, fallback) => fallback
  };
  vm.createContext(context);
  vm.runInContext(displaySource, context, { filename: "content/display.js" });
  vm.runInContext("repaintActiveAiTranslation()", context);

  assert.deepEqual(painted.at(-1), {
    text: "Translation failed [AI_JSONL_INVALID] — invalid JSONL line",
    kind: "error"
  });
});

test("a partial JSONL error is retained while the commit range is retried", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0);
  vm.runInContext(displaySource, harness.context, { filename: "content/display.js" });
  const handle = vm.runInContext("handleAiBatchResult", harness.context);
  handle({
    regionIndex: 0, requestStart: 0, requestEnd: 159, reqVid: "video", reqEpoch: 1,
    requestId: "commit:0:1:0-159", urgent: true, itemCount: 160,
    maxRequestItems: 160, sessionToken: harness.context.captureCaptionSession()
  }, {
    ok: true, translations: [], partial: true, streamPartial: true,
    error: "invalid JSONL line", errorCode: "AI_JSONL_INVALID"
  }, null);

  const visibleError = harness.context.captionSession.semanticVisibleErrors.get(0);
  assert.equal(visibleError.errorCode, "AI_JSONL_INVALID");
  assert.equal(visibleError.providerCode, "");
  assert.equal(visibleError.errorMessage, "invalid JSONL line");
  assert.equal(harness.debug.some((entry) => entry.event === "batch-retry"), true);
  assert.equal(harness.timers.length, 1);
  assert.match(harness.painted.at(-1), /AI_JSONL_INVALID/);
});

test("a rate-limit code is painted instead of being replaced by no-progress", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0);
  vm.runInContext(displaySource, harness.context, { filename: "content/display.js" });
  const handle = vm.runInContext("handleAiBatchResult", harness.context);
  handle({
    regionIndex: 0, requestStart: 0, requestEnd: 159, reqVid: "video", reqEpoch: 1,
    requestId: "commit:0:1:0-159", urgent: true, sessionToken: harness.context.captureCaptionSession()
  }, {
    ok: false, error: "AI HTTP 429", errorCode: "HTTP_429",
    providerCode: "rate_limit_exceeded", rateLimited: true, retryAfterMs: 7000
  }, null);

  assert.match(harness.painted.at(-1), /HTTP_429/);
  assert.match(harness.painted.at(-1), /rate_limit_exceeded/);
  assert.doesNotMatch(harness.painted.at(-1), /AI_NO_PROGRESS/);
});

test("a cancelled commit response re-establishes a live writer", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    deferResponses: true
  });
  const request = {
    regionIndex: 0, requestStart: 0, requestEnd: 159, reqVid: "video", reqEpoch: 1,
    requestId: "commit:0:1:0-159", urgent: true,
    sessionToken: harness.context.captureCaptionSession()
  };
  const handle = vm.runInContext("handleAiBatchResult", harness.context);
  handle(request, {
    ok: false,
    error: "AI request cancelled",
    errorCode: "AI_CANCELLED",
    cancelled: true
  }, null);
  await new Promise((resolve) => setImmediate(resolve));

  const retried = harness.messages.filter((message) => message.type === "translateBatch");
  assert.equal(retried.length, 1);
  assert.equal(retried[0].requestStart, 0);
  assert.equal(retried[0].urgent, true);
});

test("retry exhaustion forwards the original error text to the subtitle state", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 3);
  const schedule = vm.runInContext("scheduleAiBatchRetry", harness.context);
  schedule(0, 0, 159, "video", 1, "provider connection closed", {
    urgent: true,
    error: { error: "provider connection closed" }
  });

  assert.equal(
    harness.context.captionSession.semanticExhaustedRegions.get(0).errorMessage,
    "provider connection closed"
  );
});

test("accelerated prefetch skips the live writer and uses the fast transport path", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    aiRequestItems: 96,
    windowItems: 80, targetThrough: 40, urgentTarget: 0, playbackRate: 3
  });
  const sessionToken = harness.context.captureCaptionSession();
  harness.context.captionSession.semanticRequestMeta.set("dsb:0", {
    requestId: "commit:0:1:0-79", regionIndex: 0, requestStart: 0,
    requestEnd: 79, urgent: true, reqEpoch: 1, reqVid: "video",
    sessionToken, focusGeneration: 0
  });
  harness.context.captionSession.transInflight.add("dsb:0");
  const callbacks = [];
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    callbacks.push(callback);
  };

  const queue = vm.runInContext("queueAiSpeculativeRequest", harness.context);
  queue(0, 80);
  queue(0, 176);
  queue(0, 272);

  assert.deepEqual(harness.messages.map((message) => message.requestStart), [80, 176, 272]);
  assert.ok(harness.messages.every((message) => message.urgent === false));
  assert.ok(harness.messages.every((message) => message.fastPath === true));
  callbacks[0]({ ok: false, error: "temporary prefetch failure", netfail: true });
  assert.equal(harness.messages[2].requestStart, 272);
});

test("Gemini Flash Lite uses the configured request window at ordinary playback", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 320, targetThrough: 0, urgentTarget: 0, playbackRate: 1,
    aiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", aiRateLimitRpm: 15,
    aiModel: "gemini-3.1-flash-lite-preview"
  });
  vm.runInContext("pumpAiCommitRegion(0, true)", harness.context);

  const requests = harness.messages.filter((message) => message.type === "translateBatch");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].maxConcurrency, 4);
  assert.equal(requests[0].items.length, 320, "the default request-items setting");

  const customHarness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 320, targetThrough: 0, urgentTarget: 0, playbackRate: 1,
    aiRequestItems: 160,
    aiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", aiRateLimitRpm: 15,
    aiModel: "gemini-3.1-flash-lite-preview"
  });
  vm.runInContext("pumpAiCommitRegion(0, true)", customHarness.context);
  const customRequests = customHarness.messages.filter((message) => message.type === "translateBatch");
  assert.equal(customRequests.length, 1);
  assert.equal(customRequests[0].items.length, 160);
});

// Lookahead runs as one sequential writer per region. Each request starts
// exactly at the committed cursor (a proven unit boundary), so playback never
// meets an uncovered gap and no window re-translates a finished range.
async function driveLookaheadLane(harness, maxSteps = 40) {
  const starts = [];
  for (let step = 0; step < maxSteps; step++) {
    const pending = harness.pendingCallbacks.filter((entry) => !entry.responded);
    if (!pending.length) break;
    assert.equal(pending.length, 1, "one region must have exactly one writer");
    const entry = pending[0];
    assert.equal(entry.message.requestStart, harness.state.cursor,
      "every request must start at the committed cursor");
    starts.push(entry.message.requestStart);
    entry.responded = true;
    entry.callback({
      ok: true,
      translations: rangeSemanticResponse(entry.message.requestStart, entry.message.requestEnd),
      deferredIds: [],
      httpDiagnostics: { attempts: [] }
    });
    for (let tick = 0; tick < 4; tick++) await new Promise((resolve) => setImmediate(resolve));
  }
  return starts;
}

for (const [label, providerOptions] of [
  ["DeepSeek", {}],
  ["Gemini", {
    aiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", aiRateLimitRpm: 15,
    aiModel: "gemini-3.5-flash-lite-preview", aiRequestItems: 320
  }],
  ["compatible", { aiBaseUrl: "https://gateway.example/v1", aiModel: "other-model" }]
]) {
  test(`3x ${label} playback keeps one gap-free lookahead writer within its prefetch budget`, async () => {
    const { harness, requests } = loadPlaybackPrefetchHarness({
      windowItems: 80, targetThrough: 40, urgentTarget: 0, playbackRate: 3,
      batchSize: 64, groupCount: 1201, limitEnd: 1200,
      maxPrefetchBatches: 12, fastPrefetchBatches: 6, highSpeedPrefetchBatches: 8,
      ...providerOptions
    });
    assert.equal(requests.length, 1, "no parallel staged windows before the first response");
    assert.equal(requests[0].requestStart, 0);
    assert.equal(requests[0].urgent, true);

    const starts = await driveLookaheadLane(harness);
    const lookaheadEnd = 8 * 32;
    // A wide window (Gemini) may cover the whole lookahead in one request;
    // narrower windows must keep continuing from the cursor.
    assert.ok(starts.length >= 2 || harness.state.cursor > 8 * 32,
      "the lane must reach the lookahead");
    assert.ok(harness.state.cursor > lookaheadEnd, "the lane must pass the lookahead end");
    assert.ok(starts.every((start) => start <= lookaheadEnd),
      "no request may start beyond the configured lookahead");
    const visibleThrough = harness.state.targetThrough;
    const sent = harness.messages.filter((message) => message.type === "translateBatch");
    assert.ok(sent.filter((message) => message.requestStart > visibleThrough)
      .every((message) => message.urgent === false),
      `lookahead beyond the visible target (${visibleThrough}) must not be urgent: ` +
      JSON.stringify(sent.map((m) => [m.requestStart, m.requestEnd, m.urgent])));
  });
}

test("a commit supersedes only the overlapping provisional prefix and reuses the future suffix", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 128, targetThrough: 160, urgentTarget: 0, playbackRate: 1,
    groupCount: 301, limitEnd: 300, deferResponses: true
  });
  const sessionToken = harness.context.captureCaptionSession();
  const prefetchRequest = {
    requestId: "prefetch:0:1:64-159", prefetch: true, regionIndex: 0,
    requestStart: 64, requestEnd: 191, commitFloor: 64, limitEnd: 300,
    effectiveGuardItems: 16, reqEpoch: 1, reqVid: "video", sessionToken,
    focusGeneration: 0, progressTranslations: [], progressRecoveryTranslations: []
  };
  const prefetchResponse = [
    ...unitSemanticResponse(64, 95, "semantic-64-95"),
    ...unitSemanticResponse(96, 159, "semantic-96-159"),
    ...unitSemanticResponse(160, 191, "semantic-160-191")
  ];
  const handle = vm.runInContext("handleAiBatchResult", harness.context);
  handle(prefetchRequest, {
    ok: true, translations: prefetchResponse, deferredIds: [],
    httpDiagnostics: { attempts: [] }
  }, null);
  assert.equal(harness.state.prefetchResponses.has(64), true);

  handle({
    requestId: "commit:0:2:0-127", urgent: true, regionIndex: 0,
    requestStart: 0, requestEnd: 127, commitFloor: 0, limitEnd: 300,
    effectiveGuardItems: 16, reqEpoch: 1, reqVid: "video", sessionToken,
    focusGeneration: 0, itemCount: 128, targetAwareItems: 128,
    maxRequestItems: 160
  }, {
    ok: true,
    translations: [
      ...unitSemanticResponse(0, 63, "semantic-0-63"),
      ...unitSemanticResponse(64, 95, "semantic-64-95", "commit translation"),
      ...unitSemanticResponse(96, 127, "semantic-96-127", "commit translation")
    ],
    deferredIds: [], httpDiagnostics: { attempts: [] }
  }, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.state.cursor, 160);
  assert.equal(harness.state.prefetchResponses.has(64), false);
  assert.equal(harness.context.captionSession.transCache.get("video g96"),
    "unit translation");
  assert.equal(harness.messages.some((message) =>
    message.type === "translateBatch" && message.requestStart === 96
  ), false);
  assert.equal(harness.debug.some((entry) =>
    entry.event === "semantic-prefetch-candidate-trimmed"
  ), true);
});

test("3x playback consumes a streamed future prefix before its response settles", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 95, urgentTarget: 80, playbackRate: 3,
    batchSize: 64, groupCount: 401, limitEnd: 400
  });
  harness.state.cursor = 80;
  harness.state.commitFloor = 80;
  harness.state.targetThrough = 95;
  harness.state.urgentTarget = 80;
  const sessionToken = harness.context.captureCaptionSession();
  const request = {
    requestId: "prefetch:0:1:80-175",
    prefetch: true,
    regionIndex: 0,
    requestStart: 80,
    requestEnd: 175,
    commitFloor: 80,
    limitEnd: 400,
    effectiveGuardItems: 16,
    reqEpoch: 1,
    reqVid: "video",
    sessionToken,
    focusGeneration: 0,
    progressTranslations: rangeSemanticResponse(80, 95),
    progressRecoveryTranslations: rangeSemanticResponse(80, 95)
  };
  harness.context.captionSession.semanticRequestMeta.set("dsp:0:80", request);
  harness.context.captionSession.transInflight.add("dsp:0:80");

  vm.runInContext("pumpAiCommitRegion(0, true)", harness.context);

  assert.equal(harness.state.cursor, 96);
  assert.equal(harness.context.captionSession.transCache.has("video g80"), true);
  assert.deepEqual(harness.messages, []);
});

test("a gapped future stream cannot block the accelerated urgent writer", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 95, urgentTarget: 80, playbackRate: 3,
    batchSize: 64, groupCount: 401, limitEnd: 400
  });
  harness.state.cursor = 80;
  harness.state.commitFloor = 80;
  harness.state.targetThrough = 95;
  harness.state.urgentTarget = 80;
  const sessionToken = harness.context.captureCaptionSession();
  const request = {
    requestId: "prefetch:0:1:80-175",
    prefetch: true,
    regionIndex: 0,
    requestStart: 80,
    requestEnd: 175,
    commitFloor: 80,
    limitEnd: 400,
    effectiveGuardItems: 16,
    reqEpoch: 1,
    reqVid: "video",
    sessionToken,
    focusGeneration: 0,
    progressTranslations: rangeSemanticResponse(96, 110),
    progressRecoveryTranslations: rangeSemanticResponse(96, 110)
  };
  harness.context.captionSession.semanticRequestMeta.set("dsp:0:80", request);
  harness.context.captionSession.transInflight.add("dsp:0:80");
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    if (typeof callback === "function") callback({ ok: true });
  };

  vm.runInContext("pumpAiCommitRegion(0, true)", harness.context);

  assert.equal(harness.messages[0].type, "cancelAiTranslationRequest");
  assert.equal(harness.messages[0].requestId, request.requestId);
  assert.ok(harness.messages.some((message) =>
    message.type === "translateBatch" && message.requestStart === 80 && message.urgent
  ));
});

test("a speculative provider 429 backs off and requeues the same range", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 200, urgentTarget: 0, playbackRate: 3,
    groupCount: 401, limitEnd: 400
  });
  const sessionToken = harness.context.captureCaptionSession();
  const request = {
    requestId: "prefetch:0:1:80-175",
    prefetch: true,
    regionIndex: 0,
    requestStart: 80,
    requestEnd: 175,
    reqEpoch: 1,
    reqVid: "video",
    sessionToken,
    focusGeneration: 0,
    progressTranslations: [],
    progressRecoveryTranslations: []
  };
  harness.context.captionSession.semanticRequestMeta.set("dsp:0:80", request);
  harness.context.captionSession.transInflight.add("dsp:0:80");
  // The production callback finishes ownership before handing the response
  // to the result handler; mirror that ordering so the retry is not mistaken
  // for a duplicate live writer.
  harness.context.captionSession.semanticRequestMeta.delete("dsp:0:80");
  harness.context.captionSession.transInflight.delete("dsp:0:80");

  const handle = vm.runInContext("handleAiBatchResult", harness.context);
  handle(request, {
    ok: false,
    rateLimited: true,
    retryAfterMs: 5000,
    limitReason: "provider-rate-limit"
  }, null);

  assert.equal(harness.state.prefetchQueued.has(80), true);
  assert.ok(harness.context.captionSession.semanticSpeculativeBackoffUntil > Date.now());
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.debug.some((entry) =>
    entry.event === "semantic-speculative-backoff"
  ), true);
});

test("speculative local concurrency backoff requeues and pauses further speculative requests", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 200, urgentTarget: 0, playbackRate: 3,
    groupCount: 401, limitEnd: 400
  });
  const sessionToken = harness.context.captureCaptionSession();
  const request = {
    requestId: "prefetch:0:1:80-175",
    prefetch: true,
    regionIndex: 0,
    requestStart: 80,
    requestEnd: 175,
    reqEpoch: 1,
    reqVid: "video",
    sessionToken,
    focusGeneration: 0,
    progressTranslations: [],
    progressRecoveryTranslations: []
  };
  harness.context.captionSession.semanticRequestMeta.set("dsp:0:80", request);
  harness.context.captionSession.transInflight.add("dsp:0:80");
  harness.context.captionSession.semanticRequestMeta.delete("dsp:0:80");
  harness.context.captionSession.transInflight.delete("dsp:0:80");

  const handle = vm.runInContext("handleAiBatchResult", harness.context);
  handle(request, {
    ok: false,
    rateLimited: true,
    retryAfterMs: 1500,
    limitReason: "local-concurrency"
  }, null);

  assert.equal(harness.state.prefetchQueued.has(80), true);
  assert.equal(harness.context.captionSession.semanticSpeculativeBackoffReason, "local-concurrency");
  assert.ok(harness.context.captionSession.semanticSpeculativeBackoffUntil > Date.now());
  assert.equal(harness.messages.length, 0);

  // While local-concurrency backoff is active, pumping speculative requests does not launch requests
  const pump = vm.runInContext("pumpAiSpeculativeRequests", harness.context);
  pump(0, harness.state);
  assert.equal(harness.messages.length, 0);
});

test("settling an active request clears local-concurrency backoff and pumps speculative queue", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 100, urgentTarget: 0, playbackRate: 3,
    groupCount: 401, limitEnd: 400, deferResponses: true
  });

  vm.runInContext("pumpAiCommitRegion(0, true)", harness.context);
  assert.equal(harness.pendingCallbacks.length, 1);

  harness.context.captionSession.semanticSpeculativeBackoffReason = "local-concurrency";
  harness.context.captionSession.semanticSpeculativeBackoffUntil = Date.now() + 5000;
  vm.runInContext("aiPrefetchState", harness.context)(harness.state);
  // Queued ahead of the cursor the response is about to commit.
  harness.state.prefetchQueued.add(200);
  harness.state.prefetchQueue.push(200);

  harness.messages.length = 0;

  harness.pendingCallbacks.shift().callback({
    ok: true,
    translations: giantSemanticResponse(false)
  });

  assert.equal(harness.context.captionSession.semanticSpeculativeBackoffReason, "");
  assert.equal(harness.context.captionSession.semanticSpeculativeBackoffUntil, 0);
  // The visible target is committed, so the speculative queue resumes.
  assert.ok(harness.messages.some((msg) => msg.type === "translateBatch" && msg.requestStart === 200));
});

test("lookahead crosses a hard pause by starting the next region at its true start", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    groupCount: 64, limitEnd: 63, prefetchBatches: 4
  });
  harness.context.AI_MAX_PREFETCH_BATCHES = 12;
  harness.context.captionSession.semanticCommitRegions = [
    { start: 0, end: 31 },
    { start: 32, end: 63 }
  ];
  harness.context.captionSession.semanticCommitRegions = harness.context.captionSession.semanticCommitRegions;
  harness.context.captionSession.semanticGroupToCommitRegion = [
    ...new Array(32).fill(0),
    ...new Array(32).fill(1)
  ];
  harness.context.captionSession.semanticGroupToCommitRegion = harness.context.captionSession.semanticGroupToCommitRegion;
  harness.context.captionSession.semanticBatchWindows = [
    { start: 0, end: 15 },
    { start: 16, end: 31 },
    { start: 32, end: 47 },
    { start: 48, end: 63 }
  ];
  harness.context.captionSession.semanticBatchWindows = harness.context.captionSession.semanticBatchWindows;
  harness.context.captionSession.semanticGroupToBatch = [
    ...new Array(16).fill(0),
    ...new Array(16).fill(1),
    ...new Array(16).fill(2),
    ...new Array(16).fill(3)
  ];
  harness.context.captionSession.semanticGroupToBatch = harness.context.captionSession.semanticGroupToBatch;

  vm.runInContext(playbackSource, harness.context, { filename: "content/cue-playback.js" });
  const prefetchBatches = vm.runInContext("prefetchAiBatches", harness.context);
  prefetchBatches(0, false);

  const requests = harness.messages.filter((msg) => msg.type === "translateBatch");
  // One request starts at region 0 and spans region 1 from its true start;
  // never a mid-region start such as 16 or 48 that would leave a gap.
  assert.deepEqual(requests.map((msg) => [msg.requestStart, msg.requestEnd]), [[0, 63]]);
  assert.equal(harness.context.captionSession.semanticCommitStateByRegion.get(1).lookaheadThrough, 63);
});

test("non-urgent aiRequestBatch on an inactive region does not commit", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    groupCount: 64, limitEnd: 63
  });
  harness.context.captionSession.activeGroupIdx = 5;
  harness.context.captionSession.semanticCommitRegions = [
    { start: 0, end: 31 },
    { start: 32, end: 63 }
  ];
  harness.context.captionSession.semanticCommitRegions = harness.context.captionSession.semanticCommitRegions;
  harness.context.captionSession.semanticGroupToCommitRegion = [
    ...new Array(32).fill(0),
    ...new Array(32).fill(1)
  ];
  harness.context.captionSession.semanticGroupToCommitRegion = harness.context.captionSession.semanticGroupToCommitRegion;

  const requestBatch = vm.runInContext("aiRequestBatch", harness.context);
  requestBatch(32, true, false);

  assert.equal(harness.messages.some((msg) => msg.requestStart === 32), false);
  assert.equal(harness.context.captionSession.semanticRequestMeta.has("dsb:1"), false);
});

test("entering a new semantic region cancels obsolete old-region writers", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 40, urgentTarget: 0, playbackRate: 3
  });
  const oldRequest = {
    requestId: "commit:old:0-79", regionIndex: -1, requestStart: 0, requestEnd: 79,
    urgent: false, reqEpoch: 1, reqVid: "video"
  };
  harness.context.captionSession.semanticRequestMeta.set("dsb:-1", oldRequest);
  harness.context.captionSession.transInflight.add("dsb:-1");
  harness.context.sendRuntimeMessage = (message) => harness.messages.push(message);

  vm.runInContext("aiRequestBatch(0, true, true)", harness.context);

  assert.equal(harness.messages[0].type, "cancelAiTranslationRequest");
  assert.equal(harness.messages[0].requestId, oldRequest.requestId);
  assert.equal(harness.context.captionSession.semanticRequestMeta.has("dsb:-1"), false);
  assert.equal(harness.messages[1].type, "translateBatch");
});

test("entering a new semantic region preserves future runway requests", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 40, urgentTarget: 0, playbackRate: 3
  });
  const oldRequest = {
    requestId: "prefetch:old", regionIndex: 0, requestStart: 0, requestEnd: 79,
    prefetch: true, urgent: false, reqEpoch: 1, reqVid: "video"
  };
  const futureRequest = {
    requestId: "prefetch:future", regionIndex: 2, requestStart: 160, requestEnd: 255,
    prefetch: true, urgent: false, reqEpoch: 1, reqVid: "video"
  };
  harness.context.captionSession.semanticRequestMeta.set("dsp:0:0", oldRequest);
  harness.context.captionSession.semanticRequestMeta.set("dsp:2:160", futureRequest);
  harness.context.captionSession.transInflight.add("dsp:0:0");
  harness.context.captionSession.transInflight.add("dsp:2:160");
  harness.context.sendRuntimeMessage = (message) => harness.messages.push(message);

  vm.runInContext("cancelAiRequestsBeforeRegion(1)", harness.context);

  assert.deepEqual(harness.messages.map((message) => message.requestId), [oldRequest.requestId]);
  assert.equal(harness.context.captionSession.semanticRequestMeta.has("dsp:0:0"), false);
  assert.equal(harness.context.captionSession.semanticRequestMeta.has("dsp:2:160"), true);
  assert.equal(harness.context.captionSession.transInflight.has("dsp:2:160"), true);
});

test("a future response bridge keeps only the boundary overlap", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 200, urgentTarget: 64, playbackRate: 3
  });
  harness.state.cursor = 64;
  harness.state.commitFloor = 64;
  harness.state.targetThrough = 200;
  harness.state.urgentTarget = 64;
  const sessionToken = harness.context.captureCaptionSession();
  harness.context.captionSession.semanticRequestMeta.set("dsp:0:80", {
    requestId: "prefetch:0:1:80-175", prefetch: true, regionIndex: 0,
    requestStart: 80, requestEnd: 175, urgent: false,
    reqEpoch: 1, reqVid: "video", sessionToken, focusGeneration: 0
  });
  harness.context.captionSession.transInflight.add("dsp:0:80");
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    harness.callback = callback;
  };

  const pump = vm.runInContext("pumpAiCommitRegion", harness.context);
  pump(0, true);
  assert.equal(harness.messages[0].requestStart, 64);
  // The bridge still targets the future response, but never below the
  // minimum useful window (twice the uncommitted runway).
  assert.equal(harness.messages[0].requestEnd, 127);
  assert.equal(harness.debug.some((entry) => entry.event === "semantic-prefetch-bridge"), true);

  harness.messages.length = 0;
  harness.context.captionSession.semanticRequestMeta.delete("dsb:0");
  harness.context.captionSession.transInflight.delete("dsb:0");
  harness.state.cursor = 80;
  harness.state.commitFloor = 80;
  pump(0, true);
  assert.deepEqual(harness.messages, []);
});

test("a bridge overlaps an adjacent future start so a cross-join unit can resolve", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    playbackRate: 3
  });
  const bridge = vm.runInContext("aiBridgeRequestItems", harness.context);
  assert.equal(bridge(80, 81, 160, 500), 33);
});

test("bridge sizing mathematically guarantees positive commit progress and crosses gap across random intervals", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    playbackRate: 3
  });
  const bridge = vm.runInContext("aiBridgeRequestItems", harness.context);
  const guardStartHelper = vm.runInContext("YTDS_SHARED.semanticCommitGuardStart", harness.context);
  const minRunway = vm.runInContext("AI_MIN_COMMIT_RUNWAY_ITEMS", harness.context);
  const guardLimit = vm.runInContext("AI_COMMIT_GUARD_ITEMS", harness.context);

  let seed = 0x7c3a91;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let run = 0; run < 500; run++) {
    const requestStart = Math.floor(random() * 5000);
    const gap = 1 + Math.floor(random() * 100);
    const futureStart = requestStart + gap;
    const maxItems = 64 + Math.floor(random() * 144); // 64..208
    const limitEnd = futureStart + 100 + Math.floor(random() * 500);

    const count = bridge(requestStart, futureStart, maxItems, limitEnd);
    if (count > 0) {
      assert.ok(count >= gap + 1, `Bridge count ${count} must overlap futureStart (gap ${gap}) at run ${run}`);
      assert.ok(count <= maxItems, `Bridge count ${count} must not exceed maxItems ${maxItems} at run ${run}`);

      const requestEnd = requestStart + count - 1;
      const guardStart = guardStartHelper(requestStart, requestEnd, limitEnd, guardLimit, minRunway);

      // Invariant 1: guardStart must reach or cross futureStart, guaranteeing the gap can be committed without deadlock
      assert.ok(guardStart >= futureStart,
        `Bridge guardStart ${guardStart} must reach or exceed futureStart ${futureStart} (gap ${gap}, count ${count}) at run ${run}`);

      // Invariant 2: guardStart must exceed requestStart, guaranteeing non-zero commit capacity
      assert.ok(guardStart > requestStart,
        `Bridge must have positive commit capacity at run ${run}`);
    } else {
      // If bridge returned 0, it must be because maxItems cannot satisfy both gap and minimum runway
      const runwayHelper = vm.runInContext("YTDS_SHARED.semanticCommitRunwayItems", harness.context);
      const minRunwayItems = runwayHelper(maxItems, guardLimit, minRunway);
      assert.ok(maxItems - minRunwayItems < gap,
        `Bridge returned 0 but maxItems ${maxItems} could satisfy gap ${gap} with runway ${minRunwayItems}`);
    }
  }
});

test("a max-planned short bridge recovers past its future join instead of exhausting retries", async () => {
  const translations = Array.from({ length: 3 }, (_value, id) => ({
    id: String(id), unitId: "semantic-0-2", translation: "joined translation"
  }));
  const harness = loadSemanticCommitHarness(translations, 0, {
    windowItems: 160, targetThrough: 100, urgentTarget: 0, playbackRate: 3,
    groupCount: 301, limitEnd: 300, deferResponses: true, maxRequestItems: 160
  });
  const sessionToken = harness.context.captureCaptionSession();
  harness.context.captionSession.semanticRequestMeta.set("dsp:0:2", {
    requestId: "prefetch:0:1:2-97", prefetch: true, regionIndex: 0,
    requestStart: 2, requestEnd: 97, urgent: false,
    reqEpoch: 1, reqVid: "video", sessionToken, focusGeneration: 0
  });
  harness.context.captionSession.transInflight.add("dsp:0:2");

  const handle = vm.runInContext("handleAiBatchResult", harness.context);
  handle({
    requestId: "commit:0:2:0-2", urgent: true, regionIndex: 0,
    requestStart: 0, requestEnd: 2, commitFloor: 0, limitEnd: 300,
    effectiveGuardItems: 1, reqEpoch: 1, reqVid: "video", sessionToken,
    focusGeneration: 0, itemCount: 3, targetAwareItems: 160, maxRequestItems: 160
  }, {
    ok: true, translations, deferredIds: [], httpDiagnostics: { attempts: [] }
  }, null);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.timers.length, 0);
  assert.equal(harness.state.recoveryWindowItems, true);
  assert.equal(harness.pendingCallbacks[0].message.requestStart, 0);
  assert.equal(harness.pendingCallbacks[0].message.requestEnd, 159);
});

test("adaptive no-progress enters recovery instead of replaying the same cached bridge", async () => {
  const translations = Array.from({ length: 10 }, (_value, id) => ({
    id: String(id), unitId: id < 5 ? "semantic-0-4" : "semantic-5-9",
    translation: "guarded translation"
  }));
  const harness = loadSemanticCommitHarness(translations, 0, {
    windowItems: 160, targetThrough: 100, urgentTarget: 0, playbackRate: 3,
    groupCount: 301, limitEnd: 300, deferResponses: true, maxRequestItems: 160
  });
  harness.state.commitFloor = 10;
  const sessionToken = harness.context.captureCaptionSession();
  harness.context.captionSession.semanticRequestMeta.set("dsp:0:9", {
    requestId: "prefetch:0:1:9-104", prefetch: true, regionIndex: 0,
    requestStart: 9, requestEnd: 104, reqEpoch: 1, reqVid: "video",
    sessionToken, focusGeneration: 0
  });

  const handle = vm.runInContext("handleAiBatchResult", harness.context);
  handle({
    requestId: "commit:0:2:0-9", urgent: true, regionIndex: 0,
    requestStart: 0, requestEnd: 9, commitFloor: 10, limitEnd: 300,
    effectiveGuardItems: 3, reqEpoch: 1, reqVid: "video", sessionToken,
    focusGeneration: 0, itemCount: 10, targetAwareItems: 160, maxRequestItems: 160
  }, { ok: true, translations, deferredIds: [], httpDiagnostics: { attempts: [] } }, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.state.recoveryWindowItems, true);
  assert.equal(harness.timers.length, 0);
  assert.equal(harness.pendingCallbacks[0].message.requestStart, 0);
  assert.equal(harness.pendingCallbacks[0].message.requestEnd, 159);
});

test("a repeated no-progress range is delayed and bypasses cache", async () => {
  const translations = Array.from({ length: 10 }, (_value, id) => ({
    id: String(id), unitId: id < 5 ? "semantic-0-4" : "semantic-5-9",
    translation: "guarded translation"
  }));
  const harness = loadSemanticCommitHarness(translations, 0, {
    windowItems: 42, targetThrough: 100, urgentTarget: 0, playbackRate: 3,
    groupCount: 301, limitEnd: 300, deferResponses: true
  });
  harness.state.commitFloor = 10;
  harness.state.recoveryWindowItems = true;
  harness.state.noProgressRange = "0:9";
  const handle = vm.runInContext("handleAiBatchResult", harness.context);
  handle({
    requestId: "commit:0:3:0-9", urgent: true, regionIndex: 0,
    requestStart: 0, requestEnd: 9, commitFloor: 10, limitEnd: 300,
    effectiveGuardItems: 3, reqEpoch: 1, reqVid: "video",
    sessionToken: harness.context.captureCaptionSession(), focusGeneration: 0,
    itemCount: 10, targetAwareItems: 42, maxRequestItems: 160
  }, { ok: true, translations, deferredIds: [], httpDiagnostics: { attempts: [] } }, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.pendingCallbacks.length, 0);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.debug.some((entry) => entry.event === "batch-retry"), true);
});

test("same-language captions are shown directly without translation requests", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    targetLang: "en",
    sourceLang: "en",
    deferResponses: true
  });
  harness.context.settings.enabled = true;
  harness.context.AI_MAX_PREFETCH_BATCHES = 0;
  harness.context.PENDING_ELLIPSIS_MS = 400;
  harness.context.captionSession.activeGroupIdx = 0;
  vm.runInContext(playbackSource, harness.context, { filename: "content/cue-playback.js" });

  vm.runInContext("prefetchFrom(0)", harness.context);
  vm.runInContext(
    "renderTranslationForCue(0, { text: 'same-language source' }, 'same-language source', false)",
    harness.context
  );

  assert.equal(harness.messages.some((message) => message.type === "translateBatch"), false);
  assert.deepEqual(harness.painted, [""]);
});

test("accelerated playback prefetches the current semantic batch before promotion", () => {
  const calls = [];
  const requestedAhead = [];
  const batchStarts = Array.from({ length: 9 }, (_value, index) => index);
  const context = {
    Number,
    settings: { enabled: true, aiPrefetchBatches: 3 },
    captionSession: {
      cueList: [{ start: 0, end: 1000 }],
      cueToGroup: [0],
      cueToGroups: [[0]],
      sentGroups: batchStarts.map((group) => ({ start: group, end: group })),
      semanticBatchWindows: batchStarts.map((group) => ({ start: group, end: group })),
      semanticGroupToBatch: batchStarts,
      activeCueIdx: 0,
      activeGroupIdx: 0
    },
    getVideo: () => ({ playbackRate: 3 }),
    aiRequestBatch: (group, _includePredecessor, urgent) =>
      calls.push({ group, urgent: !!urgent }),
    YTDS_SHARED: {
      isSameLanguage: () => false,
      semanticPrefetchBatchStarts: (_group, _mapping, _windows, ahead) => {
        requestedAhead.push(ahead);
        return batchStarts.slice(1, ahead + 1);
      }
    },
    AI_MAX_PREFETCH_BATCHES: 10,
    aiGroupForCueAt: () => 0
  };
  vm.createContext(context);
  vm.runInContext(playbackSource, context, { filename: "content/cue-playback.js" });
  vm.runInContext("prefetchFrom(0)", context);
  // A 3-batch setting raised to round(3 + 1) = 4 at 3x.
  assert.deepEqual(requestedAhead, [4]);
  assert.deepEqual(calls, [
    { group: 0, urgent: true },
    ...batchStarts.slice(1, 5).map((group) => ({ group, urgent: false }))
  ]);
});

test("same-group playback watchdog and rate change re-arm accelerated current prefetch", () => {
  const calls = [];
  const sessionToken = Object.freeze({ revision: 1 });
  const context = {
    Map, Set, Date, Math, Number, String, Array, Object, Promise,
    groupKey: (id) => `video g${id}`,
    settings: { enabled: true, aiPrefetchBatches: 0 },
    captionSession: {
      cueList: [{ text: "source", start: 0, end: 1000 }],
      cueToGroup: [0], cueToGroups: [[0]],
      sentGroups: [{ start: 0, end: 0, hardAfter: false }],
      semanticBatchWindows: [{ start: 0, end: 0 }],
      semanticGroupToBatch: [0], semanticGroupToCommitRegion: [0],
      semanticExhaustedRegions: new Set(), transCache: new Map(),
      semanticDisplayCache: new Map(), semanticSourceCache: new Map(),
      semanticUnitCache: new Map(), activeCueIdx: 0, activeGroupIdx: 0,
      semanticSeekSettling: false, pendingTimer: null, pendingIndicatorKey: "",
      cueVideoId: "video", currentVideoId: "video", cueEpoch: 1,
      semanticFocusGeneration: 0
    },
    getVideo: () => ({ currentTime: 0, playbackRate: 3 }),
    AI_MAX_PREFETCH_BATCHES: 10,
    extensionContextAlive: () => true,
    maybeReflowSemanticDisplay: () => {},
    armPendingTranslationIndicator: () => {},
    aiRequestBatch: (group, includePredecessor, urgent) => {
      calls.push({ group, includePredecessor, urgent: !!urgent });
      context.captionSession.transCache.set("video g0", "ready");
    },
    YTDS_SHARED: {
      isSameLanguage: () => false,
      semanticPrefetchBatchStarts: () => [],
      pendingTranslationScopeKey: () => "ai-batch:0"
    },
    captureCaptionSession: () => sessionToken,
    isCaptionSessionCurrent: (token) => token === sessionToken,
    manualTranslationSelected: () => false,
    manualTranslationTextAt: () => "",
    emitDebug: () => {}, emitCaptionStateTransition: () => {},
    clearPendingTimer: () => {}, setOriginal: () => {}, setTranslation: () => {},
    t: (_key, fallback) => fallback
  };
  vm.createContext(context);
  vm.runInContext(playbackSource, context, { filename: "content/cue-playback.js" });
  vm.runInContext("cueTick({ type: 'timeupdate' })", context);
  assert.deepEqual(calls, [{ group: 0, includePredecessor: true, urgent: true }]);
  calls.length = 0;
  context.captionSession.transCache.clear();
  vm.runInContext("cueTick({ type: 'ratechange' })", context);
  assert.deepEqual(calls, [{ group: 0, includePredecessor: true, urgent: true }]);
});

test("cached translations are normalized again while preserving sentence spacing", () => {
  const cached = [
    {
      id: "0",
      unitId: "semantic-0-1",
      translation: "缓存。译文。",
      alignedChunks: [{ ids: ["0", "1"], translation: "缓存。译文。" }]
    },
    { id: "1", unitId: "semantic-0-1", translation: "缓存。译文。" }
  ];
  const harness = loadSemanticCommitHarness(cached, 0);
  const commit = vm.runInContext("commitAiResponsePrefix", harness.context);
  const nextCursor = commit(0, 0, 1, 0, 500, cached, 0);

  assert.equal(nextCursor, 2);
  assert.equal(harness.context.captionSession.transCache.get("video g0"), "缓存 译文");
  assert.equal(
    harness.context.captionSession.semanticAlignedChunksCache.get("semantic-0-1")[0].translation,
    "缓存 译文"
  );
});

test("an unrecoverable no-progress response keeps a bounded budget and bypasses cache", () => {
  // A unit as large as the window cap can never commit: the retry budget applies.
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 2, { maxRequestItems: 160 });
  const pump = vm.runInContext("pumpAiCommitRegion", harness.context);
  pump(0, true);

  const retry = harness.debug.find((entry) => entry.event === "batch-retry");
  assert.equal(retry.data.attempt, 3);
  assert.equal(harness.context.captionSession.semanticRetryCounts.get(harness.retryKey), 3);
  assert.equal(harness.timers.length, 1);

  const retried = [];
  harness.context.aiRequestBatch = (...args) => retried.push(args);
  harness.timers[0].callback();
  assert.equal(retried[0][3].bypassCache, true);

  const schedule = vm.runInContext("scheduleAiBatchRetry", harness.context);
  schedule(0, 0, 159, "video", 1, "no immutable semantic prefix", {
    urgent: true, bypassCache: true,
    errorCode: "HTTP_400", providerCode: "invalid_request_error"
  });
  assert.equal(harness.debug.at(-1).event, "batch-retry-exhausted");
  assert.equal(harness.context.captionSession.semanticExhaustedRegions.has(0), true);
  assert.equal(harness.painted.at(-1), "Translation failed [HTTP_400 / invalid_request_error]");
});

test("a non-retryable provider response is painted at the active subtitle", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0);
  const handle = vm.runInContext("handleAiBatchResult", harness.context);
  handle({
    regionIndex: 0, requestStart: 0, requestEnd: 159, reqVid: "video", reqEpoch: 1,
    requestId: "commit:0:1:0-159", urgent: true,
    sessionToken: harness.context.captureCaptionSession()
  }, {
    ok: false,
    error: "AI HTTP 400",
    errorCode: "HTTP_400",
    providerCode: "invalid_request_error"
  }, null);

  assert.equal(harness.painted.at(-1), "Translation failed [HTTP_400 / invalid_request_error]");
  assert.equal(harness.context.captionSession.semanticExhaustedRegions.get(0).errorCode, "HTTP_400");
});

test("an invalidated semantic retry timer cannot resurrect its request", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, { maxRequestItems: 160 });
  const pump = vm.runInContext("pumpAiCommitRegion", harness.context);
  pump(0, true);
  assert.equal(harness.timers.length, 1);

  const retried = [];
  harness.context.aiRequestBatch = (...args) => retried.push(args);
  harness.invalidateSession();
  harness.timers[0].callback();

  assert.deepEqual(retried, []);
  assert.equal(
    harness.context.captionSession.semanticRetryCounts.has(harness.retryKey),
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
    AI_BATCH_INFLIGHT: new Map(),
    getAiConfig: async () => ({ model: "model", endpointKind: "compatible", extraBody: {} }),
    aiResponseCacheId: () => "cache-id",
    readAiResponseCache: async () => { cacheReads++; return cached; },
    writeAiResponseCache: async () => { cacheWrites++; },
    aiSegmentBatchFetch: async () => fresh
  };
  vm.createContext(context);
  vm.runInContext(translationSource, context, { filename: "background/translation.js" });
  context.aiSegmentBatchFetch = async () => { freshRequests++; return fresh; };
  const translate = vm.runInContext("aiTranslateBatch", context);
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
      semanticSeekSettleTimer: null,
      semanticSeekSettling: false,
      semanticPendingSeekTimeMs: 0,
      semanticFocusGeneration: 7
    },
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
    sendRuntimeMessage: (message) => messages.push(message),
    AI_SEEK_SETTLE_MS: 140
  };
  vm.createContext(context);
  vm.runInContext(playbackSource, context, { filename: "content/cue-playback.js" });
  const begin = vm.runInContext("beginAiSeek", context);
  const finish = vm.runInContext("finishAiSeek", context);
  begin(1000);
  finish(2000);
  finish(3000);
  assert.equal(context.captionSession.semanticFocusGeneration, 7);
  assert.equal(messages.length, 0);
  assert.equal(context.captionSession.semanticSeekSettling, true);
  assert.equal(context.captionSession.semanticPendingSeekTimeMs, 3000);
  assert.equal(timers.length, 3);
});

test("webRequest diagnostics preserve Chromium's underlying net error", () => {
  const listeners = {};
  const filters = {};
  const event = (name) => ({
    addListener: (listener, filter) => { listeners[name] = listener; filters[name] = filter; }
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
  for (const name of ["before", "error", "completed"]) {
    assert.equal(filters[name].tabId, -1, `${name} must not observe page traffic`);
  }
});

test("a request the extension stopped itself is not logged as a network failure", () => {
  // The worker cancels a stream once enough units arrived; Chromium then
  // reports net::ERR_FAILED for that request (seen after every early stop).
  const listeners = {};
  const event = (name) => ({ addListener: (listener) => { listeners[name] = listener; } });
  const debug = [];
  const context = {
    Map,
    Date,
    chrome: { webRequest: {
      onBeforeSendHeaders: event("before"), onErrorOccurred: event("error"), onCompleted: event("completed")
    } },
    appendDebug: (...args) => debug.push(args)
  };
  vm.createContext(context);
  vm.runInContext(networkSource, context, { filename: "background/network.js" });
  const send = (requestId, traceId) => listeners.before({
    requestId, requestHeaders: [{ name: "X-CaptionAI-Trace", value: traceId }],
    timeStamp: Date.now(), url: "https://api.deepseek.com/chat/completions"
  });
  const fail = (requestId) => listeners.error({
    requestId, error: "net::ERR_FAILED", timeStamp: Date.now(), fromCache: false, tabId: -1, type: "xmlhttprequest"
  });
  const lookup = vm.runInContext("aiNetworkFailureForTrace", context);
  const markStopped = vm.runInContext("markAiNetworkTraceStopped", context);

  send("r1", "commit:1:2:0-95.1");
  markStopped("commit:1:2:0-95.1", "commit-guard-reached");
  fail("r1");
  assert.equal(lookup("commit:1:2:0-95.1"), null);
  assert.deepEqual(debug.map((entry) => entry[1]), ["ai-network-stopped"]);
  assert.equal(debug[0][2].reason, "commit-guard-reached");

  // A failure the extension did not cause is still a network error.
  send("r2", "commit:1:3:96-191.1");
  fail("r2");
  assert.equal(lookup("commit:1:3:96-191.1").error, "net::ERR_FAILED");
  assert.equal(debug.at(-1)[1], "ai-network-error");
});

test("a commit window is never shorter than twice the uncommitted runway, except at a region end", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 48, targetThrough: 10, urgentTarget: -1, playbackRate: 1,
    groupCount: 801, limitEnd: 800, deferResponses: true
  });
  // A non-urgent lane would otherwise use its 48-item window.
  vm.runInContext("pumpAiCommitRegion(0, false)", harness.context);
  const first = harness.messages.find((message) => message.type === "translateBatch");
  assert.ok(first.items.length >= 64, "at least twice the 32-item runway");
  // The background may stop streaming where this request's runway begins.
  assert.equal(first.commitGuardLocal, first.items.length - 32);

  const tail = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 48, targetThrough: 10, urgentTarget: -1, playbackRate: 1,
    groupCount: 21, limitEnd: 20, deferResponses: true
  });
  vm.runInContext("pumpAiCommitRegion(0, false)", tail.context);
  const short = tail.messages.find((message) => message.type === "translateBatch");
  assert.equal(short.items.length, 21, "a region end needs no runway");
  assert.equal(short.commitGuardLocal, -1, "every unit can commit, so stream to the end");
});

test("a speculative window never overlaps a finished response still waiting for the cursor", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 96, targetThrough: 0, urgentTarget: -1, playbackRate: 1,
    groupCount: 801, limitEnd: 800, deferResponses: true
  });
  const store = vm.runInContext("storeAiPrefetchCandidate", harness.context);
  const sessionToken = harness.context.captureCaptionSession();
  store(harness.state, {
    requestId: "prefetch:0:1:352-447", prefetch: true, regionIndex: 0,
    requestStart: 352, requestEnd: 447, commitFloor: 352, limitEnd: 800,
    reqEpoch: 1, reqVid: "video", sessionToken, focusGeneration: 0
  }, { ok: true, translations: rangeSemanticResponse(352, 447), deferredIds: [] });
  harness.state.cursor = 331;

  // The log showed 384-479 and 416-511 launched over a finished 352-447.
  vm.runInContext("queueAiSpeculativeRequest(0, 384)", harness.context);
  const launched = harness.messages.filter((message) => message.type === "translateBatch");
  assert.equal(launched.length, 1);
  assert.equal(launched[0].requestStart, 448);
});

test("one request carries across short hard-pause regions", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 96, targetThrough: -1, urgentTarget: -1, playbackRate: 1,
    groupCount: 600, limitEnd: 19, deferResponses: true, prefetchBatches: 4,
    aiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", aiRateLimitRpm: 15,
    aiModel: "gemini-3.5-flash-lite-preview", aiRequestItems: 96
  });
  const session = harness.context.captionSession;
  session.semanticCommitRegions = [{ start: 0, end: 19 }, { start: 20, end: 29 }, { start: 30, end: 599 }];
  session.semanticGroupToCommitRegion = [
    ...new Array(20).fill(0), ...new Array(10).fill(1), ...new Array(570).fill(2)
  ];
  harness.context.AI_MAX_PREFETCH_BATCHES = 12;
  vm.runInContext(playbackSource, harness.context, { filename: "content/cue-playback.js" });
  vm.runInContext("advanceAiLookahead(0)", harness.context);

  const sent = () => harness.messages.filter((message) => message.type === "translateBatch");
  assert.equal(sent().length, 1, "one request, not one per region");
  assert.equal(sent()[0].requestStart, 0);
  const end = sent()[0].requestEnd;
  assert.ok(end > 30 && end < 599, "the request ends inside the third region");
  assert.equal(sent()[0].commitGuardLocal, end + 1 - 32, "only the last, partial region keeps a runway");

  const pending = harness.pendingCallbacks[0];
  pending.responded = true;
  pending.callback({ ok: true, translations: rangeSemanticResponse(0, end), deferredIds: [], httpDiagnostics: { attempts: [] } });
  for (let tick = 0; tick < 6; tick++) await new Promise((resolve) => setImmediate(resolve));

  const cursor = (index) => session.semanticCommitStateByRegion.get(index).cursor;
  assert.equal(cursor(0), 20);
  assert.equal(cursor(1), 30, "the second region commits from the shared response");
  assert.equal(cursor(2), end + 1 - 32, "the third region commits up to its runway");
  // The wide window already ran past the lookahead reach: nothing more to
  // fetch until playback catches up.
  assert.equal(sent().length, 1);
  vm.runInContext(`advanceAiLookahead(${end - 64})`, harness.context);
  for (let tick = 0; tick < 6; tick++) await new Promise((resolve) => setImmediate(resolve));
  const next = sent().slice(1);
  assert.equal(next.length, 1, "the lane continues with one request");
  assert.equal(next[0].requestStart, end + 1 - 32);
});
