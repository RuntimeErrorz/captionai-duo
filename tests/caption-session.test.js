"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const sessionSource = fs.readFileSync(path.join(root, "content/session.js"), "utf8");
const fallbackSource = fs.readFileSync(path.join(root, "content/fallback.js"), "utf8");

function loadFallbackLifecycleHarness() {
  const timers = new Map();
  const requests = [];
  const messages = [];
  const painted = [];
  let nextTimerId = 0;
  let session;
  const context = {
    Object,
    String,
    Number,
    Math,
    Map,
    Set,
    videoIdFromLocation: () => "video",
    extensionContextAlive: () => true,
    setTimeout: (callback) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, cancelled: false, fired: false });
      return id;
    },
    clearTimeout: (id) => {
      const timer = timers.get(id);
      if (timer) timer.cancelled = true;
    },
    sendRuntimeMessage: (message, callback) => {
      messages.push(message);
      if (message.type === "translateBatch") {
        requests.push({
          message,
          callback,
          sessionToken: session.fallbackSessionToken,
          delivered: false
        });
      }
    },
    resetDeepseekCommitTimeline: () => {},
    clearDeepseekSeekSettle: () => {},
    clearPendingTimer: () => {},
    settings: { enabled: true, targetLang: "zh-CN" },
    DEBOUNCE_MS: 450,
    setTranslation: (translation, source) => {
      session.lastTransSource = source || "";
      painted.push({ translation, source });
    }
  };
  vm.createContext(context);
  vm.runInContext(sessionSource, context, { filename: "content/session.js" });
  session = vm.runInContext("captionSession", context);
  vm.runInContext(fallbackSource, context, { filename: "content/fallback.js" });
  return {
    session,
    timers,
    requests,
    messages,
    painted,
    schedule: vm.runInContext("scheduleTranslate", context),
    reset: vm.runInContext("resetCaptionSessionState", context),
    fireTimer(id) {
      const timer = timers.get(id);
      if (!timer || timer.cancelled || timer.fired) return false;
      timer.fired = true;
      timer.callback();
      return true;
    }
  };
}

test("one session reset revokes every old callback and clears semantic owners", () => {
  const messages = [];
  const calls = [];
  let session;
  const context = {
    Object,
    String,
    Number,
    Math,
    Map,
    Set,
    videoIdFromLocation: () => "video",
    extensionContextAlive: () => true,
    sendRuntimeMessage: (message) => messages.push(message),
    cancelFallbackRequest: () => {
      calls.push("cancel-fallback");
      session.fallbackRequestId = "";
    },
    resetDeepseekCommitTimeline: () => calls.push("reset-timeline"),
    clearDeepseekSeekSettle: () => calls.push("clear-seek"),
    clearPendingTimer: () => calls.push("clear-pending")
  };
  vm.createContext(context);
  vm.runInContext(sessionSource, context, { filename: "content/session.js" });
  session = vm.runInContext("captionSession", context);
  Object.assign(session, {
    cueEpoch: 5,
    cueVideoId: "video",
    currentVideoId: "video",
    deepseekFocusGeneration: 3,
    fallbackSessionToken: { old: true },
    fallbackRequestId: "fallback:1",
    lastReqToken: 8,
    lastTransSource: "old translation",
    deepseekFocusedBatchIndex: 4,
    semanticLayoutWidth: 1200,
    activeGroupIdx: 10,
    activeCueIdx: 20,
    cueTimer: { active: true }
  });
  for (const cache of [
    session.transCache,
    session.deepseekUnitCache,
    session.deepseekSourceCache,
    session.deepseekAlignedChunksCache,
    session.deepseekDisplayCache,
    session.deepseekRequestMeta,
    session.deepseekRetryCounts,
    session.deepseekExhaustedRegions
  ]) cache.set("old", true);
  session.transInflight.add("dsb:0");
  const capture = vm.runInContext("captureCaptionSession", context);
  const isCurrent = vm.runInContext("isCaptionSessionCurrent", context);
  const reset = vm.runInContext("resetCaptionSessionState", context);
  const oldToken = capture();

  const newToken = reset("configuration-change");

  assert.equal(isCurrent(oldToken), false);
  assert.equal(isCurrent(newToken), true);
  assert.equal(newToken.reason, "configuration-change");
  assert.equal(session.cueEpoch, 6);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "cancelDeepSeek");
  assert.equal(messages[0].videoId, "video");
  assert.deepEqual(calls, ["cancel-fallback", "reset-timeline", "clear-seek", "clear-pending"]);
  for (const cache of [
    session.transCache,
    session.deepseekUnitCache,
    session.deepseekSourceCache,
    session.deepseekAlignedChunksCache,
    session.deepseekDisplayCache,
    session.deepseekRequestMeta,
    session.transInflight,
    session.deepseekRetryCounts,
    session.deepseekExhaustedRegions
  ]) assert.equal(cache.size, 0);
  assert.equal(session.fallbackSessionToken, null);
  assert.equal(session.lastReqToken, 9);
  assert.equal(session.lastTransSource, "");
  assert.equal(session.deepseekFocusedBatchIndex, -1);
  assert.equal(session.semanticLayoutWidth, 0);
  assert.equal(session.activeGroupIdx, -1);
  assert.equal(session.activeCueIdx, -1);
});

test("configuration invalidation orders old and new fallback completions safely", () => {
  const harness = loadFallbackLifecycleHarness();
  harness.session.lastSource = "same caption";
  harness.schedule("same caption");
  harness.fireTimer(1);
  const oldRequest = harness.requests[0];

  harness.reset("settings-change");
  harness.schedule("same caption");
  harness.fireTimer(2);
  const newRequest = harness.requests[1];

  oldRequest.callback({
    ok: true,
    translations: [{ id: "0", translation: "old provider result" }]
  }, null);
  assert.equal(harness.painted.length, 0);

  newRequest.callback({
    ok: true,
    translations: [{ id: "0", translation: "new provider result" }]
  }, null);
  assert.deepEqual(harness.painted, [{
    translation: "new provider result",
    source: "same caption"
  }]);
});

test("random lifecycle ordering never lets an invalidated fallback effect commit", () => {
  const harness = loadFallbackLifecycleHarness();
  let seed = 0x5eed1234;
  let sourceSerial = 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let step = 0; step < 800; step++) {
    const operation = Math.floor(random() * 4);
    if (operation === 0) {
      const source = `caption-${++sourceSerial}`;
      harness.session.lastSource = source;
      harness.schedule(source);
    } else if (operation === 1) {
      harness.reset(step % 2 ? "seek-focus" : "navigation");
    } else if (operation === 2) {
      const pending = Array.from(harness.timers.entries()).filter(
        ([, timer]) => !timer.cancelled && !timer.fired
      );
      if (pending.length) {
        const [id] = pending[Math.floor(random() * pending.length)];
        harness.fireTimer(id);
      }
    } else {
      const pending = harness.requests.filter((request) => !request.delivered);
      if (!pending.length) continue;
      const request = pending[Math.floor(random() * pending.length)];
      request.delivered = true;
      const requestToken = Number(request.message.requestId.split(":")[1]);
      const requestSource = request.message.items[0].text;
      const mayCommit = request.sessionToken === harness.session.token &&
        requestToken === harness.session.lastReqToken &&
        requestSource === harness.session.lastSource;
      const before = harness.painted.length;
      request.callback({
        ok: true,
        translations: [{ id: "0", translation: `translation-${step}` }]
      }, null);
      assert.equal(
        harness.painted.length,
        before + (mayCommit ? 1 : 0),
        `seed 0x5eed1234 step ${step} violated session commit ownership`
      );
    }
  }
});
