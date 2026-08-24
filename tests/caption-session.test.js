"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sessionSource = fs.readFileSync(
  path.join(__dirname, "..", "content/session.js"), "utf8"
);

test("one session reset revokes every old callback and clears semantic owners", () => {
  const messages = [];
  const calls = [];
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
    resetDeepseekCommitTimeline: () => calls.push("reset-timeline"),
    clearDeepseekSeekSettle: () => calls.push("clear-seek"),
    clearPendingTimer: () => calls.push("clear-pending")
  };
  vm.createContext(context);
  vm.runInContext(sessionSource, context, { filename: "content/session.js" });
  const session = vm.runInContext("captionSession", context);
  Object.assign(session, {
    cueEpoch: 5,
    cueVideoId: "video",
    currentVideoId: "video",
    deepseekFocusGeneration: 3,
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
  assert.deepEqual(calls, ["reset-timeline", "clear-seek", "clear-pending"]);
  for (const cache of [
    session.transCache,
    session.deepseekUnitCache,
    session.deepseekSourceCache,
    session.deepseekRequestMeta,
    session.transInflight,
    session.deepseekRetryCounts,
    session.deepseekExhaustedRegions
  ]) assert.equal(cache.size, 0);
  assert.equal(session.deepseekFocusedBatchIndex, -1);
  assert.equal(session.semanticLayoutWidth, 0);
  assert.equal(session.activeGroupIdx, -1);
  assert.equal(session.activeCueIdx, -1);
});
