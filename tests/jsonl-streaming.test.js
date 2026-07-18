"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();

function sampleItems() {
  return [
    { id: "0", text: "I met", startMs: 0, endMs: 700, hardAfter: false },
    { id: "1", text: "American soldiers.", startMs: 700, endMs: 1700, hardAfter: false },
    { id: "2", text: "They helped us.", startMs: 1700, endMs: 2800, hardAfter: false },
    { id: "3", text: "The next thought is unfinished", startMs: 2800, endMs: 3900, hardAfter: false }
  ];
}

test("JSONL line buffering survives arbitrary network splits", () => {
  const first = shared.aiJsonlLines('{"type":"unit","chunks":[{"ids":["0"],', false);
  assert.equal(first.lines.length, 0);
  const second = shared.aiJsonlLines(
    first.rest + '"translation":"译文"}]}\r\n{"type":"done","deferred_ids":[]}\n',
    false
  );
  assert.equal(second.rest, "");
  assert.equal(second.lines.length, 2);
  assert.equal(shared.aiJsonlRecordFromLine(second.lines[0]).record.type, "unit");
  assert.equal(shared.aiJsonlRecordFromLine(second.lines[1]).record.type, "done");
});

test("JSONL state accepts ordered semantic units and an exact deferred suffix", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  const first = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [{ ids: ["0", "1"], translation: "我遇到了美国士兵。" }]
  });
  assert.equal(first.ok, true);
  assert.equal(first.unitId, "semantic-0-1");
  assert.equal(first.translations.length, 2);

  const second = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [{ ids: ["2"], translation: "他们帮助了我们。" }]
  });
  assert.equal(second.ok, true);
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "done", deferred_ids: ["3"]
  }).ok, true);

  const result = shared.aiJsonlTranslationResult(state, false);
  assert.equal(result.length, 3);
  assert.deepEqual(result.deferredIds, ["3"]);
  assert.equal(result.streamPartial, false);
});

test("JSONL state rejects reordered ids, hard-boundary crossings and a wrong done suffix", () => {
  const reordered = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  assert.match(shared.pushAiJsonlTranslationRecord(reordered, {
    type: "unit", chunks: [{ ids: ["1", "0"], translation: "乱序" }]
  }).error, /unexpected JSONL id/);

  const hardItems = sampleItems();
  hardItems[0] = { ...hardItems[0], hardAfter: true };
  const crossed = shared.createAiJsonlTranslationState(hardItems, "zh-CN");
  assert.match(shared.pushAiJsonlTranslationRecord(crossed, {
    type: "unit", chunks: [{ ids: ["0", "1"], translation: "越界" }]
  }).error, /hard boundary/);

  const wrongDone = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  assert.match(shared.pushAiJsonlTranslationRecord(wrongDone, {
    type: "done", deferred_ids: ["2", "3"]
  }).error, /deferred suffix/);
});

test("a malformed tail preserves every previously valid JSONL unit", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [{ ids: ["0", "1"], translation: "已完成前缀" }]
  }).ok, true);
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [{ ids: ["3"], translation: "跳过了编号二" }]
  }).ok, false);

  assert.equal(shared.aiJsonlTranslationResult(state, false), null);
  const partial = shared.aiJsonlTranslationResult(state, true);
  assert.equal(partial.length, 2);
  assert.deepEqual(partial.deferredIds, ["2", "3"]);
  assert.equal(partial.streamPartial, true);
  assert.match(partial.streamError, /unexpected JSONL id/);
});

test("JSONL structural validation does not reject natural numeric wording", () => {
  const items = [
    { id: "295", text: "This is pretty much a", startMs: 1000, endMs: 1800, hardAfter: false },
    { id: "296", text: "10 out of 10.", startMs: 1800, endMs: 2400, hardAfter: false }
  ];
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [{ ids: ["295", "296"], translation: "这差不多是十分满分。" }]
  }).ok, true);
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "done", deferred_ids: []
  }).ok, true);
  assert.equal(shared.aiJsonlTranslationResult(state, false).length, 2);
});
