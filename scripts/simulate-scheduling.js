#!/usr/bin/env node
// Replays playback against the real content scheduler with a simulated
// provider, to compare scheduling changes. Usage:
//   node scripts/simulate-scheduling.js [repoRoot] [deepseek|gemini] [rate] [short|long]
// SCENARIO=reload plays the video, reloads the page and plays it again;
// SCENARIO=seekback plays to 60%, seeks back to 20% and plays to the end;
// SCENARIO=hop plays 0-20%, jumps to 50-60%, then plays 20% to the end.
// repoRoot defaults to this checkout, so an older tree (git archive) can be
// measured with the same scenario.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const provider = process.argv[3] || "deepseek";
const playbackRate = Number(process.argv[4] || 2);
const regionShape = process.argv[5] || "short";
const scenario = process.env.SCENARIO || "play";
const { loadShared } = require(path.join(root, "tests/helpers.js"));

// ---- deterministic scenario -------------------------------------------
let seed = 7;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const WORD_MS = 400;           // ~2.5 words per second of speech
const HARD_PAUSE_MS = 4500;    // >= 4000 ms creates a hard region boundary
const WORDS = 1200;
const words = [];
let clock = 0;
let regionLeft = 0;
for (let id = 0; id < WORDS; id++) {
  if (regionLeft <= 0) {
    regionLeft = regionShape === "long"
      ? 120 + Math.floor(random() * 281)   // long monologue regions
      : 10 + Math.floor(random() * 51);    // 10-60 words, as in the log
  }
  regionLeft--;
  const hardAfter = regionLeft === 0 || id === WORDS - 1;
  words.push({ id, start: clock, end: clock + WORD_MS, hardAfter });
  clock += WORD_MS + (hardAfter ? HARD_PAUSE_MS : 0);
}
// Ground-truth sentences: ~12 words, never across a hard boundary.
const unitEndOf = new Array(WORDS);
for (let start = 0; start < WORDS;) {
  let length = Math.max(3, Math.round(12 + (random() - 0.5) * 10));
  let end = start;
  while (end < WORDS - 1 && end - start + 1 < length && !words[end].hardAfter) end++;
  for (let id = start; id <= end; id++) unitEndOf[id] = end;
  start = end + 1;
}

const PROVIDERS = {
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", rpm: 0,
    ttfb: () => 120 + random() * 120, perItemMs: 16, maxActive: 12 },
  compatible: { baseUrl: "https://api.example.com/v1", model: "generic-model", rpm: 0,
    ttfb: () => 700 + random() * 800, perItemMs: 8, maxActive: 4 },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.5-flash-lite-preview", rpm: 15,
    ttfb: () => 6500 + random() * 2300, perItemMs: 3, maxActive: 1 }
};
const spec = PROVIDERS[provider];

// ---- virtual time ------------------------------------------------------
let now = 0;
const timers = [];
const at = (time, fn) => timers.push({ time, fn, order: timers.length });
const runDue = () => {
  timers.sort((a, b) => a.time - b.time || a.order - b.order);
  while (timers.length && timers[0].time <= now) timers.shift().fn();
};

// ---- content context -----------------------------------------------------
const shared = loadShared();
const contentFiles = ["content/semantic-policy.js", "content/semantic-requests.js",
  "content/semantic-results.js", "content/semantic-lookahead.js", "content/semantic.js",
  "content/translation-ledger.js", "content/cue-indicator.js", "content/cue-playback.js"]
  .filter((file) => fs.existsSync(path.join(root, file)));
const httpSource = fs.readFileSync(path.join(root, "background/http.js"), "utf8");
const adaptiveTimeouts = httpSource.includes("aiConnectTimeoutMs");
const groups = words.map((word) => ({
  startIdx: word.id, endIdx: word.id, text: `w${word.id}`, start: word.start, end: word.end,
  pauseAfterMs: word.hardAfter ? HARD_PAUSE_MS : 0, softAfter: false, hardAfter: word.hardAfter
}));
const batchWindows = [];
for (let start = 0; start < WORDS; start += 32) batchWindows.push({ start, end: Math.min(WORDS - 1, start + 31) });
let videoTimeMs = 0;
const metrics = { requests: 0, httpAttempts: 0, sentItems: 0, outputItems: 0, timeouts: 0 };
// chrome.storage.local survives the simulated page reload.
const storageData = new Map();
const eventCounts = {};
const storageLocal = {
  get: async (keys) => {
    const out = {};
    if (typeof keys === "string") { if (storageData.has(keys)) out[keys] = storageData.get(keys); return out; }
    for (const [key, fallback] of Object.entries(keys || {})) {
      out[key] = storageData.has(key) ? storageData.get(key) : fallback;
    }
    return out;
  },
  set: async (values) => { for (const [key, value] of Object.entries(values)) storageData.set(key, JSON.parse(JSON.stringify(value))); },
  remove: async (keys) => { for (const key of [].concat(keys)) storageData.delete(key); }
};
const context = {
  Map, Set, Math, Number, String, Array, Object, Promise, JSON,
  chrome: { storage: { local: storageLocal } },
  Date: { now: () => now },
  queueMicrotask: (fn) => at(now, fn),
  setTimeout: (fn, delay) => { at(now + Math.max(0, Number(delay) || 0), fn); return timers.length; },
  clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  YTDS_SHARED: shared,
  captionSession: {
    cueVideoId: "video", currentVideoId: "video", cueEpoch: 1, cueSourceLang: "en",
    cueTrackSignature: "track", semanticCommitStateByRegion: new Map(),
    cueList: groups.map((group) => ({ text: group.text, start: group.start, end: group.end })),
    cueToGroup: groups.map((_g, id) => id), cueToGroups: groups.map((_g, id) => [id]),
    sentGroups: groups, semanticBatchWindows: batchWindows,
    semanticGroupToBatch: groups.map((_g, id) => Math.floor(id / 32)),
    semanticRequestMeta: new Map(), transInflight: new Set(), semanticRetryCounts: new Map(),
    semanticExhaustedRegions: new Map(), semanticVisibleErrors: new Map(), transCache: new Map(),
    semanticUnitCache: new Map(), semanticSourceCache: new Map(),
    semanticAlignedChunksCache: new Map(), semanticDisplayCache: new Map(),
    semanticRequestSerial: 0, semanticFocusGeneration: 0, semanticFocusedBatchIndex: -1,
    semanticSeekSettling: false, semanticLayoutWidth: 0, pendingTimer: null,
    pendingIndicatorKey: "", activeGroupIdx: -1, activeCueIdx: -1
  },
  settings: {
    enabled: true, targetLang: "zh-CN", debugEnabled: false, aiBaseUrl: spec.baseUrl,
    aiModel: spec.model, aiPrefetchBatches: 1,
    aiRequestItems: Number(process.env.REQUEST_ITEMS || 96), aiRateLimitRpm: spec.rpm,
    aiExtraBodyRevision: 0, aiContextPast: 1, aiContextFuture: 1,
    aiMaxConcurrency: Number(process.env.CONC || 4)
  },
  SEMANTIC_CORE_ITEMS: 32, AI_CORE_ITEMS: 32, AI_INITIAL_REQUEST_ITEMS: 48, AI_REQUEST_ITEMS: 80,
  AI_URGENT_REQUEST_ITEMS: 96,
  ACCELERATED_URGENT_REQUEST_ITEMS: Number(process.env.ACCEL_URGENT || 128),
  DEEPSEEK_ACCELERATED_URGENT_REQUEST_ITEMS: 64,
  DEEPSEEK_HIGH_SPEED_URGENT_REQUEST_ITEMS: 48, COMPATIBLE_ACCELERATED_URGENT_REQUEST_ITEMS: 80,
  COMPATIBLE_HIGH_SPEED_URGENT_REQUEST_ITEMS: 80, GEMINI_REQUEST_ITEMS: 96,
  GEMINI_MAX_REQUEST_ITEMS: 320, GEMINI_MAX_SPECULATIVE_REQUESTS: 1,
  AI_REQUEST_LIMITED_MAX_REQUEST_ITEMS: 320, AI_REQUEST_LIMITED_MAX_SPECULATIVE_REQUESTS: 1,
  AI_NORMAL_MAX_REQUEST_ITEMS: 160, AI_MAX_REQUEST_ITEMS: 320, AI_HIGH_SPEED_MAX_REQUEST_ITEMS: 160,
  AI_MAX_CURRENT_CHARS: 18000, SEMANTIC_COMMIT_GUARD_ITEMS: 16, AI_COMMIT_GUARD_ITEMS: 16,
  SEMANTIC_MIN_COMMIT_RUNWAY_ITEMS: 32, AI_MIN_COMMIT_RUNWAY_ITEMS: 32,
  AI_URGENT_TARGET_TAIL_ITEMS: 48, AI_FAST_TARGET_TAIL_ITEMS: 192, AI_HIGH_SPEED_TARGET_TAIL_ITEMS: 224,
  AI_SEEK_BACKTRACK_ITEMS: 64, AI_SEEK_LEFT_GUARD_ITEMS: 16, AI_SEEK_SETTLE_MS: 140,
  AI_MAX_PREFETCH_BATCHES: 12, AI_FAST_PREFETCH_BATCHES: 3, AI_HIGH_SPEED_PREFETCH_BATCHES: 4,
  AI_CONTEXT_GROUPS: 20, AI_COLD_RETRY_DELAYS_MS: Object.freeze([400, 1200, 2500]),
  AI_RATE_RETRY_LIMIT: 6, AI_PLAYBACK_STARTUP_GRACE_MS: 6000, AI_HIGH_SPEED_STARTUP_GRACE_MS: 3500,
  AI_PLAYBACK_PROGRESS_GRACE_MS: 4000, AI_HIGH_SPEED_PROGRESS_GRACE_MS: 2500,
  emitDebug: (event) => { eventCounts[event] = (eventCounts[event] || 0) + 1; },
  emitCaptionStateTransition: () => {},
  mergeCueTexts: (items) => items.map((item) => item.text).join(" "),
  cacheAiDisplayNeighborhood: () => {}, semanticDisplayWidth: () => 1000,
  repaintActiveAiTranslation: () => {}, aiTranslationErrorText: () => "error",
  clearPendingTimer: () => {}, sourceForDisplayedCue: () => "", manualTranslationSelected: () => false,
  manualTranslationTextAt: () => "", setTranslation: () => {}, setOriginal: () => {},
  t: (_key, fallback) => fallback, armPendingTranslationIndicator: () => {},
  maybeReflowSemanticDisplay: () => {}, extensionContextAlive: () => true,
  getVideo: () => ({ currentTime: videoTimeMs / 1000, playbackRate }),
  captureCaptionSession: () => "session", isCaptionSessionCurrent: (token) => token === "session",
  aiGroupForCueAt: (idx) => idx, aiUpdateDisplayError: () => {}
};

// ---- simulated provider + worker -------------------------------------------
let active = 0;
let lastStart = -Infinity;
const interval = spec.rpm > 0 ? Math.ceil((60000 / spec.rpm) * 1.05) : 0;
const live = new Map();
function modelUnits(start, end, regionEnd) {
  const units = [];
  for (let id = start; id <= end;) {
    const unitEnd = Math.min(unitEndOf[id], regionEnd);
    // A unit that would continue past the window is an unresolved suffix.
    if (unitEnd > end) break;
    units.push([id, unitEnd]);
    id = unitEnd + 1;
  }
  return units;
}
function respond(entry, payload) {
  if (entry.done) return;
  entry.done = true;
  live.delete(entry.message.requestId);
  active = Math.max(0, active - 1);
  entry.callback(payload);
}
context.sendRuntimeMessage = (message, callback) => {
  if (message.type === "cancelAiTranslationRequest" || message.type === "cancelAiTranslation") {
    for (const entry of Array.from(live.values())) {
      const kept = Array.isArray(message.keepRequestIds) &&
        message.keepRequestIds.includes(entry.message.requestId);
      if ((message.type === "cancelAiTranslation" && !kept) ||
          entry.message.requestId === message.requestId) {
        // Chrome delivers the cancelled reply later, after the page has
        // already dropped the request's owner; never answer synchronously.
        at(now, () => respond(entry, { ok: false, cancelled: true, errorCode: "AI_CANCELLED", translations: [] }));
      }
    }
    if (typeof callback === "function") callback({ ok: true });
    return true;
  }
  if (message.type !== "translateBatch") return true;
  // Newer trees send the profile's concurrency; older ones imply it.
  const maxActive = spec.rpm > 0 && spec.rpm <= 30 ? 1
    : Number.isInteger(message.maxConcurrency) ? message.maxConcurrency : spec.maxActive;
  const status = shared.aiConcurrencyStatus(active, maxActive, !!message.urgent);
  if (!status.allowed) {
    at(now, () => callback({ ok: false, rateLimited: true, retryAfterMs: status.retryAfterMs,
      limitReason: status.reason, errorCode: "AI_RATE_LIMITED" }));
    return true;
  }
  active++;
  const entry = { message, callback, done: false };
  live.set(message.requestId, entry);
  const regionEnd = (() => { let id = message.requestEnd; while (id < WORDS - 1 && !words[id].hardAfter) id++; return id; })();
  const units = modelUnits(message.requestStart, message.requestEnd, Math.max(message.requestEnd, regionEnd))
    .filter(([, end]) => end <= message.requestEnd);
  const guard = Number.isInteger(message.commitGuardLocal) && message.commitGuardLocal > 0
    ? message.requestStart + message.commitGuardLocal : Infinity;
  const attempt = (number, attemptStart) => {
    if (entry.done) return;
    metrics.httpAttempts++;
    if (number === 1) {
      metrics.requests++;
      metrics.sentItems += message.items.length;
    }
    const ttfb = spec.ttfb();
    const connectTimeout = adaptiveTimeouts
      ? (spec.rpm > 0 && spec.rpm <= 30 ? 20000 : message.urgent ? 8000 : 12000)
      : (message.urgent ? 8000 : 12000);
    if (ttfb > connectTimeout && number < 3) {
      metrics.timeouts++;
      at(attemptStart + connectTimeout + 800, () => {
        if (!entry.done) enqueue(entry, () => attempt(number + 1, now));
      });
      return;
    }
    let t = attemptStart + ttfb;
    const delivered = [];
    for (const [s, e] of units) {
      t += (e - s + 1) * spec.perItemMs;
      const unit = Array.from({ length: e - s + 1 }, (_v, k) => ({
        id: String(s + k), unitId: `semantic-${s}-${e}`, translation: "译文" }));
      metrics.outputItems += e - s + 1;
      delivered.push(...unit);
      at(t, () => {
        if (entry.done) return;
        context.handleAiTranslationProgress({ type: "translationBatchProgress",
          requestId: message.requestId, videoId: "video",
          focusGeneration: message.focusGeneration, translations: unit });
      });
      if (e >= guard) break; // worker stops the stream at the runway
    }
    const all = delivered.slice();
    at(t + 50, () => respond(entry, { ok: true, translations: all,
      deferredIds: [], httpDiagnostics: { attempts: [] }, partial: false }));
  };
  enqueue(entry, () => attempt(1, now));
  return true;
};

// The worker spaces HTTP starts by the provider interval; urgent first.
// A request cancelled while waiting never consumes a slot.
const startQueue = [];
let pumpScheduled = false;
function enqueue(entry, start) {
  startQueue.push({ entry, start, order: startQueue.length });
  pumpStarts();
}
function pumpStarts() {
  for (let i = startQueue.length - 1; i >= 0; i--) if (startQueue[i].entry.done) startQueue.splice(i, 1);
  if (!startQueue.length) return;
  const ready = lastStart + interval;
  if (now < ready) {
    if (!pumpScheduled) { pumpScheduled = true; at(ready, () => { pumpScheduled = false; pumpStarts(); }); }
    return;
  }
  startQueue.sort((a, b) => Number(!!b.entry.message.urgent) - Number(!!a.entry.message.urgent) || a.order - b.order);
  const next = startQueue.shift();
  lastStart = now;
  next.start();
  if (startQueue.length) pumpStarts();
}

vm.createContext(context);
for (const file of contentFiles) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}
vm.runInContext("buildSemanticCommitRegions()", context);
const hasLedger = typeof context.loadAiTranslationLedger === "function";

// ---- playback -------------------------------------------------------------
const STEP = 50;
const totalVideoMs = words[WORDS - 1].end;
const settle = async () => { for (let i = 0; i < 4; i++) await null; };
async function play(fromMs, untilMs) {
  const result = { stallMs: 0, stalls: 0 };
  let stalled = false;
  let lastGroup = -2;
  videoTimeMs = fromMs;
  while (videoTimeMs < untilMs) {
    await settle();
    runDue();
    const word = words.find((w) => videoTimeMs >= w.start && videoTimeMs < w.end);
    const group = word ? word.id : -1;
    const session = context.captionSession;
    session.activeGroupIdx = group;
    session.activeCueIdx = group;
    if (group !== lastGroup && group >= 0) {
      if (!session.transCache.has(`video g${group}`)) context.aiRequestBatch(group, true, true);
      context.prefetchAiBatches(group, false);
      lastGroup = group;
    }
    const missing = group >= 0 && !session.transCache.has(`video g${group}`);
    if (missing) { result.stallMs += STEP; if (!stalled) result.stalls++; }
    stalled = missing;
    now += STEP;
    videoTimeMs += STEP * playbackRate;
  }
  return result;
}
function reloadPage() {
  const session = context.captionSession;
  for (const key of ["transCache", "semanticUnitCache", "semanticSourceCache",
    "semanticAlignedChunksCache", "semanticDisplayCache", "semanticRequestMeta",
    "semanticRetryCounts", "semanticExhaustedRegions", "semanticVisibleErrors"]) session[key].clear();
  session.transInflight.clear();
  for (const entry of Array.from(live.values())) respond(entry, { ok: false, cancelled: true, translations: [] });
  vm.runInContext("buildSemanticCommitRegions()", context);
}

(async () => {
  if (hasLedger) await context.loadAiTranslationLedger();
  const passes = [];
  const snapshot = () => ({ ...metrics });
  const delta = (before) => ({ requests: metrics.requests - before.requests,
    sentItems: metrics.sentItems - before.sentItems });
  if (scenario === "reload") {
    let before = snapshot();
    passes.push({ pass: "first", ...(await play(0, totalVideoMs)), ...delta(before) });
    if (hasLedger) await context.flushAiLedger();
    await settle();
    reloadPage();
    if (hasLedger) await context.loadAiTranslationLedger();
    before = snapshot();
    passes.push({ pass: "after-reload", ...(await play(0, totalVideoMs)), ...delta(before) });
  } else if (scenario === "seekback") {
    let before = snapshot();
    passes.push({ pass: "to-60%", ...(await play(0, totalVideoMs * 0.6)), ...delta(before) });
    before = snapshot();
    passes.push({ pass: "20%-to-end", ...(await play(totalVideoMs * 0.2, totalVideoMs)), ...delta(before) });
  } else if (scenario === "hop") {
    // Jump ahead, then back: the lane resuming at 20% runs into the block
    // already committed at 50-60% of the same long region.
    let before = snapshot();
    passes.push({ pass: "0-20%", ...(await play(0, totalVideoMs * 0.2)), ...delta(before) });
    before = snapshot();
    passes.push({ pass: "50-60%", ...(await play(totalVideoMs * 0.5, totalVideoMs * 0.6)), ...delta(before) });
    before = snapshot();
    passes.push({ pass: "20%-end", ...(await play(totalVideoMs * 0.2, totalVideoMs)), ...delta(before) });
  } else {
    passes.push({ pass: "play", ...(await play(0, totalVideoMs)) });
  }
  const stallMs = passes.reduce((sum, item) => sum + item.stallMs, 0);
  const stalls = passes.reduce((sum, item) => sum + item.stalls, 0);
  const label = path.basename(root);
  console.log(JSON.stringify({
    tree: label, provider, playbackRate, regionShape,
    scenario, stallSeconds: +(stallMs / 1000).toFixed(1), stallEpisodes: stalls,
    requests: metrics.requests, httpAttempts: metrics.httpAttempts, connectTimeouts: metrics.timeouts,
    inputAmplification: +(metrics.sentItems / WORDS).toFixed(2),
    outputAmplification: +(metrics.outputItems / WORDS).toFixed(2),
    wallSeconds: +(now / 1000).toFixed(0),
    ...(process.env.EVENTS ? { events: eventCounts } : {}),
    passes: passes.map((item) => ({ ...item, stallMs: undefined,
      stallSeconds: +(item.stallMs / 1000).toFixed(1) }))
  }));
})();
