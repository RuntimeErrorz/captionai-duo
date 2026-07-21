"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();

function unit(first, last, translation = "译文") {
  const unitId = `semantic-${first}-${last}`;
  return Array.from({ length: last - first + 1 }, (_value, offset) => ({
    id: String(first + offset), unitId, translation
  }));
}

test("a semantic unit touching the private guard is carried whole even if the model did not defer it", () => {
  const translations = [
    ...unit(4371, 4395, "此前的完整句子"),
    ...unit(4396, 4399, "Like it's nuts")
  ];
  const plan = shared.monotonicSemanticCommitPlan(
    translations, 4371, 4399, 4500, 16
  );

  assert.equal(plan.guardStart, 4384);
  assert.equal(plan.commitThrough, 4370);
  assert.equal(plan.carryStart, 4371);
  assert.deepEqual(Array.from(plan.translations), []);
});

test("the carried phrase commits once a later window contains its natural completion", () => {
  const translations = [
    ...unit(4371, 4395, "此前的完整句子"),
    ...unit(4396, 4401, "简直太疯狂了，伙计。"),
    ...unit(4402, 4420, "下一句")
  ];
  const plan = shared.monotonicSemanticCommitPlan(
    translations, 4371, 4475, 4600, 16
  );

  assert.equal(plan.commitThrough, 4420);
  assert.equal(plan.carryStart, 4421);
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(plan.units, (entry) => entry.members))), [
    Array.from({ length: 25 }, (_value, offset) => 4371 + offset),
    [4396, 4397, 4398, 4399, 4400, 4401],
    Array.from({ length: 19 }, (_value, offset) => 4402 + offset)
  ]);
});

test("a guard-blocking unit can recover an immutable prefix from model-aligned chunks", () => {
  const chunks = [
    { ids: Array.from({ length: 40 }, (_value, offset) => String(offset)), translation: "第一段" },
    { ids: Array.from({ length: 40 }, (_value, offset) => String(40 + offset)), translation: "第二段" },
    { ids: Array.from({ length: 40 }, (_value, offset) => String(80 + offset)), translation: "第三段" },
    { ids: Array.from({ length: 40 }, (_value, offset) => String(120 + offset)), translation: "尾部" }
  ];
  const translations = unit(0, 159, "整段");
  translations[0].alignedChunks = chunks;

  const blocked = shared.monotonicSemanticCommitPlan(translations, 0, 159, 500, 16);
  assert.equal(blocked.commitThrough, -1);

  const recovered = shared.semanticUnitsFromAlignedChunks(translations);
  const plan = shared.monotonicSemanticCommitPlan(recovered, 0, 159, 500, 16);
  assert.deepEqual(Array.from(plan.units, (entry) => [
    entry.members[0], entry.members[entry.members.length - 1]
  ]), [[0, 39], [40, 79], [80, 119]]);
  assert.equal(plan.commitThrough, 119);
  assert.equal(plan.carryStart, 120);
  assert.equal(recovered[0].translation, "第一段");
  assert.equal(recovered[40].translation, "第二段");
});

test("only a contiguous prefix can commit; a hole cannot be repaired by a later unit", () => {
  const translations = [
    ...unit(10, 14),
    ...unit(17, 20)
  ];
  const plan = shared.monotonicSemanticCommitPlan(translations, 10, 39, 100, 8);

  assert.equal(plan.commitThrough, 14);
  assert.equal(plan.carryStart, 15);
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(plan.units, (entry) => entry.members))),
    [[10, 11, 12, 13, 14]]);
});

test("the final hard-boundary window flushes its complete tail without a guard", () => {
  const translations = [
    ...unit(90, 96),
    ...unit(97, 100)
  ];
  const plan = shared.monotonicSemanticCommitPlan(translations, 90, 100, 100, 16);

  assert.equal(plan.guardStart, 101);
  assert.equal(plan.commitThrough, 100);
  assert.equal(plan.carryStart, 101);
});

test("random access discards the left-edge unit and commits a safe interior island", () => {
  const translations = [
    ...unit(4389, 4397, "左侧只读上下文"),
    ...unit(4398, 4410, "接触左保护区，不能提交"),
    ...unit(4411, 4475, "包含当前播放位置的完整安全单元"),
    ...unit(4476, 4495, "接触右保护区，留到下次")
  ];
  const plan = shared.monotonicSemanticCommitPlan(
    translations, 4389, 4495, 6000, 16, 4405
  );

  assert.equal(plan.commitStart, 4411);
  assert.equal(plan.commitThrough, 4475);
  assert.equal(plan.carryStart, 4476);
  assert.ok(plan.translations.some((item) => Number(item.id) === 4469));
  assert.ok(plan.translations.every((item) => Number(item.id) >= 4411 && Number(item.id) <= 4475));
});

test("ordinary prefix mode still refuses a response missing its first id", () => {
  const plan = shared.monotonicSemanticCommitPlan(
    [...unit(2, 20)], 0, 47, 100, 16
  );
  assert.equal(plan.commitThrough, -1);
  assert.deepEqual(Array.from(plan.translations), []);
});

test("speculative prefetch cannot steal the active playback safety island", () => {
  const state = { cursor: 4416, commitFloor: 4416, limitEnd: 22605 };
  assert.equal(shared.shouldReseedSemanticCommitState(
    true, 4576, state, 144, false, true
  ), false);
});

test("an urgent random-access target can relocate the safety island", () => {
  const state = { cursor: 4496, commitFloor: 4512, limitEnd: 22605 };
  assert.equal(shared.shouldReseedSemanticCommitState(
    true, 4481, state, 144, true, true
  ), true);
});

test("gap prewarming can relocate an idle safety island", () => {
  const state = { cursor: 0, commitFloor: 0, limitEnd: 22605 };
  assert.equal(shared.shouldReseedSemanticCommitState(
    true, 13520, state, 144, false, false
  ), true);
});

test("urgent request sizing ignores a farther speculative target but preserves throughput", () => {
  const state = {
    cursor: 4416, windowItems: 80, urgentTarget: 4447, targetThrough: 4575
  };
  assert.deepEqual(JSON.parse(JSON.stringify(
    shared.semanticCommitRequestPlan(state, 4416, 16, 160, true, 96, 48)
  )), {
    targetThrough: 4447,
    itemCount: 96
  });
});

test("non-urgent continuation still consumes the requested preload range", () => {
  const state = {
    cursor: 4416, windowItems: 80, urgentTarget: 4447, targetThrough: 4575
  };
  assert.deepEqual(JSON.parse(JSON.stringify(
    shared.semanticCommitRequestPlan(state, 4416, 16, 160, false)
  )), {
    targetThrough: 4575,
    itemCount: 160
  });
});

test("guard-crossing recovery expansion is not clamped back to the cold window", () => {
  const state = {
    cursor: 4743, windowItems: 80, urgentTarget: 4753, targetThrough: 4831
  };
  assert.deepEqual(JSON.parse(JSON.stringify(
    shared.semanticCommitRequestPlan(state, 4743, 16, 160, true, 96, 48)
  )), {
    targetThrough: 4753,
    itemCount: 80
  });
});

test("first urgent window covers the visible target without absorbing speculative preload", () => {
  const state = {
    cursor: 4416, windowItems: 48, urgentTarget: 4495, targetThrough: 4575
  };
  assert.deepEqual(JSON.parse(JSON.stringify(
    shared.semanticCommitRequestPlan(state, 4416, 16, 160, true, 96, 48)
  )), {
    targetThrough: 4495,
    itemCount: 144
  });
});

test("urgent window can expand after an unsafe prefix while remaining globally bounded", () => {
  const state = {
    cursor: 4416, windowItems: 128, urgentTarget: 4495, targetThrough: 4575
  };
  assert.deepEqual(JSON.parse(JSON.stringify(
    shared.semanticCommitRequestPlan(state, 4416, 16, 160, true, 96, 48)
  )), {
    targetThrough: 4495,
    itemCount: 144
  });
});

test("an urgent seek leaves semantic runway after the visible target", () => {
  const state = {
    cursor: 1317, windowItems: 48, urgentTarget: 1381, targetThrough: 1397
  };
  const request = shared.semanticCommitRequestPlan(
    state, 1317, 16, 160, true, 96, 48
  );
  const requestEnd = 1317 + request.itemCount - 1;
  const translations = [
    ...unit(1317, 1331),
    ...unit(1332, 1373),
    ...unit(1374, 1396),
    ...unit(1397, 1414)
  ];
  const plan = shared.monotonicSemanticCommitPlan(
    translations, 1317, requestEnd, 2000, 16, 1333
  );

  assert.equal(request.itemCount, 129);
  assert.ok(plan.guardStart > 1396);
  assert.ok(plan.units.some((entry) =>
    entry.members[0] === 1374 && entry.members.at(-1) === 1396
  ));
  assert.ok(plan.translations.some((item) => Number(item.id) === 1381));
});

test("random segmentations never split a unit or commit inside the guard", () => {
  let seed = 0x3255;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let run = 0; run < 500; run++) {
    const requestEnd = 79;
    const guardStart = 64;
    const translations = [];
    const boundaries = [];
    let cursor = 0;
    while (cursor <= requestEnd) {
      const last = Math.min(requestEnd, cursor + Math.floor(random() * 12));
      translations.push(...unit(cursor, last, `t${cursor}`));
      boundaries.push({ first: cursor, last });
      cursor = last + 1;
    }
    const plan = shared.monotonicSemanticCommitPlan(
      translations, 0, requestEnd, 200, 16
    );
    const expected = boundaries.filter((entry) => entry.last < guardStart);
    assert.deepEqual(Array.from(plan.units, (entry) => ({
      first: entry.members[0], last: entry.members[entry.members.length - 1]
    })), expected);
    assert.ok(plan.commitThrough < guardStart);
    assert.equal(plan.carryStart, plan.commitThrough + 1);
  }
});

test("random aligned-chunk recovery preserves exact coverage and the trailing guard", () => {
  let seed = 0x8f29c4d1;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let run = 0; run < 500; run++) {
    const requestEnd = 159;
    const translations = unit(0, requestEnd, "oversized");
    const chunks = [];
    let cursor = 0;
    while (cursor <= requestEnd) {
      const last = Math.min(requestEnd, cursor + 1 + Math.floor(random() * 23));
      chunks.push({
        ids: Array.from({ length: last - cursor + 1 }, (_value, offset) =>
          String(cursor + offset)),
        translation: `chunk-${cursor}`
      });
      cursor = last + 1;
    }
    translations[0].alignedChunks = chunks;
    const recovered = shared.semanticUnitsFromAlignedChunks(translations);
    const plan = shared.monotonicSemanticCommitPlan(recovered, 0, requestEnd, 500, 16);
    const expected = chunks
      .map((chunk) => [Number(chunk.ids[0]), Number(chunk.ids.at(-1))])
      .filter((range) => range[1] < plan.guardStart);

    assert.deepEqual(Array.from(plan.units, (entry) => [
      entry.members[0], entry.members[entry.members.length - 1]
    ]), expected, `recovery boundaries changed at seed run ${run}`);
    assert.equal(recovered.length, requestEnd + 1);
    assert.deepEqual(Array.from(recovered, (item) => Number(item.id)),
      Array.from({ length: requestEnd + 1 }, (_value, id) => id));
    assert.ok(plan.commitThrough < plan.guardStart);
  }
});
