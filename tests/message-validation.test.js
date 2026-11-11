"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const root = path.resolve(__dirname, "..");
const stateSource = fs.readFileSync(path.join(root, "background/state.js"), "utf8");
const messagesSource = fs.readFileSync(path.join(root, "background/messages.js"), "utf8");
const WATCH = "https://www.youtube.com/watch?v=abcdefghijk";

// Real sender/batch validators from state.js; AI work is replaced by spies.
function loadRouter() {
  let listener = null;
  const calls = { translate: 0, cancel: 0, slot: 0 };
  const context = {
    console, Date, Math, JSON, Map, Set, URL, AbortController, setTimeout, clearTimeout,
    YTDS_SHARED: loadShared(),
    chrome: {
      runtime: { onMessage: { addListener: (callback) => { listener = callback; } } },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        sync: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        session: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener: () => {} }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(stateSource, context, { filename: "background/state.js" });
  Object.assign(context, {
    appendDebug: () => {},
    persistAiStatus: () => {},
    acquireAiSlot: () => { calls.slot++; return () => {}; },
    registerAiController: () => () => {},
    aiTranslateBatch: async () => { calls.translate++; return []; },
    cancelAiForSender: () => { calls.cancel++; },
    cancelAiRequestForSender: () => true,
    sendTranslationBatchProgress: () => {}
  });
  vm.runInContext(messagesSource, context, { filename: "background/messages.js" });
  const send = (msg, sender) => {
    let response;
    listener(msg, sender, (value) => { response = value; });
    return response;
  };
  return { send, calls };
}

const batch = (overrides = {}) => ({
  type: "translateBatch",
  videoId: "abcdefghijk",
  requestId: "commit-1",
  targetLang: "zh-CN",
  sourceLang: "en",
  items: [{ id: "0", cueId: "0", text: "hello", startMs: 0, endMs: 1000 }],
  contextBefore: [],
  contextAfter: [],
  ...overrides
});

test("translation batches are accepted only from the YouTube page they describe", () => {
  const { send, calls } = loadRouter();
  const youtube = { tab: { id: 1, url: WATCH }, url: WATCH };

  assert.equal(send(batch(), { tab: { id: 1, url: "https://evil.example/" }, url: "https://evil.example/" }).ok, false);
  assert.equal(send(batch({ videoId: "otherVideo1" }), youtube).errorCode, "AI_INVALID_BATCH");
  assert.equal(send(batch({ requestId: "bad id with spaces" }), youtube).errorCode, "AI_INVALID_BATCH");
  assert.equal(send(batch({ targetLang: "xx" }), youtube).errorCode, "AI_INVALID_BATCH");
  assert.equal(calls.slot, 0, "rejected batches must not reserve a provider slot");

  assert.equal(send(batch(), youtube), undefined, "a valid batch answers asynchronously");
  assert.equal(calls.slot, 1);
});

test("cancellation from an untrusted page is refused", () => {
  const { send, calls } = loadRouter();
  const response = send({ type: "cancelAiTranslation", videoId: "abcdefghijk" },
    { tab: { id: 1, url: "https://evil.example/" }, url: "https://evil.example/" });
  assert.equal(response.errorCode, "AI_UNTRUSTED_SENDER");
  assert.equal(calls.cancel, 0);
  send({ type: "cancelAiTranslation", videoId: "abcdefghijk" }, { tab: { id: 1, url: WATCH }, url: WATCH });
  assert.equal(calls.cancel, 1);
});

test("unknown and legacy message types are ignored", () => {
  const { send, calls } = loadRouter();
  const youtube = { tab: { id: 1, url: WATCH }, url: WATCH };
  for (const type of ["cancelDeepSeek", "cancelDeepSeekRequest", "toString", "__proto__", ""]) {
    assert.equal(send({ type, videoId: "abcdefghijk" }, youtube), undefined, type);
  }
  assert.equal(calls.cancel, 0);
});
