"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const bridgeSource = fs.readFileSync(path.join(root, "content", "bridge.js"), "utf8");
const playbackSource = fs.readFileSync(
  path.join(root, "content", "cue-playback.js"), "utf8"
);

test("a selected caption track renders directly without an AI request", () => {
  const painted = [];
  const aiRequests = [];
  const context = {
    captionSession: {
      selectedTranslationTrackId: "track:zh:manual:two",
      translationCueList: [{ start: 0, end: 1000, text: "已有译文" }],
      cueList: [{ start: 0, end: 1000, text: "original caption" }],
      activeCueIdx: -1,
      activeGroupIdx: -1,
      lastDebugCueIdx: -1
    },
    settings: { enabled: true, targetLang: "zh-CN" },
    getVideo: () => ({ currentTime: 0.5, playbackRate: 1 }),
    setOriginal: (text) => painted.push({ type: "original", text }),
    setTranslation: (text, source) => painted.push({ type: "translation", text, source }),
    deepseekRequestBatch: (...args) => aiRequests.push(args),
    extensionContextAlive: () => true,
    emitDebug: () => {}
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context, { filename: "content/bridge.js" });
  vm.runInContext(playbackSource, context, { filename: "content/cue-playback.js" });

  vm.runInContext("cueTick({ type: 'timeupdate' })", context);

  assert.deepEqual(painted, [
    { type: "original", text: "original caption" },
    { type: "translation", text: "已有译文", source: "original caption" }
  ]);
  assert.deepEqual(aiRequests, []);
});
