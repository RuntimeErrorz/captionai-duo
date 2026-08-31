"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const injectSource = [
  fs.readFileSync(path.join(root, "inject/caption-tracks.js"), "utf8"),
  fs.readFileSync(path.join(root, "inject/track-transport.js"), "utf8"),
  fs.readFileSync(path.join(root, "inject/translation-track.js"), "utf8"),
  fs.readFileSync(path.join(root, "inject.js"), "utf8")
].join("\n");

function json3(text) {
  return JSON.stringify({
    events: [{
      tStartMs: 0,
      dDurationMs: 2000,
      segs: [{ utf8: text }]
    }]
  });
}

test("auto selection strips stale translation parameters and catalogs an observed track", async () => {
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
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
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
    const params = new URL(value).searchParams;
    const text = params.has("tlang") ? "自动翻译英文字幕" : "中文原文字幕";
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => json3(text),
      clone: () => ({ text: async () => json3(text) })
    };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  context.translatedUrl =
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh&kind=asr&tlang=en&pot=fresh";
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 41}});" +
    "window.fetch(translatedUrl);",
    context
  );
  await new Promise((resolve) => setImmediate(resolve));

  const cuePosts = posts.filter((entry) => entry.type === "cues");
  assert.equal(cuePosts.length, 1, JSON.stringify({ fetchCalls, posts }));
  assert.equal(cuePosts[0].sourceLang, "zh");
  assert.equal(cuePosts[0].cues[0].text, "中文原文字幕");
  assert.equal(fetchCalls.some((url) => !new URL(url).searchParams.has("tlang")), true);
  const observedCatalog = posts.find((entry) => entry.type === "caption-tracks");
  assert.ok(observedCatalog, JSON.stringify({ fetchCalls, posts }));
  assert.equal(
    JSON.stringify(Array.from(observedCatalog.tracks, (track) => [track.languageCode, track.kind])),
    JSON.stringify([["zh", "asr"]])
  );
  assert.doesNotMatch(JSON.stringify(observedCatalog), /timedtext|fresh/);
});

test("caption catalog exposes every YouTube track without proof-bearing URLs", async () => {
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
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
    },
    ytInitialPlayerResponse: {
      videoDetails: { defaultAudioLanguage: "en" },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&pot=secret-en",
          languageCode: "en", kind: "asr", vssId: "a.en", name: { simpleText: "English (auto-generated)" }
        },
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh-CN&pot=secret-zh",
          languageCode: "zh-CN", name: { simpleText: "中文" }
        },
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=ja&pot=secret-ja",
          languageCode: "ja", name: { simpleText: "日本語" }
        }
      ] } }
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
    const translated = new URL(value).searchParams.has("tlang");
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => json3(translated ? "YouTube translated captions" : "original captions"),
      clone: () => ({ text: async () => json3(translated ? "YouTube translated captions" : "original captions") })
    };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 42, captionTrackId: 'auto'}});",
    context
  );

  const catalog = posts.find((entry) => entry.type === "caption-tracks");
  assert.ok(catalog, JSON.stringify({ fetchCalls, posts }));
  assert.equal(catalog.tracks.length, 3, JSON.stringify(catalog));
  assert.deepEqual(Array.from(catalog.tracks, (track) => track.languageCode), ["en", "zh-CN", "ja"]);
  assert.equal(catalog.tracks.some((track) => track.kind === "asr"), true);
  const preferredTrack = catalog.tracks.find((track) => track.languageCode === "en");
  assert.ok(preferredTrack, JSON.stringify(catalog));
  assert.equal(preferredTrack.label, "English (auto-generated)");
  assert.equal(catalog.preferredTrackId, preferredTrack.id);
  assert.doesNotMatch(JSON.stringify(catalog), /secret-|baseUrl|timedtext/);

  // The player may first request a stale/previously selected language. Auto
  // mode must still follow the track matching the original audio language.
  context.playerSelectedUrl =
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh-CN&pot=player-zh&" +
    "potc=1&c=WEB&cver=2.0";
  await vm.runInContext("window.fetch(playerSelectedUrl);", context);
  await new Promise((resolve) => setImmediate(resolve));
  const cue = posts.find((entry) => entry.type === "cues");
  assert.ok(cue, JSON.stringify({ fetchCalls, posts }));
  assert.equal(cue.sourceLang, "en");
  assert.equal(cue.cues[0].text, "original captions");
  assert.equal(fetchCalls.some((url) => new URL(url).searchParams.get("lang") === "en"), true);
  assert.equal(posts.filter((entry) => entry.type === "caption-tracks").at(-1).tracks.length, 3);
  const observed = vm.runInContext(
    "window.__ytdsCaptionTrackCatalog.observed(" +
      JSON.stringify("https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&pot=player-en&potc=1&c=WEB&cver=2.0") +
    ")",
    context
  );
  assert.equal(observed.track.label, "English (auto-generated)");
});

test("caption catalog upgrades a language-code label when a later player response has the track name", () => {
  const trackUrl = "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&pot=proof-en";
  const context = {
    URL,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    ytInitialPlayerResponse: {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        baseUrl: trackUrl, languageCode: "en", kind: "asr", vssId: "a.en"
      }] } }
    },
    window: null
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "inject/caption-tracks.js"), "utf8"), context);

  const first = vm.runInContext("window.__ytdsCaptionTrackCatalog.scan('abcdefghijk')", context);
  assert.equal(first.tracks[0].label, "en");

  context.ytplayer = { config: { args: { player_response: {
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
      baseUrl: trackUrl, languageCode: "en", kind: "asr", vssId: "a.en",
      name: { simpleText: "English (auto-generated)" }
    }] } }
  } } } };
  const refreshed = vm.runInContext(
    "window.__ytdsCaptionTrackCatalog.scan('abcdefghijk')", context
  );
  assert.equal(refreshed.tracks[0].label, "English (auto-generated)");
  assert.equal(refreshed.tracks[0].id, first.tracks[0].id);
});

test("explicit caption selection fetches the chosen language track", async () => {
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
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
    },
    ytInitialPlayerResponse: {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&pot=proof-en",
          languageCode: "en", kind: "asr", vssId: "a.en", name: { simpleText: "English" }
        },
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh-CN&pot=proof-zh",
          languageCode: "zh-CN", name: { simpleText: "中文" }
        }
      ] } }
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
    const language = new URL(value).searchParams.get("lang");
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => json3(language === "zh-CN" ? "中文字幕轨" : "英文字幕轨"),
      clone: () => ({ text: async () => json3(language === "zh-CN" ? "中文字幕轨" : "英文字幕轨") })
    };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 43, captionTrackId: 'auto'}});",
    context
  );
  const catalog = posts.find((entry) => entry.type === "caption-tracks");
  const chineseTrack = catalog.tracks.find((track) => track.languageCode === "zh-CN");
  assert.ok(chineseTrack, JSON.stringify({ fetchCalls, posts }));
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 44, captionTrackId: " +
    JSON.stringify(chineseTrack.id) + "}});",
    context
  );
  await new Promise((resolve) => setImmediate(resolve));

  const cuePosts = posts.filter((entry) => entry.type === "cues");
  assert.equal(cuePosts.length, 1, JSON.stringify({ fetchCalls, posts }));
  assert.equal(cuePosts[0].sourceLang, "zh-CN");
  assert.equal(cuePosts[0].captionTrackId, chineseTrack.id);
  assert.equal(cuePosts[0].cues[0].text, "中文字幕轨");
  assert.equal(
    fetchCalls.filter((url) => new URL(url).searchParams.get("lang") === "zh-CN").length,
    1
  );
  assert.equal(fetchCalls.some((url) => new URL(url).searchParams.get("lang") === "en"), false);

  const englishTrack = catalog.tracks.find((track) => track.languageCode === "en");
  assert.ok(englishTrack, JSON.stringify(catalog));
  context.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl =
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&pot=rotated-en";
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 45, captionTrackId: " +
    JSON.stringify(chineseTrack.id) + ", translationTrackId: " +
    JSON.stringify(englishTrack.id) + "}});",
    context
  );
  await new Promise((resolve) => setImmediate(resolve));
  const translationCue = posts.find((entry) => entry.type === "translation-cues");
  assert.ok(translationCue, JSON.stringify({ fetchCalls, posts }));
  assert.equal(translationCue.captionTrackId, englishTrack.id);
  assert.equal(translationCue.sourceLang, "en");
  assert.equal(translationCue.cues[0].text, "英文字幕轨");
  assert.equal(fetchCalls.some((url) => url.includes("pot=rotated-en")), true);
});

test("a player track wins when its catalog appears after explicit config", async () => {
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
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
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
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => json3("player-selected captions"),
      clone: () => ({ text: async () => json3("player-selected captions") })
    };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 46, " +
    "captionTrackId: 'track:zh-cn:manual:m.zh'}});",
    context
  );

  // The player response can expose the catalog only after config has already
  // selected a track. The player's request must be the first source fetch.
  context.ytInitialPlayerResponse = {
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
      baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh-CN&pot=player-zh",
      languageCode: "zh-CN", vssId: "m.zh", name: { simpleText: "中文" }
    }] } }
  };
  context.playerUrl =
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh-CN&pot=player-zh";
  await vm.runInContext("window.fetch(playerUrl);", context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCalls.length, 1, JSON.stringify({ fetchCalls, posts }));
  assert.equal(fetchCalls[0], context.playerUrl);
  const cue = posts.find((entry) => entry.type === "cues");
  assert.ok(cue, JSON.stringify({ fetchCalls, posts }));
  assert.equal(cue.captionTrackId, "track:zh-cn:manual:m.zh");
  assert.equal(cue.cues[0].text, "player-selected captions");
});

test("explicit selection asks YouTube for the track before direct fallback", async () => {
  const listeners = new Map();
  const posts = [];
  const fetchCalls = [];
  const playerCalls = [];
  const player = {
    setOption: (...args) => playerCalls.push(args)
  };
  const context = {
    URL,
    AbortController,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    YTDS_SHARED: {
      videoIdFromUrl: () => "abcdefghijk",
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
    },
    ytInitialPlayerResponse: {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=fr&pot=proof-fr",
        languageCode: "fr", vssId: "m.fr", name: { simpleText: "Français" }
      }] } }
    },
    document: {
      getElementById: () => player,
      querySelector: () => null
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
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => json3("player-selected French captions"),
      clone: () => ({ text: async () => json3("player-selected French captions") })
    };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 47, captionTrackId: 'auto'}});",
    context
  );
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 48, " +
    "captionTrackId: 'track:fr:manual:m.fr'}});",
    context
  );

  assert.equal(JSON.stringify(playerCalls), JSON.stringify([["captions", "track", {
    languageCode: "fr", kind: "", vssId: "m.fr"
  }]]));
  assert.equal(fetchCalls.length, 0, "native player request must get first chance");

  context.playerUrl =
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=fr&pot=player-fr";
  await vm.runInContext("window.fetch(playerUrl);", context);
  await new Promise((resolve) => setImmediate(resolve));
  const cue = posts.find((entry) => entry.type === "cues");
  assert.ok(cue, JSON.stringify({ fetchCalls, posts }));
  assert.equal(cue.cues[0].text, "player-selected French captions");
  assert.equal(fetchCalls.length, 1);
});

test("a player track waits for the delayed native response before fallback", async () => {
  const listeners = new Map();
  const posts = [];
  const fetchCalls = [];
  const timers = [];
  const player = { setOption: () => {} };
  const context = {
    URL,
    AbortController,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    YTDS_SHARED: {
      videoIdFromUrl: () => "abcdefghijk",
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
    },
    ytInitialPlayerResponse: {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&pot=proof-en",
        languageCode: "en", vssId: "m.en", name: { simpleText: "English" }
      }] } }
    },
    document: {
      getElementById: () => player,
      querySelector: () => null
    },
    XMLHttpRequest: function XMLHttpRequest() {},
    performance: { getEntriesByType: () => [] },
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
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
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => json3("delayed native response fallback"),
      clone: () => ({ text: async () => json3("delayed native response fallback") })
    };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 49, " +
    "captionTrackId: 'track:en:manual:m.en'}});",
    context
  );

  const fallbackTimer = timers.find((timer) => timer.delay === 2500 && !timer.cancelled);
  assert.ok(fallbackTimer, JSON.stringify(timers.map(({ delay, cancelled }) => ({ delay, cancelled }))));
  assert.equal(fetchCalls.length, 0, "direct fallback must wait for the native response window");
  fallbackTimer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.length, 1);
  assert.equal(posts.some((entry) => entry.type === "cues"), true);
});

test("an empty explicit track retries native selection once for a fresh source", async () => {
  const listeners = new Map();
  const posts = [];
  const fetchCalls = [];
  const playerCalls = [];
  const timers = [];
  let poll;
  const player = { setOption: (...args) => playerCalls.push(args) };
  const context = {
    URL,
    AbortController,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    YTDS_SHARED: {
      videoIdFromUrl: () => "abcdefghijk",
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
    },
    ytInitialPlayerResponse: {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&pot=proof-en",
        languageCode: "en", vssId: "m.en", name: { simpleText: "English" }
      }] } }
    },
    document: {
      getElementById: () => player,
      querySelector: () => null
    },
    XMLHttpRequest: function XMLHttpRequest() {},
    performance: { getEntriesByType: () => [] },
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    setInterval: (callback) => { poll = callback; return 1; },
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
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => "",
      clone: () => ({ text: async () => "" })
    };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 50, " +
    "captionTrackId: 'track:en:manual:m.en'}});",
    context
  );
  const fallbackTimer = timers.find((timer) => timer.delay === 2500 && !timer.cancelled);
  assert.ok(fallbackTimer);
  assert.equal(playerCalls.length, 1);
  fallbackTimer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.length, 1);
  assert.equal(posts.some((entry) => entry.type === "nocues"), true, JSON.stringify(posts));

  poll();
  assert.equal(playerCalls.length, 2, JSON.stringify(playerCalls));
  poll();
  assert.equal(playerCalls.length, 2, "a failed source must not start an unbounded native retry loop");
});

test("manual translation survives an original-track config change", async () => {
  const listeners = new Map();
  const posts = [];
  const fetchCalls = [];
  let resolveTranslation;
  const translationResponse = new Promise((resolve) => { resolveTranslation = resolve; });
  const tracks = [
    ["en", "m.en", "English"],
    ["de", "m.de", "Deutsch"],
    ["fr", "m.fr", "Français"]
  ].map(([language, vssId, label]) => ({
    baseUrl: `https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=${language}&pot=proof-${language}`,
    languageCode: language, vssId, name: { simpleText: label }
  }));
  const context = {
    URL,
    AbortController,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    YTDS_SHARED: {
      videoIdFromUrl: () => "abcdefghijk",
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
    },
    ytInitialPlayerResponse: {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } }
    },
    document: {
      getElementById: () => null,
      querySelector: () => null
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
  context.fetch = (url) => {
    const value = String(url);
    fetchCalls.push(value);
    if (new URL(value).searchParams.get("lang") === "de") return translationResponse;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => json3("original track"),
      clone: () => ({ text: async () => json3("original track") })
    });
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 101, " +
    "captionTrackId: 'track:en:manual:m.en', " +
    "translationTrackId: 'track:de:manual:m.de'}});",
    context
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.some((url) => new URL(url).searchParams.get("lang") === "de"), true);

  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 102, " +
    "captionTrackId: 'track:fr:manual:m.fr', " +
    "translationTrackId: 'track:de:manual:m.de'}});",
    context
  );
  resolveTranslation({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => json3("manual German translation"),
    clone: () => ({ text: async () => json3("manual German translation") })
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const translationCue = posts.find((entry) => entry.type === "translation-cues");
  assert.ok(translationCue, JSON.stringify({ fetchCalls, posts }));
  assert.equal(translationCue.nonce, 102);
  assert.equal(translationCue.captionTrackId, "track:de:manual:m.de");
  assert.equal(translationCue.cues[0].text, "manual German translation");
});

test("manual translation refreshes its player source after an empty catalog response", async () => {
  const listeners = new Map();
  const posts = [];
  const fetchCalls = [];
  const playerCalls = [];
  const player = { setOption: (...args) => playerCalls.push(args) };
  const tracks = [
    ["en", "m.en", "English"],
    ["fr", "m.fr", "Français"]
  ].map(([language, vssId, label]) => ({
    baseUrl: `https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=${language}&pot=stale-${language}`,
    languageCode: language, vssId, name: { simpleText: label }
  }));
  const context = {
    URL,
    AbortController,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    YTDS_SHARED: {
      videoIdFromUrl: () => "abcdefghijk",
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
    },
    ytInitialPlayerResponse: {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } }
    },
    document: {
      getElementById: () => player,
      querySelector: () => null
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
    const params = new URL(value).searchParams;
    const empty = params.get("lang") === "fr" && params.get("pot") === "stale-fr";
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => empty ? "" : json3("fresh French translation"),
      clone: () => ({ text: async () => empty ? "" : json3("fresh French translation") })
    };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 103, " +
    "captionTrackId: 'track:en:manual:m.en', " +
    "translationTrackId: 'track:fr:manual:m.fr'}});",
    context
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(playerCalls.some((args) => args[2] && args[2].vssId === "m.fr"), true);

  context.freshTranslationUrl =
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=fr&pot=fresh-fr";
  await vm.runInContext("window.fetch(freshTranslationUrl);", context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const translationCue = posts.find((entry) => entry.type === "translation-cues");
  assert.ok(translationCue, JSON.stringify({ fetchCalls, playerCalls, posts }));
  assert.equal(translationCue.cues[0].text, "fresh French translation");
  assert.equal(translationCue.captionTrackId, "track:fr:manual:m.fr");
});

test("a rotating URL for the selected track does not restart native switching", async () => {
  const listeners = new Map();
  const posts = [];
  const playerCalls = [];
  let poll;
  let resolvePlayerResponse;
  const playerResponse = new Promise((resolve) => { resolvePlayerResponse = resolve; });
  const player = { setOption: (...args) => playerCalls.push(args) };
  const context = {
    URL,
    AbortController,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    YTDS_SHARED: {
      videoIdFromUrl: () => "abcdefghijk",
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
    },
    ytInitialPlayerResponse: {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=fr&" +
          "ei=initial&xorb=one&pot=proof-fr",
        languageCode: "fr", vssId: "m.fr", name: { simpleText: "Français" }
      }] } }
    },
    document: {
      getElementById: () => player,
      querySelector: () => null
    },
    XMLHttpRequest: function XMLHttpRequest() {},
    performance: { getEntriesByType: () => [] },
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: (callback) => { poll = callback; return 1; },
    clearInterval: () => {}
  };
  context.XMLHttpRequest.prototype.open = function open() {};
  context.XMLHttpRequest.prototype.send = function send() {};
  context.window = context;
  context.addEventListener = (type, callback) => listeners.set(type, callback);
  context.postMessage = (message) => posts.push(message);
  context.fetch = () => playerResponse;

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  const trackId = "track:fr:manual:m.fr";
  vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 52, captionTrackId: " +
    JSON.stringify(trackId) + "}});",
    context
  );
  assert.equal(playerCalls.length, 1, JSON.stringify(playerCalls));

  context.playerUrl =
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=fr&" +
    "ei=rotated&xorb=two&pot=player-fr";
  vm.runInContext("window.fetch(playerUrl);", context);
  assert.ok(poll, "the catalog poll should be installed");
  poll();
  assert.equal(playerCalls.length, 1, "URL rotation must not re-issue setOption");

  const body = json3("rotated player captions");
  resolvePlayerResponse({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => body,
    clone: () => ({ text: async () => body })
  });
  await new Promise((resolve) => setImmediate(resolve));
  const cue = posts.find((entry) => entry.type === "cues");
  assert.ok(cue, JSON.stringify(posts));
  assert.equal(cue.captionTrackId, trackId);
  assert.equal(cue.cues[0].text, "rotated player captions");
});

test("config waits for a player timedtext response already in flight", async () => {
  const listeners = new Map();
  const posts = [];
  const fetchCalls = [];
  const body = json3("player-owned original captions");
  let resolvePlayerResponse;
  const playerResponse = new Promise((resolve) => { resolvePlayerResponse = resolve; });
  const context = {
    URL,
    AbortController,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    YTDS_SHARED: {
      videoIdFromUrl: () => "abcdefghijk",
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
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
  context.fetch = (url) => {
    fetchCalls.push(String(url));
    return playerResponse;
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  context.playerUrl =
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&pot=fresh";
  vm.runInContext("window.fetch(playerUrl);", context);
  vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 51}});",
    context
  );

  assert.equal(fetchCalls.length, 1, JSON.stringify(fetchCalls));
  resolvePlayerResponse({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => body,
    clone: () => ({ text: async () => body })
  });
  await new Promise((resolve) => setImmediate(resolve));

  const cuePosts = posts.filter((entry) => entry.type === "cues");
  assert.equal(cuePosts.length, 1, JSON.stringify({ fetchCalls, posts }));
  assert.equal(cuePosts[0].cues[0].text, "player-owned original captions");
});

test("an empty extension refetch requests a fresh player caption source", async () => {
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
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
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
      status: 200,
      headers: { get: () => "text/html" },
      text: async () => "",
      clone: () => ({ text: async () => "" })
    };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  context.translatedUrl =
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&tlang=zh&pot=stale";
  vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 61}});" +
    "window.fetch(translatedUrl);",
    context
  );
  await new Promise((resolve) => setImmediate(resolve));

  const noCue = posts.find((entry) => entry.type === "nocues");
  assert.equal(!!noCue, true, JSON.stringify({ fetchCalls, posts }));
  assert.equal(noCue.requestFreshSource, true, JSON.stringify(posts));
});

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
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => json3(text),
      clone: () => ({ text: async () => json3(text) })
    };
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
      status: 200,
      headers: { get: (name) => name === "content-type" ? "application/json" : null },
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
  const responseDiagnostic = posts.find(
    (entry) => entry.type === "diagnostic" && entry.event === "player-timedtext-response"
  );
  assert.deepEqual(
    {
      transport: responseDiagnostic && responseDiagnostic.data.transport,
      method: responseDiagnostic && responseDiagnostic.data.method,
      status: responseDiagnostic && responseDiagnostic.data.status,
      contentType: responseDiagnostic && responseDiagnostic.data.contentType,
      responseChars: responseDiagnostic && responseDiagnostic.data.responseChars
    },
    {
      transport: "fetch",
      method: "GET",
      status: 200,
      contentType: "application/json",
      responseChars: body.length
    }
  );

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
      status: 200,
      headers: { get: () => body ? "application/json" : "text/html" },
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
  assert.equal(firstNoCues.sourceLang, "en");
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

test("an aborted player request cannot quarantine a source before its valid peer completes", async () => {
  const listeners = new Map();
  const posts = [];
  const body = json3("valid peer response");
  let requestCount = 0;
  const context = {
    URL,
    AbortController,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    YTDS_SHARED: {
      videoIdFromUrl: () => "abcdefghijk",
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
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
  context.fetch = async () => {
    requestCount++;
    const aborted = requestCount === 1;
    const responseBody = aborted ? "" : body;
    return {
      ok: !aborted,
      status: aborted ? 0 : 200,
      headers: { get: () => aborted ? "" : "application/json" },
      text: async () => responseBody,
      clone: () => ({ text: async () => responseBody })
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
      data: { source: "ytds-content", type: "config", nonce: 31 }
    });
    Promise.all([window.fetch(playerUrl), window.fetch(playerUrl)]);
  `, context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(posts.some((entry) => entry.type === "nocues"), false, JSON.stringify(posts));
  const cuePosts = posts.filter((entry) => entry.type === "cues");
  assert.equal(cuePosts.length, 1, JSON.stringify(posts));
  assert.equal(cuePosts[0].cues[0].text, "valid peer response");
});

test("an empty catalog URL reuses a player session proof for an ASR track", async () => {
  const listeners = new Map();
  const posts = [];
  const fetchCalls = [];
  const target = "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&signature=target";
  const donor = "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh&pot=player-pot";
  const context = {
    URL,
    AbortController,
    location: {
      href: "https://www.youtube.com/watch?v=abcdefghijk",
      origin: "https://www.youtube.com"
    },
    YTDS_SHARED: {
      videoIdFromUrl: () => "abcdefghijk",
      isAllowedTimedtextUrl: (url) =>
        String(url).startsWith("https://www.youtube.com/api/timedtext")
    },
    ytInitialPlayerResponse: {
      videoDetails: { defaultAudioLanguage: "zh" },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { baseUrl: donor, languageCode: "zh", name: { simpleText: "中文" } },
        { baseUrl: target, languageCode: "en", kind: "asr", vssId: "a.en", name: { simpleText: "English" } }
      ] } }
    },
    document: { getElementById: () => null, querySelector: () => null },
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
    const params = new URL(value).searchParams;
    const body = params.get("pot") === "player-pot" && params.get("kind") === "asr"
      ? json3("grafted ASR captions") : "";
    return {
      ok: true,
      status: 200,
      headers: { get: () => body ? "application/json" : "text/html" },
      text: async () => body,
      clone: () => ({ text: async () => body })
    };
  };

  vm.createContext(context);
  vm.runInContext(injectSource, context);
  context.messageListener = listeners.get("message");
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 71, captionTrackId: 'auto'}});" +
    "window.fetch(" + JSON.stringify(donor) + ");",
    context
  );
  await new Promise((resolve) => setImmediate(resolve));
  await vm.runInContext(
    "messageListener({source: window, origin: location.origin, " +
    "data: {source: 'ytds-content', type: 'config', nonce: 72, " +
    "captionTrackId: 'track:en:asr:a.en'}});",
    context
  );
  await new Promise((resolve) => setImmediate(resolve));

  const cue = posts.find((entry) => entry.type === "cues");
  assert.ok(cue, JSON.stringify({ fetchCalls, posts }));
  assert.equal(cue.cues[0].text, "grafted ASR captions");
  const grafted = fetchCalls.find((url) => new URL(url).searchParams.get("kind") === "asr");
  assert.ok(grafted, JSON.stringify(fetchCalls));
  assert.equal(new URL(grafted).searchParams.get("pot"), "player-pot");
  assert.equal(new URL(grafted).searchParams.get("lang"), "en");
});
