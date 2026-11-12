"use strict";

// The word-timing export keeps what an SRT loses: each word's onset. The
// replay tooling (scripts/sim-replay.js) reads it back unchanged.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { cuesFromFile } = require("../scripts/lib/e2e-common");

const root = path.resolve(__dirname, "..");

function loadExport() {
  const context = { chrome: { runtime: { onMessage: { addListener: () => {} } } }, settings: {}, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "content/export.js"), "utf8"), context,
    { filename: "content/export.js" });
  return vm.runInContext("buildTimedJson3", context);
}

test("word-timed export round-trips through the replay reader", (t) => {
  const build = loadExport();
  const cues = [
    { start: 1000, dur: 2400, text: "so this is", parts: [{ text: "so", offsetMs: 0 }, { text: "this", offsetMs: 900 }, { text: "is", offsetMs: 2100 }] },
    { start: 7400, dur: 1200, text: "after a pause", parts: [{ text: "after", offsetMs: 0 }, { text: "a", offsetMs: 400 }, { text: "pause", offsetMs: 700 }] },
    { start: 9000, dur: 800, text: "A manual line" }
  ];
  const built = build(cues);
  assert.equal(built.count, 3);
  const file = path.join(t.testdir || require("node:os").tmpdir(), `timed-${process.pid}.json3`);
  fs.writeFileSync(file, built.text);
  try {
    const back = cuesFromFile(file);
    assert.deepEqual(back.map((cue) => cue.start), [1000, 7400, 9000]);
    assert.deepEqual(back[0].parts.map((part) => [part.text, part.offsetMs]), [["so", 0], ["this", 900], ["is", 2100]]);
    assert.equal(back[1].start - (back[0].start + back[0].dur), 4000, "the pause between cues survives");
    assert.equal(back[2].text, "A manual line");
  } finally {
    fs.rmSync(file, { force: true });
  }
});
