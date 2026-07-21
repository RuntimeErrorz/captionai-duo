"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();
const lengthMeasure = (text) => String(text).length;

function pageForMember(plan, memberIndex) {
  const page = plan.assignments[memberIndex];
  return {
    source: plan.sourcePages[page] && plan.sourcePages[page].text,
    translation: plan.translationPages[page] && plan.translationPages[page].text
  };
}

test("Friday-night cross-cue phrase remains on one visible page", () => {
  const plan = shared.semanticDisplayPlan(
    "You can cook in here. You can make a mess. You can leave it a mess on a Friday night and not worry about it, but it's also got that awesome flow.",
    "你可以在这里做饭。你可以弄得一团糟。周五晚上把这里弄乱也不用担心，而且动线也很棒。",
    [
      "You can cook in here. You can make a mess. You can leave it a mess on a",
      "Friday night and not worry about it, but it's also got",
      "that awesome flow."
    ],
    2,
    lengthMeasure,
    lengthMeasure
  );
  const friday = pageForMember(plan, 1);
  assert.match(friday.source, /on a Friday night/);
  assert.match(friday.translation, /周五晚上/);
});

test("fullscreen Westside Highway page stays paired with its translation", () => {
  const source = "notice this little space where I told you guys to pause the frame? This is a dead space. It's not even in line with your bar. Now, if you would place the closet over here, you would have an outdoor closet for your guest or for your winter jackets in summertime to hold over here. Imagine waking up and putting on your running shoes and going for a run across the street up and down the Westside Highway. How amazing is that? Getting on your bike and going to";
  const translation = "注意到我让你们暂停画面的这个小空间了吗？这是一个死空间，甚至与你的吧台不在一条线上。现在，如果你把衣柜放在这里，你就有了一个户外衣柜，供客人或冬季外套在夏天存放。想象一下，醒来后穿上跑鞋，穿过街道，在西区高速公路上来回奔跑。这有多棒？骑上自行车去";
  const members = [
    "notice this little space where I told you guys to pause the frame?",
    "This is a dead space. It's not even in line with your bar.",
    "Now, if you would place the closet over here, you would have an outdoor closet for your guest or for",
    "your winter jackets in summertime to hold over here. Imagine waking up and",
    "putting on your running shoes and going for a run across the street up and down",
    "the Westside Highway. How amazing is that? Getting on your bike and going to"
  ];
  const plan = shared.semanticDisplayPlan(source, translation, members, 4, lengthMeasure, lengthMeasure);
  const highway = pageForMember(plan, 4);
  assert.match(highway.source, /Westside Highway/);
  assert.match(highway.translation, /西区高速公路上来回奔跑/);
});

test("dwell translation follows a 3-source-to-2-target sentence merge", () => {
  const plan = shared.semanticDisplayPlan(
    ">> But my job is to analyze and commentate and give life to what's happening inside the octagon. And I try not to dwell too much on the money. I just want them",
    ">> 但我的工作只是分析、评论并为八角笼内发生的事情增添活力。我尽量不过多纠结于钱，我只希望他们",
    [
      ">> But my job is to analyze",
      "and commentate and give life",
      "to what's happening inside the octagon.",
      "And I try not to dwell",
      "too much on the money.",
      "I just want them"
    ],
    2,
    lengthMeasure,
    lengthMeasure
  );
  const dwell = pageForMember(plan, 3);
  assert.match(dwell.source, /dwell too much on the money/);
  assert.match(dwell.translation, /纠结于钱/);
});

test("J.D. Vance remains indivisible when an oversized model chunk falls back to pagination", () => {
  const source = "Let's move on to someone in the West Wing who's slightly less important than the prompter guy, J.D. Vance, vice president and the weak link in your improv group.";
  const translation = "我们换个话题，问一个西翼的人，一个比提词器小哥还稍微不重要的人，J.D. 万斯，副总统，也是你们即兴表演小组的薄弱环节。";
  const members = [
    "Let's move on to someone in the West",
    "Wing who's slightly less important than",
    "the prompter guy, J.D. Vance, vice",
    "president and the weak link in your",
    "improv group."
  ];
  const plan = shared.semanticDisplayPlan(
    source, translation, members, 2, lengthMeasure, lengthMeasure, "en", "zh-CN"
  );
  const sourcePages = Array.from(plan.sourcePages, (page) => page.text);
  const translationPages = Array.from(plan.translationPages, (page) => page.text);

  assert.equal(sourcePages.length, 2);
  assert.ok(sourcePages.some((page) => page.includes("J.D. Vance")), JSON.stringify(sourcePages));
  assert.ok(translationPages.some((page) => page.includes("J.D. 万斯")), JSON.stringify(translationPages));
  assert.ok(sourcePages.every((page) => !/\bJ\.$|^D\.\s+Vance/.test(page)), JSON.stringify(sourcePages));
  assert.equal(sourcePages.join(" "), source);
  assert.equal(translationPages.join(""), translation);
});

test("display pagination protects lexical punctuation shapes without phrase exceptions", () => {
  const cases = [
    ["A long introduction before J. D. Vance and several words after the complete name.", "J. D. Vance"],
    ["A long introduction before JD Vance and several words after the complete name.", "JD Vance"],
    ["A long introduction before the Ph.D. researcher and several words after the title.", "Ph.D."],
    ["The measured value before calibration is 3.14159 and the experiment continues afterward.", "3.14159"],
    ["The currently installed release is v3.25.3 and every existing setting remains compatible.", "v3.25.3"],
    ["Send the detailed report to person@example.com and retain a local archived copy afterward.", "person@example.com"],
    ["Open https://example.com/a.b/c and compare the documented result with the local result afterward.", "https://example.com/a.b/c"]
  ];

  for (const [text, token] of cases) {
    const pages = shared.splitTextForDisplay(text, 2, lengthMeasure, "en");
    assert.equal(pages.length, 2, JSON.stringify({ text, pages }));
    assert.ok(pages.some((page) => page.text.includes(token)), JSON.stringify({ token, pages }));
    assert.equal(pages.map((page) => page.text).join(" "), text);
  }
});

test("Chinese word remains indivisible when an oversized chunk is split by pixel width", () => {
  const text = "CLE 是那些出售杠杆的人在他们刚刚装满烟花的建筑物需要撤离时所购买的火灾保险。";
  const cjkDoubleWidth = (value) => Array.from(String(value)).reduce((width, character) =>
    width + (/[⺀-鿿]/.test(character) ? 2 : 1), 0);
  const pages = shared.splitTextForDisplay(text, 2, cjkDoubleWidth, "zh-CN");

  assert.equal(pages.length, 2, JSON.stringify(pages));
  assert.ok(pages.some((page) => page.text.includes("烟花")), JSON.stringify(pages));
  assert.ok(pages.every((page) => !page.text.endsWith("烟") && !page.text.startsWith("花")),
    JSON.stringify(pages));
  assert.equal(pages.map((page) => page.text).join(""), text);
});

test("a truly oversized word falls back to grapheme-safe pagination", () => {
  const familyEmoji = "👨‍👩‍👧‍👦";
  const text = "x".repeat(16) + familyEmoji + "x".repeat(16);
  const pages = shared.splitTextForDisplay(text, 3, lengthMeasure, "en");

  assert.equal(pages.length, 3, JSON.stringify(pages));
  assert.ok(pages.every((page) => page.text.length > 0));
  assert.ok(pages.some((page) => page.text.includes(familyEmoji)), JSON.stringify(pages));
  assert.equal(pages.map((page) => page.text).join(""), text);
});

test("a cue crossing a page boundary advances so no boundary word is orphaned", () => {
  const plan = shared.semanticDisplayPlan(
    "and to see what's going on and to commentate and try to give color and life to what's happening inside the octagon. And I don't I try not to dwell",
    "并观察情况，进行评论，尝试为八角笼内发生的事情增添色彩和活力。我尽量不",
    [
      "and to see what's going on and to commentate and try to give color and",
      "life to what's happening inside the octagon. And I don't I try not to dwell"
    ],
    2,
    lengthMeasure,
    lengthMeasure
  );
  assert.deepEqual(Array.from(plan.assignments), [0, 1]);
  const second = pageForMember(plan, 1);
  assert.match(second.source, /\bdwell\b/);
  assert.match(second.translation, /我尽量不/);
});

test("one semantic unit remains continuously visible across a non-hard raw cue hole", () => {
  const previous = { start: 273759, end: 276759 };
  const next = { start: 279600, end: 282919 };
  assert.equal(shared.shouldBridgeSemanticCueGap(
    previous, next, 276784, "semantic-545-547", "semantic-545-547", true
  ), true, "a 2841ms soft boundary must not clear and repaint one semantic page");
  assert.equal(shared.shouldBridgeSemanticCueGap(
    previous, next, 276784, "semantic-545", "semantic-546", true
  ), false, "distinct semantic units must remain distinct even across a short hole");
  assert.equal(shared.shouldBridgeSemanticCueGap(
    previous, next, 276784, "same", "same", false
  ), false, "a hard semantic boundary must never be bridged");
  assert.equal(shared.shouldBridgeSemanticCueGap(
    previous, next, 279600, "same", "same", true
  ), false, "the bridge applies only inside the raw cue hole");
});

test("semantic gap continuity depends on semantic ownership, not raw gap duration", () => {
  let state = 0x47c2a91d;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };

  for (let run = 0; run < 500; run++) {
    const previousEnd = Math.floor(random() * 60 * 60 * 1000);
    const gap = 1 + Math.floor(random() * 12000);
    const nextStart = previousEnd + gap;
    const time = previousEnd + Math.floor(random() * gap);
    const sameUnit = random() < 0.5;
    const boundaryOpen = random() < 0.5;
    const previousUnit = "unit-a";
    const nextUnit = sameUnit ? previousUnit : "unit-b";

    assert.equal(shared.shouldBridgeSemanticCueGap(
      { start: previousEnd - 1000, end: previousEnd },
      { start: nextStart, end: nextStart + 1000 },
      time,
      previousUnit,
      nextUnit,
      boundaryOpen
    ), sameUnit && boundaryOpen, `timeline invariant failed for seed run ${run}`);
  }
});

test("an imperceptible tail unit is co-displayed with the preceding unit from the same cue", () => {
  const groups = [
    { startIdx: 525, start: 1088560, end: 1088800 },
    { startIdx: 525, start: 1088800, end: 1089300 },
    { startIdx: 525, start: 1089300, end: 1089700 },
    { startIdx: 525, start: 1089700, end: 1089914 },
    { startIdx: 525, start: 1089914, end: 1090160 }
  ];
  const clusters = shared.semanticDisplayClusters([
    { unitId: "semantic-3365-3368", members: [0, 1, 2, 3] },
    { unitId: "semantic-3369-3369", members: [4] }
  ], groups, 650);

  assert.equal(clusters.length, 1);
  assert.deepEqual(Array.from(clusters[0].unitIds),
    ["semantic-3365-3368", "semantic-3369-3369"]);
  assert.deepEqual(Array.from(clusters[0].members), [0, 1, 2, 3, 4]);
  assert.equal(clusters[0].smoothed, true);
});

test("display smoothing never merges semantic units across raw cues", () => {
  const clusters = shared.semanticDisplayClusters([
    { unitId: "answer", members: [0] },
    { unitId: "next-speaker", members: [1] }
  ], [
    { startIdx: 7, start: 1000, end: 1200 },
    { startIdx: 8, start: 1200, end: 1450 }
  ], 650);

  assert.equal(clusters.length, 2);
  assert.deepEqual(Array.from(clusters, (cluster) => Array.from(cluster.unitIds)),
    [["answer"], ["next-speaker"]]);
});

test("a short leading unit is co-displayed forward within its raw cue", () => {
  const clusters = shared.semanticDisplayClusters([
    { unitId: "short", members: [0] },
    { unitId: "complete", members: [1, 2] }
  ], [
    { startIdx: 12, start: 2000, end: 2200 },
    { startIdx: 12, start: 2200, end: 2800 },
    { startIdx: 12, start: 2800, end: 3500 }
  ], 650);

  assert.equal(clusters.length, 1);
  assert.deepEqual(Array.from(clusters[0].members), [0, 1, 2]);
});

test("display planning preserves structural invariants across randomized timelines", () => {
  let state = 0x6d2b79f5;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };

  for (let run = 0; run < 500; run++) {
    const memberCount = 2 + Math.floor(random() * 9);
    const pageCount = 1 + Math.floor(random() * memberCount);
    const sourceSentences = Array.from({ length: memberCount }, (_v, i) =>
      `Sentence ${i} has token ${Math.floor(random() * 10000)}.`);
    const targetSentences = Array.from({ length: memberCount }, (_v, i) =>
      `译文${i}包含词语${Math.floor(random() * 10000)}。`);
    const source = sourceSentences.join(" ");
    const translation = targetSentences.join("");
    const plan = shared.semanticDisplayPlan(
      source, translation, sourceSentences, pageCount, lengthMeasure, lengthMeasure
    );

    assert.equal(plan.sourcePages.length, pageCount);
    assert.equal(plan.translationPages.length, pageCount);
    assert.equal(plan.assignments.length, memberCount);
    assert.ok(plan.sourcePages.every((page) => page.text.length > 0));
    assert.ok(plan.translationPages.every((page) => page.text.length > 0));
    assert.ok(plan.assignments.every((page) => page >= 0 && page < pageCount));
    for (let i = 1; i < plan.assignments.length; i++) {
      assert.ok(plan.assignments[i] >= plan.assignments[i - 1]);
    }
    assert.deepEqual([...new Set(plan.assignments)], Array.from({ length: pageCount }, (_v, i) => i));
    assert.equal(plan.sourcePages.map((page) => page.text).join(" "), source);
    assert.equal(plan.translationPages.map((page) => page.text).join(""), translation);
  }
});
