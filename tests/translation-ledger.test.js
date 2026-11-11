"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const shared = loadShared();
const root = path.resolve(__dirname, "..");
const CONTENT = [
  "content/semantic-policy.js", "content/semantic-requests.js", "content/semantic-results.js",
  "content/semantic-lookahead.js", "content/semantic.js", "content/translation-ledger.js"
];

function memoryStorage() {
  const data = new Map();
  return {
    data,
    get: async (keys) => {
      const out = {};
      if (typeof keys === "string") {
        if (data.has(keys)) out[keys] = structuredClone(data.get(keys));
        return out;
      }
      for (const [key, fallback] of Object.entries(keys || {})) {
        out[key] = data.has(key) ? structuredClone(data.get(key)) : fallback;
      }
      return out;
    },
    set: async (values) => {
      for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value));
    },
    remove: async (keys) => { for (const key of [].concat(keys)) data.delete(key); }
  };
}

// Sixty words in two hard-pause regions: 0-39 and 40-59.
function words() {
  return Array.from({ length: 60 }, (_v, id) => ({
    startIdx: id, endIdx: id, text: `w${id}`, start: id * 400, end: id * 400 + 400,
    pauseAfterMs: id === 39 || id === 59 ? 5000 : 0, softAfter: false, hardAfter: id === 39 || id === 59
  }));
}

function createRuntime(storage, overrides = {}) {
  const sent = [];
  const timers = [];
  const groups = overrides.groups || words();
  const context = {
    Map, Set, Math, Number, String, Array, Object, Promise, JSON, Date,
    queueMicrotask, structuredClone,
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimeout: () => {},
    YTDS_SHARED: shared,
    chrome: { storage: { local: storage } },
    captionSession: {
      cueVideoId: "video", cueTrackSignature: "track", cueEpoch: 1, cueSourceLang: "en",
      cueList: groups.map((group) => ({ text: group.text, start: group.start, end: group.end })),
      sentGroups: groups, semanticBatchWindows: [{ start: 0, end: groups.length - 1 }],
      semanticGroupToBatch: groups.map(() => 0),
      semanticRequestMeta: new Map(), transInflight: new Set(), semanticRetryCounts: new Map(),
      semanticExhaustedRegions: new Map(), semanticVisibleErrors: new Map(), transCache: new Map(),
      semanticUnitCache: new Map(), semanticSourceCache: new Map(),
      semanticAlignedChunksCache: new Map(), semanticDisplayCache: new Map(),
      semanticCommitStateByRegion: new Map(), semanticRequestSerial: 0,
      semanticFocusGeneration: 0, semanticFocusedBatchIndex: -1, semanticSeekSettling: false,
      activeGroupIdx: -1, activeCueIdx: -1
    },
    settings: {
      enabled: true, targetLang: "zh-CN", aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash", aiExtraBodyRevision: 0, aiContextPast: 1, aiContextFuture: 1,
      aiPrefetchBatches: 1, aiRequestItems: 320, aiRateLimitRpm: 0, ...(overrides.settings || {})
    },
    AI_CORE_ITEMS: 32, AI_INITIAL_REQUEST_ITEMS: 48, AI_REQUEST_ITEMS: 80, AI_URGENT_REQUEST_ITEMS: 96,
    DEEPSEEK_ACCELERATED_URGENT_REQUEST_ITEMS: 64, DEEPSEEK_HIGH_SPEED_URGENT_REQUEST_ITEMS: 48,
    COMPATIBLE_ACCELERATED_URGENT_REQUEST_ITEMS: 80, COMPATIBLE_HIGH_SPEED_URGENT_REQUEST_ITEMS: 80,
    AI_REQUEST_LIMITED_MAX_REQUEST_ITEMS: 320, AI_REQUEST_LIMITED_MAX_SPECULATIVE_REQUESTS: 1,
    AI_NORMAL_MAX_REQUEST_ITEMS: 160, AI_MAX_REQUEST_ITEMS: 320, AI_HIGH_SPEED_MAX_REQUEST_ITEMS: 160,
    AI_MAX_CURRENT_CHARS: 18000, AI_COMMIT_GUARD_ITEMS: 16, SEMANTIC_COMMIT_GUARD_ITEMS: 16,
    AI_MIN_COMMIT_RUNWAY_ITEMS: 32, SEMANTIC_MIN_COMMIT_RUNWAY_ITEMS: 32,
    AI_URGENT_TARGET_TAIL_ITEMS: 48, AI_FAST_TARGET_TAIL_ITEMS: 192, AI_HIGH_SPEED_TARGET_TAIL_ITEMS: 224,
    AI_SEEK_BACKTRACK_ITEMS: 64, AI_SEEK_LEFT_GUARD_ITEMS: 16, AI_SEEK_SETTLE_MS: 140,
    AI_MAX_PREFETCH_BATCHES: 12, AI_FAST_PREFETCH_BATCHES: 3, AI_HIGH_SPEED_PREFETCH_BATCHES: 4,
    AI_CONTEXT_GROUPS: 20, AI_RATE_RETRY_LIMIT: 6, AI_COLD_RETRY_DELAYS_MS: [400, 1200, 2500],
    AI_PLAYBACK_STARTUP_GRACE_MS: 6000, AI_HIGH_SPEED_STARTUP_GRACE_MS: 3500,
    AI_PLAYBACK_PROGRESS_GRACE_MS: 4000, AI_HIGH_SPEED_PROGRESS_GRACE_MS: 2500,
    getVideo: () => ({ currentTime: 0, playbackRate: 1 }), repaintActiveAiTranslation: () => {},
    semanticDisplayWidth: () => 1000, aiUpdateDisplayError: () => {},
    emitDebug: () => {}, emitCaptionStateTransition: () => {},
    mergeCueTexts: (items) => items.map((item) => item.text).join(" "),
    cacheAiDisplayNeighborhood: () => {}, extensionContextAlive: () => true,
    captureCaptionSession: () => "session", isCaptionSessionCurrent: (token) => token === "session",
    sendRuntimeMessage: (message) => { sent.push(message); return true; },
    prefetchAiBatches: () => {}, clearPendingTimer: () => {}, setTranslation: () => {},
    sourceForDisplayedCue: () => "", aiTranslationErrorText: () => "error"
  };
  vm.createContext(context);
  for (const file of CONTENT) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  vm.runInContext("buildSemanticCommitRegions()", context);
  return { context, sent, timers, session: context.captionSession };
}

function commitUnit(runtime, first, last, translation, alignedChunks) {
  const ids = [];
  for (let id = first; id <= last; id++) ids.push(id);
  const source = ids.map((id) => `w${id}`).join(" ");
  for (const id of ids) {
    runtime.session.transCache.set(`video g${id}`, translation);
    runtime.session.semanticUnitCache.set(`video g${id}`, `semantic-${first}-${last}`);
  }
  runtime.context.recordAiLedgerUnits([{ members: ids, translation, source, alignedChunks }]);
}

test("committed units survive a reload and come back whole", async () => {
  const storage = memoryStorage();
  const first = createRuntime(storage);
  await first.context.loadAiTranslationLedger();
  commitUnit(first, 0, 4, "第一句", [
    { ids: ["0", "1"], translation: "第一", sentenceBoundaryAfter: false },
    { ids: ["2", "3", "4"], translation: "句", sentenceBoundaryAfter: true }
  ]);
  commitUnit(first, 5, 9, "第二句");
  await first.context.flushAiLedger();
  assert.equal(Array.from(storage.data.keys()).filter((key) => key.startsWith("aiLedgerV1:video:")).length, 1);

  const second = createRuntime(storage);
  const hydrated = await second.context.loadAiTranslationLedger();
  assert.equal(hydrated, 2);
  for (let id = 0; id <= 4; id++) assert.equal(second.session.transCache.get(`video g${id}`), "第一句");
  assert.equal(second.session.transCache.get("video g9"), "第二句");
  assert.equal(second.session.semanticUnitCache.get("video g7"), "semantic-5-9");
  assert.equal(second.session.semanticSourceCache.get("video g7"), "w5 w6 w7 w8 w9");
  const chunks = second.session.semanticAlignedChunksCache.get("semantic-0-4");
  assert.deepEqual(chunks.map((chunk) => [chunk.ids.join(","), chunk.translation, chunk.sentenceBoundaryAfter]),
    [["0,1", "第一", false], ["2,3,4", "句", true]]);
  // The region's lane resumes after the restored prefix.
  const state = second.context.semanticCommitState(0);
  assert.equal(state.cursor, 10);
  assert.equal(state.commitFloor, 10);
});

test("a different model, prompt or track never reuses another ledger", async () => {
  const storage = memoryStorage();
  const first = createRuntime(storage);
  await first.context.loadAiTranslationLedger();
  commitUnit(first, 0, 4, "第一句");
  await first.context.flushAiLedger();

  for (const settings of [{ aiModel: "other-model" }, { targetLang: "ja" },
    { aiExtraBodyRevision: 1 }, { aiContextPast: 3 }]) {
    const other = createRuntime(storage, { settings });
    assert.equal(await other.context.loadAiTranslationLedger(), 0, JSON.stringify(settings));
    assert.equal(other.session.transCache.size, 0);
  }
  const otherTrack = createRuntime(storage);
  otherTrack.session.cueTrackSignature = "edited-track";
  assert.equal(await otherTrack.context.loadAiTranslationLedger(), 0);
});

test("a stored unit whose source text no longer matches is dropped", async () => {
  const storage = memoryStorage();
  const first = createRuntime(storage);
  await first.context.loadAiTranslationLedger();
  commitUnit(first, 0, 4, "第一句");
  commitUnit(first, 5, 9, "第二句");
  await first.context.flushAiLedger();

  const groups = words();
  groups[6] = { ...groups[6], text: "changed" };
  const second = createRuntime(storage, { groups });
  assert.equal(await second.context.loadAiTranslationLedger(), 1);
  assert.equal(second.session.transCache.get("video g0"), "第一句");
  assert.equal(second.session.transCache.has("video g6"), false);
});

test("requests wait while the ledger loads, then resume from the playhead", async () => {
  const storage = memoryStorage();
  let release;
  const slowGet = storage.get;
  storage.get = (keys) => typeof keys === "string"
    ? new Promise((resolve) => { release = () => resolve(slowGet(keys)); })
    : slowGet(keys);
  const runtime = createRuntime(storage);
  runtime.session.activeGroupIdx = 0;
  const loading = runtime.context.loadAiTranslationLedger();
  assert.equal(runtime.context.aiLedgerBlocksRequests(), true);
  runtime.context.aiRequestBatch(0, true, true);
  assert.equal(runtime.sent.filter((message) => message.type === "translateBatch").length, 0);
  for (let i = 0; i < 4 && !release; i++) await null;
  release();
  await loading;
  assert.equal(runtime.context.aiLedgerBlocksRequests(), false);
  assert.equal(runtime.sent.filter((message) => message.type === "translateBatch").length, 1);
});

test("a commit lane continues after an already committed block", () => {
  const runtime = createRuntime(memoryStorage());
  for (let id = 10; id <= 19; id++) runtime.session.transCache.set(`video g${id}`, "已有");
  for (let id = 30; id <= 34; id++) runtime.session.transCache.set(`video g${id}`, "已有");
  const state = runtime.context.semanticCommitState(0);
  assert.equal(state.cursor, 0);
  state.cursor = 10;
  runtime.context.aiSkipCommittedBlock(0, state);
  assert.equal(state.cursor, 20);
  assert.equal(state.commitFloor, 20);
  assert.equal(state.limitEnd, 29);

  state.cursor = 30;
  runtime.context.aiSkipCommittedBlock(0, state);
  assert.equal(state.cursor, 35);
  assert.equal(state.limitEnd, 39);

  // A fully committed region leaves nothing pending.
  for (let id = 40; id <= 59; id++) runtime.session.transCache.set(`video g${id}`, "已有");
  const second = runtime.context.semanticCommitState(1);
  assert.equal(second.cursor, 60);
  assert.equal(runtime.context.aiCommitPending(second), false);
});

test("the least recently written ledgers are evicted beyond sixty videos", async () => {
  const storage = memoryStorage();
  const index = {};
  for (let i = 0; i < 60; i++) {
    const key = `aiLedgerV1:old${i}:x`;
    index[key] = { chars: 100, at: 1000 + i };
    storage.data.set(key, { v: 1, groups: 1, units: [] });
  }
  storage.data.set("aiLedgerIndexV1", index);
  const runtime = createRuntime(storage);
  await runtime.context.loadAiTranslationLedger();
  commitUnit(runtime, 0, 4, "第一句");
  await runtime.context.flushAiLedger();
  assert.equal(storage.data.has("aiLedgerV1:old0:x"), false);
  assert.equal(storage.data.has("aiLedgerV1:old59:x"), true);
  assert.equal(Object.keys(storage.data.get("aiLedgerIndexV1")).length, 60);
});

test("waiting for a local concurrency slot never exhausts a region", () => {
  const runtime = createRuntime(memoryStorage());
  for (let attempt = 0; attempt < 12; attempt++) {
    runtime.session.transInflight.clear();
    runtime.context.scheduleAiBatchRetry(0, 0, 63, "video", 1, "busy", {
      rateLimited: true, retryAfterMs: 1500,
      error: { rateLimited: true, limitReason: "local-concurrency" }
    });
  }
  assert.equal(runtime.session.semanticExhaustedRegions.size, 0);

  // A real provider rate limit still has a bounded budget.
  for (let attempt = 0; attempt < 12; attempt++) {
    runtime.session.transInflight.clear();
    runtime.context.scheduleAiBatchRetry(0, 0, 63, "video", 1, "429", {
      rateLimited: true, retryAfterMs: 1500, error: { rateLimited: true, errorCode: "HTTP_429" }
    });
  }
  assert.equal(runtime.session.semanticExhaustedRegions.size, 1);
});
