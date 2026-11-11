"use strict";

// The region commit lane changes only through the shared transitions. Each
// one keeps its own rule; the forbidden-pattern guard keeps callers honest.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadShared } = require("./helpers");

const shared = loadShared();
const region = { start: 100, end: 399 };

test("a new lane starts at its region with no demand", () => {
  const state = shared.commitStateCreate(region, 320);
  assert.deepEqual({ ...state }, {
    cursor: 100, commitFloor: 100, limitEnd: 399, targetThrough: 99, urgentTarget: 99,
    lookaheadThrough: 99, windowItems: 320, recoveryWindowItems: false, noProgressRange: ""
  });
  assert.deepEqual(Array.from(shared.commitStateViolations(state, region)), []);
});

test("committing only ever moves the cursor forward", () => {
  const state = shared.commitStateCreate(region, 96);
  shared.commitStateNoProgress(state, "100:195", 320);
  assert.equal(shared.commitStateAdvance(state, 150, 96), true);
  assert.equal(state.cursor, 150);
  assert.equal(state.commitFloor, 150);
  assert.equal(state.recoveryWindowItems, false, "progress ends recovery");
  assert.equal(state.noProgressRange, "");
  for (const backwards of [150, 120, Number.NaN, "x"]) {
    assert.equal(shared.commitStateAdvance(state, backwards, 96), false);
    assert.equal(state.cursor, 150);
  }
});

test("a reseed and a focus change both drop the old focus's demand", () => {
  const state = shared.commitStateCreate(region, 96);
  shared.commitStateRaiseDemand(state, 300, 280);
  shared.commitStateExtendLookahead(state, 350);
  shared.commitStateReseed(state, 200, 216, 399, 320);
  assert.equal(state.cursor, 200);
  assert.equal(state.commitFloor, 216);
  for (const field of ["targetThrough", "urgentTarget", "lookaheadThrough"]) assert.equal(state[field], 199);

  shared.commitStateRaiseDemand(state, 300, 280);
  shared.commitStateExtendLookahead(state, 350);
  shared.commitStateDropDemand(state);
  for (const field of ["targetThrough", "urgentTarget", "lookaheadThrough"]) assert.ok(state[field] < state.cursor, field);
  assert.deepEqual(Array.from(shared.commitStateViolations(state, region)), []);
});

test("demand and lookahead only grow within a focus", () => {
  const state = shared.commitStateCreate(region, 96);
  shared.commitStateRaiseDemand(state, 250);
  shared.commitStateRaiseDemand(state, 200);
  assert.equal(state.targetThrough, 250);
  assert.equal(shared.commitStateExtendLookahead(state, 300), true);
  assert.equal(shared.commitStateExtendLookahead(state, 280), false);
  assert.equal(state.lookaheadThrough, 300);
});

test("a completed region and a skipped ledger block keep the lane valid", () => {
  const done = shared.commitStateCreate(region, 96);
  shared.commitStateComplete(done, region);
  assert.equal(done.cursor, 400);
  assert.deepEqual(Array.from(shared.commitStateViolations(done, region)), []);

  const skipped = shared.commitStateCreate(region, 96);
  assert.equal(shared.commitStateSkipCommitted(skipped, 180, 260), true);
  assert.equal(skipped.cursor, 180);
  assert.equal(skipped.limitEnd, 260);
  assert.equal(shared.commitStateSkipCommitted(skipped, 150, 399), false, "never moves back");
});

test("the violation check names broken lanes", () => {
  const bad = { ...shared.commitStateCreate(region, 96), cursor: 450, commitFloor: 90, limitEnd: 500, windowItems: 0 };
  assert.deepEqual(Array.from(shared.commitStateViolations(bad, region)).sort(),
    ["commit-floor-below-cursor", "cursor-outside-region", "empty-window", "limit-beyond-region"]);
});

test("content code never assigns lane fields directly", () => {
  const fields = "cursor|commitFloor|limitEnd|targetThrough|urgentTarget|lookaheadThrough|windowItems|recoveryWindowItems|noProgressRange";
  const assignment = new RegExp(`\\bstate\\.(${fields})\\s*=(?!=)`);
  const dir = path.join(__dirname, "..", "content");
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".js"))) {
    fs.readFileSync(path.join(dir, file), "utf8").split("\n").forEach((line, index) => {
      if (assignment.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], "use the YTDS_SHARED.commitState* transitions");
});
