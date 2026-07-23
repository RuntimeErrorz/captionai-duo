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

test("player fetch response is consumed without a duplicate timedtext request", async () => {
  const listeners = new Map();
  const posts = [];
  const fetchCalls = [];
  const body = json3("caption returned to the player");
  const context = {
    URL,
    AbortController,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    YTDS_SHARED: {
      videoIdFromUrl: () => "abcdefghijk",
      isAllowedTimedtextUrl: (url) => String(url).startsWith("https://www.youtube.com/api/timedtext")
    },
    XMLHttpRequest: function XMLHttpRequest() {},
    performance: { getEntriesByType: () => [] },
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
    fetchCalls.push(String(url));
    return {
      ok: true,
      text: async () => body,
      clone: () => ({ text: async () => body })
    };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  context.playerUrl =
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&fmt=json3&pot=fresh";
  await vm.runInContext(`
    messageListener({
      source: window,
      origin: location.origin,
      data: { source: "ytds-content", type: "config", nonce: 11 }
    });
    window.fetch(playerUrl);
  `, context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCalls.length, 1, JSON.stringify(fetchCalls));
  const cuePosts = posts.filter((entry) => entry.type === "cues");
  assert.equal(cuePosts.length, 1, JSON.stringify(posts));
  assert.equal(cuePosts[0].cues[0].text, "caption returned to the player");

  vm.runInContext(`
    messageListener({
      source: window,
      origin: location.origin,
      data: { source: "ytds-content", type: "config", nonce: 11 }
    });
  `, context);
  assert.equal(posts.filter((entry) => entry.type === "cues").length, 1);
  assert.equal(fetchCalls.length, 1);

  vm.runInContext(`
    messageListener({
      source: window,
      origin: location.origin,
      data: { source: "ytds-content", type: "config", nonce: 12 }
    });
  `, context);
  assert.equal(posts.filter((entry) => entry.type === "cues").length, 2);
  assert.equal(posts.filter((entry) => entry.type === "cues")[1].nonce, 12);
  assert.equal(fetchCalls.length, 1, "a new config should replay cached cues, not refetch");
});

test("empty player URL is quarantined until the player rotates it", async () => {
  const listeners = new Map();
  const posts = [];
  const fetchCalls = [];
  const context = {
    URL,
    AbortController,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    YTDS_SHARED: {
      videoIdFromUrl: () => "abcdefghijk",
      isAllowedTimedtextUrl: (url) => String(url).startsWith("https://www.youtube.com/api/timedtext")
    },
    XMLHttpRequest: function XMLHttpRequest() {},
    performance: { getEntriesByType: () => [] },
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
    const body = value.includes("pot=fresh") ? json3("recovered timeline") : "";
    return {
      ok: true,
      text: async () => body,
      clone: () => ({ text: async () => body })
    };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  context.staleUrl =
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&fmt=json3&pot=stale";
  context.freshUrl =
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&fmt=json3&pot=fresh";
  await vm.runInContext(`
    messageListener({
      source: window,
      origin: location.origin,
      data: { source: "ytds-content", type: "config", nonce: 21 }
    });
    window.fetch(staleUrl);
  `, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.length, 1, JSON.stringify(fetchCalls));
  const firstNoCues = posts.find((entry) => entry.type === "nocues");
  assert.equal(!!firstNoCues, true, JSON.stringify(posts));
  assert.equal(firstNoCues.requestFreshSource, true, JSON.stringify(posts));

  await vm.runInContext("window.fetch(staleUrl)", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.length, 2, JSON.stringify(fetchCalls));
  const staleFailures = posts.filter((entry) => entry.type === "nocues");
  assert.equal(staleFailures.length, 2, JSON.stringify(posts));
  assert.equal(staleFailures[1].requestFreshSource, false, JSON.stringify(posts));

  vm.runInContext(`
    messageListener({
      source: window,
      origin: location.origin,
      data: { source: "ytds-content", type: "config", nonce: 22 }
    });
  `, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.length, 2, "config replay must not refetch a quarantined URL");

  await vm.runInContext("window.fetch(freshUrl)", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.length, 3, JSON.stringify(fetchCalls));
  const cuePosts = posts.filter((entry) => entry.type === "cues");
  assert.equal(cuePosts.length, 1, JSON.stringify(posts));
  assert.equal(cuePosts[0].nonce, 22);
  assert.equal(cuePosts[0].cues[0].text, "recovered timeline");
});
