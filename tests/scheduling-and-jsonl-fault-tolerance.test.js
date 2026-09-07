"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const root = path.resolve(__dirname, "..");
const shared = loadShared();

const semanticSource = [
  "content/semantic-policy.js",
  "content/semantic-requests.js",
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
      deepseekCommitRegions: [{ start: 0, end: groupCount - 1 }],
      semanticGroupToCommitRegion: new Array(groupCount).fill(0),
      deepseekGroupToCommitRegion: new Array(groupCount).fill(0),
      semanticCommitStateByRegion: new Map([[0, state]]),
      deepseekCommitStateByRegion: new Map([[0, state]]),
      semanticGroupToBatch: groups.map((_g, id) => Math.floor(id / batchSize)),
      deepseekGroupToBatch: groups.map((_g, id) => Math.floor(id / batchSize)),
      semanticBatchWindows: batchWindows,
      deepseekBatchWindows: batchWindows,
      semanticRequestMeta: new Map(),
      deepseekRequestMeta: new Map(),
      transInflight: new Set(),
      semanticRetryCounts: new Map(),
      deepseekRetryCounts: new Map(),
      semanticExhaustedRegions: new Map(),
      deepseekExhaustedRegions: new Map(),
      transCache: new Map(),
      semanticUnitCache: new Map(),
      deepseekUnitCache: new Map(),
      semanticSourceCache: new Map(),
      deepseekSourceCache: new Map(),
      semanticAlignedChunksCache: new Map(),
      deepseekAlignedChunksCache: new Map(),
      semanticDisplayCache: new Map(),
      deepseekDisplayCache: new Map(),
      deepseekSpeculativeBackoffReason: "",
      deepseekSpeculativeBackoffUntil: 0,
      deepseekSpeculativeResumeTimer: null,
      activeGroupIdx: 0,
      activeCueIdx: 0
    },
    settings: {
      targetLang: "zh-CN",
      debugEnabled: true,
      aiBaseUrl: options.aiBaseUrl || "https://api.deepseek.com",
      aiModel: options.aiModel || "test-model"
    },
    SEMANTIC_CORE_ITEMS: 16,
    DEEPSEEK_CORE_ITEMS: 16,
    DEEPSEEK_INITIAL_REQUEST_ITEMS: 48,
    DEEPSEEK_REQUEST_ITEMS: 80,
    DEEPSEEK_URGENT_REQUEST_ITEMS: 96,
    DEEPSEEK_ACCELERATED_URGENT_REQUEST_ITEMS: 64,
    DEEPSEEK_HIGH_SPEED_URGENT_REQUEST_ITEMS: 48,
    COMPATIBLE_ACCELERATED_URGENT_REQUEST_ITEMS: 80,
    COMPATIBLE_HIGH_SPEED_URGENT_REQUEST_ITEMS: 80,
    GEMINI_REQUEST_ITEMS: 320,
    GEMINI_MAX_REQUEST_ITEMS: 320,
    GEMINI_MAX_SPECULATIVE_REQUESTS: 1,
    DEEPSEEK_NORMAL_MAX_REQUEST_ITEMS: 160,
    DEEPSEEK_MAX_REQUEST_ITEMS: 320,
    DEEPSEEK_HIGH_SPEED_MAX_REQUEST_ITEMS: 160,
    DEEPSEEK_MAX_CURRENT_CHARS: 18000,
    DEEPSEEK_COMMIT_GUARD_ITEMS: 16,
    DEEPSEEK_MIN_COMMIT_RUNWAY_ITEMS: 32,
    DEEPSEEK_URGENT_TARGET_TAIL_ITEMS: 48,
    DEEPSEEK_CONTEXT_GROUPS: 20,
    DEEPSEEK_COLD_RETRY_DELAYS_MS: [400, 1200, 2500],
    emitDebug: () => {},
    emitCaptionStateTransition: () => {},
    repaintActiveDeepseekTranslation: () => {},
    cacheDeepseekDisplayNeighborhood: () => {},
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
  const handleResult = vm.runInContext("handleDeepseekBatchResult", harness.context);

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
  assert.equal(harness.state.windowItems, Math.min(harness.context.DEEPSEEK_URGENT_REQUEST_ITEMS, 96));
});

test("Gemini prioritizes urgent commit over speculative prefetch when urgent lane is pending", async () => {
  const harness = loadHarness({
    aiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    aiModel: "gemini-3.5-flash-lite-preview",
    targetThrough: 200,
    urgentTarget: 200
  });
  harness.state.prefetchQueue.push(100);
  harness.state.prefetchQueued.add(100);

  const handleResult = vm.runInContext("handleDeepseekBatchResult", harness.context);

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
  harness.context.captionSession.deepseekRequestMeta.set("dsb:0", { requestId: "commit:0:1", urgent: true });
  harness.context.captionSession.deepseekSpeculativeBackoffReason = "local-concurrency";
  harness.context.captionSession.deepseekSpeculativeBackoffUntil = Date.now() + 100;
  harness.context.captionSession.deepseekSpeculativeResumeTimer = null;

  const resume = vm.runInContext("scheduleDeepseekSpeculativeResume", harness.context);
  resume();

  const timerCb = harness.getTimerCallback();
  assert.ok(typeof timerCb === "function");
  harness.context.captionSession.deepseekSpeculativeBackoffUntil = Date.now() - 1;

  timerCb();

  // No messages should have been sent because an active request is still in flight
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.context.captionSession.deepseekSpeculativeBackoffReason, "local-concurrency");
});
