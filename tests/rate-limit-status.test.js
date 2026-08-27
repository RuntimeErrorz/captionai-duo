"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const messagesSource = fs.readFileSync(
  path.resolve(__dirname, "../background/messages.js"), "utf8"
);

function loadRateLimitHarness(errorValue, urgent = false) {
  let listener = null;
  const statuses = [];
  const responses = [];
  const context = {
    chrome: { runtime: { onMessage: { addListener: (callback) => { listener = callback; } } } },
    isYoutubeSender: () => true,
    senderPageUrls: () => ["https://www.youtube.com/watch?v=video"],
    cleanBatchItems: () => [{
      id: "0", cueId: "0", text: "hello", startMs: 0, endMs: 1000,
      pauseAfterMs: 0, softAfter: false, hardAfter: true
    }],
    cleanTargetLang: () => "zh-CN",
    cleanSourceLang: () => "en",
    cleanContext: () => [],
    YTDS_SHARED: { ...loadShared(), videoIdMatchesPageUrls: () => true },
    acquireDeepSeekSlot: () => { throw errorValue; },
    persistAiStatus: (...args) => statuses.push(args),
    sendResponse: () => {}
  };
  vm.createContext(context);
  vm.runInContext(messagesSource, context, { filename: "background/messages.js" });
  listener({
    type: "translateBatch",
    videoId: "video",
    requestId: "prefetch-1",
    urgent,
    targetLang: "zh-CN",
    sourceLang: "en",
    items: [{ id: "0", cueId: "0", text: "hello", startMs: 0, endMs: 1000 }]
  }, { tab: { id: 1 }, url: "https://www.youtube.com/watch?v=video" },
  (response) => responses.push(response));
  return { statuses, responses };
}

test("local prefetch backpressure does not surface as a provider rate-limit status", () => {
  const error = new Error("AI local concurrency guard busy");
  error.rateLimited = true;
  error.retryAfterMs = 1500;
  error.limitReason = "local-concurrency";
  const harness = loadRateLimitHarness(error);

  assert.equal(harness.statuses.length, 0);
  assert.equal(harness.responses[0].rateLimited, true);
  assert.equal(harness.responses[0].limitReason, "local-concurrency");
});

test("a provider rate limit still surfaces the user-facing status", () => {
  const error = new Error("AI HTTP 429");
  error.rateLimited = true;
  error.retryAfterMs = 7000;
  const harness = loadRateLimitHarness(error, true);

  assert.equal(harness.statuses.length, 1);
  assert.equal(harness.statuses[0][0], "limited");
  assert.equal(harness.responses[0].retryAfterMs, 7000);
});

test("a speculative provider rate limit stays a background retry", () => {
  const error = new Error("AI HTTP 429");
  error.rateLimited = true;
  error.retryAfterMs = 7000;
  const harness = loadRateLimitHarness(error, false);

  assert.equal(harness.statuses.length, 0);
  assert.equal(harness.responses[0].rateLimited, true);
  assert.equal(harness.responses[0].retryAfterMs, 7000);
});
