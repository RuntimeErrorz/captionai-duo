"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();

test("aiPrefetchBatchCount is the configured minimum raised by playback speed", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");

  const playbackSource = fs.readFileSync(
    path.join(__dirname, "..", "content/cue-playback.js"), "utf8"
  );

  let currentRate = 1;
  const context = {
    settings: { aiPrefetchBatches: 1 },
    AI_MAX_PREFETCH_BATCHES: 12,
    getVideo: () => ({ playbackRate: currentRate })
  };
  vm.createContext(context);
  vm.runInContext(playbackSource, context, { filename: "content/cue-playback.js" });
  const count = (rate, configured) => {
    currentRate = rate;
    context.settings.aiPrefetchBatches = configured;
    return vm.runInContext("aiPrefetchBatchCount()", context);
  };

  // round(rate + 1) batches at least, continuously in the playback speed.
  for (const [rate, floor] of [[1, 2], [1.25, 2], [1.5, 3], [1.75, 3], [2, 3], [2.5, 4], [3, 4]]) {
    assert.equal(count(rate, 0), floor, `${rate}x`);
    assert.equal(count(rate, 6), 6, "a larger setting is kept");
  }
  assert.equal(count(3, 40), 12, "capped");
  // Monotonic: a faster speed never looks less far ahead.
  let previous = 0;
  for (let rate = 0.25; rate <= 4; rate += 0.05) {
    const value = count(rate, 0);
    assert.ok(value >= previous);
    previous = value;
  }
});
