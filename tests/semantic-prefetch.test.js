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
