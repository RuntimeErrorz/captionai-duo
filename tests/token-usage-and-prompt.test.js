"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();
const plain = (value) => JSON.parse(JSON.stringify(value));

test("DeepSeek usage is normalized with cache and reasoning details", () => {
  assert.deepEqual(plain(shared.normalizeAiTokenUsage({
    prompt_tokens: 4200,
    completion_tokens: 620,
    total_tokens: 4820,
    prompt_cache_hit_tokens: 1100,
    prompt_cache_miss_tokens: 3100,
    completion_tokens_details: { reasoning_tokens: 80 }
  })), {
    promptTokens: 4200,
    completionTokens: 620,
    totalTokens: 4820,
    cacheHitTokens: 1100,
    cacheMissTokens: 3100,
    reasoningTokens: 80
  });
  assert.equal(shared.normalizeAiTokenUsage(null), null);
  assert.equal(shared.normalizeAiTokenUsage({ choices: [] }), null);
});

test("OpenAI-compatible cached input details are accepted", () => {
  assert.deepEqual(plain(shared.normalizeAiTokenUsage({
    input_tokens: 1000,
    output_tokens: 200,
    prompt_tokens_details: { cached_tokens: 640 }
  })), {
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    cacheHitTokens: 640,
    cacheMissTokens: 360,
    reasoningTokens: 0
  });
});

test("Gemini usage metadata and Interactions token fields are normalized", () => {
  assert.deepEqual(plain(shared.normalizeAiTokenUsage({ usageMetadata: {
    promptTokenCount: 900,
    candidatesTokenCount: 140,
    totalTokenCount: 1100,
    cachedContentTokenCount: 300,
    thoughtsTokenCount: 60
  } })), {
    promptTokens: 900,
    completionTokens: 140,
    totalTokens: 1100,
    cacheHitTokens: 300,
    cacheMissTokens: 600,
    reasoningTokens: 60
  });
  assert.deepEqual(plain(shared.normalizeAiTokenUsage({
    total_input_tokens: 700,
    total_output_tokens: 120,
    total_tokens: 900,
    total_cached_tokens: 256,
    total_thought_tokens: 80
  })), {
    promptTokens: 700,
    completionTokens: 120,
    totalTokens: 900,
    cacheHitTokens: 256,
    cacheMissTokens: 444,
    reasoningTokens: 80
  });
});

test("compact prompt rows retain the semantic boundary contract with much less JSON", () => {
  const items = Array.from({ length: 80 }, (_, index) => ({
    id: String(index),
    cueId: String(Math.floor(index / 8)),
    text: index % 2 ? "translation" : "subtitle",
    startMs: index * 400,
    endMs: index * 400 + 380,
    pauseAfterMs: index === 79 ? 4000 : index % 8 === 7 ? 950 : 0,
    softAfter: index % 8 === 7,
    hardAfter: index === 79
  }));
  const rows = shared.compactAiPromptCueRows(items);
  assert.deepEqual(Array.from(rows[0]), ["0", "subtitle", 0, ""]);
  assert.deepEqual(Array.from(rows[7]), ["7", "translation", 950, "s"]);
  assert.deepEqual(Array.from(rows[79]), ["79", "translation", 4000, "h"]);
  assert.ok(JSON.stringify(rows).length < JSON.stringify(items).length * 0.4);

  const contextRows = shared.compactAiPromptContextRows([
    { id: "c3", text: "Earlier cue", temporal: "past" }
  ]);
  assert.deepEqual(Array.from(contextRows[0]), ["c3", "Earlier cue"]);
});
