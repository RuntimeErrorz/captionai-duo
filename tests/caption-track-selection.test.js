"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bridgeSource = fs.readFileSync(
  path.join(__dirname, "..", "content", "bridge.js"), "utf8"
);

test("caption-track selection accepts only the current video's listed tracks", () => {
  const configs = [];
  const resetReasons = [];
  const context = {
    location: { origin: "https://www.youtube.com" },
    window: {
      postMessage: (message) => configs.push(message)
    },
    settings: { enabled: true },
    captionSession: {
      currentVideoId: "abcdefghijk",
      availableCaptionTracks: [
        { id: "track:en:manual:one", languageCode: "en", label: "English", kind: "manual" },
        { id: "track:zh:manual:two", languageCode: "zh-CN", label: "中文", kind: "manual" }
      ],
      selectedCaptionTrackId: "auto",
      selectedTranslationTrackId: "ai",
      configNonce: 0
    },
    stopCueLoop: () => {},
    stopCueRecovery: () => {},
    resetCaptionSessionState: (reason) => resetReasons.push(reason),
    removeOverlay: () => {},
    ensureOverlay: () => {},
    overlay: null,
    nextConfigNonce: () => 77,
    emitDebug: () => {},
    captionButtonDebugState: () => ({})
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);

  const rejected = vm.runInContext(
    "setCaptionTrackSelection('track:fr:manual:missing')", context
  );
  assert.equal(rejected.ok, false);
  assert.equal(context.captionSession.selectedCaptionTrackId, "auto");
  assert.equal(configs.length, 0);

  const selected = vm.runInContext(
    "setCaptionTrackSelection('track:zh:manual:two')", context
  );
  assert.equal(selected.ok, true);
  assert.equal(selected.selectedTrackId, "track:zh:manual:two");
  assert.equal(context.captionSession.selectedCaptionTrackId, "track:zh:manual:two");
  assert.deepEqual(resetReasons, ["caption-track-selection"]);
  assert.equal(configs.length, 1);
  assert.equal(configs[0].captionTrackId, "track:zh:manual:two");

  const invalidTranslation = vm.runInContext(
    "setCaptionTranslationSelection('track:fr:manual:missing')", context
  );
  assert.equal(invalidTranslation.ok, false);
  assert.equal(context.captionSession.selectedTranslationTrackId, "ai");

  const selectedTranslation = vm.runInContext(
    "setCaptionTranslationSelection('track:en:manual:one')", context
  );
  assert.equal(selectedTranslation.ok, true);
  assert.equal(selectedTranslation.selectedTranslationTrackId, "track:en:manual:one");
  assert.equal(context.captionSession.selectedTranslationTrackId, "track:en:manual:one");
  assert.deepEqual(resetReasons, ["caption-track-selection", "caption-track-selection"]);
  assert.equal(configs.length, 2);
  assert.equal(configs[1].captionTrackId, "track:zh:manual:two");
  assert.equal(configs[1].translationTrackId, "track:en:manual:one");

  context.captionSession.translationCueList = [{ start: 0, end: 1000, text: "已有译文" }];
  const switchedOriginal = vm.runInContext(
    "setCaptionTrackSelection('auto')", context
  );
  assert.equal(switchedOriginal.ok, true);
  assert.equal(context.captionSession.selectedCaptionTrackId, "auto");
  assert.equal(context.captionSession.selectedTranslationTrackId, "track:en:manual:one");
  assert.deepEqual(context.captionSession.translationCueList, [
    { start: 0, end: 1000, text: "已有译文" }
  ]);
  assert.deepEqual(resetReasons, [
    "caption-track-selection", "caption-track-selection", "caption-track-selection"
  ]);
  assert.equal(configs.length, 3);
  assert.equal(configs[2].captionTrackId, "auto");
  assert.equal(configs[2].translationTrackId, "track:en:manual:one");
});

test("caption-track catalog diagnostics retain labels without proof-bearing URLs", () => {
  const events = [];
  const context = {
    location: { origin: "https://www.youtube.com" },
    window: {},
    settings: { enabled: true, debugEnabled: true },
    captionSession: {
      currentVideoId: "abcdefghijk",
      availableCaptionTracks: [],
      selectedCaptionTrackId: "auto",
      selectedTranslationTrackId: "ai",
      configNonce: 0
    },
    emitDebug: (event, data) => events.push({ event, data }),
    captionButtonDebugState: () => ({})
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  vm.runInContext(`onInjectMessage({
    source: window,
    origin: location.origin,
    data: {
      source: "ytds-inject",
      type: "caption-tracks",
      videoId: "abcdefghijk",
      catalogReason: "catalog-scan",
      tracks: [{
        id: "track:en:asr:a.en",
        languageCode: "en",
        label: "English (auto-generated)",
        kind: "asr"
      }],
      selectedTrackId: "auto",
      preferredTrackId: "track:en:asr:a.en",
      selectedTranslationTrackId: "ai"
    }
  })`, context);

  const catalog = events.find((entry) => entry.event === "caption-track-catalog");
  assert.ok(catalog, JSON.stringify(events));
  assert.equal(catalog.data.reason, "catalog-scan");
  assert.equal(JSON.stringify(catalog.data.tracks), JSON.stringify([{
    id: "track:en:asr:a.en",
    languageCode: "en",
    label: "English (auto-generated)",
    kind: "asr",
    labelFallback: false
  }]));
  assert.doesNotMatch(JSON.stringify(catalog), /timedtext|baseUrl|proof/);
});
