"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();

test("prompt context deduplicates rolling cues and preserves temporal direction", () => {
  const prepared = shared.preparePromptContexts(
    [
      { id: "p0", text: "Earlier context", temporal: "past" },
      { id: "p1", text: "We are", temporal: "past" },
      { id: "p2", text: "We are ready", temporal: "past" }
    ],
    [
      { id: "f0", text: "The next", temporal: "future" },
      { id: "f1", text: "The next topic", temporal: "future" }
    ],
    3,
    2,
    [{ id: "0", text: "Current subtitle" }],
    28000
  );

  assert.equal(JSON.stringify(prepared.past.map((entry) => entry.text)), JSON.stringify([
    "Earlier context", "We are ready"
  ]));
  assert.equal(JSON.stringify(prepared.future.map((entry) => entry.text)),
    JSON.stringify(["The next topic"]));
  assert.ok(prepared.past.every((entry) => entry.temporal === "past"));
  assert.ok(prepared.future.every((entry) => entry.temporal === "future"));
});

test("prompt context obeys the aggregate source budget without trimming current items", () => {
  const prepared = shared.preparePromptContexts(
    [{ id: "p", text: "p".repeat(700), temporal: "past" }],
    [{ id: "f", text: "f".repeat(700), temporal: "future" }],
    1,
    1,
    [{ id: "0", text: "current".repeat(20) }],
    1024
  );

  assert.ok(prepared.usedChars <= prepared.maxSourceChars);
  assert.equal(prepared.currentChars, "current".repeat(20).length + 32);
  assert.equal(prepared.past.length + prepared.future.length, 1);
  assert.equal(prepared.droppedPast + prepared.droppedFuture, 1);
});

test("context already contained in the current window is omitted", () => {
  const prepared = shared.preparePromptContexts(
    [{ id: "p", text: "current subtitle", temporal: "past" }],
    [],
    1,
    0,
    [{ id: "0", text: "This is the current subtitle now" }],
    28000
  );
  assert.equal(prepared.past.length, 0);
});
