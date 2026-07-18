"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();

test("local DeepSeek concurrency guard admits requests below the cap", () => {
  const status = shared.deepSeekConcurrencyStatus(1, 2);
  assert.equal(status.allowed, true);
  assert.equal(status.retryAfterMs, 0);
});

test("local DeepSeek concurrency guard counts requests, not cue items", () => {
  const status = shared.deepSeekConcurrencyStatus(2, 2);
  assert.equal(status.allowed, false);
  assert.equal(status.reason, "local-concurrency");
  assert.equal(status.retryAfterMs, 1500);
});

test("the active subtitle bypasses a cap occupied by speculative prefetch", () => {
  const status = shared.deepSeekConcurrencyStatus(2, 2, true);
  assert.equal(status.allowed, true);
  assert.equal(status.reason, "urgent-bypass");
  assert.equal(status.retryAfterMs, 0);
});
