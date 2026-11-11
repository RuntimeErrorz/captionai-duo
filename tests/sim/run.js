"use strict";

// One seeded run: a synthetic video, a seeded user (play, rate changes, seeks,
// scrubs, pauses, reloads, settings changes), the real runtime in a World, and
// an invariant checker that fails on the first protocol violation.

const { World, createRandom } = require("./world");
const { FakeProvider, SECRET_KEY } = require("./provider");
const { loadShared } = require("../helpers");

const shared = loadShared();
const VIDEO_ID = "simVideo001";
const STEP_MS = 50;
const TAG = /T(\d+)-(\d+)/g;

const PROVIDER_SETTINGS = Object.freeze({
  fast: { aiBaseUrl: "https://api.deepseek.com", aiModel: "deepseek-v4-flash", aiRateLimitRpm: 0 },
  limited: { aiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    aiModel: "gemini-3.5-flash-lite", aiRateLimitRpm: 15 },
  flaky: { aiBaseUrl: "https://api.example.test/v1", aiModel: "flaky-model", aiRateLimitRpm: 60 },
  slow: { aiBaseUrl: "https://api.example.test/v1", aiModel: "thinking-model", aiRateLimitRpm: 15 }
});

// ---- synthetic video ---------------------------------------------------------
function buildTruth(random, wordCount) {
  const words = [];
  let clock = random.int(500, 4000);
  let regionLeft = 0;
  for (let id = 0; id < wordCount; id++) {
    if (regionLeft <= 0) regionLeft = random.chance(0.3) ? random.int(80, 300) : random.int(6, 60);
    regionLeft--;
    const hardAfter = regionLeft === 0 || id === wordCount - 1;
    const duration = random.int(220, 520);
    words.push({ id, start: clock, end: clock + duration, hardAfter });
    const softPause = !hardAfter && random.chance(0.04) ? random.int(900, 2500) : random.int(0, 60);
    clock += duration + (hardAfter ? random.int(4500, 9000) : softPause);
  }
  const unitEnd = new Array(wordCount);
  const unitStart = new Array(wordCount);
  for (let start = 0; start < wordCount;) {
    const length = random.int(2, 16);
    let end = start;
    while (end < wordCount - 1 && end - start + 1 < length && !words[end].hardAfter) end++;
    for (let id = start; id <= end; id++) { unitStart[id] = start; unitEnd[id] = end; }
    start = end + 1;
  }
  const regionOf = new Array(wordCount);
  for (let id = 0, region = 0; id < wordCount; id++) {
    regionOf[id] = region;
    if (words[id].hardAfter) region++;
  }
  // YouTube ASR cues: 2-9 timed words, never across a hard pause.
  const cues = [];
  for (let id = 0; id < wordCount;) {
    const size = random.int(2, 9);
    const members = [];
    while (members.length < size && id < wordCount) {
      members.push(words[id]);
      if (words[id++].hardAfter) break;
    }
    const start = members[0].start;
    const end = members[members.length - 1].end;
    cues.push({
      start, dur: end - start,
      text: members.map((word) => `w${word.id}`).join(" "),
      parts: members.map((word) => ({ text: `w${word.id}`, offsetMs: word.start - start }))
    });
  }
  // The alignment chunks the model emits for a whole unit (see provider.js).
  const canonicalChunks = (id) => {
    const start = unitStart[id];
    const end = unitEnd[id];
    if (end - start < 9) return [[start, end]];
    const mid = start + Math.floor((end - start) / 2);
    return [[start, mid], [mid + 1, end]];
  };
  return {
    words, cues, regionOf, canonicalChunks,
    unitOf: (id) => [unitStart[id], unitEnd[id]],
    durationMs: words[wordCount - 1].end + 2000
  };
}

// ---- user behaviour ------------------------------------------------------------
function buildActions(random, truth) {
  const actions = [];
  const count = random.int(5, 14);
  for (let i = 0; i < count; i++) {
    const roll = random();
    if (roll < 0.42) actions.push({ type: "play", rate: random.pick([1, 1, 1.25, 1.5, 2, 3]), ms: random.int(4000, 70000) });
    else if (roll < 0.66) actions.push({ type: "seek", to: random.int(0, truth.durationMs - 1000) });
    else if (roll < 0.74) actions.push({ type: "scrub", to: random.int(0, truth.durationMs - 1000), steps: random.int(2, 5) });
    else if (roll < 0.82) actions.push({ type: "pause", ms: random.int(500, 15000) });
    else if (roll < 0.88) actions.push({ type: "reload" });
    else if (roll < 0.94) actions.push({ type: "setting", key: "aiMaxConcurrency", value: random.int(1, 6) });
    else actions.push({ type: "play", rate: 3, ms: random.int(20000, 60000) });
  }
  actions.push({ type: "play", rate: random.pick([1, 2, 3]), ms: random.int(10000, 40000) });
  return actions;
}

// ---- invariants ------------------------------------------------------------------
class Violation extends Error {
  constructor(name, detail) {
    super(`${name}: ${JSON.stringify(detail)}`);
    this.invariant = name;
    this.detail = detail;
  }
}

function tagsOf(text) {
  return Array.from(String(text || "").matchAll(TAG), (match) => [Number(match[1]), Number(match[2])]);
}

class Checker {
  constructor(truth, provider) {
    this.truth = truth;
    this.provider = provider;
    this.committed = new Map();
    this.requests = new Map();
    this.recentCancels = [];
    this.sendTimes = [];
    this.metrics = { translateBatches: 0, sentItems: 0, cancels: 0, stallMs: 0, paints: 0 };
    this.untranslatedSince = -1;
    this.paints = [];
  }

  // The first violation wins. Checks that run inside runtime callbacks record
  // it instead of throwing into extension code, which would mask it.
  fail(name, detail) {
    if (!this.violation) this.violation = new Violation(name, detail);
    throw this.violation;
  }
  observe(fn) {
    try { fn(); } catch (error) { if (!(error instanceof Violation)) throw error; }
  }

  onTransport(event) {
    const message = event.message || event.response;
    const text = JSON.stringify(event);
    if (text.includes(SECRET_KEY)) this.fail("secret-leaked-to-transport", { kind: event.kind });
    if (event.kind === "background-reply" && event.request && event.request.type === "translateBatch") {
      this.requests.delete(event.request.requestId);
      return;
    }
    if (event.kind !== "to-background" || !message) return;
    if (message.type === "translateBatch") {
      this.metrics.translateBatches++;
      this.metrics.sentItems += Array.isArray(message.items) ? message.items.length : 0;
      const request = { requestId: message.requestId, start: message.requestStart, end: message.requestEnd,
        focus: message.focusGeneration, t: event.t };
      // The same range must not be re-sent right after it was cancelled: that
      // pays the provider twice for work that was still in flight.
      for (const cancel of this.recentCancels) {
        if (event.t - cancel.t <= 30 && cancel.start === request.start && cancel.end === request.end) {
          this.fail("cancelled-range-resent", { cancelled: cancel.requestId, resent: request.requestId,
            range: [request.start, request.end], reason: cancel.reason });
        }
      }
      this.requests.set(message.requestId, request);
      this.sendTimes.push(event.t);
      while (this.sendTimes.length && event.t - this.sendTimes[0] > 1000) this.sendTimes.shift();
      if (this.sendTimes.length > 30) this.fail("request-hot-loop", { perSecond: this.sendTimes.length, at: event.t });
    } else if (message.type === "cancelAiTranslationRequest") {
      this.noteCancel(this.requests.get(message.requestId), event.t, "request");
    } else if (message.type === "cancelAiTranslation") {
      const keep = new Set(Array.isArray(message.keepRequestIds) ? message.keepRequestIds : []);
      const before = Number(message.beforeFocusGeneration);
      for (const request of this.requests.values()) {
        if (keep.has(request.requestId)) continue;
        if (!Number.isFinite(before) || request.focus < before) this.noteCancel(request, event.t, "focus");
      }
    }
  }

  noteCancel(request, t, reason) {
    if (!request) return;
    this.metrics.cancels++;
    this.recentCancels.push({ ...request, t, reason });
    this.recentCancels = this.recentCancels.filter((cancel) => t - cancel.t <= 30);
    this.requests.delete(request.requestId);
  }

  onReload() {
    this.committed.clear();
    this.requests.clear();
    this.recentCancels = [];
  }

  // A painted translation belongs to the unit on screen: never a stale range
  // from another position or region.
  onPaint(context, text, displayState, now) {
    this.metrics.paints++;
    const sessionView = context.__sim.session;
    this.paints.push({ t: now, text: String(text || "").slice(0, 60), displayState: displayState || "",
      group: sessionView.activeGroupIdx, cue: sessionView.activeCueIdx });
    if (this.paints.length > 12) this.paints.shift();
    if (displayState === "error") return;
    const tags = tagsOf(text);
    if (!tags.length) return;
    const session = context.__sim.session;
    const group = session.activeGroupIdx;
    if (!Number.isInteger(group) || group < 0) {
      this.fail("translation-painted-without-active-group", { text, at: now });
    }
    // A display page may co-display neighbouring short units, but it is one
    // contiguous span of the active group's region that reaches its unit.
    const [unitStart, unitEnd] = this.truth.unitOf(group);
    const sorted = tags.slice().sort((x, y) => x[0] - y[0]);
    const contiguous = sorted.every((range, i) => i === 0 || range[0] === sorted[i - 1][1] + 1);
    const sameRegion = sorted.every(([a, b]) => this.truth.regionOf[a] === this.truth.regionOf[group] &&
      this.truth.regionOf[b] === this.truth.regionOf[group]);
    const reachesUnit = sorted[0][0] <= unitEnd && sorted[sorted.length - 1][1] >= unitStart;
    if (!contiguous || !sameRegion || !reachesUnit) {
      this.fail("stale-translation-painted", { activeGroup: group, unit: [unitStart, unitEnd], painted: sorted, at: now });
    }
  }

  check(context, background, now, playing) {
    const session = context.__sim.session;
    // Committed translations are immutable and match the truth they came from.
    for (const [key, value] of session.transCache) {
      const previous = this.committed.get(key);
      if (previous !== undefined) {
        if (previous !== value) this.fail("committed-translation-rewritten", { key, previous, value });
        continue;
      }
      // A committed unit starts and ends at true sentence boundaries: its
      // chunks are exactly the chunks of the whole sentence, never a fragment
      // that began mid-sentence at a request edge.
      const id = Number(String(key).slice(String(key).lastIndexOf("g") + 1));
      const expected = this.truth.canonicalChunks(id).map(([a, b]) => `T${a}-${b}`);
      const tags = tagsOf(value).map(([a, b]) => `T${a}-${b}`);
      if (!tags.length || tags.some((tag) => !expected.includes(tag))) {
        this.fail("misaligned-commit", { group: id, unit: this.truth.unitOf(id), expected, value });
      }
      this.committed.set(key, value);
      this.dirty = true;
    }
    // Every committed block begins on a true sentence boundary: a block that
    // opens mid-sentence leaves a fragment no later window can close. It may
    // end at an alignment-chunk boundary (urgent chunk progress), never
    // inside a chunk.
    if (this.dirty) {
      this.dirty = false;
      const has = (id) => session.transCache.has(`${session.cueVideoId} g${id}`);
      const last = this.truth.words.length - 1;
      for (let id = 0; id <= last; id++) {
        if (!has(id)) continue;
        const [unitStart, unitEnd] = this.truth.unitOf(id);
        if (id > 0 && !has(id - 1) && id !== unitStart) {
          this.fail("commit-block-starts-mid-sentence", { group: id, unit: [unitStart, unitEnd] });
        }
        const chunkEnds = this.truth.canonicalChunks(id).map((chunk) => chunk[1]);
        if (id < last && !has(id + 1) && !chunkEnds.includes(id)) {
          this.fail("commit-block-ends-mid-sentence", { group: id, unit: [unitStart, unitEnd] });
        }
      }
    }
    // Busy keys are exactly the live owners plus pending retry holds.
    const holds = session.semanticRequestHolds instanceof Map ? session.semanticRequestHolds : new Map();
    for (const key of session.semanticRequestMeta.keys()) {
      if (!session.transInflight.has(key)) {
        this.fail("request-owner-without-inflight-key", { key, requestId: session.semanticRequestMeta.get(key).requestId });
      }
    }
    for (const key of session.transInflight) {
      if (!session.semanticRequestMeta.has(key) && !holds.has(key)) this.fail("busy-key-without-owner-or-hold", { key });
    }
    for (const key of holds.keys()) {
      if (!session.transInflight.has(key)) this.fail("retry-hold-not-busy", { key });
    }
    // Liveness: the visible group is never left untranslated with nothing
    // working on it (no request anywhere, no fetch, no retry pending).
    const group = session.activeGroupIdx;
    const missing = playing && Number.isInteger(group) && group >= 0 && session.cueList &&
      !session.transCache.has(`${session.cueVideoId} g${group}`);
    if (missing) this.metrics.stallMs += STEP_MS;
    const idle = session.semanticRequestMeta.size === 0 && session.transInflight.size === 0 &&
      background.__sim.aiControllers.size === 0 && this.provider.inFlight === 0;
    if (missing && idle && !session.semanticSeekSettling) {
      if (this.untranslatedSince < 0) this.untranslatedSince = now;
      if (now - this.untranslatedSince > 6000 && !this.lastPaintError) {
        this.fail("visible-group-abandoned", { group, since: this.untranslatedSince, at: now });
      }
    } else {
      this.untranslatedSince = -1;
    }
  }

  quiescent(context, background, world) {
    const session = context.__sim.session;
    const leftovers = {
      contentOwners: Array.from(session.semanticRequestMeta.keys()),
      controllers: background.__sim.aiControllers.size,
      activeSlots: background.__sim.aiActiveByTab.size,
      providerStreams: this.provider.inFlight
    };
    if (leftovers.contentOwners.length || leftovers.controllers || leftovers.activeSlots || leftovers.providerStreams) {
      this.fail("not-quiescent-after-drain", leftovers);
    }
    for (const [area, store] of [["sync", world.sync], ["local", world.local], ["session", world.session]]) {
      for (const [key, value] of store.data) {
        if (key === "aiApiKeys") continue;
        if (JSON.stringify(value).includes(SECRET_KEY)) this.fail("secret-leaked-to-storage", { area, key });
      }
    }
  }
}

// ---- driver ----------------------------------------------------------------------
async function runSeed(seed, options = {}) {
  const random = createRandom(seed);
  const truth = buildTruth(random, options.words || random.int(250, 900));
  const profile = options.profile || random.pick(["fast", "fast", "limited", "limited", "flaky"]);
  const settings = {
    enabled: true, targetLang: "zh-CN", debugEnabled: true, translationEnabled: true,
    aiMaxConcurrency: random.int(1, 6), ...PROVIDER_SETTINGS[profile],
    ...(Number.isFinite(options.rpm) ? { aiRateLimitRpm: options.rpm } : {})
  };
  // Experiment overrides: the provider enforces the same RPM the profile sets.
  const overrides = {
    ...(Number.isFinite(options.rpm) ? { rpm: options.rpm } : {}),
    ...(Array.isArray(options.ttfb) ? { ttfb: options.ttfb } : {})
  };
  let world;
  const provider = new FakeProvider({ truth, random: createRandom(seed ^ 0x9e3779b9), clock: null, profile, overrides });
  let checker = null;
  world = new World({
    seed,
    sync: settings,
    local: { aiApiKeys: { [shared.aiCredentialScope(settings.aiBaseUrl)]: SECRET_KEY } },
    fetch: (url, init) => provider.fetch(url, init),
    onEvent: (event) => {
      if (options.record) options.record.push(`${event.t} ${event.kind} ${JSON.stringify(event.message || event.request || "").slice(0, 160)}`);
      if (checker) checker.observe(() => checker.onTransport(event));
    }
  });
  provider.clock = world.clock;
  checker = new Checker(truth, provider);
  const trace = [];
  const debugTail = [];
  const note = (entry) => { trace.push({ t: world.clock.now, ...entry }); if (trace.length > 400) trace.shift(); };

  const video = {
    currentTime: 0, playbackRate: 1, paused: true, seeking: false, listeners: new Map(), frameCallbacks: [],
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); },
    removeEventListener(type, fn) { if (this.listeners.has(type)) this.listeners.get(type).delete(fn); },
    dispatch(type) { for (const fn of Array.from(this.listeners.get(type) || [])) fn({ type }); },
    requestVideoFrameCallback(fn) { const id = ++this.frameId; this.frameCallbacks.push({ id, fn }); return id; },
    cancelVideoFrameCallback(id) { this.frameCallbacks = this.frameCallbacks.filter((entry) => entry.id !== id); },
    frameId: 0
  };
  const player = { clientWidth: 1100, classList: { contains: () => false }, querySelector: () => video };

  let context = null;
  const boot = async () => {
    video.listeners.clear();
    video.frameCallbacks = [];
    context = world.loadContent((ctx) => {
      ctx.getPlayer = () => player;
      ctx.getVideo = () => video;
      ctx.isPlayerFullscreen = () => false;
      ctx.ensureOverlay = () => ({});
      ctx.setOriginal = () => {};
      ctx.updateEmptyState = () => {};
      ctx.applyStateToDom = () => {};
      ctx.styleOverlay = () => {};
      ctx.syncPlayerToggle = () => {};
      ctx.semanticDisplayWidth = () => 1100;
      ctx.emitDebug = ((original) => (event, data) => {
        debugTail.push({ t: world.clock.now, event, data: JSON.stringify(data || {}).slice(0, 300) });
        if (debugTail.length > 200) debugTail.shift();
        return original(event, data);
      })(ctx.emitDebug);
      ctx.setTranslation = (text, _forSource, displayState) => {
        checker.lastPaintError = displayState === "error";
        checker.observe(() => checker.onPaint(ctx, text, displayState, world.clock.now));
      };
    });
    await context.loadSettings();
    await world.clock.advanceTo(world.clock.now + 5);
    context.onCues({ videoId: VIDEO_ID, nonce: context.__sim.session.configNonce, cues: structuredClone(truth.cues),
      trackKind: "asr", sourceLang: "en", captionTrackId: "en.asr" });
  };

  const step = async () => {
    if (!video.paused && !video.seeking) {
      video.currentTime = Math.min(truth.durationMs / 1000, video.currentTime + (STEP_MS / 1000) * video.playbackRate);
      const callbacks = video.frameCallbacks;
      video.frameCallbacks = [];
      for (const entry of callbacks) entry.fn(world.clock.now, {});
      if (Math.floor(world.clock.now / 250) !== Math.floor((world.clock.now + STEP_MS) / 250)) video.dispatch("timeupdate");
    }
    await world.clock.advanceTo(world.clock.now + STEP_MS);
    if (checker.violation) throw checker.violation;
    if (options.onStep) options.onStep(context, world);
    checker.check(context, world.background, world.clock.now, !video.paused && !video.seeking);
  };
  const runFor = async (ms) => { const until = world.clock.now + ms; while (world.clock.now < until) await step(); };
  const seekTo = async (ms) => {
    video.seeking = true;
    video.currentTime = Math.max(0, ms / 1000);
    video.dispatch("seeking");
    await runFor(random.int(20, 400));
    video.seeking = false;
    video.dispatch("seeked");
  };

  const actions = options.actions || buildActions(random, truth);
  if (Number.isFinite(options.rate)) for (const action of actions) if (action.type === "play") action.rate = options.rate;
  try {
    await boot();
    video.paused = false;
    video.dispatch("play");
    for (const action of actions) {
      note({ action });
      if (action.type === "play") {
        if (video.playbackRate !== action.rate) { video.playbackRate = action.rate; video.dispatch("ratechange"); }
        if (video.paused) { video.paused = false; video.dispatch("play"); }
        await runFor(action.ms);
      } else if (action.type === "seek") {
        await seekTo(action.to);
      } else if (action.type === "scrub") {
        for (let i = 0; i < action.steps; i++) await seekTo(action.to + random.int(-20000, 20000));
      } else if (action.type === "pause") {
        video.paused = true;
        await runFor(action.ms);
        video.paused = false;
        video.dispatch("play");
      } else if (action.type === "reload") {
        checker.onReload();
        await boot();
      } else if (action.type === "setting") {
        await world.sync.set({ [action.key]: action.value });
      }
      if (video.currentTime * 1000 >= truth.durationMs - 1500) await seekTo(random.int(0, truth.durationMs / 2));
    }
    video.paused = true;
    await runFor(180000);
    if (checker.violation) throw checker.violation;
    checker.quiescent(context, world.background, world);
    return { ok: true, seed, profile, metrics: checker.metrics, virtualMs: world.clock.now,
      providerRequests: provider.requests, provider429: provider.rejected429, words: truth.words.length };
  } catch (error) {
    if (!(error instanceof Violation)) throw error;
    return { ok: false, seed, profile, invariant: error.invariant, detail: error.detail,
      at: world.clock.now, trace: trace.slice(-12), paints: checker.paints.slice(-8),
      debug: debugTail.slice(-40) };
  }
}

module.exports = { runSeed, buildTruth, Violation };
