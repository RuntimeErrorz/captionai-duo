"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const root = path.resolve(__dirname, "..");
const httpSource = fs.readFileSync(path.join(root, "background/http.js"), "utf8");
const semanticSource = ["content/semantic-requests.js", "content/semantic.js"].map((file) =>
  fs.readFileSync(path.join(root, file), "utf8")).join("\n");
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

function rangeSemanticResponse(start, end) {
  return Array.from({ length: Math.max(0, end - start + 1) }, (_value, offset) => ({
    id: String(start + offset),
    unitId: `semantic-${start + offset}`,
    translation: "range translation"
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
      deepseekCommitRegions: [{ start: 0, end: limitEnd }],
      deepseekGroupToCommitRegion: new Array(groupCount).fill(0),
      deepseekCommitStateByRegion: new Map([[0, state]]),
      deepseekGroupToBatch: batchSize
        ? groups.map((_group, id) => Math.floor(id / batchSize))
        : new Array(groupCount).fill(0),
      deepseekBatchWindows: batchWindows,
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
    settings: {
      targetLang: options.targetLang || "zh-CN", debugEnabled: true,
      aiBaseUrl: options.aiBaseUrl || "https://api.deepseek.com"
    },
    DEEPSEEK_INITIAL_REQUEST_ITEMS: 48,
    DEEPSEEK_REQUEST_ITEMS: 80,
    DEEPSEEK_URGENT_REQUEST_ITEMS: 96,
    DEEPSEEK_ACCELERATED_URGENT_REQUEST_ITEMS: 64,
    DEEPSEEK_HIGH_SPEED_URGENT_REQUEST_ITEMS: 48,
    COMPATIBLE_ACCELERATED_URGENT_REQUEST_ITEMS: 80,
    COMPATIBLE_HIGH_SPEED_URGENT_REQUEST_ITEMS: 80,
    DEEPSEEK_NORMAL_MAX_REQUEST_ITEMS: 160,
    DEEPSEEK_MAX_REQUEST_ITEMS: 320,
    DEEPSEEK_HIGH_SPEED_MAX_REQUEST_ITEMS: 160,
    DEEPSEEK_MAX_CURRENT_CHARS: 18000,
    DEEPSEEK_COMMIT_GUARD_ITEMS: 16,
    DEEPSEEK_URGENT_TARGET_TAIL_ITEMS: 48,
    DEEPSEEK_FAST_TARGET_TAIL_ITEMS: 192,
    DEEPSEEK_HIGH_SPEED_TARGET_TAIL_ITEMS: 224,
    DEEPSEEK_SEEK_BACKTRACK_ITEMS: 64,
    DEEPSEEK_SEEK_LEFT_GUARD_ITEMS: 16,
    DEEPSEEK_FAST_PREFETCH_BATCHES: 6,
    DEEPSEEK_HIGH_SPEED_PREFETCH_BATCHES: 8,
    DEEPSEEK_CONTEXT_GROUPS: 20,
    DEEPSEEK_COLD_RETRY_DELAYS_MS: Object.freeze([400, 1200, 2500]),
    DEEPSEEK_RATE_RETRY_LIMIT: 6,
    emitDebug: (event, data) => debug.push({ event, data }),
    emitCaptionStateTransition: (machine, transition, data) =>
      debug.push({ event: "state-transition", data: { machine, transition, ...data } }),
    mergeCueTexts: (items) => items.map((item) => item.text).join(" "),
    cacheDeepseekDisplayNeighborhood: () => {},
    semanticDisplayWidth: () => 1000,
    repaintActiveDeepseekTranslation: () => {},
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
    aiBaseUrl: options.aiBaseUrl
  });
  harness.context.settings.enabled = true;
  for (const [name, value] of Object.entries({
    DEEPSEEK_MAX_PREFETCH_BATCHES: options.maxPrefetchBatches,
    DEEPSEEK_FAST_PREFETCH_BATCHES: options.fastPrefetchBatches,
    DEEPSEEK_HIGH_SPEED_PREFETCH_BATCHES: options.highSpeedPrefetchBatches
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
    emitDebug: () => {},
    emitCaptionStateTransition: () => {}
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
    DEEPSEEK_FAST_TARGET_TAIL_ITEMS: 192,
    DEEPSEEK_HIGH_SPEED_TARGET_TAIL_ITEMS: 224,
    DEEPSEEK_NORMAL_MAX_REQUEST_ITEMS: 160,
    DEEPSEEK_MAX_REQUEST_ITEMS: 320,
    getVideo: () => null,
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
      deepseekRequestMeta: new Map([["dsb:1", request]]),
      cueEpoch: 2,
      deepseekFocusGeneration: 4
    },
    DEEPSEEK_URGENT_TARGET_TAIL_ITEMS: 48,
    DEEPSEEK_FAST_TARGET_TAIL_ITEMS: 192,
    DEEPSEEK_HIGH_SPEED_TARGET_TAIL_ITEMS: 224,
    DEEPSEEK_NORMAL_MAX_REQUEST_ITEMS: 160,
    DEEPSEEK_MAX_REQUEST_ITEMS: 320,
    getVideo: () => ({ playbackRate: 3 }),
    isCaptionSessionCurrent: (token) => token === request.sessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const canContinue = vm.runInContext("canContinueDeepseekInflight", context);
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
      deepseekRequestMeta: new Map([["dsb:1", request]]),
      cueEpoch: 2,
      deepseekFocusGeneration: 4
    },
    DEEPSEEK_URGENT_TARGET_TAIL_ITEMS: 48,
    DEEPSEEK_FAST_TARGET_TAIL_ITEMS: 192,
    DEEPSEEK_HIGH_SPEED_TARGET_TAIL_ITEMS: 224,
    DEEPSEEK_NORMAL_MAX_REQUEST_ITEMS: 160,
    DEEPSEEK_MAX_REQUEST_ITEMS: 320,
    getVideo: () => ({ playbackRate: 3 }),
    isCaptionSessionCurrent: (token) => token === sessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const isStale = vm.runInContext("deepseekRequestIsStaleForTarget", context);
  const canContinue = vm.runInContext("canContinueDeepseekInflight", context);
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
      deepseekRequestMeta: new Map([["dsp:1:5793", request]]),
      cueEpoch: 2,
      deepseekFocusGeneration: 4
    },
    DEEPSEEK_URGENT_TARGET_TAIL_ITEMS: 48,
    DEEPSEEK_FAST_TARGET_TAIL_ITEMS: 192,
    DEEPSEEK_HIGH_SPEED_TARGET_TAIL_ITEMS: 224,
    DEEPSEEK_NORMAL_MAX_REQUEST_ITEMS: 160,
    DEEPSEEK_MAX_REQUEST_ITEMS: 320,
    getVideo: () => ({ playbackRate: 3 }),
    isCaptionSessionCurrent: (token) => token === sessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const isStale = vm.runInContext("deepseekRequestIsStaleForTarget", context);

  assert.equal(isStale(request, 5873), false);
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
  harness.context.captionSession.deepseekRequestMeta.set("dsp:0:0", stale);
  harness.context.captionSession.transInflight.add("dsp:0:0");
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    if (typeof callback === "function") callback({ ok: true });
  };

  const request = vm.runInContext("deepseekRequestBatch", harness.context);
  request(60, true, true);

  assert.equal(harness.messages[0].type, "cancelDeepSeekRequest");
  assert.equal(harness.messages[0].requestId, stale.requestId);
  assert.equal(harness.context.captionSession.deepseekRequestMeta.has("dsp:0:0"), false);
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
      deepseekRequestMeta: new Map([["dsb:1", request]]),
      cueEpoch: 2,
      deepseekFocusGeneration: 4
    },
    getVideo: () => ({ playbackRate: 3 }),
    isCaptionSessionCurrent: (token) => token === sessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const isLagging = vm.runInContext("deepseekRequestIsPlaybackLagging", context);
  const canContinue = vm.runInContext("canContinueDeepseekInflight", context);
  assert.equal(isLagging(request, { cursor: 96 }, 128), true);
  assert.equal(canContinue(1, { cursor: 96 }, 128), false);
  request.startedAt = Date.now() - 4000;
  assert.equal(isLagging(request, { cursor: 104 }, 128), true);
  request.startedAt = Date.now() - 3000;
  assert.equal(isLagging(request, { cursor: 104 }, 128), false);
  request.startedAt = Date.now() - 2000;
  assert.equal(isLagging(request, { cursor: 96 }, 128), false);
  request.startedAt = Date.now() - 7000;
  request.lastProgressAt = Date.now() - 1000;
  // A timestamp from a provisional/left-guard fragment must not reset the
  // startup grace period.
  assert.equal(isLagging(request, { cursor: 96 }, 128), true);
  request.progressCursor = 96;
  assert.equal(isLagging(request, { cursor: 96 }, 128), false);
  request.lastProgressAt = Date.now() - 5000;
  assert.equal(isLagging(request, { cursor: 96 }, 128), true);
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
    startedAt: Date.now() - 7000,
    urgent: true,
    reqEpoch: 1,
    reqVid: "video",
    focusGeneration: 0,
    sessionToken,
    progressTranslations: [],
    progressRecoveryTranslations: []
  };
  harness.context.captionSession.deepseekRequestMeta.set("dsb:0", oldRequest);
  harness.context.captionSession.transInflight.add("dsb:0");
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    return true;
  };

  const request = vm.runInContext("deepseekRequestBatch", harness.context);
  request(80, true, true);

  assert.equal(harness.messages[0].type, "cancelDeepSeekRequest");
  assert.equal(harness.messages[0].requestId, oldRequest.requestId);
  assert.equal(harness.messages[1].type, "translateBatch");
  assert.equal(harness.messages[1].requestStart, 56);
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
    startedAt: Date.now() - 7000,
    lastProgressAt: 0,
    progressCursor: 0,
    progressTranslations: [],
    progressRecoveryTranslations: []
  };
  harness.context.captionSession.deepseekRequestMeta.set("dsb:0", stalled);
  harness.context.captionSession.deepseekRequestMeta.set("dsp:0:48", future);
  harness.context.captionSession.transInflight.add("dsb:0");
  harness.context.captionSession.transInflight.add("dsp:0:48");
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    if (message.type === "cancelDeepSeekRequest" && typeof callback === "function") {
      callback({ ok: true });
    }
    return true;
  };

  vm.runInContext("deepseekRequestBatch(100, true, true)", harness.context);

  assert.equal(harness.messages[0].type, "cancelDeepSeekRequest");
  assert.equal(harness.messages[0].requestId, stalled.requestId);
  assert.equal(harness.messages.some((message) => message.requestId === future.requestId), false);
  assert.equal(harness.context.captionSession.deepseekRequestMeta.get("dsp:0:48"), future);
  assert.equal(future.urgent, true);
  // The preserved future request already covers the reseeded cursor, so it
  // becomes the single visible writer instead of creating a duplicate call.
  assert.equal(harness.messages.some((message) =>
    message.type === "translateBatch" && message.urgent
  ), false);
});

test("stale prefetch is cancelled before an urgent request is rebuilt", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 48, targetThrough: 40, urgentTarget: 40, playbackRate: 3
  });
  const sessionToken = harness.context.captureCaptionSession();
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    if (typeof callback === "function") {
      callback({ ok: true, translations: giantSemanticResponse(false), deferredIds: [] });
    }
  };
  harness.context.captionSession.deepseekRequestMeta.set("dsb:0", {
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

  const request = vm.runInContext("deepseekRequestBatch", harness.context);
  request(60, true, true);

  assert.equal(harness.messages[0].type, "cancelDeepSeekRequest");
  assert.equal(harness.messages[1].type, "translateBatch");
  assert.equal(harness.messages[1].urgent, true);
  assert.equal(harness.messages[1].items.length, 48);
  assert.equal(harness.debug.some((entry) =>
    entry.event === "semantic-stale-prefetch-reseed"
  ), true);
});

test("2x playback gets the intermediate semantic runway", () => {
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
      deepseekRequestMeta: new Map([["dsb:1", request]]),
      cueEpoch: 2,
      deepseekFocusGeneration: 4
    },
    DEEPSEEK_URGENT_TARGET_TAIL_ITEMS: 48,
    DEEPSEEK_FAST_TARGET_TAIL_ITEMS: 192,
    DEEPSEEK_HIGH_SPEED_TARGET_TAIL_ITEMS: 224,
    DEEPSEEK_NORMAL_MAX_REQUEST_ITEMS: 160,
    DEEPSEEK_MAX_REQUEST_ITEMS: 320,
    getVideo: () => ({ playbackRate: 2 }),
    isCaptionSessionCurrent: (token) => token === request.sessionToken
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  const tailItems = vm.runInContext("deepseekUrgentTargetTailItems", context);
  const canContinue = vm.runInContext("canContinueDeepseekInflight", context);
  assert.equal(tailItems(), 192);
  assert.equal(canContinue(1, { cursor: 5793 }, 6064), true);
  assert.equal(canContinue(1, { cursor: 5793 }, 6065), false);
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

test("malformed JSONL falls back to a bounded prefix and exposes the suffix", async () => {
  const calls = [];
  const context = {
    YTDS_SHARED: loadShared(),
    MAX_PROMPT_SOURCE_CHARS: 28000,
    DEEPSEEK_STREAM_COMPLETION_GRACE_MS: 750,
    AI_PROMPT_CACHE_VERSION: "test",
    DEEPSEEK_BATCH_INFLIGHT: new Map(),
    getAiConfig: async () => ({
      model: "model", baseUrl: "https://api.example.test", endpointKind: "compatible",
      extraBody: {}, contextPast: 0, contextFuture: 0
    }),
    aiResponseCacheId: () => "fallback-cache",
    readAiResponseCache: async () => null,
    writeAiResponseCache: async () => {},
    appendDebug: () => {},
    aiRawCompletion: async (_config, _messages, _signal, _maxTokens, _temperature, trace) => {
      calls.push(!!(trace && trace.jsonLines));
      if (trace && trace.jsonLines) {
        return { raw: "not valid JSONL", diagnostics: { attempts: [] } };
      }
      return {
        raw: JSON.stringify({
          segments: Array.from({ length: 96 }, (_value, id) => ({
            ids: [String(id)], translation: "译文"
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
  const result = await context.deepseekTranslateBatch(
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
  assert.equal(context.deepseekFallbackPrefixItems(longItems).length, 12);
});

test("a guard-touching unit expands directly to the maximum recovery window", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 40, urgentTarget: 40
  });
  const pump = vm.runInContext("pumpDeepseekCommitRegion", harness.context);
  pump(0, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.messages.map((message) => message.items.length), [105, 160]);
  assert.equal(harness.debug.filter((entry) =>
    entry.event === "semantic-commit-window-expanded"
  ).length, 1);
  assert.equal(harness.debug.find((entry) =>
    entry.event === "semantic-commit-window-expanded"
  ).data.reason, "leading-unit-reaches-window-end");
});

test("3x urgent playback keeps the visible request short while runway prefetch fills ahead", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 40, urgentTarget: 80, playbackRate: 3
  });
  const pump = vm.runInContext("pumpDeepseekCommitRegion", harness.context);
  pump(0, true);
  await new Promise((resolve) => setImmediate(resolve));

  // The visible request stays bounded so distinct speculative ranges can run
  // beside it; inner aligned chunks still release the prefix immediately.
  assert.deepEqual(harness.messages.map((message) => message.items.length), [97, 160]);
  assert.ok(harness.messages.every((message) => message.items.length <= 160));
});

test("urgent aligned chunks release a safe prefix before a giant outer unit", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(true), 2, {
    windowItems: 48, targetThrough: 40, urgentTarget: 40, playbackRate: 3
  });
  const pump = vm.runInContext("pumpDeepseekCommitRegion", harness.context);
  pump(0, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.messages.map((message) => message.items.length), [57, 48, 160]);
  assert.ok(harness.messages.every((message) => message.urgent));
  assert.ok(harness.state.cursor >= 80);
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
  harness.context.captionSession.deepseekRequestMeta.set("dsb:0", request);
  const handle = vm.runInContext("handleDeepseekTranslationProgress", harness.context);
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
  harness.context.captionSession.deepseekRequestMeta.set("dsb:0", request);
  const handle = vm.runInContext("handleDeepseekTranslationProgress", harness.context);

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

test("accelerated streamed progress hands off from a safe prefix before the long response ends", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(true), 0, {
    windowItems: 48, targetThrough: 255, urgentTarget: 40, playbackRate: 3
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
  harness.context.captionSession.deepseekRequestMeta.set("dsb:0", request);
  harness.context.captionSession.transInflight.add("dsb:0");
  const calls = [];
  harness.context.sendRuntimeMessage = (message, callback) => {
    calls.push(message);
    if (message.type === "cancelDeepSeekRequest" && typeof callback === "function") {
      callback({ ok: true });
    }
    return true;
  };

  const handle = vm.runInContext("handleDeepseekTranslationProgress", harness.context);
  assert.equal(handle({
    type: "translationBatchProgress",
    requestId: request.requestId,
    videoId: "video",
    focusGeneration: 0,
    translations: giantSemanticResponse(true)
  }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.state.cursor, 120);
  assert.equal(calls[0].type, "cancelDeepSeekRequest");
  assert.equal(calls[1].type, "translateBatch");
  assert.equal(calls[1].requestStart, 120);
  assert.equal(calls[1].urgent, true);
  assert.equal(calls[1].bypassCache, true);
  assert.ok(calls[1].items.length > 0);
  assert.ok(calls[1].items.length <= 160);
  assert.equal(harness.debug.some((entry) =>
    entry.event === "semantic-stream-handoff"
  ), true);
});

test("accelerated prefetch starts with enough runway before urgent promotion", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 48, targetThrough: 40, urgentTarget: -1, playbackRate: 3
  });
  const pump = vm.runInContext("pumpDeepseekCommitRegion", harness.context);
  pump(0, false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.messages.map((message) => message.items.length), [160]);
  assert.ok(harness.messages.every((message) => message.items.length <= 160));
});

test("same semantic region prefetches distinct future ranges concurrently", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 48, targetThrough: 40, urgentTarget: 0, playbackRate: 3
  });
  const callbacks = [];
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    callbacks.push(callback);
  };
  const queue = vm.runInContext("queueDeepseekSpeculativeRequest", harness.context);
  queue(0, 64);
  queue(0, 160);
  queue(0, 256);

  assert.deepEqual(harness.messages.map((message) => message.requestStart), [64, 160, 256]);
  assert.ok(harness.messages.every((message) => message.urgent === false));
  assert.equal(callbacks.length, 3);

  callbacks[0]({ ok: false, error: "temporary prefetch failure", netfail: true });
  assert.equal(harness.messages[2].requestStart, 256);
});

test("accelerated prefetch skips the live writer and uses the fast transport path", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 40, urgentTarget: 0, playbackRate: 3
  });
  const sessionToken = harness.context.captureCaptionSession();
  harness.context.captionSession.deepseekRequestMeta.set("dsb:0", {
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

  const queue = vm.runInContext("queueDeepseekSpeculativeRequest", harness.context);
  queue(0, 80);
  queue(0, 176);
  queue(0, 272);

  assert.deepEqual(harness.messages.map((message) => message.requestStart), [80, 176, 272]);
  assert.ok(harness.messages.every((message) => message.urgent === false));
  assert.ok(harness.messages.every((message) => message.fastPath === true));
  callbacks[0]({ ok: false, error: "temporary prefetch failure", netfail: true });
  assert.equal(harness.messages[2].requestStart, 272);
});

test("3x DeepSeek playback dispatches the visible writer and eleven future ranges before any response", () => {
  const { harness, requests } = loadPlaybackPrefetchHarness({
    windowItems: 80, targetThrough: 40, urgentTarget: 0, playbackRate: 3,
    batchSize: 64, groupCount: 1201, limitEnd: 1200,
    maxPrefetchBatches: 12, fastPrefetchBatches: 6, highSpeedPrefetchBatches: 12
  });

  assert.deepEqual(requests.map((message) => message.requestStart), [
    0, 64, 160, 256, 352, 448, 544, 640, 736, 832, 928, 1024
  ]);
  assert.equal(harness.pendingCallbacks.length, 12);
  assert.ok(requests.slice(1).every((message) =>
    message.urgent === false && message.fastPath === true
  ));
});

test("3x DeepSeek uses a short visible writer while Gemini keeps the wider lane", () => {
  const deepseek = loadPlaybackPrefetchHarness({
    windowItems: 48, targetThrough: 0, urgentTarget: 0, playbackRate: 3,
    batchSize: 32, maxPrefetchBatches: 12, highSpeedPrefetchBatches: 12
  });
  const deepseekRequests = deepseek.requests;
  assert.equal(deepseekRequests[0].requestStart, 0);
  assert.equal(deepseekRequests[0].items.length, 48);
  assert.ok(deepseekRequests[1].requestStart > deepseekRequests[0].requestEnd);

  const gemini = loadPlaybackPrefetchHarness({
    windowItems: 48, targetThrough: 0, urgentTarget: 0, playbackRate: 3,
    batchSize: 32, maxPrefetchBatches: 12, highSpeedPrefetchBatches: 12,
    aiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai"
  });
  const geminiRequests = gemini.requests;
  assert.equal(geminiRequests[0].requestStart, 0);
  assert.equal(geminiRequests[0].items.length, 80);
});

test("3x compatible playback keeps a provider-safe speculative lane", () => {
  const { harness, requests } = loadPlaybackPrefetchHarness({
    windowItems: 80, targetThrough: 40, urgentTarget: 0, playbackRate: 3,
    batchSize: 64, maxPrefetchBatches: 12, fastPrefetchBatches: 6,
    highSpeedPrefetchBatches: 12,
    aiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai"
  });

  assert.deepEqual(requests.map((message) => message.requestStart), [0, 80, 176, 272]);
  assert.equal(harness.pendingCallbacks.length, 4);
  assert.ok(requests.every((message) => message.endpointKind === "compatible"));
});

test("2x DeepSeek playback also fills an accelerated runway", () => {
  const { harness, requests } = loadPlaybackPrefetchHarness({
    windowItems: 80, targetThrough: 40, urgentTarget: 0, playbackRate: 2,
    batchSize: 64, maxPrefetchBatches: 8, fastPrefetchBatches: 8,
    highSpeedPrefetchBatches: 12
  });

  assert.deepEqual(requests.map((message) => message.requestStart), [
    0, 64, 160, 256, 352, 448, 544, 640
  ]);
  assert.equal(harness.pendingCallbacks.length, 8);
  assert.ok(requests.every((message) => message.endpointKind === "deepseek"));
});

test("3x playback consumes staged future ranges while the current response is slow", async () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 40, urgentTarget: 0, playbackRate: 3,
    batchSize: 64, deferResponses: true
  });
  harness.context.settings.enabled = true;
  harness.context.DEEPSEEK_MAX_PREFETCH_BATCHES = 10;
  harness.context.DEEPSEEK_FAST_PREFETCH_BATCHES = 6;
  harness.context.DEEPSEEK_HIGH_SPEED_PREFETCH_BATCHES = 10;
  harness.context.captionSession.activeGroupIdx = 0;
  vm.runInContext(playbackSource, harness.context, { filename: "content/cue-playback.js" });
  vm.runInContext("prefetchFrom(0)", harness.context);

  const respond = async (requestStart, start, end) => {
    const pending = harness.pendingCallbacks.find((entry) =>
      !entry.responded && entry.message.requestStart === requestStart
    );
    assert.ok(pending, `missing pending response for ${requestStart}`);
    pending.responded = true;
    pending.callback({
      ok: true,
      translations: rangeSemanticResponse(start, end),
      deferredIds: [],
      httpDiagnostics: { attempts: [] }
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  // Let the look-ahead finish before the visible writer. A slow current
  // response must not make these already-paid-for ranges unusable.
  await respond(64, 64, 159);
  await respond(160, 160, 255);
  await respond(256, 256, 351);
  await respond(352, 352, 447);
  assert.equal(harness.state.cursor, 0);
  assert.equal(harness.state.prefetchResponses.has(64), true);
  assert.equal(harness.state.prefetchResponses.has(160), true);

  await respond(0, 0, 63);
  assert.ok(harness.messages.some((message) =>
    message.type === "translateBatch" && message.requestStart === 32 && message.urgent
  ));
  await respond(32, 32, 63);
  assert.ok(harness.state.cursor >= 144);
  assert.equal(harness.state.prefetchResponses.has(64), false);
  assert.equal(harness.state.prefetchResponses.has(160), true);
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
  harness.context.captionSession.deepseekRequestMeta.set("dsp:0:80", request);
  harness.context.captionSession.transInflight.add("dsp:0:80");

  vm.runInContext("pumpDeepseekCommitRegion(0, true)", harness.context);

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
  harness.context.captionSession.deepseekRequestMeta.set("dsp:0:80", request);
  harness.context.captionSession.transInflight.add("dsp:0:80");
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    if (typeof callback === "function") callback({ ok: true });
  };

  vm.runInContext("pumpDeepseekCommitRegion(0, true)", harness.context);

  assert.equal(harness.messages[0].type, "cancelDeepSeekRequest");
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
  harness.context.captionSession.deepseekRequestMeta.set("dsp:0:80", request);
  harness.context.captionSession.transInflight.add("dsp:0:80");

  const handle = vm.runInContext("handleDeepseekBatchResult", harness.context);
  handle(request, {
    ok: false,
    rateLimited: true,
    retryAfterMs: 5000,
    limitReason: "provider-rate-limit"
  }, null);

  assert.equal(harness.state.prefetchQueued.has(80), true);
  assert.ok(harness.context.captionSession.deepseekSpeculativeBackoffUntil > Date.now());
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.debug.some((entry) =>
    entry.event === "semantic-speculative-backoff"
  ), true);
});

test("entering a new semantic region cancels obsolete old-region writers", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 40, urgentTarget: 0, playbackRate: 3
  });
  const oldRequest = {
    requestId: "commit:old:0-79", regionIndex: -1, requestStart: 0, requestEnd: 79,
    urgent: false, reqEpoch: 1, reqVid: "video"
  };
  harness.context.captionSession.deepseekRequestMeta.set("dsb:-1", oldRequest);
  harness.context.captionSession.transInflight.add("dsb:-1");
  harness.context.sendRuntimeMessage = (message) => harness.messages.push(message);

  vm.runInContext("deepseekRequestBatch(0, true, true)", harness.context);

  assert.equal(harness.messages[0].type, "cancelDeepSeekRequest");
  assert.equal(harness.messages[0].requestId, oldRequest.requestId);
  assert.equal(harness.context.captionSession.deepseekRequestMeta.has("dsb:-1"), false);
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
  harness.context.captionSession.deepseekRequestMeta.set("dsp:0:0", oldRequest);
  harness.context.captionSession.deepseekRequestMeta.set("dsp:2:160", futureRequest);
  harness.context.captionSession.transInflight.add("dsp:0:0");
  harness.context.captionSession.transInflight.add("dsp:2:160");
  harness.context.sendRuntimeMessage = (message) => harness.messages.push(message);

  vm.runInContext("cancelDeepseekRequestsBeforeRegion(1)", harness.context);

  assert.deepEqual(harness.messages.map((message) => message.requestId), [oldRequest.requestId]);
  assert.equal(harness.context.captionSession.deepseekRequestMeta.has("dsp:0:0"), false);
  assert.equal(harness.context.captionSession.deepseekRequestMeta.has("dsp:2:160"), true);
  assert.equal(harness.context.captionSession.transInflight.has("dsp:2:160"), true);
});

test("a future response gets a guard-sized bridge and is reused at the cursor", () => {
  const harness = loadSemanticCommitHarness(giantSemanticResponse(false), 0, {
    windowItems: 80, targetThrough: 200, urgentTarget: 64, playbackRate: 3
  });
  harness.state.cursor = 64;
  harness.state.commitFloor = 64;
  harness.state.targetThrough = 200;
  harness.state.urgentTarget = 64;
  const sessionToken = harness.context.captureCaptionSession();
  harness.context.captionSession.deepseekRequestMeta.set("dsp:0:80", {
    requestId: "prefetch:0:1:80-175", prefetch: true, regionIndex: 0,
    requestStart: 80, requestEnd: 175, urgent: false,
    reqEpoch: 1, reqVid: "video", sessionToken, focusGeneration: 0
  });
  harness.context.captionSession.transInflight.add("dsp:0:80");
  harness.context.sendRuntimeMessage = (message, callback) => {
    harness.messages.push(message);
    harness.callback = callback;
  };

  const pump = vm.runInContext("pumpDeepseekCommitRegion", harness.context);
  pump(0, true);
  assert.equal(harness.messages[0].requestStart, 64);
  assert.equal(harness.messages[0].requestEnd, 86);
  assert.equal(harness.debug.some((entry) => entry.event === "semantic-prefetch-bridge"), true);

  harness.messages.length = 0;
  harness.context.captionSession.deepseekRequestMeta.delete("dsb:0");
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
  const bridge = vm.runInContext("deepseekBridgeRequestItems", harness.context);
  assert.equal(bridge(80, 81, 160, 500), 2);
});

test("a max-planned short bridge recovers past its future join instead of exhausting retries", async () => {
  const translations = Array.from({ length: 3 }, (_value, id) => ({
    id: String(id), unitId: "semantic-0-2", translation: "joined translation"
  }));
  const harness = loadSemanticCommitHarness(translations, 0, {
    windowItems: 160, targetThrough: 100, urgentTarget: 0, playbackRate: 3,
    groupCount: 301, limitEnd: 300, deferResponses: true
  });
  const sessionToken = harness.context.captureCaptionSession();
  harness.context.captionSession.deepseekRequestMeta.set("dsp:0:2", {
    requestId: "prefetch:0:1:2-97", prefetch: true, regionIndex: 0,
    requestStart: 2, requestEnd: 97, urgent: false,
    reqEpoch: 1, reqVid: "video", sessionToken, focusGeneration: 0
  });
  harness.context.captionSession.transInflight.add("dsp:0:2");

  const handle = vm.runInContext("handleDeepseekBatchResult", harness.context);
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
    groupCount: 301, limitEnd: 300, deferResponses: true
  });
  harness.state.commitFloor = 10;
  const sessionToken = harness.context.captureCaptionSession();
  harness.context.captionSession.deepseekRequestMeta.set("dsp:0:9", {
    requestId: "prefetch:0:1:9-104", prefetch: true, regionIndex: 0,
    requestStart: 9, requestEnd: 104, reqEpoch: 1, reqVid: "video",
    sessionToken, focusGeneration: 0
  });

  const handle = vm.runInContext("handleDeepseekBatchResult", harness.context);
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
  const handle = vm.runInContext("handleDeepseekBatchResult", harness.context);
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
  harness.context.DEEPSEEK_MAX_PREFETCH_BATCHES = 0;
  harness.context.DEEPSEEK_FAST_PREFETCH_BATCHES = 0;
  harness.context.DEEPSEEK_HIGH_SPEED_PREFETCH_BATCHES = 0;
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
    settings: { enabled: true, deepseekPrefetchBatches: 3 },
    captionSession: {
      cueList: [{ start: 0, end: 1000 }],
      cueToGroup: [0],
      cueToGroups: [[0]],
      sentGroups: batchStarts.map((group) => ({ start: group, end: group })),
      deepseekBatchWindows: batchStarts.map((group) => ({ start: group, end: group })),
      deepseekGroupToBatch: batchStarts,
      activeCueIdx: 0,
      activeGroupIdx: 0
    },
    getVideo: () => ({ playbackRate: 3 }),
    deepseekRequestBatch: (group, _includePredecessor, urgent) =>
      calls.push({ group, urgent: !!urgent }),
    YTDS_SHARED: {
      isSameLanguage: () => false,
      semanticPrefetchBatchStarts: (_group, _mapping, _windows, ahead) => {
        requestedAhead.push(ahead);
        return batchStarts.slice(1, ahead + 1);
      }
    },
    DEEPSEEK_MAX_PREFETCH_BATCHES: 10,
    DEEPSEEK_FAST_PREFETCH_BATCHES: 6,
    DEEPSEEK_HIGH_SPEED_PREFETCH_BATCHES: 8,
    deepseekGroupForCueAt: () => 0
  };
  vm.createContext(context);
  vm.runInContext(playbackSource, context, { filename: "content/cue-playback.js" });
  vm.runInContext("prefetchFrom(0)", context);
  assert.deepEqual(requestedAhead, [8]);
  assert.deepEqual(calls, [
    { group: 0, urgent: true },
    ...batchStarts.slice(1).map((group) => ({ group, urgent: false }))
  ]);
});

test("same-group playback watchdog and rate change re-arm accelerated current prefetch", () => {
  const calls = [];
  const sessionToken = Object.freeze({ revision: 1 });
  const context = {
    Map, Set, Date, Math, Number, String, Array, Object, Promise,
    groupKey: (id) => `video g${id}`,
    settings: { enabled: true, deepseekPrefetchBatches: 0 },
    captionSession: {
      cueList: [{ text: "source", start: 0, end: 1000 }],
      cueToGroup: [0], cueToGroups: [[0]],
      sentGroups: [{ start: 0, end: 0, hardAfter: false }],
      deepseekBatchWindows: [{ start: 0, end: 0 }],
      deepseekGroupToBatch: [0], deepseekGroupToCommitRegion: [0],
      deepseekExhaustedRegions: new Set(), transCache: new Map(),
      deepseekDisplayCache: new Map(), deepseekSourceCache: new Map(),
      deepseekUnitCache: new Map(), activeCueIdx: 0, activeGroupIdx: 0,
      deepseekSeekSettling: false, pendingTimer: null, pendingIndicatorKey: "",
      cueVideoId: "video", currentVideoId: "video", cueEpoch: 1,
      deepseekFocusGeneration: 0
    },
    getVideo: () => ({ currentTime: 0, playbackRate: 3 }),
    DEEPSEEK_MAX_PREFETCH_BATCHES: 10,
    DEEPSEEK_FAST_PREFETCH_BATCHES: 6,
    DEEPSEEK_HIGH_SPEED_PREFETCH_BATCHES: 8,
    extensionContextAlive: () => true,
    maybeReflowSemanticDisplay: () => {},
    armPendingTranslationIndicator: () => {},
    deepseekRequestBatch: (group, includePredecessor, urgent) => {
      calls.push({ group, includePredecessor, urgent: !!urgent });
      context.captionSession.transCache.set("video g0", "ready");
    },
    YTDS_SHARED: {
      isSameLanguage: () => false,
      semanticPrefetchBatchStarts: () => [],
      pendingTranslationScopeKey: () => "deepseek-batch:0"
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

test("cached translations are normalized again at the content cache boundary", () => {
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
  const commit = vm.runInContext("commitDeepseekResponsePrefix", harness.context);
  const nextCursor = commit(0, 0, 1, 0, 500, cached, 0);

  assert.equal(nextCursor, 2);
  assert.equal(harness.context.captionSession.transCache.get("video g0"), "缓存译文");
  assert.equal(
    harness.context.captionSession.deepseekAlignedChunksCache.get("semantic-0-1")[0].translation,
    "缓存译文"
  );
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
