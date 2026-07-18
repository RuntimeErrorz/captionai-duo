"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const injectSource = fs.readFileSync(path.join(root, "inject.js"), "utf8");

function json3(text) {
  return JSON.stringify({
    events: [{
      tStartMs: 0,
      dDurationMs: 2000,
      segs: [{ utf8: text }]
    }]
  });
}

test("competing timedtext tracks publish only the newest timeline", async () => {
  const listeners = new Map();
  const posts = [];
  const fetchCalls = [];
  const observers = [];

  const context = {
    URL,
    AbortController,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    YTDS_SHARED: {
      TARGET_LANGS: ["zh-CN"],
      videoIdFromUrl: () => "abcdefghijk",
      isAllowedTimedtextUrl: (url) => String(url).startsWith("https://www.youtube.com/api/timedtext")
    },
    XMLHttpRequest: function XMLHttpRequest() {},
    performance: { getEntriesByType: () => [] },
    PerformanceObserver: class PerformanceObserver {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {}
  };
  context.XMLHttpRequest.prototype.open = function open() {};
  context.XMLHttpRequest.prototype.send = function send() {};
  context.window = context;
  context.addEventListener = (type, callback) => listeners.set(type, callback);
  context.postMessage = (message) => posts.push(message);
  context.fetch = async (url) => {
    const value = String(url);
    fetchCalls.push(value);
    const text = value.includes("kind=asr") ? "newest ASR track" : "stale manual track";
    return { ok: true, text: async () => json3(text) };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);

  const manual = "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&pot=one";
  const asr = "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&pot=two";
  context.messageListener = listeners.get("message");
  context.manualUrl = manual;
  context.asrUrl = asr;
  vm.runInContext(`
    messageListener({
      source: window,
      origin: location.origin,
      data: {
        source: "ytds-content",
        type: "config",
        nonce: 7,
        targetLang: "zh-CN",
        mode: "deepseek"
      }
    });
    window.fetch(manualUrl);
    window.fetch(asrUrl);
  `, context);
  await new Promise((resolve) => setImmediate(resolve));

  const cuePosts = posts.filter((entry) => entry.type === "cues");
  assert.equal(cuePosts.length, 1, JSON.stringify({ fetchCalls, posts }));
  assert.equal(cuePosts[0].trackKind, "asr");
  assert.equal(cuePosts[0].sourceLang, "en");
  assert.equal(cuePosts[0].cues[0].text, "newest ASR track");

  // Resource Timing reports our internal fmt=json3 requests after completion.
  // Re-observing them must not select a track or start another refetch.
  const internalUrls = fetchCalls.filter((url) => url.includes("fmt=json3"));
  const callsBeforeResourceReplay = fetchCalls.length;
  observers[0].callback({
    getEntries: () => internalUrls.map((name) => ({ name }))
  });
  await Promise.resolve();

  assert.equal(fetchCalls.length, callsBeforeResourceReplay);
  assert.equal(posts.filter((entry) => entry.type === "cues").length, 1);
});
