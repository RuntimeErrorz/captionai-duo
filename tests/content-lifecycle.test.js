"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const lifecycleSource = fs.readFileSync(path.join(root, "content", "lifecycle.js"), "utf8");
const stateUiSource = fs.readFileSync(path.join(root, "content", "state-ui.js"), "utf8");

test("content i18n falls back when the extension context is invalidated", () => {
  const context = {
    window: { __ytdsContentLoaded: false },
    chrome: {
      i18n: {
        getMessage() { throw new Error("Extension context invalidated"); }
      }
    }
  };
  const i18nSectionEnd = stateUiSource.indexOf("// ---- shared settings model");
  vm.createContext(context);
  vm.runInContext(stateUiSource.slice(0, i18nSectionEnd), context);

  assert.equal(vm.runInContext('t("missing", "fallback")', context), "fallback");
});

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

test("cold-start URL discovery enters the video session even without yt-navigate-finish", () => {
  const listeners = new Map();
  const intervals = [];
  const calls = [];
  let currentUrlVideoId = "";
  const context = {
    settings: { enabled: true },
    INITIAL_CUE_RECOVERY_MS: 7000,
    captionSession: {
      currentVideoId: "",
      cueList: null,
      weEnabledCC: false
    },
    videoIdFromLocation: () => currentUrlVideoId,
    emitCaptionStateTransition: (...args) => calls.push(["transition", ...args]),
    emitDebug: (...args) => calls.push(["debug", ...args]),
    stopCueLoop: () => calls.push(["stopCueLoop"]),
    resetCaptionSessionState: (reason) => calls.push(["reset", reason]),
    removeOverlay: () => calls.push(["removeOverlay"]),
    stopCueRecovery: () => calls.push(["stopRecovery"]),
    ensureOverlay: () => calls.push(["ensureOverlay"]),
    sendConfig: (...args) => calls.push(["sendConfig", ...args]),
    scheduleCueRecovery: (...args) => calls.push(["scheduleRecovery", ...args]),
    syncCaptions: (...args) => calls.push(["syncCaptions", ...args]),
    onInjectMessage: () => {},
    scheduleDeepseekDisplayReflow: () => {},
    styleOverlay: () => {},
    overlay: null,
    loadSettings: () => ({ then: () => {} }),
    applyStateToDom: () => {},
    setInterval: (callback, delay) => {
      intervals.push({ callback, delay });
      return intervals.length;
    },
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
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].delay, 500);

  currentUrlVideoId = "abcdefghijk";
  intervals[0].callback();

  assert.equal(context.captionSession.currentVideoId, "abcdefghijk");
  assert.equal(calls.some(([name]) => name === "reset"), true, JSON.stringify(calls));
  assert.equal(calls.some(([name]) => name === "sendConfig"), true, JSON.stringify(calls));
  assert.equal(calls.some(([name]) => name === "scheduleRecovery"), true, JSON.stringify(calls));
  assert.equal(calls.some(([name]) => name === "syncCaptions"), true, JSON.stringify(calls));

  currentUrlVideoId = "";
  intervals[0].callback();
  assert.equal(context.captionSession.currentVideoId, "");
});
