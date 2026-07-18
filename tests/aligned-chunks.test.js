"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();
const lengthMeasure = (text) => String(text).length;

const successorItems = [
  { id: "221", text: "The Shah is letting this happen,", startMs: 569850, endMs: 571650, hardAfter: false },
  { id: "222", text: "but very soon after, he dies,", startMs: 571650, endMs: 574650, hardAfter: false },
  { id: "223", text: "and the next guy, his son, hates the parliament,", startMs: 574650, endMs: 578370, hardAfter: false },
  { id: "224", text: "doesn't like how it's limiting his power.", startMs: 578370, endMs: 580950, hardAfter: false }
];

const successorResponse = JSON.stringify({ segments: [{
  ids: ["221", "222", "223", "224"],
  chunks: [
    { ids: ["221", "222"], translation: "国王允许这种情况发生，但不久后他去世了，" },
    { ids: ["223", "224"], translation: "他的儿子讨厌议会，不喜欢议会限制他的权力。" }
  ]
}] });

test("aligned response validates nested cue coverage and preserves chunk metadata", () => {
  const output = shared.alignedTranslationsFromJsonText(
    successorResponse, successorItems, "zh-CN"
  );
  assert.equal(output.length, 4);
  assert.equal(output[0].unitId, "semantic-221-224");
  assert.equal(output[0].translation,
    "国王允许这种情况发生，但不久后他去世了，他的儿子讨厌议会，不喜欢议会限制他的权力。");
  assert.equal(output[0].alignedChunks.length, 2);
  assert.deepEqual(Array.from(output[0].alignedChunks[1].ids), ["223", "224"]);
});

test("compact aligned response derives segment coverage from chunk ids", () => {
  const compact = JSON.stringify({ segments: [{ chunks: [
    { ids: ["221", "222"], translation: "国王允许这种情况发生，但不久后他去世了，" },
    { ids: ["223", "224"], translation: "他的儿子讨厌议会，不喜欢议会限制他的权力。" }
  ] }] });
  const output = shared.alignedTranslationsFromJsonText(
    compact, successorItems, "zh-CN"
  );
  assert.ok(output);
  assert.equal(output.length, successorItems.length);
  assert.equal(output[0].unitId, "semantic-221-224");
  assert.equal(output[0].alignedChunks.length, 2);
});

test("flat alignment schema groups chunks by monotonic segment number", () => {
  const flat = JSON.stringify({ chunks: [
    { segment: 1, ids: ["221", "222"], translation: "国王允许这种情况发生，但不久后他去世了，" },
    { segment: 1, ids: ["223"], translation: "他的儿子讨厌议会，" },
    { segment: 2, ids: ["224"], translation: "不喜欢议会限制他的权力。" }
  ] });
  const output = shared.alignedTranslationsFromJsonText(flat, successorItems, "zh-CN");
  assert.ok(output);
  assert.equal(output[0].unitId, "semantic-221-223");
  assert.equal(output[0].alignedChunks.length, 2);
  assert.equal(output[3].unitId, "semantic-224-224");
});

test("rolling alignment accepts only a contiguous model-deferred suffix", () => {
  const partial = JSON.stringify({
    chunks: [{
      segment: 1,
      ids: ["221", "222"],
      translation: "国王允许这种情况发生，但不久后他去世了。"
    }],
    deferred_ids: ["223", "224"]
  });
  const diagnostics = {};
  const output = shared.alignedTranslationsFromJsonText(
    partial, successorItems, "zh-CN", diagnostics
  );
  assert.ok(output);
  assert.equal(output.length, 2);
  assert.deepEqual(Array.from(output.deferredIds), ["223", "224"]);
  assert.equal(diagnostics.deferredStart, "223");

  const allDeferred = shared.alignedTranslationsFromJsonText(
    JSON.stringify({ chunks: [], deferred_ids: ["221", "222", "223", "224"] }),
    successorItems,
    "zh-CN"
  );
  assert.ok(allDeferred);
  assert.equal(allDeferred.length, 0);
  assert.deepEqual(Array.from(allDeferred.deferredIds), ["221", "222", "223", "224"]);
});

test("rolling alignment rejects a deferred hole or duplicated completed token", () => {
  for (const response of [
    {
      chunks: [{ segment: 1, ids: ["221", "222"], translation: "前半句" }],
      deferred_ids: ["224"]
    },
    {
      chunks: [{ segment: 1, ids: ["221", "222", "223", "224"], translation: "整句" }],
      deferred_ids: ["224"]
    }
  ]) {
    const diagnostics = {};
    assert.equal(shared.alignedTranslationsFromJsonText(
      JSON.stringify(response), successorItems, "zh-CN", diagnostics
    ), null);
    assert.match(diagnostics.reason, /deferred|coverage|offset|segment/);
  }
});

test("misnested legacy chunk containers are lifted without changing leaf coverage", () => {
  const misnested = JSON.stringify({ segments: [{ chunks: [
    { ids: ["221", "222"], translation: "国王允许这种情况发生，但不久后他去世了。" },
    { chunks: [
      { ids: ["223", "224"], translation: "他的儿子讨厌议会，不喜欢议会限制他的权力。" }
    ] }
  ] }] });
  const output = shared.alignedTranslationsFromJsonText(
    misnested, successorItems, "zh-CN"
  );
  assert.ok(output);
  assert.equal(output[0].unitId, "semantic-221-222");
  assert.equal(output[2].unitId, "semantic-223-224");
  assert.deepEqual(Array.from(output[2].alignedChunks[0].ids), ["223", "224"]);
});

test("aligned response rejects omitted, reordered and cross-boundary chunk ids", () => {
  for (const [response, currentItems, expectedReason] of [
    [{ segments: [{ ids: ["221", "222", "223", "224"], chunks: [
      { ids: ["221", "222"], translation: "前" },
      { ids: ["224"], translation: "漏项" }
    ] }] }, successorItems, /unexpected aligned chunk id/],
    [{ segments: [{ ids: ["221", "222", "223", "224"], chunks: [
      { ids: ["221", "223"], translation: "乱序" },
      { ids: ["222", "224"], translation: "乱序" }
    ] }] }, successorItems, /unexpected aligned chunk id/],
    [{ segments: [{ ids: ["221", "222", "223", "224"], chunks: [
      { ids: ["221", "222"], translation: "越界" },
      { ids: ["223", "224"], translation: "后" }
    ] }] }, [{ ...successorItems[0], hardAfter: true }, ...successorItems.slice(1)], /hard boundary/]
  ]) {
    const diagnostics = {};
    assert.equal(shared.alignedTranslationsFromJsonText(
      JSON.stringify(response), currentItems, "zh-CN", diagnostics
    ), null);
    assert.match(diagnostics.reason, expectedReason);
  }
});

test("browser packing keeps the next-guy appositive paired with its translation", () => {
  const chunks = [
    {
      ids: ["221", "222"],
      cues: successorItems.slice(0, 2),
      translation: "国王允许这种情况发生，但不久后他去世了，"
    },
    {
      ids: ["223", "224"],
      cues: successorItems.slice(2),
      translation: "他的儿子讨厌议会，不喜欢议会限制他的权力。"
    }
  ];
  const narrow = shared.alignedChunkDisplayPlan(
    chunks, 90, 32, lengthMeasure, lengthMeasure, "zh-CN"
  );
  assert.equal(narrow.pages.length, 2);
  assert.doesNotMatch(narrow.pages[0].source, /the next guy/);
  assert.match(narrow.pages[1].source, /the next guy, his son/);
  assert.match(narrow.pages[1].translation, /他的儿子/);
  assert.equal(narrow.memberPages["223"], 1);

  const wide = shared.alignedChunkDisplayPlan(
    chunks, 500, 500, lengthMeasure, lengthMeasure, "zh-CN"
  );
  assert.equal(wide.pages.length, 1);
  assert.equal(wide.memberPages["223"], 0);
});

test("cross-cue phrases remain indivisible aligned chunks", () => {
  const fridayItems = [
    { id: "42", text: "You can leave it a mess on a", startMs: 195200, endMs: 201200 },
    { id: "43", text: "Friday night and not worry about it.", startMs: 199280, endMs: 207280 }
  ];
  const plan = shared.alignedChunkDisplayPlan([{
    ids: ["42", "43"],
    cues: fridayItems,
    translation: "你可以在周五晚上把这里弄乱，也不用担心。"
  }], 30, 15, lengthMeasure, lengthMeasure, "zh-CN");

  assert.equal(plan.pages.length, 1);
  assert.match(plan.pages[0].source, /on a Friday night/);
  assert.equal(plan.memberPages["42"], plan.memberPages["43"]);
});

test("coarse model alignment stays valid and only its oversized chunk is paginated", () => {
  const words = ("No tax on tips, no tax on overtime, and no tax on social security for our great " +
    "seniors, along with the interest deduction on a loan used to purchase a car, but only if that " +
    "car is made in America and a 100% expensing for our job creating businesses.").split(/\s+/);
  const items = words.map((text, index) => ({
    id: String(219 + index),
    text,
    startMs: index * 450,
    endMs: (index + 1) * 450,
    hardAfter: false
  }));
  const ids = items.map((item) => item.id);
  const diagnostics = {};
  const coarse = JSON.stringify({ segments: [{
    ids,
    chunks: [{ ids, translation: "整段不可拆的粗粒度译文。" }]
  }] });

  const coarseResult = shared.alignedTranslationsFromJsonText(
    coarse, items, "zh-CN", diagnostics
  );
  assert.ok(coarseResult);
  assert.equal(diagnostics.reason, "");
  assert.equal(coarseResult[0].alignedChunks.length, 1);
  const coarsePlan = shared.alignedChunkDisplayPlan([{
    ...coarseResult[0].alignedChunks[0],
    cues: items
  }], 100, 40, lengthMeasure, lengthMeasure, "zh-CN");
  assert.equal(coarsePlan.overflow, false);
  assert.ok(coarsePlan.pages.length >= 2);
  assert.ok(coarsePlan.pages.every((page) => page.splitChunk === true));
  assert.deepEqual(Array.from(coarsePlan.pages.flatMap((page) => page.ids)), ids);
  assert.ok(coarsePlan.memberPages[ids[0]] < coarsePlan.memberPages[ids.at(-1)]);

  const ranges = [[0, 15], [15, 32], [32, items.length]];
  const chunks = ranges.map(([from, to], index) => ({
    ids: ids.slice(from, to),
    translation: [`小费和加班费不征税，`, `老年人的社会保障不征税，并允许扣除购车贷款利息，`,
      `但汽车必须在美国制造，并允许企业百分之百费用化。`][index]
  }));
  const repaired = shared.alignedTranslationsFromJsonText(
    JSON.stringify({ segments: [{ ids, chunks }] }), items, "zh-CN"
  );
  assert.ok(repaired);
  assert.equal(repaired[0].alignedChunks.length, 3);

  const plan = shared.alignedChunkDisplayPlan(
    repaired[0].alignedChunks.map((chunk) => ({
      ...chunk,
      cues: chunk.ids.map((id) => items[Number(id) - 219])
    })),
    100, 40, lengthMeasure, lengthMeasure, "zh-CN"
  );
  assert.ok(plan.pages.length >= 2);
  assert.equal(plan.overflow, false);
  assert.ok(plan.pages.every((page) => page.source.length <= 110));
});

test("aligned chunk packing preserves fitting chunks and locally splits only oversized ones", () => {
  let state = 0x51f15e5d;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };

  for (let run = 0; run < 500; run++) {
    const chunkCount = 1 + Math.floor(random() * 14);
    let nextId = 0;
    let start = 0;
    const chunks = Array.from({ length: chunkCount }, (_value, chunkIndex) => {
      const cueCount = 1 + Math.floor(random() * 3);
      const cues = Array.from({ length: cueCount }, () => {
        const id = String(nextId++);
        const cue = {
          id,
          text: `source ${id} token${Math.floor(random() * 1000)}`,
          startMs: start,
          endMs: start + 900
        };
        start += 900;
        return cue;
      });
      return {
        ids: cues.map((cue) => cue.id),
        cues,
        translation: `译文${chunkIndex}。`
      };
    });
    const sourceLimit = 30 + Math.floor(random() * 180);
    const translationLimit = 10 + Math.floor(random() * 80);
    const plan = shared.alignedChunkDisplayPlan(
      chunks, sourceLimit, translationLimit, lengthMeasure, lengthMeasure, "zh-CN"
    );
    const expectedIds = chunks.flatMap((chunk) => chunk.ids);
    const actualIds = plan.pages.flatMap((page) => Array.from(page.ids));

    assert.deepEqual(Array.from(actualIds), expectedIds);
    assert.equal(plan.overflow, false);
    assert.ok(plan.pages.every((page) => page.source && page.translation && page.chunkCount >= 1));
    for (const chunk of chunks) {
      const pages = new Set(chunk.ids.map((id) => plan.memberPages[id]));
      const source = shared.mergeTimedCueTexts(chunk.cues);
      const individuallyFits = lengthMeasure(source) <= sourceLimit &&
        lengthMeasure(chunk.translation) <= translationLimit;
      if (individuallyFits) assert.equal(pages.size, 1);
      else assert.ok(pages.size >= 1);
    }
    for (let id = 1; id < expectedIds.length; id++) {
      assert.ok(plan.memberPages[String(id)] >= plan.memberPages[String(id - 1)]);
    }
  }
});

test("an oversized middle chunk does not discard neighboring alignment boundaries", () => {
  const cue = (id, text) => ({ id: String(id), text, startMs: id * 1000, endMs: (id + 1) * 1000 });
  const chunks = [
    { ids: ["0"], cues: [cue(0, "Short opening.")], translation: "开场。" },
    {
      ids: ["1", "2", "3", "4", "5", "6"],
      cues: [
        cue(1, "This deliberately long middle"),
        cue(2, "chunk contains several natural"),
        cue(3, "phrases that need local"),
        cue(4, "pagination without changing"),
        cue(5, "the chunks on either"),
        cue(6, "side of it.")
      ],
      translation: "这个较长的中间区块包含多个自然短语，需要单独分页，同时保留两侧区块。"
    },
    { ids: ["7"], cues: [cue(7, "Short ending.")], translation: "结尾。" }
  ];
  const plan = shared.alignedChunkDisplayPlan(
    chunks, 55, 18, lengthMeasure, lengthMeasure, "zh-CN", "en"
  );

  assert.equal(plan.overflow, false);
  assert.equal(plan.memberPages["0"], 0);
  assert.ok(plan.memberPages["1"] > plan.memberPages["0"]);
  assert.ok(plan.memberPages["6"] > plan.memberPages["1"]);
  assert.ok(plan.memberPages["7"] > plan.memberPages["6"]);
  assert.equal(plan.pages[0].source, "Short opening.");
  assert.equal(plan.pages.at(-1).source, "Short ending.");
  assert.ok(plan.pages.slice(1, -1).every((page) => page.splitChunk === true));
});
