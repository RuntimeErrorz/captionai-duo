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
    '```json\n{"segments":[{"start":0,"end":2,"translation":"周五晚上弄乱也不用担心。"}]}\n```',
    items
  );
  assert.equal(output.length, 3);
  assert.equal(output[0].unitId, "semantic-42-44");
});

test("semantic fallback rejects legacy ids fields anywhere in the response", () => {
  const diagnostics = {};
  const output = shared.segmentedTranslationsFromJsonText(
    JSON.stringify({
      segments: [{ start: 0, end: 2, translation: "旧协议" }],
      deferred_ids: []
    }),
    items,
    diagnostics
  );
  assert.equal(output, null);
  assert.match(diagnostics.reason, /legacy ids arrays are not supported/);
});

test("semantic response rejects omissions, reordering and hard-boundary crossings with diagnostics", () => {
  for (const [response, currentItems, reason] of [
    [{ segments: [{ start: 0, end: 0, translation: "漏项" }] }, items, /missing cue coverage/],
    [{ segments: [{ start: 1, end: 2, translation: "乱序" }] }, items, /unexpected (?:JSONL )?position/],
    [{ segments: [{ start: 0, end: 1, translation: "越界" }, { start: 2, end: 2, translation: "尾部" }] },
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
    { start: 0, end: 2, translation: "译文" }
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

test("semantic parser normalizes natural model translations without content heuristics", () => {
  const current = [
    { id: "295", text: "This is pretty much a", startMs: 1000, endMs: 1800, hardAfter: false },
    { id: "296", text: "10 out of 10.", startMs: 1800, endMs: 2400, hardAfter: false }
  ];
  const output = shared.segmentedTranslationsFromJsonText(
    JSON.stringify({ segments: [{
      start: 0,
      end: 1,
      translation: "这差不多是10分满分。"
    }] }),
    current
  );
  assert.equal(output.length, 2);
  assert.equal(output[0].translation, "这差不多是10分满分");
});

test("semantic fallback rejects a verbatim source phrase across languages", () => {
  const copyItems = [
    { id: "0", text: "I met", startMs: 0, endMs: 700, hardAfter: false },
    { id: "1", text: "American soldiers.", startMs: 700, endMs: 1700, hardAfter: false }
  ];
  const diagnostics = {};
  const output = shared.segmentedTranslationsFromJsonText(
    JSON.stringify({ segments: [{
      start: 0, end: 1, translation: "I met American soldiers."
    }] }),
    copyItems, diagnostics, "zh-CN", "en"
  );

  assert.equal(output, null);
  assert.match(diagnostics.reason, /untranslated source text/);
});

test("removing Chinese full stops preserves a space between adjacent sentences", () => {
  assert.equal(
    shared.normalizeTranslatedText("但在这个封闭的世界里拍摄将极其困难。声音越来越大了。"),
    "但在这个封闭的世界里拍摄将极其困难 声音越来越大了"
  );
  assert.equal(
    shared.normalizeTranslatedText("第一句。  第二句。"),
    "第一句 第二句"
  );
});
