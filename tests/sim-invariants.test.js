"use strict";

// Deterministic simulation of the real background + content runtime (see
// tests/sim/). Each seed is a synthetic video and a scripted user: play at
// 1-3x, seeks, scrubs, pauses, reloads and settings changes, against a fake
// provider that streams the real JSONL protocol with injected faults. The run
// fails on the first violated invariant; `npm run sim:fuzz -- --seed N`
// replays a seed with its event trace.

const test = require("node:test");
const assert = require("node:assert/strict");
const { runSeed } = require("./sim/run");

const SEEDS = 30;
const PROFILES = ["fast", "limited", "flaky"];

test(`simulated playback keeps every protocol invariant (${SEEDS} seeds)`, async () => {
  const failures = [];
  for (let i = 0; i < SEEDS; i++) {
    const seed = 1000 + i;
    const result = await runSeed(seed, { profile: PROFILES[i % PROFILES.length] });
    if (!result.ok) failures.push(`seed ${seed} [${result.profile}] ${result.invariant} ${JSON.stringify(result.detail)}`);
  }
  assert.deepEqual(failures, []);
});

test("urgent work in a later region never cancels the region playback is in", async () => {
  // Sim seed 95096: after a reload, a resumed retry for a later region
  // cancelled the visible region's writer as obsolete, which then re-sent the
  // same range (cancelled-range-resent).
  const result = await runSeed(95096, { profile: "flaky" });
  assert.equal(result.ok, true, `${result.invariant} ${JSON.stringify(result.detail)}`);
});

test("changing scheduling settings never cancels in-flight work", async () => {
  // Concurrency and RPM change how future requests are scheduled; the
  // translations already in flight stay valid (sim seed 5032 re-sent them).
  for (const seed of [11, 12, 13]) {
    const result = await runSeed(seed, {
      profile: "limited",
      // Change settings while the first requests are still in flight.
      actions: [
        { type: "play", rate: 1, ms: 300 },
        { type: "setting", key: "aiMaxConcurrency", value: 2 },
        { type: "play", rate: 1, ms: 300 },
        { type: "setting", key: "aiRateLimitRpm", value: 40 },
        { type: "play", rate: 1, ms: 6000 }
      ]
    });
    assert.equal(result.ok, true, JSON.stringify(result.detail));
    assert.equal(result.metrics.cancels, 0, `seed ${seed}`);
  }
});

test("the simulation is deterministic: one seed, one event sequence", async () => {
  const first = [];
  const second = [];
  await runSeed(1007, { profile: "flaky", record: first });
  await runSeed(1007, { profile: "flaky", record: second });
  assert.ok(first.length > 50);
  assert.deepEqual(second, first);
});

test("a smaller request-items setting keeps every invariant", async () => {
  // Users may lower the window; the seek-adoption reach once broke there
  // (sim seed 9021 at 160 items).
  const failures = [];
  for (const [i, requestItems] of [96, 160, 96, 160, 96, 160].entries()) {
    const seed = i === 0 ? 9021 : 2000 + i;
    const result = await runSeed(seed, { profile: i === 0 || i % 2 ? "fast" : "limited", rate: 1, requestItems });
    if (!result.ok) failures.push(`seed ${seed} items ${requestItems} ${result.invariant} ${JSON.stringify(result.detail)}`);
  }
  assert.deepEqual(failures, []);
});
