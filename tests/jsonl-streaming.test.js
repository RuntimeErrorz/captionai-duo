"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const shared = loadShared();

function loadJsonlStreamObserver() {
  const context = { YTDS_SHARED: shared };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, "../background/translation.js"), "utf8"),
    context,
    { filename: "background/translation.js" }
  );
  return vm.runInContext("createAiJsonlStreamObserver", context);
}

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
    first.rest + '"translation":"译文"}]}\r\n{"type":"done"}\n',
    false
  );
  assert.equal(second.rest, "");
  assert.equal(second.lines.length, 2);
  assert.equal(shared.aiJsonlRecordFromLine(second.lines[0]).record.type, "unit");
  assert.equal(shared.aiJsonlRecordFromLine(second.lines[1]).record.type, "done");
});

test("legacy enumerated done is recognized before its numeric list is generated", () => {
  const prefix = '{"type":"done","deferred_ids":';
  for (let index = 0; index < prefix.length; index++) {
    assert.equal(shared.aiJsonlLegacyDonePrefix(prefix.slice(0, index)), false);
  }
  assert.equal(shared.aiJsonlLegacyDonePrefix(prefix), true);
  assert.equal(shared.aiJsonlLegacyDonePrefix(
    prefix + '["5818","5819","5820","5821"'
  ), true);
  assert.equal(shared.aiJsonlLegacyDonePrefix('{"type":"done"}'), false);
});

test("JSONL state derives the deferred suffix from its coverage cursor", () => {
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
  assert.equal(shared.pushAiJsonlTranslationRecord(state, { type: "done" }).ok, true);

  const result = shared.aiJsonlTranslationResult(state, false);
  assert.equal(result.length, 3);
  assert.deepEqual(result.deferredIds, ["3"]);
  assert.equal(result.streamPartial, false);
});

test("JSONL translations remove every Chinese full stop before caching", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  const accepted = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [{ ids: ["0", "1"], translation: "第一句。第二句。。真的吗？" }]
  });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.translations[0].translation, "第一句第二句真的吗？");
  assert.equal(accepted.translations[0].alignedChunks[0].translation, "第一句第二句真的吗？");
});

test("JSONL state rejects reordered ids, hard-boundary crossings and records after done", () => {
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

  const afterDone = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  assert.equal(shared.pushAiJsonlTranslationRecord(afterDone, { type: "done" }).ok, true);
  assert.match(shared.pushAiJsonlTranslationRecord(afterDone, {
    type: "unit", chunks: [{ ids: ["0"], translation: "多余" }]
  }).error, /after done/);
});

test("legacy deferred id lists are ignored instead of inviting numeric continuation", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [{ ids: ["0", "1"], translation: "已完成" }]
  }).ok, true);
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "done", deferred_ids: ["999", "1000", "1001"]
  }).ok, true);
  assert.deepEqual(shared.aiJsonlTranslationResult(state, false).deferredIds, ["2", "3"]);
});

test("complete ordered coverage is final even when the model omits done", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [{ ids: ["0", "1"], translation: "前半" }]
  }).ok, true);
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [{ ids: ["2", "3"], translation: "后半" }]
  }).ok, true);
  const result = shared.aiJsonlTranslationResult(state, false);
  assert.equal(result.length, 4);
  assert.deepEqual(result.deferredIds, []);
  assert.equal(result.streamPartial, false);
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

test("a repeated-id correction cannot publish the incomplete unit it revises", () => {
  const items = Array.from({ length: 6 }, (_value, id) => ({
    id: String(id), text: `token-${id}`, startMs: id * 500, endMs: (id + 1) * 500,
    hardAfter: false
  }));
  const progress = [];
  const observer = loadJsonlStreamObserver()(items, "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  });

  observer.onTextDelta(
    '{"type":"unit","chunks":[{"ids":["0"],"translation":"confirmed prefix"}]}\n',
    false
  );
  observer.onTextDelta(
    '{"type":"unit","chunks":[{"ids":["1","2","3","4","5"],"translation":"incomplete clause"}]}\n',
    false
  );
  const rejected = observer.onTextDelta(
    '{"type":"unit","chunks":[{"ids":["3","4","5"],"translation":"missing correction"}]}\n',
    false
  );

  assert.equal(rejected.stop, true);
  assert.deepEqual(progress, [["0"]]);
  const partial = observer.result(true);
  assert.deepEqual(Array.from(partial, (item) => String(item.id)), ["0"]);
  assert.deepEqual(Array.from(partial.deferredIds), ["1", "2", "3", "4", "5"]);
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
  assert.equal(shared.pushAiJsonlTranslationRecord(state, { type: "done" }).ok, true);
  assert.equal(shared.aiJsonlTranslationResult(state, false).length, 2);
});
