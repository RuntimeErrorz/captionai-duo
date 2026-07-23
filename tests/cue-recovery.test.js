"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const fallbackSource = fs.readFileSync(path.join(root, "content", "fallback.js"), "utf8");

test("a confirmed empty player response requests one immediate fresh caption source", () => {
  const calls = [];
  const context = {
    captionSession: {
      currentVideoId: "abcdefghijk",
      configNonce: 31,
      cueList: null,
      sentGroups: null,
      cueToGroup: null,
      cueToGroups: null,
      deepseekBatchWindows: [],
      deepseekGroupToBatch: [],
      cueTrackKind: "",
      cueSourceLang: "",
      cueTrackSignature: "",
      duplicateCueEvents: 0,
      nocuesFallback: false
    },
    settings: { enabled: true },
    stopCueLoop: () => calls.push("stopCueLoop"),
    resetCaptionSessionState: () => calls.push("reset"),
    emitDebug: () => {},
    captionButtonDebugState: () => ({ present: true, pressed: "true", disabled: "" }),
    ensureOverlay: () => calls.push("ensureOverlay"),
    setInterval: () => 99,
    forceCaptionReload: () => calls.push("forceCaptionReload"),
    scheduleCueRecovery: () => calls.push("scheduleCueRecovery")
  };
  vm.createContext(context);
  vm.runInContext(fallbackSource, context);

  vm.runInContext(`
    onNoCues({
      videoId: "abcdefghijk",
      nonce: 31,
      reason: "fetch-error",
      detail: "player timedtext empty body",
      requestFreshSource: true
    });
  `, context);

  assert.deepEqual(
    calls,
    ["stopCueLoop", "reset", "ensureOverlay", "forceCaptionReload", "scheduleCueRecovery"]
  );
  assert.equal(context.captionSession.pollTimer, 99);
});
