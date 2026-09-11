"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const stateUiSource = fs.readFileSync(path.join(root, "content", "state-ui.js"), "utf8");
const start = stateUiSource.indexOf("function syncCaptions");
const recoverySource = stateUiSource.slice(start);

function createTestHarness(initialVideoId = "") {
  const calls = [];
  const debug = [];
  const timers = new Map();
  let nextTimerId = 1;

  const context = {
    settings: { enabled: true, debugEnabled: true },
    captionSession: {
      currentVideoId: initialVideoId,
      cueList: null,
      cueRecoveryTimer: null,
      cueRecoveryAttempt: 0,
      weEnabledCC: false,
      activeCueIdx: -1,
      activeGroupIdx: -1
    },
    ensureCaptionsOn: (...args) => calls.push(["ensureCaptionsOn", ...args]),
    restoreCaptionsIfWeEnabled: () => calls.push(["restoreCaptionsIfWeEnabled"]),
    ensureOverlay: () => true,
    removeOverlay: () => {},
    sendConfig: (...args) => calls.push(["sendConfig", ...args]),
    forceCaptionReload: (...args) => calls.push(["forceCaptionReload", ...args]),
    emitDebug: (...args) => debug.push(args),
    captionButtonDebugState: () => ({ present: false, pressed: "", disabled: "" }),
    emitCaptionStateTransition: (...args) => calls.push(["stateTransition", ...args]),
    document: {
      querySelector: () => null,
      readyState: "complete",
      documentElement: { classList: { toggle: () => {} } }
    },
    getVideo: () => null,
    getPlayer: () => null,
    setTimeout: (fn, delay) => {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    captureCaptionSession: () => ({ revision: 1, epoch: 1 }),
    isCaptionSessionCurrent: () => true
  };

  vm.createContext(context);
  vm.runInContext(recoverySource, context, { filename: "content/state-ui.js" });

  return { context, calls, debug, timers };
}

test("idle tab without videoId does not schedule cue recovery or click captions", () => {
  const harness = createTestHarness("");
  const { context, calls, debug, timers } = harness;

  // Attempting recovery when videoId is empty must be a no-op
  context.scheduleCueRecovery();
  assert.equal(timers.size, 0, "No timer should be scheduled when videoId is empty");
  assert.equal(debug.length, 0, "No debug event should be emitted when videoId is empty");

  // Syncing captions when videoId is empty must not call ensureCaptionsOn
  context.syncCaptions("idle-sync");
  assert.equal(calls.some(([name]) => name === "ensureCaptionsOn"), false);
  assert.equal(calls.some(([name]) => name === "restoreCaptionsIfWeEnabled"), true);
});

test("navigating away from video clears cue recovery timer on fire", () => {
  const harness = createTestHarness("video12345");
  const { context, calls, debug, timers } = harness;

  context.scheduleCueRecovery(3000);
  assert.equal(timers.size, 1, "Timer should be scheduled for active video");
  assert.equal(debug[0][0], "cue-recovery-scheduled");

  // User navigates to home page before timer fires
  context.captionSession.currentVideoId = "";

  const timerEntry = timers.get(context.captionSession.cueRecoveryTimer);
  assert.ok(timerEntry);
  timerEntry.fn();

  // On fire, it should detect videoId is empty, stop recovery, and not call ensureCaptionsOn or forceCaptionReload
  assert.equal(context.captionSession.cueRecoveryTimer, null);
  assert.equal(calls.some(([name]) => name === "ensureCaptionsOn"), false);
  assert.equal(calls.some(([name]) => name === "forceCaptionReload"), false);
});
