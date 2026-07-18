"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();

function cue(id, text, start, end) {
  return { id: String(id), text, start, end, dur: end - start, lastOff: end };
}

test("business end of the sport is not cut at the preferred six-cue boundary", () => {
  const cues = [
    cue(241, ">> It's a good question. You know, I don't", 441919, 445520),
    cue(242, "know what his contract is. I don't know", 443919, 446960),
    cue(243, "how it works. I don't know what the most", 445520, 448960),
    cue(244, "anyone's ever I try not to pay attention", 446960, 450319),
    cue(245, "to that stuff", 448960, 452720),
    cue(246, ">> because I'm not on the business end of", 450319, 453440),
    cue(247, "the sport.", 452720, 454560),
    cue(248, ">> It kind of color your perception a", 453440, 455199),
    cue(249, "little bit.", 454560, 458000),
    cue(250, ">> It can.", 455199, 459919)
  ];

  const windows = shared.semanticBatchWindows(cues, 6, 10);
  assert.equal(windows[0].start, 0);
  assert.equal(windows[0].end, 6);
  assert.equal(cues[windows[0].end].text, "the sport.");
  assert.ok(windows.every((window) => window.end - window.start + 1 <= 10));
});

test("batch windows still stop at a natural boundary inside six cues", () => {
  const cues = [
    cue(0, "This is", 0, 1000),
    cue(1, "one sentence.", 900, 1800),
    cue(2, "This is", 1700, 2600),
    cue(3, "another", 2500, 3400),
    cue(4, "sentence.", 3300, 4200),
    cue(5, "Next", 4100, 5000),
    cue(6, "thought.", 4900, 5800)
  ];

  assert.deepEqual(JSON.parse(JSON.stringify(shared.semanticBatchWindows(cues, 6, 10))), [
    { start: 0, end: 4 },
    { start: 5, end: 6 }
  ]);
});

test("a long timing pause remains a hard request boundary", () => {
  const cues = [
    cue(0, "one", 0, 900),
    cue(1, "two", 800, 1700),
    cue(2, "three", 1600, 2500),
    cue(3, "four", 2400, 3300),
    cue(4, "five", 3200, 4100),
    cue(5, "thought ends without punctuation", 4000, 4900),
    cue(6, "new thought", 7000, 7900),
    cue(7, "continues.", 7800, 8700)
  ];

  const windows = shared.semanticBatchWindows(cues, 6, 10);
  assert.equal(windows[0].end, 5);
  assert.equal(windows[1].start, 6);
});

test("batch planning covers randomized cue timelines exactly once", () => {
  let state = 0x8f7011ee;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };

  for (let run = 0; run < 500; run++) {
    const count = 1 + Math.floor(random() * 80);
    let start = 0;
    const cues = Array.from({ length: count }, (_value, index) => {
      const duration = 600 + Math.floor(random() * 1800);
      const gap = Math.floor(random() * 400);
      const text = `cue ${index}${random() < 0.18 ? "." : " continues"}`;
      const value = cue(index, text, start, start + duration);
      start += Math.max(100, duration - Math.floor(random() * 500)) + gap;
      return value;
    });
    const windows = shared.semanticBatchWindows(cues, 6, 10);
    const covered = windows.flatMap((window) =>
      Array.from({ length: window.end - window.start + 1 }, (_v, i) => window.start + i));

    assert.deepEqual(Array.from(covered), Array.from({ length: count }, (_v, i) => i));
    assert.ok(windows.every((window) => window.start <= window.end));
    assert.ok(windows.every((window) => window.end - window.start + 1 <= 10));
  }
});

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
