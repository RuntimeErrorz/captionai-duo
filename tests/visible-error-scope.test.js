"use strict";

// A failed request's error belongs to the lines it was translating. A real
// log showed a format error from a request for lines 0-319 painted over a
// seek target at line 1596 of the same region.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const root = path.resolve(__dirname, "..");

function loadDisplay() {
  const context = {
    Map, Set, YTDS_SHARED: loadShared(), settings: {}, t: (_key, fallback) => fallback,
    captionSession: {
      semanticGroupToCommitRegion: new Array(2000).fill(0),
      semanticExhaustedRegions: new Map(), semanticVisibleErrors: new Map()
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "content/display.js"), "utf8"), context, { filename: "content/display.js" });
  return context;
}

test("a request's error shows only at the lines it covered", () => {
  const context = loadDisplay();
  const update = vm.runInContext("aiUpdateDisplayError", context);
  const errorFor = vm.runInContext("aiDisplayErrorFor", context);
  update(0, { requestStart: 0, requestEnd: 319 }, null,
    { ok: true, errorCode: "AI_JSONL_INVALID", error: "unexpected JSONL position 78 at offset 66" });
  assert.equal(errorFor(66).errorCode, "AI_JSONL_INVALID");
  assert.equal(errorFor(319).errorCode, "AI_JSONL_INVALID");
  assert.equal(errorFor(1596), null, "a seek target outside the failed range shows no error");
});

test("a region that gave up shows its error everywhere in the region", () => {
  const context = loadDisplay();
  context.captionSession.semanticExhaustedRegions.set(0, { start: 0, end: 319, errorCode: "AI_OUTPUT_EXHAUSTED" });
  const errorFor = vm.runInContext("aiDisplayErrorFor", context);
  assert.equal(errorFor(1596).errorCode, "AI_OUTPUT_EXHAUSTED");
});
