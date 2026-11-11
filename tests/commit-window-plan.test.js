"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();

// Production defaults for a DeepSeek-like provider at 1x.
function plan(overrides = {}) {
  const { state: stateOverrides, ...rest } = overrides;
  return shared.semanticCommitWindowPlan({
    urgent: false, accelerated: false, requestStart: 0, limitEnd: 1000, futureStart: -1,
    guardItems: 16, minRunwayItems: 32, maxRequestItems: 320, targetTailItems: 48,
    acceleratedUrgentItems: 64, urgentRequestItems: 96, acceleratedPrefetchItems: 0,
    ...rest,
    state: { windowItems: 320, recoveryWindowItems: false, urgentTarget: -1, targetThrough: -1,
      ...(stateOverrides || {}) }
  });
}

test("a steady lookahead request uses the configured window", () => {
  const result = plan();
  assert.equal(result.requestUrgent, false);
  assert.equal(result.requestEnd, 319);
  assert.equal(result.bridgeItems, 0);
});

test("an urgent request is bounded around its visible target", () => {
  // target 10 + guard 16 + tail 48 = 75 items, raised to the 96-item urgent window.
  const result = plan({ urgent: true, state: { urgentTarget: 10 } });
  assert.equal(result.requestUrgent, true);
  assert.equal(result.targetThrough, 10);
  assert.equal(result.requestEnd, 95);

  const far = plan({ urgent: true, state: { urgentTarget: 200 } });
  assert.equal(far.requestEnd, 200 + 16 + 48);
});

test("a pending urgent target makes the request urgent without the flag", () => {
  assert.equal(plan({ requestStart: 40, state: { urgentTarget: 40 } }).requestUrgent, true);
  assert.equal(plan({ requestStart: 40, state: { urgentTarget: 39 } }).requestUrgent, false);
});

test("accelerated urgent playback drops the target tail and uses its own window", () => {
  const result = plan({ urgent: true, accelerated: true,
    state: { urgentTarget: 10, windowItems: 48 } });
  assert.equal(result.targetAwareItems, 64);
  assert.equal(result.requestEnd, 63);
});

test("a guard-recovery window may exceed the urgent window", () => {
  const result = plan({ urgent: true, state: { urgentTarget: 10, windowItems: 200, recoveryWindowItems: true } });
  assert.equal(result.requestEnd, 199);
});

test("accelerated prefetch widens only non-urgent work", () => {
  assert.equal(plan({ state: { windowItems: 64 }, acceleratedPrefetchItems: 300 }).requestEnd, 299);
  assert.equal(plan({ urgent: true, state: { windowItems: 64, urgentTarget: 0 },
    acceleratedPrefetchItems: 300 }).requestEnd, 64); // target 0 + guard 16 + tail 48
});

test("a window that reaches a live future request is cut to bridge it", () => {
  const result = plan({ futureStart: 100 });
  assert.ok(result.bridgeItems > 0);
  // The committable prefix (window minus its runway) reaches the future start.
  const runway = shared.semanticCommitRunwayItems(result.bridgeItems, 16, 32);
  assert.ok(result.bridgeItems - runway >= 100);
  assert.equal(result.requestEnd, result.bridgeItems - 1);
  // A recovery window never bridges.
  assert.equal(plan({ futureStart: 100, state: { recoveryWindowItems: true } }).bridgeItems, 0);
});

test("windows never shrink below twice the runway except at the region end", () => {
  assert.equal(plan({ state: { windowItems: 20 } }).requestEnd, 63);
  assert.equal(plan({ state: { windowItems: 20 }, limitEnd: 30 }).requestEnd, 30);
  assert.equal(plan({ limitEnd: 100 }).requestEnd, 100);
});
