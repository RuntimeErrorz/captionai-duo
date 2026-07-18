"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();

const items = [
  { id: "42", text: "You can leave it a mess on a", startMs: 195200, endMs: 201200, hardAfter: false },
  { id: "43", text: "Friday night and not worry about it", startMs: 199280, endMs: 207280, hardAfter: false },
  { id: "44", text: "because it has awesome flow.", startMs: 203760, endMs: 211760, hardAfter: false }
];

test("semantic response accepts exact ordered coverage and fenced JSON", () => {
  const output = shared.segmentedTranslationsFromJsonText(
    '```json\n{"segments":[{"ids":["42","43","44"],"translation":"周五晚上弄乱也不用担心。"}]}\n```',
    items
  );
  assert.equal(output.length, 3);
  assert.equal(output[0].unitId, "semantic-42-44");
});

test("semantic response rejects omissions, reordering and hard-boundary crossings with diagnostics", () => {
  for (const [response, currentItems, reason] of [
    [{ segments: [{ ids: ["42", "44"], translation: "漏项" }] }, items, /unexpected cue id/],
    [{ segments: [{ ids: ["43", "42", "44"], translation: "乱序" }] }, items, /unexpected cue id/],
    [{ segments: [{ ids: ["42", "43"], translation: "越界" }, { ids: ["44"], translation: "尾部" }] },
      [{ ...items[0], hardAfter: true }, items[1], items[2]], /hard boundary/]
  ]) {
    const diagnostics = {};
    assert.equal(shared.segmentedTranslationsFromJsonText(
      JSON.stringify(response), currentItems, diagnostics
    ), null);
    assert.match(diagnostics.reason, reason);
  }
});

test("semantic response enforces duration and source-size safety ceilings", () => {
  const response = JSON.stringify({ segments: [
    { ids: ["42", "43", "44"], translation: "译文" }
  ] });
  const durationDiagnostics = {};
  assert.equal(shared.segmentedTranslationsFromJsonText(
    response,
    [items[0], items[1], { ...items[2], endMs: items[0].startMs + 45001 }],
    durationDiagnostics
  ), null);
  assert.match(durationDiagnostics.reason, /oversized segment/);

  const sizeDiagnostics = {};
  assert.equal(shared.segmentedTranslationsFromJsonText(
    response,
    [{ ...items[0], text: "x".repeat(901) }, items[1], items[2]],
    sizeDiagnostics
  ), null);
  assert.match(sizeDiagnostics.reason, /oversized segment/);
});

test("translation quality contract rejects copied source without phrase-specific rules", () => {
  const source = "Let's move on to someone in the West Wing, J.D. Vance";
  assert.match(
    shared.translationQualityIssue(source, `${source}。`, "zh-CN", "en"),
    /matches source text/
  );
  assert.match(
    shared.translationQualityIssue(source, "We should ask another person.", "zh-CN", "en"),
    /target language script/
  );
  assert.equal(
    shared.translationQualityIssue(source, "我们换个话题，问问西翼的人——J.D. 万斯。", "zh-CN", "en"),
    ""
  );
  // Names and same-language subtitle modes are valid unchanged output.
  assert.equal(shared.translationQualityIssue("J.D. Vance", "J.D. Vance", "zh-CN", "en"), "");
  assert.equal(shared.translationQualityIssue("Same language", "Same language", "en", "en"), "");
});

test("translation quality contract protects stable facts and obvious completeness", () => {
  assert.match(
    shared.translationQualityIssue(
      "Revenue rose from 12.5% to 18%.", "收入从12.5%上升。", "zh-CN", "en"
    ),
    /numeric facts/
  );
  assert.equal(
    shared.translationQualityIssue(
      "Revenue rose from 12.5% to 18%.", "收入从12.5%上升至18%。", "zh-CN", "en"
    ),
    ""
  );
  assert.match(
    shared.translationQualityIssue(
      "Open https://example.com/docs for the full report.", "打开网站查看完整报告。", "zh-CN", "en"
    ),
    /protected token/
  );
  assert.match(
    shared.translationQualityIssue(
      "This complete sentence contains enough information to require a meaningful translation.",
      "好", "zh-CN", "en"
    ),
    /implausibly short/
  );
});

test("translation repair accepts only exact ordered units with non-copied output", () => {
  const source = "Let's move on to someone in the West Wing";
  const units = [{ unitId: "semantic-295-303", source }];
  const acceptedDiagnostics = {};
  const accepted = shared.repairedUnitTranslationsFromJsonText(
    JSON.stringify({ translations: [
      { unitId: "semantic-295-303", translation: "我们换个话题，问问西翼的人。" }
    ] }),
    units,
    "zh-CN",
    "en",
    acceptedDiagnostics
  );
  assert.equal(JSON.stringify(accepted), JSON.stringify([
    { unitId: "semantic-295-303", translation: "我们换个话题，问问西翼的人。" }
  ]));
  assert.equal(acceptedDiagnostics.reason, "");

  for (const response of [
    { translations: [{ unitId: "semantic-295-304", translation: "译文" }] },
    { translations: [{ unitId: "semantic-295-303", translation: `${source}。` }] },
    { translations: [] }
  ]) {
    const diagnostics = {};
    assert.equal(shared.repairedUnitTranslationsFromJsonText(
      JSON.stringify(response), units, "zh-CN", "en", diagnostics
    ), null);
    assert.notEqual(diagnostics.reason, "");
  }
});

test("legacy semantic parser quality-gates copied translations before commit", () => {
  const current = [
    { id: "295", text: "Let's move on", startMs: 1000, endMs: 1800, hardAfter: false },
    { id: "296", text: "to someone", startMs: 1800, endMs: 2400, hardAfter: false }
  ];
  const diagnostics = {};
  assert.equal(shared.segmentedTranslationsFromJsonText(
    JSON.stringify({ segments: [{
      ids: ["295", "296"],
      translation: "Let's move on to someone。"
    }] }),
    current,
    diagnostics,
    "zh-CN",
    "en"
  ), null);
  assert.match(diagnostics.reason, /matches source text/);
});
