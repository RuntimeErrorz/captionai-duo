"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const lifecycleSource = fs.readFileSync(path.join(root, "content", "lifecycle.js"), "utf8");

test("same-video navigate-finish preserves the active caption session", () => {
  const listeners = new Map();
  const calls = [];
  const context = {
    settings: { enabled: true },
    INITIAL_CUE_RECOVERY_MS: 7000,
    captionSession: {
      currentVideoId: "abcdefghijk",
      cueList: [{ start: 0, dur: 1000, text: "still active" }],
      weEnabledCC: false
    },
    videoIdFromLocation: () => "abcdefghijk",
    emitCaptionStateTransition: (...args) => calls.push(["transition", ...args]),
    emitDebug: (...args) => calls.push(["debug", ...args]),
    stopCueLoop: () => calls.push(["stopCueLoop"]),
    stopFallback: () => calls.push(["stopFallback"]),
    resetCaptionSessionState: () => calls.push(["reset"]),
    removeOverlay: () => calls.push(["removeOverlay"]),
    stopCueRecovery: () => calls.push(["stopRecovery"]),
    ensureOverlay: () => calls.push(["ensureOverlay"]),
    sendConfig: () => calls.push(["sendConfig"]),
    scheduleCueRecovery: () => calls.push(["scheduleRecovery"]),
    syncCaptions: () => calls.push(["syncCaptions"]),
    onInjectMessage: () => {},
    scheduleDeepseekDisplayReflow: () => {},
    styleOverlay: () => {},
    overlay: null,
    loadSettings: () => ({ then: () => {} }),
    applyStateToDom: () => {},
    document: {
      addEventListener: () => {},
      fonts: null,
      readyState: "complete",
      documentElement: { classList: { toggle: () => {} } }
    },
    window: {
      addEventListener: (type, callback) => listeners.set(type, callback)
    }
  };

  vm.createContext(context);
  vm.runInContext(lifecycleSource, context);
  listeners.get("yt-navigate-finish")();

  assert.equal(context.captionSession.cueList[0].text, "still active");
  assert.equal(calls.some(([name]) => name === "reset"), false, JSON.stringify(calls));
  assert.equal(calls.some(([name]) => name === "sendConfig"), false, JSON.stringify(calls));
  assert.equal(calls.some(([name]) => name === "syncCaptions"), true, JSON.stringify(calls));
});
