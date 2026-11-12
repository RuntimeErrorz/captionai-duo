"use strict";

// Soft and hard pauses are judged against the video's own rhythm: a slow
// speaker's routine pauses must not cut sentences, while ordinary videos
// keep the absolute thresholds.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");
const { createRandom } = require("./sim/world");

const shared = loadShared();

test("an ordinary video keeps the absolute pause thresholds", () => {
  const random = createRandom(7);
  const pauses = Array.from({ length: 400 }, () => random.chance(0.05) ? random.int(900, 2500) : random.int(0, 120));
  pauses.push(5000, 6200);
  const { softMs, hardMs } = shared.semanticPauseThresholds(pauses, 900, 4000);
  assert.equal(softMs, 900);
  assert.equal(hardMs, 4000);
});

test("a slow lecture's routine pauses are not hard boundaries", () => {
  const random = createRandom(11);
  // A long pause after one word in five, up to 1.4 s.
  const pauses = Array.from({ length: 400 }, () => random.chance(0.2) ? random.int(1100, 1400) : random.int(100, 400));
  const { softMs, hardMs, rhythmMs } = shared.semanticPauseThresholds(pauses, 900, 4000);
  assert.ok(rhythmMs >= 1100, `rhythm ${rhythmMs}`);
  assert.ok(softMs > 900);
  assert.ok(hardMs > 4000);
  assert.equal(shared.semanticPauseKind(4300, softMs, hardMs), "soft", "a routine-length long pause stays soft");
  assert.equal(shared.semanticPauseKind(hardMs + 1, softMs, hardMs), "hard");
});

test("too few pauses to know the rhythm keep the floors", () => {
  assert.deepEqual({ ...shared.semanticPauseThresholds([3000, 3000, 3000], 900, 4000) },
    { softMs: 900, hardMs: 4000, rhythmMs: 0 });
});

test("randomized: thresholds never fall below the floors and hard >= soft", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const random = createRandom(seed);
    const pauses = Array.from({ length: random.int(0, 300) }, () => random.int(0, random.pick([200, 2000, 9000])));
    const { softMs, hardMs } = shared.semanticPauseThresholds(pauses, 900, 4000);
    assert.ok(softMs >= 900 && hardMs >= 4000 && hardMs >= softMs, `seed ${seed}`);
  }
});
