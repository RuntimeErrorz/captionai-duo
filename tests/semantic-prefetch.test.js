"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();

test("DeepSeek prefetch advances by distinct request batches, not adjacent cues", () => {
  const windows = [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
    { start: 12, end: 17 },
    { start: 18, end: 20 }
  ];
  const groupToBatch = Array.from({ length: 21 }, (_value, index) => Math.min(3, Math.floor(index / 6)));

  const starts = (group) => Array.from(
    shared.semanticPrefetchBatchStarts(group, groupToBatch, windows, 2)
  );
  assert.deepEqual(starts(0), [6, 12]);
  assert.deepEqual(starts(5), [6, 12]);
  assert.deepEqual(starts(8), [12, 18]);
  assert.deepEqual(starts(19), []);
  assert.deepEqual(Array.from(
    shared.semanticPrefetchBatchStarts(0, groupToBatch, windows, 0)
  ), []);
  assert.deepEqual(Array.from(
    shared.semanticPrefetchBatchStarts(0, groupToBatch, windows, 3)
  ), [6, 12, 18]);
});

test("deepseekPrefetchBatchCount respects configured batches and enforces accelerated playback minimums", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");

  const playbackSource = fs.readFileSync(
    path.join(__dirname, "..", "content/cue-playback.js"), "utf8"
  );

  let currentRate = 1;
  const context = {
    settings: { deepseekPrefetchBatches: 1 },
    DEEPSEEK_MAX_PREFETCH_BATCHES: 12,
    DEEPSEEK_FAST_PREFETCH_BATCHES: 3,
    DEEPSEEK_HIGH_SPEED_PREFETCH_BATCHES: 4,
    getVideo: () => ({ playbackRate: currentRate })
  };
  vm.createContext(context);
  vm.runInContext(playbackSource, context, { filename: "content/cue-playback.js" });

  const getCount = () => vm.runInContext("deepseekPrefetchBatchCount()", context);

  // Normal 1x playback: respects configured value exactly (does not force 10)
  context.settings.deepseekPrefetchBatches = 0;
  assert.equal(getCount(), 0);

  context.settings.deepseekPrefetchBatches = 1;
  assert.equal(getCount(), 1);

  context.settings.deepseekPrefetchBatches = 5;
  assert.equal(getCount(), 5);

  // Accelerated 1.75x playback: keeps at least 3
  currentRate = 1.75;
  context.settings.deepseekPrefetchBatches = 0;
  assert.equal(getCount(), 3);
  context.settings.deepseekPrefetchBatches = 5;
  assert.equal(getCount(), 5);

  // High speed 2.5x playback: keeps at least 4
  currentRate = 2.5;
  context.settings.deepseekPrefetchBatches = 1;
  assert.equal(getCount(), 4);
  context.settings.deepseekPrefetchBatches = 6;
  assert.equal(getCount(), 6);
});
