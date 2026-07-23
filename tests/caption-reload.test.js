"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "content", "state-ui.js"), "utf8");
const start = source.indexOf("function forceCaptionReload");
const end = source.indexOf("function scheduleCueRecovery", start);
const forceReloadSource = source.slice(start, end);

test("confirmed failure rotates the track even when YouTube left CC off", () => {
  let pressed = "false";
  let clickCount = 0;
  const timers = [];
  const debugEvents = [];
  const token = {};
  const button = {
    getAttribute: (name) => {
      if (name === "aria-pressed") return pressed;
      if (name === "aria-disabled") return "false";
      return null;
    },
    click: () => {
      clickCount++;
      pressed = pressed === "true" ? "false" : "true";
    }
  };
  const context = {
    captionSession: {
      currentVideoId: "abcdefghijk",
      cueList: null,
      weEnabledCC: false
    },
    document: { querySelector: () => button },
    captureCaptionSession: () => token,
    isCaptionSessionCurrent: (candidate) => candidate === token,
    captionReadinessDebugState: (reason) => ({ reason }),
    emitDebug: (event, data) => debugEvents.push({ event, data }),
    ensureCaptionsOn: () => {
      throw new Error("ready button must use the deterministic reload path");
    },
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    }
  };

  vm.createContext(context);
  vm.runInContext(forceReloadSource, context);
  vm.runInContext("forceCaptionReload('empty-player-source')", context);

  assert.equal(clickCount, 1, "first enable the button left off by the aborted request");
  assert.equal(timers[0].delay, 180);
  timers.shift().callback();

  assert.equal(clickCount, 2, "then turn the stale track off");
  assert.equal(timers[0].delay, 300);
  timers.shift().callback();

  assert.equal(clickCount, 3, "finally enable a freshly rotated track");
  assert.equal(pressed, "true");
  assert.equal(context.captionSession.weEnabledCC, true);
  assert.deepEqual(
    debugEvents.map((entry) => entry.event),
    ["caption-reload-requested", "caption-reload-completed"]
  );
});
