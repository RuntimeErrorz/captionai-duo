"use strict";

// A model that loses count of positions shows it in two structural ways: a
// chunk that starts inside the previous one, or a chunk whose translation
// opens with clause punctuation (its text continues the previous chunk). In
// both cases the previous chunk's translation does not belong to its range,
// so neither chunk may be committed; the next request resumes before them.
// Shapes reduced from a real Gemini replay (sim-replay, request 9 and 11).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");
const { createRandom } = require("./sim/world");

const root = path.resolve(__dirname, "..");
const shared = loadShared();

function loadObserver() {
  const context = { YTDS_SHARED: shared, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "background/translation.js"), "utf8"), context,
    { filename: "background/translation.js" });
  return vm.runInContext("createAiJsonlStreamObserver", context);
}

// Words with a sentence end at every index in `ends`.
function items(count, ends) {
  return Array.from({ length: count }, (_v, id) => ({
    id: String(100 + id), text: ends.includes(id) ? `word${id}.` : `word${id}`,
    startMs: id * 300, endMs: id * 300 + 280, hardAfter: false
  }));
}

function stream(source, lines, trace) {
  const published = [];
  const observer = loadObserver()(source, "zh-CN", (translations) => {
    for (const item of translations) published.push(item);
  }, trace || { requestClass: "prefetch" });
  let status = null;
  for (const line of lines) {
    status = observer.onTextDelta(line, false);
    if (status.stop) break;
  }
  if (!status.stop) status = observer.onTextDelta("", true);
  const result = observer.result(true) || [];
  return { status, published, result: Array.from(result) };
}

const covered = (list) => new Set(list.map((item) => Number(item.id) - 100));

test("a chunk starting inside the previous one keeps neither of them", () => {
  const source = items(12, [3, 7, 11]);
  // [4,7] carries more text than its range; the model then restarts at 7.
  const { status, published, result } = stream(source, [
    '[[0,3,"第一句。"]]\n',
    '[[4,7,"第二句，还有第三句的前半。"]]\n',
    '[[7,11,"第三句的后半。"]]\n'
  ]);
  assert.equal(status.stop, true);
  for (const list of [published, result]) {
    const ids = covered(list);
    for (let id = 4; id <= 11; id++) assert.equal(ids.has(id), false, `position ${id} committed`);
    for (let id = 0; id <= 3; id++) assert.equal(ids.has(id), true, `position ${id} lost`);
  }
});

test("the same overlap inside one streamed line keeps neither chunk", () => {
  const source = items(12, [3, 7, 11]);
  const { published, result } = stream(source, [
    '[[0,3,"第一句。"],[4,7,"第二句，还有第三句的前半。"],',
    '[7,11,"第三句的后半。"]]\n'
  ]);
  for (const list of [published, result]) {
    const ids = covered(list);
    for (let id = 4; id <= 11; id++) assert.equal(ids.has(id), false, `position ${id} committed`);
  }
});

test("a chunk whose translation opens with a comma keeps neither it nor the previous chunk", () => {
  const source = items(14, [5, 9, 13]);
  const { status, published, result } = stream(source, [
    '[[0,5,"我们看到了一个预告片"],',
    '[6,9,"，展示了它的优点，所以我们会播放它。"],[10,13,"你可能正在看。"]]\n'
  ]);
  assert.equal(status.stop, true);
  for (const list of [published, result]) {
    const ids = covered(list);
    for (let id = 0; id <= 13; id++) assert.equal(ids.has(id), false, `position ${id} committed`);
  }
});

test("a comma-led first chunk of a request is not a misalignment", () => {
  const source = items(6, [5]);
  const { result } = stream(source, ['[[0,5,"，接着上一句说完。"]]\n', "[]\n"]);
  assert.equal(result.length, 6);
});

test("randomized: no committed chunk is the one a misaligned chunk follows", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const random = createRandom(seed);
    const count = random.int(12, 60);
    const ends = [];
    const chunks = [];
    for (let start = 0; start < count;) {
      const end = Math.min(count - 1, start + random.int(1, 8));
      ends.push(end);
      chunks.push([start, end, `译文${start}。`]);
      start = end + 1;
    }
    if (chunks.length < 3) continue;
    const bad = random.int(1, chunks.length - 1);
    if (random.chance(0.5)) chunks[bad][0] = chunks[bad - 1][1];
    else chunks[bad][2] = `，${chunks[bad][2]}`;
    const perLine = random.chance(0.5);
    const text = perLine ? chunks.map((chunk) => `${JSON.stringify([chunk])}\n`).join("")
      : `${JSON.stringify(chunks)}\n`;
    const lines = [];
    for (let i = 0; i < text.length;) { const size = random.int(1, 40); lines.push(text.slice(i, i + size)); i += size; }
    const { published, result } = stream(items(count, ends), lines);
    const previousStart = chunks[bad - 1][0];
    for (const list of [published, result]) {
      const ids = covered(list);
      for (let id = previousStart; id < count; id++) {
        assert.equal(ids.has(id), false, `seed ${seed}: position ${id} committed after a misaligned chunk`);
      }
      for (let id = 0; id < previousStart; id++) {
        if (!perLine) break; // one line: the prefix may stop earlier
        assert.equal(ids.has(id), true, `seed ${seed}: ordered position ${id} lost`);
      }
    }
  }
});

test("a comma moved across a clause edge is not a misalignment (real Gemini line)", () => {
  // "To me, this is kind of annoying." split as [0,1] and [2,6]: the model put
  // the comma at the start of the second chunk. The first chunk ends a source
  // clause, not a sentence, so both chunks commit.
  const words = ["To", "me,", "this", "is", "kind", "of", "annoying."];
  const source = words.map((text, id) => ({ id: String(500 + id), text, startMs: id * 300, endMs: id * 300 + 280, hardAfter: false }));
  const observer = loadObserver()(source, "zh-CN", () => {}, { requestClass: "prefetch" });
  let status = observer.onTextDelta('[[0,1,"对我来说"],[2,6,"，这有点烦人。"]]\n', false);
  assert.equal(status.stop, false);
  status = observer.onTextDelta("[]\n", true);
  const result = Array.from(observer.result(false) || []);
  assert.equal(result.length, 7);
});
