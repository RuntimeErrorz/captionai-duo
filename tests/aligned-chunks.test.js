"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();
const lengthMeasure = (text) => String(text).length;
const responseChunk = (start, end, translation) => [Number(start), Number(end), translation];

const successorItems = [
  { id: "221", text: "The Shah is letting this happen,", startMs: 569850, endMs: 571650, hardAfter: false },
  { id: "222", text: "but very soon after, he dies,", startMs: 571650, endMs: 574650, hardAfter: false },
  { id: "223", text: "and the next guy, his son, hates the parliament,", startMs: 574650, endMs: 578370, hardAfter: false },
  { id: "224", text: "doesn't like how it's limiting his power.", startMs: 578370, endMs: 580950, hardAfter: false }
];

const successorResponse = JSON.stringify({ segments: [{
  chunks: [
    responseChunk(0, 1, "国王允许这种情况发生，但不久后他去世了，"),
    responseChunk(2, 3, "他的儿子讨厌议会，不喜欢议会限制他的权力。")
  ]
}] });

test("aligned response validates nested cue coverage and preserves chunk metadata", () => {
  const output = shared.alignedTranslationsFromJsonText(
    successorResponse, successorItems, "zh-CN"
  );
  assert.equal(output.length, 4);
  assert.equal(output[0].unitId, "semantic-221-224");
  assert.equal(output[0].translation,
    "国王允许这种情况发生，但不久后他去世了，他的儿子讨厌议会，不喜欢议会限制他的权力");
  assert.equal(output[0].alignedChunks.length, 2);
  assert.deepEqual(Array.from(output[0].alignedChunks[1].ids), ["223", "224"]);
});

test("aligned response rejects a verbatim source phrase across languages", () => {
  const diagnostics = {};
  const output = shared.alignedTranslationsFromJsonText(
    JSON.stringify({ segments: [{ chunks: [
      responseChunk(0, 1, "The Shah is letting this happen, but very soon after, he dies,")
    ] }] }),
    successorItems, "zh-CN", diagnostics, "en"
  );

  assert.equal(output, null);
  assert.match(diagnostics.reason, /untranslated source text/);
});

test("Chinese full stops preserve spaces between aligned translation chunks", () => {
  const response = JSON.stringify({ segments: [{
    chunks: [
      responseChunk(0, 1, "第一句。"),
      responseChunk(2, 3, "第二句。")
    ]
  }] });
  const output = shared.alignedTranslationsFromJsonText(response, successorItems, "zh-CN");

  assert.equal(output[0].translation, "第一句 第二句");
  assert.equal(output[0].alignedChunks[0].sentenceBoundaryAfter, true);
  assert.equal(output[0].alignedChunks[1].sentenceBoundaryAfter, true);
  const plan = shared.alignedChunkDisplayPlan(
    output[0].alignedChunks.map((chunk) => ({
      ...chunk,
      cues: chunk.ids.map((id) => successorItems[Number(id) - 221])
    })),
    1000, 1000, lengthMeasure, lengthMeasure, "zh-CN"
  );
  assert.equal(plan.pages[0].translation, "第一句 第二句");
});

test("speaker-turn markers create a visible space in aligned CJK display text", () => {
  const items = [
    { id: "0", text: ">>", startMs: 0, endMs: 100, hardAfter: false },
    { id: "1", text: "Are", startMs: 100, endMs: 400, hardAfter: false },
    { id: "2", text: "you?", startMs: 400, endMs: 700, hardAfter: false },
    { id: "3", text: ">>", startMs: 700, endMs: 800, hardAfter: false },
    { id: "4", text: "Yeah.", startMs: 800, endMs: 1100, hardAfter: false },
    { id: "5", text: "Okay.", startMs: 1100, endMs: 1400, hardAfter: false }
  ];
  const response = JSON.stringify({ segments: [{
    chunks: [
      responseChunk(0, 2, "是吗？"),
      responseChunk(3, 5, "对，对的。")
    ]
  }] });
  const output = shared.alignedTranslationsFromJsonText(response, items, "zh-CN");
  const displayChunks = output[0].alignedChunks.map((chunk) => ({
    ids: chunk.ids,
    cues: chunk.ids.map((id) => items[Number(id)]),
    translation: chunk.translation
  }));
  const plan = shared.alignedChunkDisplayPlan(
    displayChunks, 1000, 1000, (text) => text.length, (text) => text.length,
    "zh-CN", "en"
  );

  assert.equal(output[0].translation, "是吗？ 对，对的");
  assert.equal(plan.pages.length, 1);
  assert.equal(plan.pages[0].translation, "是吗？ 对，对的");
});

test("compact aligned response derives segment coverage from ranges", () => {
  const compact = JSON.stringify({ segments: [{ chunks: [
    responseChunk(0, 1, "国王允许这种情况发生，但不久后他去世了，"),
    responseChunk(2, 3, "他的儿子讨厌议会，不喜欢议会限制他的权力。")
  ] }] });
  const output = shared.alignedTranslationsFromJsonText(
    compact, successorItems, "zh-CN"
  );
  assert.ok(output);
  assert.equal(output.length, successorItems.length);
  assert.equal(output[0].unitId, "semantic-221-224");
  assert.equal(output[0].alignedChunks.length, 2);
});

test("compact alignment schema keeps semantic segments around tuple chunks", () => {
  const compact = JSON.stringify({ segments: [
    [
      responseChunk(0, 1, "国王允许这种情况发生，但不久后他去世了，"),
      responseChunk(2, 2, "他的儿子讨厌议会，")
    ],
    [responseChunk(3, 3, "不喜欢议会限制他的权力。")]
  ] });
  const output = shared.alignedTranslationsFromJsonText(compact, successorItems, "zh-CN");
  assert.ok(output);
  assert.equal(output[0].unitId, "semantic-221-223");
  assert.equal(output[0].alignedChunks.length, 2);
  assert.equal(output[3].unitId, "semantic-224-224");
});

test("rolling alignment accepts only a contiguous model-deferred suffix", () => {
  const partial = JSON.stringify({
    chunks: [responseChunk(0, 1, "国王允许这种情况发生，但不久后他去世了。")],
    deferred_start: 2
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
    JSON.stringify({ chunks: [], deferred_start: 0 }),
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
      chunks: [responseChunk(0, 1, "前半句")],
      deferred_start: 3
    },
    {
      chunks: [responseChunk(0, 3, "整句")],
      deferred_start: 3
    }
  ]) {
    const diagnostics = {};
    assert.equal(shared.alignedTranslationsFromJsonText(
      JSON.stringify(response), successorItems, "zh-CN", diagnostics
    ), null);
    assert.match(diagnostics.reason, /deferred|coverage|offset|segment/);
  }
});

test("misnested chunk containers are lifted without changing leaf coverage", () => {
  const misnested = JSON.stringify({ segments: [{ chunks: [
    responseChunk(0, 1, "国王允许这种情况发生，但不久后他去世了。"),
    { chunks: [
      responseChunk(2, 3, "他的儿子讨厌议会，不喜欢议会限制他的权力。")
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

test("aligned response rejects omitted, reordered and cross-boundary ranges", () => {
  for (const [response, currentItems, expectedReason] of [
    [{ segments: [{ chunks: [
      responseChunk(0, 1, "前"),
      responseChunk(3, 3, "漏项")
    ] }] }, successorItems, /unexpected aligned position/],
    [{ segments: [{ chunks: [
      responseChunk(0, 0, "乱序"),
      responseChunk(2, 3, "乱序")
    ] }] }, successorItems, /unexpected aligned position/],
    [{ segments: [{ chunks: [
      responseChunk(0, 1, "越界"),
      responseChunk(2, 3, "后")
    ] }] }, [{ ...successorItems[0], hardAfter: true }, ...successorItems.slice(1)], /hard boundary/]
  ]) {
    const diagnostics = {};
    assert.equal(shared.alignedTranslationsFromJsonText(
      JSON.stringify(response), currentItems, "zh-CN", diagnostics
    ), null);
    assert.match(diagnostics.reason, expectedReason);
  }
});

test("aligned response rejects legacy ids arrays", () => {
  const diagnostics = {};
  const output = shared.alignedTranslationsFromJsonText(
    JSON.stringify({ segments: [{
      ids: ["221"],
      chunks: [{ ids: ["221"], translation: "旧格式" }]
    }] }),
    successorItems.slice(0, 1),
    "zh-CN",
    diagnostics
  );
  assert.equal(output, null);
  assert.match(diagnostics.reason, /legacy ids arrays are not supported/);
});

test("aligned response rejects keyed chunk objects after the tuple cutover", () => {
  const diagnostics = {};
  const output = shared.alignedTranslationsFromJsonText(
    JSON.stringify({ segments: [{
      chunks: [{ start: 0, end: 0, translation: "带字段名" }]
    }] }),
    successorItems.slice(0, 1),
    "zh-CN",
    diagnostics
  );
  assert.equal(output, null);
  assert.match(diagnostics.reason, /invalid aligned chunk/);
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
    chunks: [responseChunk(0, items.length - 1, "整段不可拆的粗粒度译文。")]
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
  const chunks = ranges.map(([from, to], index) => responseChunk(
    from, to - 1,
    [`小费和加班费不征税，`, `老年人的社会保障不征税，并允许扣除购车贷款利息，`,
      `但汽车必须在美国制造，并允许企业百分之百费用化。`][index]
  ));
  const repaired = shared.alignedTranslationsFromJsonText(
    JSON.stringify({ segments: [{ chunks }] }), items, "zh-CN"
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

test("aligned response adjusts internal boundary overruns across adjacent chunks", () => {
  const items = [
    { id: "10", text: "America", startMs: 0, endMs: 500, hardAfter: false },
    { id: "11", text: "is.", startMs: 500, endMs: 1000, hardAfter: false },
    { id: "12", text: "This", startMs: 1000, endMs: 1500, hardAfter: false },
    { id: "13", text: "is", startMs: 1500, endMs: 2000, hardAfter: false },
    { id: "14", text: "it.", startMs: 2000, endMs: 2500, hardAfter: false },
    { id: "15", text: "This", startMs: 2500, endMs: 3000, hardAfter: false },
    { id: "16", text: "hits.", startMs: 3000, endMs: 3500, hardAfter: false }
  ];
  const json = JSON.stringify({
    chunks: [
      [0, 2, "这就是美国。"],
      [3, 5, "这就是真实故事。"],
      [6, 6, "这就是精选辑。"]
    ]
  });
  const res = shared.alignedTranslationsFromJsonText(json, items, "zh-CN");
  assert.ok(res);
  assert.equal(res.length, 7);
  const aligned = res[0].alignedChunks;
  assert.equal(aligned.length, 3);
  assert.deepEqual(Array.from(aligned[0].ids), ["10", "11"]);
  assert.deepEqual(Array.from(aligned[1].ids), ["12", "13", "14"]);
  assert.deepEqual(Array.from(aligned[2].ids), ["15", "16"]);
});

