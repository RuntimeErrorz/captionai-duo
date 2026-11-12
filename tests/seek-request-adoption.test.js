"use strict";

// A seek that lands inside a live commit request must keep that request: the
// post-seek scheduler would otherwise send the identical range again and pay
// the provider rate limit twice (log: seek 157s -> 263s re-sent 613-932).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const contentSource = [
  "content/session.js",
  "content/semantic-policy.js",
  "content/semantic-requests.js",
  "content/semantic-results.js",
  "content/semantic-lookahead.js",
  "content/semantic.js",
  "content/cue-playback.js"
].map(read).join("\n");

const GROUPS = 1200;
const BATCH = 32;

function loadContent() {
  const messages = [];
  const transitions = [];
  const context = {
    Map, Set, Math, Number, String, Array, Object, Promise, JSON, Date,
    queueMicrotask: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    YTDS_SHARED: loadShared(),
    videoIdFromLocation: () => "video",
    extensionContextAlive: () => true,
    sendRuntimeMessage: (message) => { messages.push(message); return true; },
    emitDebug: (event, data) => {
      if (event === "state-transition") transitions.push(data);
    },
    settings: { targetLang: "zh-CN", aiRateLimitRpm: 15, aiMaxConcurrency: 4, aiPrefetchBatches: 2 },
    AI_MAX_PREFETCH_BATCHES: 12, AI_FAST_PREFETCH_BATCHES: 3,    getVideo: () => ({ currentTime: 0, playbackRate: 3 }),
    repaintActiveAiTranslation: () => {},
    cacheAiDisplayNeighborhood: () => {},
    semanticDisplayWidth: () => 1000
  };
  vm.createContext(context);
  vm.runInContext(contentSource, context, { filename: "content-runtime.js" });
  const session = vm.runInContext("captionSession", context);
  const groups = Array.from({ length: GROUPS }, (_v, id) => ({
    startIdx: id, endIdx: id, text: `w${id}`, start: id * 100, end: id * 100 + 100
  }));
  Object.assign(session, {
    cueVideoId: "video",
    cueEpoch: 3,
    cueList: groups.map((group) => ({ text: group.text, start: group.start, end: group.end })),
    cueToGroup: groups.map((_g, id) => id),
    cueToGroups: groups.map((_g, id) => [id]),
    sentGroups: groups,
    semanticCommitRegions: [{ start: 0, end: 599 }, { start: 600, end: GROUPS - 1 }],
    semanticGroupToCommitRegion: groups.map((_g, id) => (id < 600 ? 0 : 1)),
    semanticBatchWindows: Array.from({ length: GROUPS / BATCH }, (_v, i) => ({
      start: i * BATCH, end: i * BATCH + BATCH - 1
    })),
    semanticGroupToBatch: groups.map((_g, id) => Math.floor(id / BATCH)),
    semanticFocusGeneration: 1,
    semanticFocusedBatchIndex: 0
  });
  return {
    context,
    session,
    messages,
    transitions,
    capture: vm.runInContext("captureCaptionSession", context),
    isCurrent: vm.runInContext("isCaptionSessionCurrent", context),
    focusAiAfterSeek: vm.runInContext("focusAiAfterSeek", context),
    finishAiRequest: vm.runInContext("finishAiRequest", context),
    handleProgress: vm.runInContext("handleAiTranslationProgress", context)
  };
}

function startCommit(harness, regionIndex, start, end) {
  const { session } = harness;
  const key = `dsb:${regionIndex}`;
  const request = {
    requestId: `commit:${session.semanticFocusGeneration}:9:${start}-${end}`,
    regionIndex, requestStart: start, requestEnd: end,
    reqVid: "video", reqEpoch: session.cueEpoch,
    sessionToken: harness.capture(),
    focusGeneration: session.semanticFocusGeneration,
    urgent: false, startedAt: 0, lastProgressAt: 0, progressCursor: start,
    progressTranslations: [], progressRecoveryTranslations: []
  };
  session.semanticRequestMeta.set(key, request);
  session.transInflight.add(key);
  return { key, request };
}

const groupTimeMs = (group) => group * 100 + 50;

test("a seek inside a live commit range keeps that request and its response", () => {
  const harness = loadContent();
  const { key, request } = startCommit(harness, 1, 613, 932);

  harness.focusAiAfterSeek(groupTimeMs(799));

  // Still owned, owned by the new session, and not cancelled remotely.
  assert.equal(harness.session.semanticRequestMeta.get(key), request);
  assert.ok(harness.session.transInflight.has(key));
  assert.equal(harness.isCurrent(request.sessionToken), true);
  assert.equal(request.reqEpoch, harness.session.cueEpoch);
  const cancels = harness.messages.filter((m) => m.type === "cancelAiTranslation");
  assert.equal(cancels.length, 1);
  assert.deepEqual(Array.from(cancels[0].keepRequestIds), [request.requestId]);
  assert.equal(harness.messages.some((m) => m.type === "cancelAiTranslationRequest"), false);

  // Progress the worker streams with the send-time focus is still accepted.
  harness.handleProgress({
    type: "translationBatchProgress", requestId: request.requestId, videoId: "video",
    focusGeneration: request.focusGeneration,
    translations: [{ id: "613", unitId: "semantic-613-613", translation: "译文" }]
  });
  assert.equal(harness.transitions.some((t) =>
    t.machine === "semantic-progress" && t.transition === "discarded"), false);

  // The final response is delivered to the current owner.
  const finished = harness.finishAiRequest(key, request.requestId);
  assert.equal(finished, request);
  assert.equal(harness.isCurrent(finished.sessionToken), true);
});

test("a seek outside every live commit range still revokes and cancels it", () => {
  const harness = loadContent();
  const { key, request } = startCommit(harness, 1, 613, 932);
  const oldToken = request.sessionToken;

  harness.focusAiAfterSeek(groupTimeMs(1000));

  assert.equal(harness.session.semanticRequestMeta.has(key), false);
  assert.equal(harness.isCurrent(oldToken), false);
  const cancel = harness.messages.find((m) => m.type === "cancelAiTranslation");
  assert.deepEqual(Array.from(cancel.keepRequestIds), []);
});

test("seek adoption keeps exactly the commit request covering the new target", () => {
  // Fixed-seed property loop over request ranges and seek targets.
  let seed = 0x5eed;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let round = 0; round < 300; round++) {
    const harness = loadContent();
    const regionIndex = random() < 0.5 ? 0 : 1;
    const regionStart = regionIndex === 0 ? 0 : 600;
    const regionEnd = regionIndex === 0 ? 599 : GROUPS - 1;
    const start = regionStart + Math.floor(random() * (regionEnd - regionStart - 10));
    const end = Math.min(regionEnd, start + 1 + Math.floor(random() * 320));
    const { key, request } = startCommit(harness, regionIndex, start, end);
    const target = Math.floor(random() * GROUPS);
    const targetBatch = Math.floor(target / BATCH);
    if (targetBatch === harness.session.semanticFocusedBatchIndex) continue;

    harness.focusAiAfterSeek(groupTimeMs(target));

    const covers = target >= start && target <= end;
    assert.equal(harness.session.semanticRequestMeta.get(key) === request, covers,
      `seed round ${round}: request ${start}-${end} target ${target}`);
    assert.equal(harness.isCurrent(request.sessionToken), covers);
    const cancel = harness.messages.find((m) => m.type === "cancelAiTranslation");
    assert.deepEqual(Array.from(cancel.keepRequestIds), covers ? [request.requestId] : []);
  }
});

test("the worker keeps only the named requests when cancelling an older focus", () => {
  const context = {
    AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout,
    fetch: async () => { throw new Error("network should not be reached"); },
    YTDS_SHARED: loadShared(),
    AI_STREAM_COMPLETION_GRACE_MS: 750,
    aiControllers: new Map()
  };
  vm.createContext(context);
  vm.runInContext(read("background/http.js"), context, { filename: "background/http.js" });
  const register = vm.runInContext("registerAiController", context);
  const cancel = vm.runInContext("cancelAiForSender", context);
  const sender = { tab: { id: 7 } };
  const kept = new AbortController();
  const dropped = new AbortController();
  const current = new AbortController();
  register(sender, "video", kept, 1, "commit:1:4:613-932", false);
  register(sender, "video", dropped, 1, "commit:1:3:342-661", false);
  register(sender, "video", current, 2, "commit:2:5:933-1100", true);

  cancel(sender, "video", 2, ["commit:1:4:613-932"]);

  assert.equal(kept.signal.aborted, false);
  assert.equal(dropped.signal.aborted, true);
  assert.equal(current.signal.aborted, false);
  cancel(sender, "video", 3, "not-an-array");
  assert.equal(kept.signal.aborted, true, "a malformed keep list keeps nothing");
});

test("a seek drops the demand the previous focus left in every region", () => {
  // Stale targets made the lookahead restart, urgently, a far range the seek
  // had just cancelled (sim seed 55).
  const harness = loadContent();
  const state = vm.runInContext("semanticCommitState(1)", harness.context);
  Object.assign(state, { cursor: 700, targetThrough: 933, urgentTarget: 925, lookaheadThrough: 950 });

  harness.focusAiAfterSeek(groupTimeMs(100));

  assert.ok(state.targetThrough < state.cursor);
  assert.ok(state.urgentTarget < state.cursor);
  assert.ok(state.lookaheadThrough < state.cursor);
});

test("a reseed keeps a live writer that already starts at the reseed position", () => {
  // Playback overtaking a slow first byte reseeded to the same start and
  // re-sent the identical range, discarding the wait (sim seed 9).
  const harness = loadContent();
  Object.assign(harness.context, { AI_SEEK_BACKTRACK_ITEMS: 64, AI_SEEK_LEFT_GUARD_ITEMS: 16,
    AI_INITIAL_REQUEST_ITEMS: 48 });
  const session = harness.session;
  session.transCache.set(`${session.cueVideoId} g612`, "T600-612");
  const state = vm.runInContext("semanticCommitState(1)", harness.context);
  Object.assign(state, { cursor: 613, commitFloor: 613 });
  const { key, request } = startCommit(harness, 1, 613, 932);
  const reseed = vm.runInContext("reseedSemanticCommitState", harness.context);

  // At 3x the reseed backtracks 24 items; from 630 it stops after the
  // committed 612, so the reseed start is 613.
  reseed(1, 630);

  assert.equal(session.semanticRequestMeta.get(key), request);
  assert.equal(harness.messages.some((m) => m.type === "cancelAiTranslationRequest"), false);
  assert.equal(state.cursor, 613);

  // A writer that starts elsewhere is still replaced.
  state.cursor = 640;
  session.transCache.set(`${session.cueVideoId} g639`, "T630-639");
  request.requestStart = 630;
  reseed(1, 680);
  assert.equal(session.semanticRequestMeta.has(key), false);
});

test("a stale retry hold can never release a key a newer owner holds", () => {
  const harness = loadContent();
  const run = (code) => vm.runInContext(code, harness.context);
  const session = harness.session;
  const hold = run("holdAiRequestKey('dsb:1')");
  assert.ok(session.transInflight.has("dsb:1"));

  // A seek revokes the hold; a new writer claims the same key.
  run("revokeAiRequestKeys((key) => key.startsWith('dsb:'))");
  const { request } = startCommit(harness, 1, 613, 932);
  run("claimAiRequestOwner('dsb:1', captionSession.semanticRequestMeta.get('dsb:1'))");

  // The stale retry timer fires later and tries to release its hold.
  assert.equal(harness.context.releaseAiRequestHold(hold), false);
  assert.equal(session.semanticRequestMeta.get("dsb:1"), request);
  assert.ok(session.transInflight.has("dsb:1"), "the live owner keeps its busy key");

  assert.equal(harness.context.releaseAiRequestOwner("dsb:1", request), true);
  assert.equal(session.transInflight.has("dsb:1"), false);
});

test("a seek keeps a later region's lookahead lane that the new position still reaches", () => {
  // Scrubbing back by a few seconds cancelled the next region's lane and the
  // lookahead re-sent the identical range at once (sim seed 5059).
  for (const [target, kept] of [[520, true], [100, false]]) {
    const harness = loadContent();
    const state = vm.runInContext("semanticCommitState(1)", harness.context);
    state.cursor = 600;
    const { key, request } = startCommit(harness, 1, 600, 700);

    harness.focusAiAfterSeek(groupTimeMs(target));

    assert.equal(harness.session.semanticRequestMeta.get(key) === request, kept, `target ${target}`);
    const cancel = harness.messages.find((m) => m.type === "cancelAiTranslation");
    assert.deepEqual(Array.from(cancel.keepRequestIds), kept ? [request.requestId] : []);
  }
});

test("a seek back inside a region keeps that region's lane running from its cursor", () => {
  // The target is already committed and lies behind the lane's start; the
  // lookahead would restart the identical lane at once (sim seed 20035).
  const harness = loadContent();
  const state = vm.runInContext("semanticCommitState(1)", harness.context);
  state.cursor = 700;
  const { key, request } = startCommit(harness, 1, 700, 800);

  harness.focusAiAfterSeek(groupTimeMs(680));

  assert.equal(harness.session.semanticRequestMeta.get(key), request);
});

test("a lane just past the lookahead reach survives the seek that playback is about to reach", () => {
  // Cancelling a lane one item beyond reach re-sent it 10 ms later, once the
  // playhead advanced one group (sim seed 9021, request items 160).
  const harness = loadContent();
  const reach = 520 + vm.runInContext("aiLookaheadItems()", harness.context);
  for (const [start, kept] of [[reach + 1, true], [reach + 32, true], [reach + 33, false]]) {
    const run = loadContent();
    const state = vm.runInContext("semanticCommitState(1)", run.context);
    state.cursor = start;
    const { key, request } = startCommit(run, 1, start, start + 100);
    run.focusAiAfterSeek(groupTimeMs(520));
    assert.equal(run.session.semanticRequestMeta.get(key) === request, kept, `lane at ${start}`);
  }
});
