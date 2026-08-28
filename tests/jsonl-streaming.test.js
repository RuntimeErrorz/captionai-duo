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

function rangeChunk(start, end, translation) {
  return [Number(start), Number(end), translation];
}

test("accelerated JSONL publishes a complete unit before the next unit arrives", () => {
  const progress = [];
  const observer = loadJsonlStreamObserver()(sampleItems(), "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  }, { requestClass: "urgent" });

  const status = observer.onTextDelta(
    JSON.stringify({ type: "unit", chunks: [rangeChunk(0, 1, "已完成")] }) + "\n",
    false
  );

  assert.equal(status.stop, false);
  assert.deepEqual(progress, [["0", "1"]]);
  assert.equal(observer.result(true).length, 2);
});

test("compact JSONL ranges expand into the same ordered alignment coverage", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  const accepted = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [
      rangeChunk(0, 1, "我遇到了美国士兵。"),
      rangeChunk(2, 2, "他们帮助了我们。")
    ]
  });

  assert.equal(accepted.ok, true);
  assert.deepEqual(Array.from(accepted.ids), ["0", "1", "2"]);
  assert.deepEqual(Array.from(accepted.translations[0].alignedChunks, (chunk) =>
    Array.from(chunk.ids)), [
    ["0", "1"], ["2"]
  ]);
  assert.equal(state.cursor, 3);
});

test("local JSONL positions expand to the request's non-local internal IDs", () => {
  const items = sampleItems().map((item, index) => ({
    ...item,
    id: String(221 + index)
  }));
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");
  const accepted = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [
      rangeChunk(0, 1, "我遇到了美国士兵。"),
      rangeChunk(2, 2, "他们帮助了我们。")
    ]
  });

  assert.equal(accepted.ok, true);
  assert.deepEqual(Array.from(accepted.ids), ["221", "222", "223"]);
  assert.deepEqual(Array.from(accepted.translations, (item) => String(item.id)), [
    "221", "222", "223"
  ]);
  assert.equal(state.cursor, 3);
});

test("compact JSONL ranges keep gap and hard-boundary validation strict", () => {
  const gap = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  assert.match(shared.pushAiJsonlTranslationRecord(gap, {
    type: "unit", chunks: [rangeChunk(1, 1, "跳过")]
  }).error, /unexpected JSONL position 1 at offset 0/);

  const hardItems = sampleItems();
  hardItems[0] = { ...hardItems[0], hardAfter: true };
  const crossed = shared.createAiJsonlTranslationState(hardItems, "zh-CN");
  assert.match(shared.pushAiJsonlTranslationRecord(crossed, {
    type: "unit", chunks: [rangeChunk(0, 1, "越界")]
  }).error, /hard boundary/);

  const incomplete = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  assert.match(shared.pushAiJsonlTranslationRecord(incomplete, {
    type: "unit", chunks: [[0, "缺少终点"]]
  }).error, /invalid JSONL chunk/);
});

test("JSONL accepts tuple chunks and rejects keyed or legacy chunk formats", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  const keyed = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [{ start: 0, end: 0, translation: "键值格式" }]
  });

  assert.equal(keyed.ok, false);
  assert.match(keyed.error, /invalid JSONL chunk/);
  assert.equal(state.cursor, 0);

  const legacy = shared.pushAiJsonlTranslationRecord(
    shared.createAiJsonlTranslationState(sampleItems(), "zh-CN"),
    {
      type: "unit",
      chunks: [{ ids: ["0"], translation: "旧格式" }]
    }
  );
  assert.equal(legacy.ok, false);
  assert.match(legacy.error, /invalid JSONL chunk/);
  assert.equal(state.cursor, 0);

  const deferredField = shared.pushAiJsonlTranslationRecord(
    shared.createAiJsonlTranslationState(sampleItems(), "zh-CN"),
    {
      type: "done",
      deferred_ids: ["0"]
    }
  );
  assert.equal(deferredField.ok, false);
  assert.match(deferredField.error, /legacy ids fields are not supported/);
});

test("JSONL object framing survives pretty printing and arbitrary object splits", () => {
  const first = shared.aiJsonlObjects(
    '```jsonl\n{\n  "type": "unit",\n  "chunks": [[0,0,', false
  );
  assert.equal(first.objects.length, 0);
  const second = shared.aiJsonlObjects(
    first.rest + '\n  "complete"]]\n}\n{"type":"done"}\n```', true
  );
  assert.equal(second.rest, "");
  assert.equal(second.objects.length, 2);
  assert.equal(shared.aiJsonlRecordFromLine(second.objects[0]).record.type, "unit");
  assert.equal(shared.aiJsonlRecordFromLine(second.objects[1]).record.type, "done");

  const wrapped = shared.aiJsonlObjects('[{"type":"done"}]', true);
  assert.equal(wrapped.objects.length, 1);
  assert.match(shared.aiJsonlRecordFromLine(wrapped.objects[0]).error, /not an object/);
});

test("JSONL framing recovers a complete unit when only its outer wrapper is truncated", () => {
  const recovered = shared.aiJsonlObjects(
    '{"type":"unit","chunks":[[0,0,"complete"]\n{"type":"done"}',
    true
  );
  assert.equal(recovered.rest, "");
  assert.equal(recovered.objects.length, 1);
  const decoded = shared.aiJsonlRecordFromLine(recovered.objects[0]);
  assert.equal(decoded.record.type, "unit");
  assert.equal(decoded.record.chunks[0][0], 0);
  assert.equal(decoded.record.chunks[0][1], 0);
  assert.equal(decoded.record.chunks[0][2], "complete");
});

test("JSONL state derives the deferred suffix from its coverage cursor", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  const first = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [rangeChunk(0, 1, "我遇到了美国士兵。")]
  });
  assert.equal(first.ok, true);
  assert.equal(first.unitId, "semantic-0-1");
  assert.equal(first.translations.length, 2);

  const second = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [rangeChunk(2, 2, "他们帮助了我们。")]
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
    chunks: [rangeChunk(0, 1, "第一句。第二句。。真的吗？")]
  });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.translations[0].translation, "第一句第二句真的吗？");
  assert.equal(accepted.translations[0].alignedChunks[0].translation, "第一句第二句真的吗？");
});

test("JSONL translations remove protocol speaker markers before caching", () => {
  const items = [
    { id: "0", text: ">>", startMs: 0, endMs: 100, hardAfter: false },
    { id: "1", text: "Yeah.", startMs: 100, endMs: 500, hardAfter: false }
  ];
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");
  const accepted = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [rangeChunk(0, 1, ">> 是的")]
  });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.translations[0].translation, "是的");
});

test("JSONL separates aligned Chinese chunks at an explicit speaker turn", () => {
  const items = [
    { id: "0", text: ">>", startMs: 0, endMs: 100, hardAfter: false },
    { id: "1", text: "Are", startMs: 100, endMs: 400, hardAfter: false },
    { id: "2", text: "you?", startMs: 400, endMs: 700, hardAfter: false },
    { id: "3", text: ">>", startMs: 700, endMs: 800, hardAfter: false },
    { id: "4", text: "Yeah.", startMs: 800, endMs: 1100, hardAfter: false },
    { id: "5", text: "Okay.", startMs: 1100, endMs: 1400, hardAfter: false }
  ];
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");
  const accepted = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [
      rangeChunk(0, 2, "是吗？"),
      rangeChunk(3, 5, "对，对的。")
    ]
  });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.translations[0].translation, "是吗？ 对，对的");
  assert.equal(accepted.translations[0].alignedChunks[1].translation, "对，对的");
});

test("JSONL keeps oversized units when multiple aligned chunks provide recovery boundaries", () => {
  const items = Array.from({ length: 160 }, (_value, id) => ({
    id: String(id),
    text: `source-${id}`,
    startMs: id * 500,
    endMs: (id + 1) * 500,
    hardAfter: false
  }));
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");
  const accepted = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [
      rangeChunk(items[0].id, items[79].id, "前半"),
      rangeChunk(items[80].id, items[159].id, "后半")
    ]
  });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.translations.length, 160);
  assert.equal(accepted.translations[0].alignedChunks.length, 2);
  assert.equal(state.cursor, 160);
});

test("JSONL still rejects an oversized monolithic unit without alignment boundaries", () => {
  const items = Array.from({ length: 160 }, (_value, id) => ({
    id: String(id),
    text: `source-${id}`,
    startMs: id * 500,
    endMs: (id + 1) * 500,
    hardAfter: false
  }));
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");
  const rejected = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [rangeChunk(items[0].id, items[159].id, "整个大单元")]
  });

  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /oversized JSONL unit/);
  assert.equal(state.cursor, 0);
});

test("JSONL state rejects reordered ids, hard-boundary crossings and records after done", () => {
  const reordered = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  assert.match(shared.pushAiJsonlTranslationRecord(reordered, {
    type: "unit", chunks: [rangeChunk(1, 1, "乱序")]
  }).error, /unexpected JSONL position/);

  const hardItems = sampleItems();
  hardItems[0] = { ...hardItems[0], hardAfter: true };
  const crossed = shared.createAiJsonlTranslationState(hardItems, "zh-CN");
  assert.match(shared.pushAiJsonlTranslationRecord(crossed, {
    type: "unit", chunks: [rangeChunk(0, 1, "越界")]
  }).error, /hard boundary/);

  const afterDone = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  assert.equal(shared.pushAiJsonlTranslationRecord(afterDone, { type: "done" }).ok, true);
  assert.match(shared.pushAiJsonlTranslationRecord(afterDone, {
    type: "unit", chunks: [rangeChunk(0, 0, "多余")]
  }).error, /after done/);
});

test("complete ordered coverage is final even when the model omits done", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [rangeChunk(0, 1, "前半")]
  }).ok, true);
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [rangeChunk(2, 3, "后半")]
  }).ok, true);
  const result = shared.aiJsonlTranslationResult(state, false);
  assert.equal(result.length, 4);
  assert.deepEqual(result.deferredIds, []);
  assert.equal(result.streamPartial, false);
});

test("a malformed tail preserves every previously valid JSONL unit", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [rangeChunk(0, 1, "已完成前缀")]
  }).ok, true);
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [rangeChunk(3, 3, "跳过了编号二")]
  }).ok, false);

  assert.equal(shared.aiJsonlTranslationResult(state, false), null);
  const partial = shared.aiJsonlTranslationResult(state, true);
  assert.equal(partial.length, 2);
  assert.deepEqual(partial.deferredIds, ["2", "3"]);
  assert.equal(partial.streamPartial, true);
  assert.match(partial.streamError, /unexpected JSONL position/);
});

test("the stream keeps complete leading alignment chunks before a missing position", () => {
  const items = Array.from({ length: 6 }, (_value, id) => ({
    id: String(221 + id), text: `token-${id}`, startMs: id * 500, endMs: (id + 1) * 500,
    hardAfter: false
  }));
  const observer = loadJsonlStreamObserver()(items, "zh-CN", () => {});
  const status = observer.onTextDelta(JSON.stringify({
    type: "unit",
    chunks: [
      rangeChunk(0, 1, "complete prefix"),
      rangeChunk(3, 5, "skipped token")
    ]
  }), true);

  assert.equal(status.stop, true);
  assert.equal(observer.result(false), null);
  const partial = observer.result(true);
  assert.deepEqual(Array.from(partial, (item) => String(item.id)), ["221", "222"]);
  assert.deepEqual(Array.from(partial.deferredIds), ["223", "224", "225", "226"]);
  assert.match(partial.streamError, /unexpected JSONL position/);
});

test("a compact range stream recovers its safe prefix before a gapped range", () => {
  const items = Array.from({ length: 6 }, (_value, id) => ({
    id: String(id), text: `token-${id}`, startMs: id * 500, endMs: (id + 1) * 500,
    hardAfter: false
  }));
  const progress = [];
  const observer = loadJsonlStreamObserver()(items, "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  });
  const status = observer.onTextDelta(JSON.stringify({
    type: "unit",
    chunks: [
      rangeChunk(0, 1, "safe prefix"),
      rangeChunk(3, 5, "missing token")
    ]
  }), true);

  assert.equal(status.stop, true);
  assert.deepEqual(progress, [["0", "1"]]);
  assert.deepEqual(Array.from(observer.result(true), (item) => String(item.id)), ["0", "1"]);
  assert.deepEqual(Array.from(observer.result(true).deferredIds), ["2", "3", "4", "5"]);
});

test("an invalid JSONL tail publishes its safe leading prefix immediately", () => {
  const items = Array.from({ length: 6 }, (_value, id) => ({
    id: String(id), text: `token-${id}`, startMs: id * 500, endMs: (id + 1) * 500,
    hardAfter: false
  }));
  const progress = [];
  const observer = loadJsonlStreamObserver()(items, "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  });

  const status = observer.onTextDelta(JSON.stringify({
    type: "unit",
    chunks: [
      rangeChunk(0, 1, "safe prefix"),
      rangeChunk(3, 4, "missing token")
    ]
  }), true);

  assert.equal(status.stop, true);
  assert.deepEqual(progress, [["0", "1"]]);
  assert.deepEqual(Array.from(observer.result(true), (item) => String(item.id)), ["0", "1"]);
});

test("aligned chunks wait for the giant outer unit to close", () => {
  const items = Array.from({ length: 8 }, (_value, id) => ({
    id: String(id), text: `token-${id}`, startMs: id * 500, endMs: (id + 1) * 500,
    hardAfter: false
  }));
  const chunks = [
    rangeChunk(0, 1, "前半"),
    rangeChunk(2, 3, "中段"),
    rangeChunk(4, 7, "后半")
  ];
  const progress = [];
  const observer = loadJsonlStreamObserver()(items, "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  }, { requestClass: "prefetch" });
  const openOuterUnit = `{"type":"unit","chunks":${JSON.stringify(chunks.slice(0, 2)).slice(0, -1)}`;
  assert.equal(observer.onTextDelta(openOuterUnit, false).stop, false);
  assert.deepEqual(progress, []);

  const closing = `,${JSON.stringify(chunks[2])}]}\n{"type":"done"}\n`;
  assert.equal(observer.onTextDelta(closing, true).stop, false);
  const result = observer.result(false);
  assert.equal(result.length, 8);
  assert.deepEqual(Array.from(result, (item) => String(item.id)),
    items.map((item) => item.id));
});

test("a non-urgent request never publishes an unclosed outer semantic unit", () => {
  const items = Array.from({ length: 8 }, (_value, id) => ({
    id: String(id), text: `token-${id}`, startMs: id * 500, endMs: (id + 1) * 500,
    hardAfter: false
  }));
  const chunks = [
    rangeChunk(0, 1, "前半"),
    rangeChunk(2, 3, "中段")
  ];
  const progress = [];
  const observer = loadJsonlStreamObserver()(items, "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  }, { requestClass: "prefetch" });

  const openOuterUnit = `{"type":"unit","chunks":${JSON.stringify(chunks).slice(0, -1)}`;
  assert.equal(observer.onTextDelta(openOuterUnit, false).stop, false);
  assert.deepEqual(progress, []);

  const closing = `]}\n{"type":"done"}\n`;
  assert.equal(observer.onTextDelta(closing, true).stop, false);
  assert.deepEqual(Array.from(observer.result(false), (item) => String(item.id)), [
    "0", "1", "2", "3"
  ]);
});

test("a repeated-position correction cannot publish the incomplete unit it revises", () => {
  const items = Array.from({ length: 6 }, (_value, id) => ({
    id: String(42 + id), text: `token-${id}`, startMs: id * 500, endMs: (id + 1) * 500,
    hardAfter: false
  }));
  const progress = [];
  const observer = loadJsonlStreamObserver()(items, "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  });

  observer.onTextDelta(
    JSON.stringify({ type: "unit", chunks: [rangeChunk(0, 0, "confirmed prefix")] }) + "\n",
    false
  );
  observer.onTextDelta(
    JSON.stringify({ type: "unit", chunks: [rangeChunk(1, 5, "incomplete clause")] }) + "\n",
    false
  );
  const rejected = observer.onTextDelta(
    JSON.stringify({ type: "unit", chunks: [rangeChunk(3, 5, "missing correction")] }) + "\n",
    false
  );

  assert.equal(rejected.stop, true);
  assert.deepEqual(progress, [["42"]]);
  const partial = observer.result(true);
  assert.deepEqual(Array.from(partial, (item) => String(item.id)), ["42"]);
  assert.deepEqual(Array.from(partial.deferredIds), ["43", "44", "45", "46", "47"]);
  assert.match(partial.streamError, /unexpected JSONL position/);
});

test("the stream observer accepts multiline JSON objects without a fallback error", () => {
  const items = sampleItems().slice(0, 2);
  const observer = loadJsonlStreamObserver()(items, "zh-CN", () => {});
  const payload = [
    "{",
    '  "type": "unit",',
    '  "chunks": [[0,1,"complete"]]',
    "}",
    '{"type":"done"}'
  ].join("\n");
  for (let index = 0; index < payload.length; index += 7) {
    const status = observer.onTextDelta(payload.slice(index, index + 7), false);
    assert.equal(status.stop, false);
  }
  const result = observer.onTextDelta("\n", true);
  assert.equal(result.stop, false);
  assert.equal(observer.result(false).length, 2);
});

test("the stream observer ignores a truncated done tail after complete coverage", () => {
  const items = sampleItems().slice(0, 2);
  const observer = loadJsonlStreamObserver()(items, "zh-CN", () => {});
  const payload = [
    '{"type":"unit","chunks":[[0,1,"complete"]]}',
    '{"type":"done"'
  ].join("\n");
  const result = observer.onTextDelta(payload, true);
  assert.equal(result.stop, false);
  assert.equal(observer.result(false).length, 2);
});

test("JSONL structural validation does not reject natural numeric wording", () => {
  const items = [
    { id: "295", text: "This is pretty much a", startMs: 1000, endMs: 1800, hardAfter: false },
    { id: "296", text: "10 out of 10.", startMs: 1800, endMs: 2400, hardAfter: false }
  ];
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [rangeChunk(0, 1, "这差不多是十分满分。")]
  }).ok, true);
  assert.equal(shared.pushAiJsonlTranslationRecord(state, { type: "done" }).ok, true);
  assert.equal(shared.aiJsonlTranslationResult(state, false).length, 2);
});
