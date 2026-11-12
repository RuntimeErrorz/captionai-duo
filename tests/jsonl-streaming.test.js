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

// A line may hold several sentences; each becomes its own unit.
function lineChunks(translations) {
  return Array.from(translations).filter((item) => item.alignedChunks)
    .flatMap((item) => Array.from(item.alignedChunks));
}

function wireUnit(...chunks) {
  return JSON.stringify(chunks);
}

test("accelerated JSONL publishes a complete unit before the next unit arrives", () => {
  const progress = [];
  const observer = loadJsonlStreamObserver()(sampleItems(), "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  }, { requestClass: "urgent" });

  const status = observer.onTextDelta(
    wireUnit(rangeChunk(0, 1, "已完成")) + "\n",
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
  assert.deepEqual(lineChunks(accepted.translations).map((chunk) => Array.from(chunk.ids)), [
    ["0", "1"], ["2"]
  ]);
  // Two completed sentences on one line become two units.
  assert.equal(accepted.unitCount, 2);
  assert.equal(accepted.translations[0].translation, "我遇到了美国士兵");
  assert.equal(accepted.translations[2].translation, "他们帮助了我们");
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

test("JSONL array framing survives pretty printing and arbitrary array splits", () => {
  const first = shared.aiJsonlObjects(
    '```jsonl\n[\n  [0,0,', false
  );
  assert.equal(first.objects.length, 0);
  const second = shared.aiJsonlObjects(
    first.rest + '\n  "complete"]\n]\n[]\n```', true
  );
  assert.equal(second.rest, "");
  assert.equal(second.objects.length, 2);
  assert.equal(shared.aiJsonlRecordFromLine(second.objects[0]).record.type, "unit");
  assert.equal(shared.aiJsonlRecordFromLine(second.objects[1]).record.type, "done");

  const wrapped = shared.aiJsonlObjects('{"type":"done"}', true);
  assert.equal(wrapped.objects.length, 1);
  assert.match(shared.aiJsonlRecordFromLine(wrapped.objects[0]).error, /chunk array/);
});

test("JSONL normalizes safe tuple, separator and syntax drift without changing coverage", () => {
  const direct = shared.aiJsonlRecordFromLine('[0,0,"直接返回的单个 chunk"]');
  assert.equal(direct.record.type, "unit");
  assert.deepEqual(JSON.parse(JSON.stringify(direct.record.chunks)), [
    [0, 0, "直接返回的单个 chunk"]
  ]);

  const flat = shared.aiJsonlRecordFromLine('[0,0,"第一段",1,1,"第二段"]');
  assert.deepEqual(JSON.parse(JSON.stringify(flat.record.chunks)), [
    [0, 0, "第一段"], [1, 1, "第二段"]
  ]);

  const repaired = shared.aiJsonlRecordFromLine(
    `[[0,0,">>
你好"],,[1,1,"世界"],]`
  );
  assert.deepEqual(JSON.parse(JSON.stringify(repaired.record.chunks)), [
    [0, 0, ">>\n你好"], [1, 1, "世界"]
  ]);
});

test("JSONL rejects a verbatim source phrase when the target language differs", () => {
  const items = [
    { id: "0", text: "I met", startMs: 0, endMs: 700, hardAfter: false },
    { id: "1", text: "American soldiers.", startMs: 700, endMs: 1700, hardAfter: false }
  ];
  const state = shared.createAiJsonlTranslationState(items, "zh-CN", "en");
  const rejected = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [[0, 1, "I met American soldiers."]]
  });

  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /untranslated source text/);

  const sameLanguage = shared.createAiJsonlTranslationState(items, "en", "en");
  assert.equal(shared.pushAiJsonlTranslationRecord(sameLanguage, {
    type: "unit", chunks: [[0, 1, "I met American soldiers."]]
  }).ok, true);
});

test("JSONL recovers complete tuple prefix when the outer array is also malformed", () => {
  const items = sampleItems();
  const observer = loadJsonlStreamObserver()(items, "zh-CN", () => {});
  const status = observer.onTextDelta(
    '[[0,0,"第一段"],,[1,1,"第二段"]\n[]', true
  );

  assert.equal(status.stop, true);
  assert.equal(status.reason, "recoverable-jsonl-tail");
  const result = observer.result(true);
  assert.deepEqual(Array.from(result, (item) => String(item.id)), ["0", "1"]);
  assert.deepEqual(Array.from(result.deferredIds), ["2", "3"]);
  assert.equal(result.streamError, "");
});

test("a malformed record after a valid prefix is downgraded to a recoverable tail", () => {
  const observer = loadJsonlStreamObserver()(
    sampleItems(), "zh-CN", () => {}, { requestClass: "urgent" }, "en"
  );
  const status = observer.onTextDelta(
    '[[0,1,"已完成"]]\n[[2,3,"未闭合]', true
  );

  assert.equal(status.stop, true);
  assert.equal(status.reason, "recoverable-jsonl-tail");
  const result = observer.result(true);
  assert.deepEqual(Array.from(result, (item) => String(item.id)), ["0", "1"]);
  assert.deepEqual(Array.from(result.deferredIds), ["2", "3"]);
  assert.equal(result.streamError, "");
});

test("JSONL repairs non-JSON backslashes only when they are inside text", () => {
  const decoded = shared.aiJsonlRecordFromLine(
    String.raw`[[0,0,"他说：\“自由\”"]]`
  );

  assert.equal(decoded.record.type, "unit");
  assert.equal(decoded.record.chunks[0][2], "他说：“自由”");

  const unsafe = shared.aiJsonlRecordFromLine(String.raw`[[0,0,"路径\q"]]`);
  assert.equal(unsafe.record, null);
});

test("JSONL permits empty output only for source punctuation, not spoken words", () => {
  const state = shared.createAiJsonlTranslationState([
    { id: "0", text: "。", startMs: 0, endMs: 100, hardAfter: false },
    { id: "1", text: "word", startMs: 100, endMs: 500, hardAfter: false }
  ], "zh-CN");
  const rejected = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [[0, 0, ""], [1, 1, ""]]
  });

  assert.equal(rejected.ok, false);
  assert.equal(state.cursor, 0);
});

test("JSONL folds validated empty markers into a neighboring aligned chunk", () => {
  const items = [
    { id: "0", text: "Hello", startMs: 0, endMs: 300, hardAfter: false },
    { id: "1", text: ">>", startMs: 300, endMs: 400, hardAfter: false },
    { id: "2", text: "World", startMs: 400, endMs: 800, hardAfter: false }
  ];
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");
  const accepted = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [[0, 0, "你好。"], [1, 1, ">>"], [2, 2, "世界。"]]
  });

  assert.equal(accepted.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(lineChunks(accepted.translations))), [
    { ids: ["0", "1"], translation: "你好", sentenceBoundaryAfter: true },
    { ids: ["2"], translation: "世界", sentenceBoundaryAfter: true }
  ]);
  assert.equal(accepted.translations[0].translation, "你好");
  assert.equal(accepted.translations[2].translation, "世界");
});

test("JSONL fills an omitted standalone speaker marker but never an omitted word", () => {
  const markerItems = [
    { id: "0", text: "Hello", startMs: 0, endMs: 300, hardAfter: false },
    { id: "1", text: ">>", startMs: 300, endMs: 400, hardAfter: false },
    { id: "2", text: "World", startMs: 400, endMs: 800, hardAfter: false }
  ];
  const markerState = shared.createAiJsonlTranslationState(markerItems, "zh-CN");
  const recovered = shared.pushAiJsonlTranslationRecord(markerState, {
    type: "unit", chunks: [[0, 0, "你好。"], [2, 2, "世界。"]]
  });

  assert.equal(recovered.ok, true);
  assert.deepEqual(Array.from(recovered.ids), ["0", "1", "2"]);
  assert.deepEqual(JSON.parse(JSON.stringify(lineChunks(recovered.translations))), [
    { ids: ["0", "1"], translation: "你好", sentenceBoundaryAfter: true },
    { ids: ["2"], translation: "世界", sentenceBoundaryAfter: true }
  ]);

  const wordItems = markerItems.map((item, index) => ({
    ...item, text: index === 1 ? "missing" : item.text
  }));
  const rejected = shared.pushAiJsonlTranslationRecord(
    shared.createAiJsonlTranslationState(wordItems, "zh-CN"),
    { type: "unit", chunks: [[0, 0, "你好。"], [2, 2, "世界。"]] }
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /unexpected JSONL position 2 at offset 1/);
});

test("JSONL accepts a marker-only alignment chunk when the same unit has spoken text", () => {
  const items = [
    { id: "0", text: ">>", startMs: 0, endMs: 100, hardAfter: false },
    { id: "1", text: "Hello.", startMs: 100, endMs: 500, hardAfter: false }
  ];
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");
  const accepted = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [[0, 0, ">>"], [1, 1, "你好。"]]
  });

  assert.equal(accepted.ok, true);
  assert.deepEqual(Array.from(accepted.ids), ["0", "1"]);
  assert.equal(accepted.translations[0].translation, "你好");
  assert.equal(state.cursor, 2);
});

test("JSONL preserves unit boundaries when a model nests several unit arrays", () => {
  const decoded = shared.aiJsonlRecordFromLine(
    '[[[0,0,"第一句"]],[[1,1,"第二句"]]]'
  );

  assert.equal(decoded.record, null);
  assert.equal(decoded.records.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.records.map((record) => record.chunks))), [
    [[0, 0, "第一句"]], [[1, 1, "第二句"]]
  ]);
});

test("JSONL ignores records that follow a completion marker in one delta", () => {
  const items = sampleItems().slice(0, 2);
  const observer = loadJsonlStreamObserver()(items, "zh-CN", () => {});
  const status = observer.onTextDelta(
    '[[[0,0,"第一句"]],[],[[1,1,"错误尾巴"]]]', true
  );

  assert.equal(status.stop, false);
  const result = observer.result(false);
  assert.deepEqual(Array.from(result, (item) => String(item.id)), ["0"]);
  assert.deepEqual(Array.from(result.deferredIds), ["1"]);
  assert.equal(result.streamError, "");
});

test("a marker-only JSONL unit is held until the following spoken unit", () => {
  const items = [
    { id: "0", text: ">>", startMs: 0, endMs: 100, hardAfter: false },
    { id: "1", text: "Hello.", startMs: 100, endMs: 500, hardAfter: false }
  ];
  const progress = [];
  const observer = loadJsonlStreamObserver()(items, "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  }, { requestClass: "urgent" });

  assert.equal(observer.onTextDelta('[[0,0,">>"]]\n', false).stop, false);
  const result = observer.onTextDelta('[[1,1,"你好。"],[]]\n', true);

  assert.equal(result.stop, false);
  assert.deepEqual(progress, [["0", "1"]]);
  assert.deepEqual(Array.from(observer.result(false), (item) => String(item.id)), ["0", "1"]);
  assert.equal(observer.result(false).streamError, "");
});

test("JSONL framing recovers a complete unit when only its outer array is truncated", () => {
  const recovered = shared.aiJsonlObjects(
    '[[0,0,"complete"]',
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

test("JSONL rejects the removed object wrapper instead of silently accepting it", () => {
  const decoded = shared.aiJsonlRecordFromLine(
    '{"type":"unit","chunks":[[0,0,"旧外壳"]]}'
  );
  assert.equal(decoded.record, null);
  assert.match(decoded.error, /chunk array/);
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

test("JSONL translations remove Chinese full stops without joining adjacent sentences", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  const accepted = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [rangeChunk(0, 1, "第一句。第二句。。真的吗？")]
  });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.translations[0].translation, "第一句 第二句 真的吗？");
  assert.equal(accepted.translations[0].alignedChunks[0].translation, "第一句 第二句 真的吗？");
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
  // Each speaker turn closes a sentence, so each becomes its own unit.
  assert.equal(accepted.translations[0].translation, "是吗？");
  assert.equal(accepted.translations[3].translation, "对，对的");
  assert.equal(lineChunks(accepted.translations)[1].translation, "对，对的");
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

// An overlapping start means the model lost count; its ranges cannot be
// trusted, so nothing is healed (see tests/jsonl-misalignment.test.js).
test("JSONL state rejects a chunk that starts inside the previous one", () => {
  const items = sampleItems();
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");
  const result = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [
      rangeChunk(0, 1, "前半"),
      rangeChunk(1, 2, "后半")
    ]
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unexpected JSONL position 1 at offset 2/);
  assert.equal(state.cursor, 0);

  const invalidState = shared.createAiJsonlTranslationState(items, "zh-CN");
  const rejected = shared.pushAiJsonlTranslationRecord(invalidState, {
    type: "unit",
    chunks: [
      rangeChunk(0, 1, "前半"),
      rangeChunk(1, 1, "重复且不延伸")
    ]
  });
  assert.equal(rejected.ok, false);
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
  const status = observer.onTextDelta(wireUnit(
    rangeChunk(0, 1, "complete prefix"),
    rangeChunk(3, 5, "skipped token")
  ), true);

  assert.equal(status.stop, true);
  assert.equal(status.reason, "recoverable-jsonl-tail");
  assert.equal(observer.result(false), null);
  const partial = observer.result(true);
  assert.deepEqual(Array.from(partial, (item) => String(item.id)), ["221", "222"]);
  assert.deepEqual(Array.from(partial.deferredIds), ["223", "224", "225", "226"]);
  assert.equal(partial.streamError, "");
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
  const status = observer.onTextDelta(wireUnit(
    rangeChunk(0, 1, "safe prefix"),
    rangeChunk(3, 5, "missing token")
  ), true);

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

  const status = observer.onTextDelta(wireUnit(
    rangeChunk(0, 1, "safe prefix"),
    rangeChunk(3, 4, "missing token")
  ), true);

  assert.equal(status.stop, true);
  assert.deepEqual(progress, [["0", "1"]]);
  assert.deepEqual(Array.from(observer.result(true), (item) => String(item.id)), ["0", "1"]);
});

test("aligned chunks wait for the giant semantic-unit array to close", () => {
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
  const openUnit = JSON.stringify(chunks.slice(0, 2)).slice(0, -1);
  assert.equal(observer.onTextDelta(openUnit, false).stop, false);
  assert.deepEqual(progress, []);

  const closing = `,${JSON.stringify(chunks[2])}]\n[]\n`;
  assert.equal(observer.onTextDelta(closing, true).stop, false);
  const result = observer.result(false);
  assert.equal(result.length, 8);
  assert.deepEqual(Array.from(result, (item) => String(item.id)),
    items.map((item) => item.id));
});

test("a non-urgent request never publishes an unclosed semantic-unit array", () => {
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

  const openUnit = JSON.stringify(chunks).slice(0, -1);
  assert.equal(observer.onTextDelta(openUnit, false).stop, false);
  assert.deepEqual(progress, []);

  const closing = `]\n[]\n`;
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
    wireUnit(rangeChunk(0, 0, "confirmed prefix")) + "\n",
    false
  );
  observer.onTextDelta(
    wireUnit(rangeChunk(1, 5, "incomplete clause")) + "\n",
    false
  );
  const rejected = observer.onTextDelta(
    wireUnit(rangeChunk(3, 5, "missing correction")) + "\n",
    false
  );

  assert.equal(rejected.stop, true);
  assert.deepEqual(progress, [["42"]]);
  const partial = observer.result(true);
  assert.deepEqual(Array.from(partial, (item) => String(item.id)), ["42"]);
  assert.deepEqual(Array.from(partial.deferredIds), ["43", "44", "45", "46", "47"]);
  assert.match(partial.streamError, /unexpected JSONL position/);
});

test("the stream observer accepts multiline JSON arrays without a fallback error", () => {
  const items = sampleItems().slice(0, 2);
  const observer = loadJsonlStreamObserver()(items, "zh-CN", () => {});
  const payload = [
    "[",
    '  [0,1,"complete"]',
    "]",
    "[]"
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
    '[[0,1,"complete"]]',
    '['
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

test("a trailing boundary overrun across a period trims the chunk and prepends it to the next unit", () => {
  const items = [
    { id: "198", text: "threatens", startMs: 1000, endMs: 1500, hardAfter: false },
    { id: "199", text: "civilization.", startMs: 1500, endMs: 2000, hardAfter: false },
    { id: "200", text: "This", startMs: 2000, endMs: 2500, hardAfter: false },
    { id: "201", text: "is", startMs: 2500, endMs: 3000, hardAfter: false },
    { id: "202", text: "Gates.", startMs: 3000, endMs: 3500, hardAfter: false }
  ];
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");

  // Model emitted unit 1 with an off-by-one overrun including "This" (index 2)
  const unit1 = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [rangeChunk(0, 2, "这就是威胁文明的问题。")]
  });
  assert.equal(unit1.ok, true);
  assert.deepEqual(Array.from(unit1.ids), ["198", "199"]);
  assert.equal(state.cursor, 2);

  // Model emitted unit 2 starting after its own overrun (index 3), skipping "This"
  const unit2 = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [rangeChunk(3, 4, "这就是盖茨的问题。")]
  });
  assert.equal(unit2.ok, true);
  // Unit 2 prepended the trimmed "This" (index 2 / id "200")
  assert.deepEqual(Array.from(unit2.ids), ["200", "201", "202"]);
  assert.equal(state.cursor, 5);

  assert.equal(shared.pushAiJsonlTranslationRecord(state, { type: "done" }).ok, true);
  const result = shared.aiJsonlTranslationResult(state, false);
  assert.equal(result.length, 5);
  assert.deepEqual(Array.from(result.deferredIds), []);
});

test("an abbreviation like Dr. Smith is preserved and not trimmed as a boundary overrun", () => {
  const items = [
    { id: "0", text: "I", startMs: 0, endMs: 500, hardAfter: false },
    { id: "1", text: "saw", startMs: 500, endMs: 1000, hardAfter: false },
    { id: "2", text: "Dr.", startMs: 1000, endMs: 1500, hardAfter: false },
    { id: "3", text: "Smith", startMs: 1500, endMs: 2000, hardAfter: false }
  ];
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");
  const accepted = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [rangeChunk(0, 3, "我见到了史密斯医生")]
  });
  assert.equal(accepted.ok, true);
  assert.deepEqual(Array.from(accepted.ids), ["0", "1", "2", "3"]);
  assert.equal(state.cursor, 4);
});

test("internal boundary overruns across adjacent chunks in one unit are trimmed and shifted", () => {
  const items = [
    { id: "10", text: "America", startMs: 0, endMs: 500, hardAfter: false },
    { id: "11", text: "is.", startMs: 500, endMs: 1000, hardAfter: false },
    { id: "12", text: "This", startMs: 1000, endMs: 1500, hardAfter: false },
    { id: "13", text: "is", startMs: 1500, endMs: 2000, hardAfter: false },
    { id: "14", text: "it.", startMs: 2000, endMs: 2500, hardAfter: false },
    { id: "15", text: "This", startMs: 2500, endMs: 3000, hardAfter: false },
    { id: "16", text: "hits.", startMs: 3000, endMs: 3500, hardAfter: false }
  ];
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");

  const unit = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit",
    chunks: [
      rangeChunk(0, 2, "这就是美国。"),
      rangeChunk(3, 5, "这就是真实故事。"),
      rangeChunk(6, 6, "这就是精选辑。")
    ]
  });
  assert.equal(unit.ok, true);
  const aligned = lineChunks(unit.translations);
  assert.equal(aligned.length, 3);
  assert.deepEqual(Array.from(aligned[0].ids), ["10", "11"]);
  assert.deepEqual(Array.from(aligned[1].ids), ["12", "13", "14"]);
  assert.deepEqual(Array.from(aligned[2].ids), ["15", "16"]);
  assert.equal(state.cursor, 7);
});


test("the stream stops once a unit reaches the caller's uncommitted runway", () => {
  const progress = [];
  const observer = loadJsonlStreamObserver()(sampleItems(), "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  }, { requestClass: "prefetch", commitGuardLocal: 2 });

  // Positions 0-1 end before the runway: keep streaming.
  let status = observer.onTextDelta(wireUnit(rangeChunk(0, 1, "我遇到了美国士兵。")) + "\n", false);
  assert.equal(status.stop, false);
  // Position 2 is inside the runway: stop. No later record can revise the
  // stream, so everything received is flushed; the caller's commit plan
  // still keeps the runway unit uncommitted.
  status = observer.onTextDelta(wireUnit(rangeChunk(2, 2, "他们帮助了我们。")) + "\n" +
    wireUnit(rangeChunk(3, 3, "never parsed")) + "\n", false);
  assert.equal(status.stop, true);
  assert.equal(status.reason, "commit-guard-reached");
  assert.deepEqual(progress, [["0", "1"], ["2"]]);
  const partial = observer.result(true);
  assert.equal(partial.streamPartial, true, "an early stop is never cached as complete");
  assert.deepEqual(Array.from(partial, (item) => String(item.id)), ["0", "1", "2"]);
});

test("a request that reaches its region end streams to completion", () => {
  const observer = loadJsonlStreamObserver()(sampleItems(), "zh-CN", () => {},
    { requestClass: "prefetch", commitGuardLocal: -1 });
  for (const line of [wireUnit(rangeChunk(0, 1, "a")), wireUnit(rangeChunk(2, 2, "b")),
    wireUnit(rangeChunk(3, 3, "c"))]) {
    assert.equal(observer.onTextDelta(`${line}\n`, false).stop, false);
  }
});

test("a whole window on one JSONL line still commits sentence by sentence", () => {
  // Observed with deepseek-v4-flash: 23 sentences on one line, the last one
  // unfinished. Without splitting, the line was one giant unit touching the
  // window end, so nothing committed and the window was requested again.
  const words = ["I", "enjoy", "this.", "[LAUGHTER]", "Let", "me", "prepare.", "Meanwhile", "he", "earned"];
  const items = words.map((text, id) => ({ id: String(id), text, startMs: id * 400, endMs: id * 400 + 400, hardAfter: false }));
  const state = shared.createAiJsonlTranslationState(items, "zh-CN", "en");
  const accepted = shared.pushAiJsonlTranslationRecord(state, { type: "unit", chunks: [
    rangeChunk(0, 2, "我喜欢这个。"), rangeChunk(3, 3, "[笑声]"),
    rangeChunk(4, 6, "让我准备一下。"), rangeChunk(7, 9, "与此同时，他赚了，")
  ] });
  assert.equal(accepted.ok, true);
  const units = [];
  for (const item of accepted.translations) {
    if (!units.length || units[units.length - 1].unitId !== item.unitId) units.push({ unitId: item.unitId, ids: [] });
    units[units.length - 1].ids.push(item.id);
  }
  assert.deepEqual(units.map((unit) => unit.ids), [["0", "1", "2"], ["3", "4", "5", "6"], ["7", "8", "9"]]);
});

test("an abbreviation period does not split a sentence", () => {
  const words = ["Mr.", "Smith", "said", "no."];
  const items = words.map((text, id) => ({ id: String(id), text, startMs: id * 400, endMs: id * 400 + 400, hardAfter: false }));
  const state = shared.createAiJsonlTranslationState(items, "zh-CN", "en");
  const accepted = shared.pushAiJsonlTranslationRecord(state, { type: "unit", chunks: [
    rangeChunk(0, 0, "史密斯先生，"), rangeChunk(1, 3, "说不。")
  ] });
  assert.equal(accepted.unitCount, 1);
});

test("a closed sentence inside a still-streaming line is accepted before the line ends", () => {
  const progress = [];
  const observer = loadJsonlStreamObserver()(sampleItems(), "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  }, { requestClass: "urgent" });
  const line = wireUnit(
    rangeChunk(0, 1, "我遇到了美国士兵。"),
    rangeChunk(2, 2, "他们帮助了我们。"),
    rangeChunk(3, 3, "下一个想法还没说完")
  );
  const cut = line.indexOf("[3,");
  assert.equal(observer.onTextDelta(line.slice(0, cut), false).stop, false);
  // Both finished sentences are out while the line is still open; the
  // unfinished clause is not.
  assert.deepEqual(progress, [["0", "1", "2"]]);

  assert.equal(observer.onTextDelta(line.slice(cut) + "\n[]\n", false).stop, false);
  assert.deepEqual(progress, [["0", "1", "2"], ["3"]]);
  const result = observer.result(false);
  assert.deepEqual(Array.from(result, (item) => String(item.id)), ["0", "1", "2", "3"]);
  assert.equal(result.streamPartial, false);
});

test("an open line with no closed sentence waits for the line to end", () => {
  const progress = [];
  const observer = loadJsonlStreamObserver()(sampleItems(), "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  }, { requestClass: "urgent" });
  const line = wireUnit(rangeChunk(0, 0, "我遇到了，"), rangeChunk(1, 1, "美国士兵。"));
  observer.onTextDelta(line.slice(0, line.indexOf("[1,")), false);
  assert.deepEqual(progress, []);
  // A chunk whose closing quote has not arrived is never accepted.
  observer.onTextDelta(line.slice(line.indexOf("[1,"), -3), false);
  assert.deepEqual(progress, []);
  observer.onTextDelta(line.slice(-3) + "\n", false);
  assert.deepEqual(progress, [["0", "1"]]);
});

test("streaming a multi-sentence line byte by byte yields the same units as one delta", () => {
  const text = wireUnit(
    rangeChunk(0, 1, "我遇到了美国士兵。"),
    rangeChunk(2, 2, "他们帮助了我们。"),
    rangeChunk(3, 3, "下一个想法还没说完")
  ) + "\n[]\n";
  const collect = (deltas) => {
    const units = [];
    const observer = loadJsonlStreamObserver()(sampleItems(), "zh-CN", (translations) => {
      for (const item of translations) if (item.alignedChunks) units.push(item.unitId);
    }, { requestClass: "prefetch" });
    for (const delta of deltas) assert.equal(observer.onTextDelta(delta, false).stop, false);
    observer.onTextDelta("", true);
    return { units, result: Array.from(observer.result(false), (item) => item.unitId) };
  };
  const whole = collect([text]);
  const bytes = collect(Array.from(text));
  assert.deepEqual(bytes.result, whole.result);
  assert.deepEqual(new Set(bytes.result).size, 3);
});

test("an open-line prefix still stops at the commit guard", () => {
  const observer = loadJsonlStreamObserver()(sampleItems(), "zh-CN", () => {}, {
    requestClass: "prefetch", commitGuardLocal: 1
  });
  const line = wireUnit(
    rangeChunk(0, 1, "我遇到了美国士兵。"),
    rangeChunk(2, 2, "他们帮助了我们。")
  );
  const status = observer.onTextDelta(line.slice(0, line.indexOf("[2,")), false);
  assert.equal(status.stop, true);
  assert.equal(status.reason, "commit-guard-reached");
});

function endChunk(end, translation) {
  return [Number(end), translation];
}

test("end-only chunks start right after the previous chunk across lines", () => {
  const progress = [];
  const observer = loadJsonlStreamObserver()(sampleItems(), "zh-CN", (translations) => {
    progress.push(Array.from(translations, (item) => String(item.id)));
  }, { requestClass: "urgent" });
  const text = wireUnit(endChunk(1, "我遇到了美国士兵。")) + "\n" +
    wireUnit(endChunk(2, "他们帮助了我们。")) + "\n" +
    wireUnit(endChunk(3, "下一个想法还没说完")) + "\n[]\n";
  assert.equal(observer.onTextDelta(text, true).stop, false);
  assert.deepEqual(progress, [["0", "1"], ["2"], ["3"]]);
  const result = observer.result(false);
  assert.equal(result.streamPartial, false);
  assert.equal(result[0].translation, "我遇到了美国士兵");
});

test("end-only lines stream byte by byte to the same units as one delta", () => {
  const text = wireUnit(
    endChunk(1, "我遇到了美国士兵。"),
    endChunk(2, "他们帮助了我们。"),
    endChunk(3, "下一个想法还没说完")
  ) + "\n[]\n";
  const run = (deltas) => {
    const observer = loadJsonlStreamObserver()(sampleItems(), "zh-CN", () => {}, {
      requestClass: "prefetch"
    });
    for (const delta of deltas) assert.equal(observer.onTextDelta(delta, false).stop, false);
    observer.onTextDelta("", true);
    return Array.from(observer.result(false), (item) => `${item.id}:${item.unitId}`);
  };
  const whole = run([text]);
  assert.deepEqual(run(Array.from(text)), whole);
  assert.equal(whole.length, 4);
});

test("end-only chunks keep coverage validation strict", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  // An end before the implied start is a malformed range.
  assert.equal(shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [[null, 1, "我遇到了美国士兵。"]]
  }).ok, true);
  const backwards = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [[null, 1, "重复"]]
  });
  assert.equal(backwards.ok, false);
  assert.match(backwards.error, /invalid JSONL range|unexpected JSONL position/);

  const hardItems = sampleItems();
  hardItems[0] = { ...hardItems[0], hardAfter: true };
  const crossed = shared.createAiJsonlTranslationState(hardItems, "zh-CN");
  assert.match(shared.pushAiJsonlTranslationRecord(crossed, {
    type: "unit", chunks: [[null, 1, "越界"]]
  }).error, /hard boundary/);
});

test("end-only and start-end chunks can be mixed on one line", () => {
  const decoded = shared.aiJsonlRecordFromLine('[[1,"我遇到了美国士兵。"],[2,2,"他们帮助了我们。"]]');
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  const accepted = shared.pushAiJsonlTranslationRecord(state, decoded.record);
  assert.equal(accepted.ok, true);
  assert.deepEqual(Array.from(accepted.ids), ["0", "1", "2"]);
});

test("an end-only chunk that overruns a sentence boundary is trimmed back", () => {
  const items = [
    { id: "0", text: "We won.", startMs: 0, endMs: 700, hardAfter: false },
    { id: "1", text: "Then", startMs: 700, endMs: 1000, hardAfter: false },
    { id: "2", text: "we left.", startMs: 1000, endMs: 1700, hardAfter: false }
  ];
  const state = shared.createAiJsonlTranslationState(items, "zh-CN");
  const first = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [[null, 1, "我们赢了。"]]
  });
  assert.equal(first.ok, true);
  assert.deepEqual(Array.from(first.ids), ["0"]);
  const second = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [[null, 2, "然后我们离开了。"]]
  });
  assert.equal(second.ok, true);
  assert.deepEqual(Array.from(second.ids), ["1", "2"]);
});

test("an end-only chunk repeating the previous end joins its translation", () => {
  const state = shared.createAiJsonlTranslationState(sampleItems(), "zh-CN");
  const accepted = shared.pushAiJsonlTranslationRecord(state, {
    type: "unit", chunks: [[null, 1, "我遇到了"], [null, 1, "美国士兵。"], [null, 2, "他们帮助了我们。"]]
  });
  assert.equal(accepted.ok, true);
  assert.deepEqual(Array.from(accepted.ids), ["0", "1", "2"]);
  assert.equal(accepted.translations[0].translation, "我遇到了美国士兵");
});
