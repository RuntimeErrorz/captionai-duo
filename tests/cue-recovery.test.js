"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bridgeSource = fs.readFileSync(
  path.join(__dirname, "..", "content/bridge.js"), "utf8"
);

test("an unavailable cue track schedules network recovery without rendered-caption fallback", () => {
  const calls = [];
  const debug = [];
  const context = {
    captionSession: {
      currentVideoId: "abcdefghijk",
      configNonce: 31,
      cueList: [{ text: "stale", start: 0, end: 1000 }],
      cueVideoId: "abcdefghijk",
      activeCueIdx: 2,
      sentGroups: [],
      cueToGroup: [],
      cueToGroups: [],
      deepseekBatchWindows: [],
      deepseekGroupToBatch: [],
      cueTrackKind: "asr",
      cueSourceLang: "en",
      cueTrackId: "track:en:asr:a.en",
      cueTrackSignature: "old",
      selectedTranslationTrackId: "ai"
    },
    settings: { enabled: true },
    stopCueLoop: () => calls.push("stopCueLoop"),
    resetCaptionSessionState: (reason) => calls.push(["reset", reason]),
    emitDebug: (...args) => debug.push(args),
    captionButtonDebugState: () => ({ present: true, pressed: "true", disabled: "" }),
    forceCaptionReload: (reason) => calls.push(["forceCaptionReload", reason]),
    scheduleCueRecovery: () => calls.push("scheduleCueRecovery")
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context, { filename: "content/bridge.js" });

  vm.runInContext(`onNoCues({
    videoId: "abcdefghijk",
    nonce: 31,
    reason: "fetch-error",
    detail: "timedtext empty body",
    requestFreshSource: true
  })`, context);

  assert.deepEqual(calls, [
    "stopCueLoop",
    ["reset", "caption-cues-unavailable"],
    ["forceCaptionReload", "empty-player-source"],
    "scheduleCueRecovery"
  ]);
  assert.equal(debug[0][0], "cues-unavailable");
});
