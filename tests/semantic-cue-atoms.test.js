"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();

test("YouTube seg offsets become addressable lexical references with real timing", () => {
  const cue = {
    text: "as the global economy becomes worse",
    start: 324000,
    end: 328720,
    dur: 4720,
    parts: [
      { text: "as ", offsetMs: 0 },
      { text: "the ", offsetMs: 380 },
      { text: "global ", offsetMs: 720 },
      { text: "economy ", offsetMs: 1310 },
      { text: "becomes ", offsetMs: 2210 },
      { text: "worse", offsetMs: 3370 }
    ]
  };
  const atoms = shared.cueReferenceAtoms([cue]);

  assert.deepEqual(Array.from(atoms, (atom) => atom.text),
    ["as", "the", "global", "economy", "becomes", "worse"]);
  assert.deepEqual(Array.from(atoms, (atom) => Math.round(atom.start)),
    [324000, 324380, 324720, 325310, 326210, 327370]);
  assert.ok(atoms.every((atom) => atom.timed === true));
  assert.equal(atoms[atoms.length - 1].end, cue.end);
});

test("manual cues get generic lexical coordinates without semantic splitting", () => {
  const atoms = shared.cueReferenceAtoms([
    { text: "from 16 to 79. I have a very extensive", start: 1000, end: 5000, dur: 4000 }
  ]);
  assert.deepEqual(Array.from(atoms, (atom) => atom.text),
    ["from", "16", "to", "79.", "I", "have", "a", "very", "extensive"]);
  assert.ok(atoms.every((atom) => atom.timed === false));
  assert.ok(atoms.every((atom, index) => !index || atom.start > atoms[index - 1].start));
});

test("CJK cues without spaces still expose contiguous reference coordinates", () => {
  const atoms = shared.cueReferenceAtoms([
    { text: "全球经济越来越糟。权力会变化。", start: 0, end: 4000, dur: 4000 }
  ]);
  assert.ok(atoms.length > 2);
  assert.equal(shared.mergeTimedCueTexts(atoms), "全球经济越来越糟。权力会变化。");
  assert.equal(atoms.map((atom) => atom.text).join(""), "全球经济越来越糟。权力会变化。");
});

test("lexical density is bounded by transport item limits", () => {
  const cues = [
    [">> I did receive approximately 140 marriage", 635400, 640839],
    ["proposals. I had a wide range of men", 637920, 643200],
    ["filling out the form. The ages ranged", 640839, 646960],
    ["from 16 to 79. I have a very extensive", 643200, 648960],
    ["website. I even list my cup size on", 646960, 649400],
    ["there.", 648960, 649640]
  ].map(([text, start, end]) => ({ text, start, end, dur: end - start, lastOff: end }));
  const atoms = shared.cueReferenceAtoms(cues);
  const windows = shared.referenceBatchWindows(
    cues, atoms, 0, 0, true, { coreItems: 12, requestItems: 18 }
  );

  assert.ok(windows.length > 1);
  assert.ok(windows.every((window) => window.end - window.start + 1 <= 12));
  assert.ok(windows.every((window) => window.requestEnd - window.requestStart + 1 <= 18));
  assert.deepEqual(Array.from(windows.flatMap((window) =>
    Array.from({ length: window.end - window.start + 1 }, (_v, offset) => window.start + offset)
  )), Array.from({ length: atoms.length }, (_v, index) => index));
});

test("overlapping request windows preserve the configured lexical core", () => {
  const cues = [
    { text: "provisions.", start: 0, end: 1000, dur: 1000 },
    { text: "No tax on tips, no tax on", start: 1000, end: 2000, dur: 1000 },
    { text: "overtime, and no tax on social security", start: 2000, end: 3000, dur: 1000 },
    { text: "for our great seniors.", start: 3000, end: 4000, dur: 1000 }
  ];
  const atoms = shared.cueReferenceAtoms(cues);
  const windows = shared.referenceBatchWindows(
    cues, atoms, 0, 0, true, { coreItems: 8, requestItems: 16 }
  );

  assert.equal(windows.length, 3);
  assert.equal(windows[0].end, 7);
  assert.equal(windows[0].requestEnd, 15);
  assert.equal(windows[1].start, 8);
  assert.equal(windows[1].requestStart, 8);

});

test("loading scope remains stable while fast lexical tokens advance inside one batch", () => {
  const groupToBatch = [];
  for (let group = 2062; group <= 2120; group++) groupToBatch[group] = 31;
  for (let group = 2121; group <= 2155; group++) groupToBatch[group] = 32;

  const first = shared.pendingTranslationScopeKey(2062, groupToBatch);
  for (let group = 2063; group <= 2120; group++) {
    assert.equal(shared.pendingTranslationScopeKey(group, groupToBatch), first);
  }
  assert.equal(first, "deepseek-batch:31");
  assert.equal(
    shared.pendingTranslationScopeKey(2121, groupToBatch),
    "deepseek-batch:32"
  );
});

test("lexical references preserve randomized cue text, order, timing and batch coverage", () => {
  let seed = 0x323c0de;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let run = 0; run < 150; run++) {
    const cueCount = 1 + Math.floor(random() * 18);
    const cues = [];
    let cursor = 0;
    for (let cueIndex = 0; cueIndex < cueCount; cueIndex++) {
      const wordCount = 1 + Math.floor(random() * 10);
      const words = Array.from({ length: wordCount }, (_, wordIndex) =>
        `w${cueIndex}_${wordIndex}${wordIndex === wordCount - 1 && random() < 0.35 ? "." : ""}`);
      const dur = 600 + wordCount * 170 + Math.floor(random() * 900);
      const parts = words.map((word, wordIndex) => ({
        text: `${word}${wordIndex + 1 < wordCount ? " " : ""}`,
        offsetMs: Math.floor(wordIndex * dur / wordCount)
      }));
      cues.push({ text: words.join(" "), start: cursor, end: cursor + dur, dur, parts });
      cursor += dur + Math.floor(random() * 500);
    }

    const atoms = shared.cueReferenceAtoms(cues);
    assert.ok(atoms.length >= cues.length);
    for (let cueIndex = 0; cueIndex < cues.length; cueIndex++) {
      const members = atoms.filter((atom) => atom.sourceCueIndex === cueIndex);
      assert.equal(shared.mergeTimedCueTexts(members), cues[cueIndex].text);
      assert.equal(members[members.length - 1].end, cues[cueIndex].end);
      assert.ok(members.every((atom) => atom.start >= cues[cueIndex].start &&
        atom.end <= cues[cueIndex].end && atom.start <= atom.end));
      assert.ok(members.every((atom, index) => !index || atom.start >= members[index - 1].start));
    }
    const windows = shared.referenceBatchWindows(
      cues, atoms, 0, 0, true, { coreItems: 32, requestItems: 48 }
    );
    const covered = Array.from(windows).flatMap((window) =>
      Array.from({ length: window.end - window.start + 1 }, (_, offset) => window.start + offset));
    assert.deepEqual(covered, Array.from({ length: atoms.length }, (_, index) => index));
    assert.ok(windows.every((window) => window.end - window.start + 1 <= 32));
    assert.ok(windows.every((window) => window.requestEnd - window.requestStart + 1 <= 48));
  }
});

test("rolling cue overlap is normalized before lexical timing is estimated", () => {
  const cues = [
    { text: "stronger, and far wealthier than it has", start: 10719, end: 17279 },
    { text: "ever been before. We are doing great.", start: 14080, end: 20000 },
    { text: "Less than two years ago, we inherited an", start: 17279, end: 23199 }
  ];
  const atoms = shared.cueReferenceAtoms(cues);
  const middle = atoms.filter((atom) => atom.sourceCueIndex === 1);
  const next = atoms.filter((atom) => atom.sourceCueIndex === 2);
  const we = middle.find((atom) => atom.text === "We");

  assert.equal(shared.mergeTimedCueTexts(middle), cues[1].text);
  assert.equal(middle[middle.length - 1].end, cues[2].start);
  assert.equal(next[0].start, cues[2].start);
  assert.ok(we.start < 16000);
  assert.ok(cues[2].start - we.start > 1500);
  assert.ok(middle.every((atom) => atom.start >= cues[1].start && atom.end <= cues[2].start));
});

test("DeepSeek can align worse and worse across original cue boundaries", () => {
  const cues = [
    { text: "as the global economy becomes worse", start: 0, end: 4000, dur: 4000 },
    { text: "and worse, power will become much more", start: 3000, end: 7000, dur: 4000 },
    { text: "dependent on China.", start: 6000, end: 9000, dur: 3000 }
  ];
  const atoms = shared.cueReferenceAtoms(cues);
  const items = Array.from(atoms, (atom, index) => ({
    id: String(index),
    text: atom.text,
    startMs: atom.start,
    endMs: atom.end,
    hardAfter: false
  }));
  const worse = items.findIndex((item) => item.text === "worse");
  const secondWorse = items.findIndex((item, index) => index > worse && item.text === "worse,");
  const chunks = [
    { ids: items.slice(0, secondWorse + 1).map((item) => item.id), translation: "随着全球经济变得越来越糟，" },
    { ids: items.slice(secondWorse + 1).map((item) => item.id), translation: "权力将更加依赖中国。" }
  ];
  const response = JSON.stringify({ segments: [{ ids: items.map((item) => item.id), chunks }] });
  const parsed = shared.alignedTranslationsFromJsonText(response, items, "zh-CN");

  assert.ok(parsed);
  assert.ok(chunks[0].ids.includes(String(worse)));
  assert.ok(chunks[0].ids.includes(String(secondWorse)));
  assert.deepEqual(Array.from(parsed[0].alignedChunks[0].ids), chunks[0].ids);
});
