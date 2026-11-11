"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared, contentConstants } = require("./helpers");

const root = path.resolve(__dirname, "..");
const shared = loadShared();

const semanticSource = [
  "content/semantic-policy.js",
  "content/semantic-requests.js",
  "content/semantic-results.js",
  "content/semantic-lookahead.js",
  "content/semantic.js",
  "content/cue-indicator.js"
].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");

function loadJsonlStreamObserver() {
  const context = {
    YTDS_SHARED: shared,
    console
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(root, "background/translation.js"), "utf8"),
    context,
    { filename: "background/translation.js" }
  );
  return vm.runInContext("createAiJsonlStreamObserver", context);
}

function sampleItems(count = 4) {
  return Array.from({ length: count }, (_value, id) => ({
    id: String(id),
    text: `cue-word-${id}`,
    startMs: id * 1000,
    endMs: (id + 1) * 1000,
    hardAfter: false
  }));
}

function rangeSemanticResponse(start, end) {
  return Array.from({ length: Math.max(0, end - start + 1) }, (_value, offset) => ({
    id: String(start + offset),
    unitId: `semantic-${start + offset}`,
    translation: "range translation"
  }));
}

function loadHarness(options = {}) {
  const messages = [];
  const pendingCallbacks = [];
  const groupCount = options.groupCount || 300;
  const groups = Array.from({ length: groupCount }, (_v, id) => ({
    startIdx: 0,
    endIdx: 0,
    text: `w${id}`,
    start: id * 10,
    end: id * 10 + 10,
    pauseAfterMs: 0,
    softAfter: false,
    hardAfter: false
  }));
  const batchSize = options.batchSize || 32;
  const batchWindows = Array.from({ length: Math.ceil(groups.length / batchSize) }, (_v, i) => ({
    start: i * batchSize,
    end: Math.min(groups.length - 1, (i + 1) * batchSize - 1)
  }));
  const state = {
    cursor: 0,
    commitFloor: 0,
    limitEnd: groupCount - 1,
    targetThrough: options.targetThrough ?? 0,
    urgentTarget: options.urgentTarget ?? 0,
    windowItems: options.windowItems || 160,
    recoveryWindowItems: false,
    noProgressRange: "",
    prefetchQueue: [],
    prefetchQueued: new Set(),
    prefetchResponses: new Map()
  };

  let timerCallback = null;
  const sessionToken = { revision: 1 };
  const context = {
    Map, Set, Date, Math, Number, String, Array, Object,
    queueMicrotask,
    clearTimeout: () => {},
    setTimeout: (fn) => { timerCallback = fn; return 1; },
    YTDS_SHARED: shared,
    captionSession: {
      cueVideoId: "video",
      currentVideoId: "video",
      cueEpoch: 1,
      cueSourceLang: "en",
      cueList: [{ text: "source", start: 0, end: 1000 }],
      cueToGroup: [0],
      cueToGroups: [[0]],
      sentGroups: groups,
      semanticCommitRegions: [{ start: 0, end: groupCount - 1 }],
      semanticCommitRegions: [{ start: 0, end: groupCount - 1 }],
      semanticGroupToCommitRegion: new Array(groupCount).fill(0),
      semanticGroupToCommitRegion: new Array(groupCount).fill(0),
      semanticCommitStateByRegion: new Map([[0, state]]),
      semanticCommitStateByRegion: new Map([[0, state]]),
      semanticGroupToBatch: groups.map((_g, id) => Math.floor(id / batchSize)),
      semanticGroupToBatch: groups.map((_g, id) => Math.floor(id / batchSize)),
      semanticBatchWindows: batchWindows,
      semanticBatchWindows: batchWindows,
      semanticRequestMeta: new Map(),
      semanticRequestMeta: new Map(),
      transInflight: new Set(),
      semanticRetryCounts: new Map(),
      semanticRetryCounts: new Map(),
      semanticExhaustedRegions: new Map(),
      semanticExhaustedRegions: new Map(),
      transCache: new Map(),
      semanticUnitCache: new Map(),
      semanticUnitCache: new Map(),
      semanticSourceCache: new Map(),
      semanticSourceCache: new Map(),
      semanticAlignedChunksCache: new Map(),
      semanticAlignedChunksCache: new Map(),
      semanticDisplayCache: new Map(),
      semanticDisplayCache: new Map(),
      semanticSpeculativeBackoffReason: "",
      semanticSpeculativeBackoffUntil: 0,
      semanticSpeculativeResumeTimer: null,
      activeGroupIdx: 0,
      activeCueIdx: 0
    },
    settings: {
      targetLang: "zh-CN",
      debugEnabled: true,
      aiBaseUrl: options.aiBaseUrl || "https://api.deepseek.com",
      aiRateLimitRpm: options.aiRateLimitRpm || 0,
      aiModel: options.aiModel || "test-model"
    },
    ...contentConstants(),
    // Scenario override: 16-item batch scopes keep the fixtures small.
    SEMANTIC_CORE_ITEMS: 16,
    AI_CORE_ITEMS: 16,
    emitDebug: () => {},
    emitCaptionStateTransition: () => {},
    repaintActiveAiTranslation: () => {},
    cacheAiDisplayNeighborhood: () => {},
    semanticDisplayWidth: () => 1000,
    mergeCueTexts: (items) => items.map((item) => item.text).join(" "),
    getVideo: () => ({ playbackRate: options.playbackRate || 1 }),
    sendRuntimeMessage: (msg, callback) => {
      messages.push(msg);
      if (typeof callback === "function") pendingCallbacks.push({ msg, callback });
    },
    captureCaptionSession: () => sessionToken,
    isCaptionSessionCurrent: () => true
  };
  vm.createContext(context);
  vm.runInContext(semanticSource, context, { filename: "content/semantic.js" });
  return { context, state, messages, pendingCallbacks, getTimerCallback: () => timerCallback };
}

test("JSONL parser tolerates coordinate-in-bracket strings like ['[2,2]', '']", () => {
  const line = '[["[0,1]", "hello"], ["[2,2]", ""]]';
  const decoded = shared.aiJsonlRecordFromLine(line);
  assert.equal(decoded.record.type, "unit");
  assert.equal(decoded.record.chunks[0][0], "0");
  assert.equal(decoded.record.chunks[0][1], "1");
  assert.equal(decoded.record.chunks[0][2], "hello");
  assert.equal(decoded.record.chunks[1][0], "2");
  assert.equal(decoded.record.chunks[1][1], "2");
  assert.equal(decoded.record.chunks[1][2], "");
});

test("JSONL parser tolerates 2-element array coordinates like [[4, 10], 'text']", () => {
  const line = '[[0, 1], "part one"]';
  const decoded = shared.aiJsonlRecordFromLine(line);
  assert.equal(decoded.record.type, "unit");
  assert.equal(decoded.record.chunks[0][0], 0);
  assert.equal(decoded.record.chunks[0][1], 1);
  assert.equal(decoded.record.chunks[0][2], "part one");
});

test("JSONL stream observer recovers from overlapping repeated unit without failing the stream", () => {
  const items = sampleItems(6);
  const progress = [];
  const observer = loadJsonlStreamObserver()(items, "zh-CN", (translations) => {
    progress.push(translations.map((item) => item.id));
  }, { requestClass: "urgent" });

  let status = observer.onTextDelta('[[0, 1, "first unit"]]\n', false);
  assert.equal(status.stop, false);

  status = observer.onTextDelta('[[2, 3, "second unit initial"]]\n', false);
  assert.equal(status.stop, false);

  // Model sends a revision/repetition starting at unitStart (2): [2, 3, "second unit revised"]
  status = observer.onTextDelta('[[2, 3, "second unit revised"]]\n', false);
  assert.equal(status.stop, false);

  status = observer.onTextDelta('[[4, 5, "third unit"]]\n', false);
  assert.equal(status.stop, false);

  const result = observer.result(false);
  assert.equal(result.length, 6);
  assert.equal(result[2].translation, "second unit revised");
});

test("adaptive batch window reduces size when response has deferredIds", () => {
  const harness = loadHarness({ windowItems: 160 });
  const handleResult = vm.runInContext("handleAiBatchResult", harness.context);

  const request = {
    regionIndex: 0,
    requestStart: 0,
    requestEnd: 47,
    limitEnd: 299,
    itemCount: 48,
    effectiveGuardItems: 16,
    urgent: true,
    reqEpoch: 1,
    reqVid: "video"
  };

  const responseWithDeferrals = {
    ok: true,
    translations: rangeSemanticResponse(0, 31),
    deferredIds: ["32", "33", "34"]
  };

  handleResult(request, responseWithDeferrals, null);

  assert.ok(harness.state.cursor > 0);
  assert.equal(harness.state.windowItems, vm.runInContext("Math.min(aiUrgentRequestItems(), 96)", harness.context));
});

test("a request-limited profile prioritizes urgent commit over speculative prefetch", async () => {
  const harness = loadHarness({
    aiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    aiRateLimitRpm: 15,
    aiModel: "gemini-3.5-flash-lite-preview",
    targetThrough: 200,
    urgentTarget: 200
  });
  harness.state.prefetchQueue.push(100);
  harness.state.prefetchQueued.add(100);

  const handleResult = vm.runInContext("handleAiBatchResult", harness.context);

  const request = {
    regionIndex: 0,
    requestStart: 0,
    requestEnd: 63,
    limitEnd: 299,
    itemCount: 64,
    effectiveGuardItems: 16,
    urgent: true,
    reqEpoch: 1,
    reqVid: "video"
  };

  const resp = {
    ok: true,
    translations: rangeSemanticResponse(0, 63)
  };

  handleResult(request, resp, null);

  // Wait for microtask (queueMicrotask)
  await Promise.resolve();

  // The urgent commit request should be dispatched for region 0
  assert.ok(harness.messages.length >= 1);
  assert.equal(harness.messages[0].urgent, true);
  assert.equal(harness.messages[0].requestStart, 32);
  // Speculative prefetch for 100 should NOT have been launched ahead of urgent commit
  assert.equal(harness.messages.some((msg) => msg.requestStart === 100), false);
});

test("speculative resume timer does not re-poll during active request in local-concurrency backoff", () => {
  const harness = loadHarness();
  harness.context.captionSession.semanticRequestMeta.set("dsb:0", { requestId: "commit:0:1", urgent: true });
  harness.context.captionSession.semanticSpeculativeBackoffReason = "local-concurrency";
  harness.context.captionSession.semanticSpeculativeBackoffUntil = Date.now() + 100;
  harness.context.captionSession.semanticSpeculativeResumeTimer = null;

  const resume = vm.runInContext("scheduleAiSpeculativeResume", harness.context);
  resume();

  const timerCb = harness.getTimerCallback();
  assert.ok(typeof timerCb === "function");
  harness.context.captionSession.semanticSpeculativeBackoffUntil = Date.now() - 1;

  timerCb();

  // No messages should have been sent because an active request is still in flight
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.context.captionSession.semanticSpeculativeBackoffReason, "local-concurrency");
});
