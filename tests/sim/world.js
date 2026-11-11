"use strict";

// Deterministic world for the real extension runtime: one virtual clock, the
// real background worker modules and the real content runtime in separate vm
// contexts, and an asynchronous Chrome transport between them. Only leaf DOM
// functions (overlay, video lookup, text measuring) are replaced; everything
// that decides requests, ownership, commits and paints is the shipped code.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("manifest.json"));

const BACKGROUND_FILES = read("background.js").match(/"[^"]+\.js"/g).map((s) => s.slice(1, -1));
const CONTENT_SCRIPT = manifest.content_scripts.find((entry) => entry.world !== "MAIN");
// Navigation and page wiring are driven by the simulator; everything else loads.
const CONTENT_SKIP = new Set(["content/lifecycle.js"]);
const CONTENT_FILES = CONTENT_SCRIPT.js.filter((file) => !CONTENT_SKIP.has(file));
const SOURCES = new Map([...BACKGROUND_FILES, ...CONTENT_FILES].map((file) => [file, read(file)]));

const EPOCH_MS = Date.UTC(2026, 0, 1);
const TAB_ID = 7;
const EXTENSION_ID = "simextensionid";
const PAGE_URL = "https://www.youtube.com/watch?v=simVideo001";

function createRandom(seedValue) {
  let seed = (Number(seedValue) >>> 0) || 1;
  const next = () => {
    // xorshift32: deterministic, fast, good enough for scheduling noise.
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  next.pick = (list) => list[Math.floor(next() * list.length)];
  next.chance = (p) => next() < p;
  return next;
}

class Clock {
  constructor() {
    this.now = 0;
    this.timers = new Map();
    this.sequence = 0;
    this.executed = 0;
  }
  schedule(owner, delay, fn, repeat) {
    const id = ++this.sequence;
    const ms = Math.max(0, Number(delay) || 0);
    this.timers.set(id, { id, owner, time: this.now + ms, fn, repeat: repeat ? Math.max(1, ms) : 0, order: id });
    return id;
  }
  cancel(id) { this.timers.delete(id); }
  dropOwner(owner) {
    for (const [id, timer] of this.timers) if (timer.owner === owner) this.timers.delete(id);
  }
  nextDue(limit) {
    let best = null;
    for (const timer of this.timers.values()) {
      if (timer.time > limit) continue;
      if (!best || timer.time < best.time || (timer.time === best.time && timer.order < best.order)) best = timer;
    }
    return best;
  }
  // Run every timer due up to `time`, flushing real microtasks between them so
  // promise chains inside the runtime interleave exactly as on an event loop.
  async advanceTo(time) {
    await flushMicrotasks();
    for (;;) {
      const timer = this.nextDue(time);
      if (!timer) break;
      this.now = Math.max(this.now, timer.time);
      if (timer.repeat) {
        timer.time = this.now + timer.repeat;
        timer.order = ++this.sequence;
      } else {
        this.timers.delete(timer.id);
      }
      this.executed++;
      timer.fn();
      await flushMicrotasks();
    }
    this.now = Math.max(this.now, time);
    await flushMicrotasks();
  }
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function timerApi(clock, owner) {
  return {
    setTimeout: (fn, delay, ...args) => clock.schedule(owner, delay, () => fn(...args), false),
    clearTimeout: (id) => clock.cancel(id),
    setInterval: (fn, delay, ...args) => clock.schedule(owner, delay, () => fn(...args), true),
    clearInterval: (id) => clock.cancel(id)
  };
}

function simDateClass(clock) {
  return class SimDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(EPOCH_MS + clock.now);
    }
    static now() { return EPOCH_MS + clock.now; }
  };
}

function storageArea(initial, onChange, areaName) {
  const data = new Map(Object.entries(initial || {}).map(([k, v]) => [k, structuredClone(v)]));
  const get = (keys) => {
    const out = {};
    if (keys == null) {
      for (const [key, value] of data) out[key] = structuredClone(value);
    } else if (typeof keys === "string") {
      if (data.has(keys)) out[keys] = structuredClone(data.get(keys));
    } else if (Array.isArray(keys)) {
      for (const key of keys) if (data.has(key)) out[key] = structuredClone(data.get(key));
    } else {
      for (const [key, fallback] of Object.entries(keys)) {
        out[key] = data.has(key) ? structuredClone(data.get(key)) : structuredClone(fallback);
      }
    }
    return out;
  };
  const withCallback = (value, callback) => {
    if (typeof callback === "function") { callback(value); return undefined; }
    return Promise.resolve(value);
  };
  return {
    data,
    get: (keys, callback) => withCallback(get(keys), callback),
    set: (values, callback) => {
      const changes = {};
      for (const [key, value] of Object.entries(values || {})) {
        changes[key] = { oldValue: data.get(key), newValue: structuredClone(value) };
        data.set(key, structuredClone(value));
      }
      if (onChange && Object.keys(changes).length) onChange(changes, areaName);
      return withCallback(undefined, callback);
    },
    remove: (keys, callback) => {
      const changes = {};
      for (const key of [].concat(keys)) {
        if (data.has(key)) changes[key] = { oldValue: data.get(key) };
        data.delete(key);
      }
      if (onChange && Object.keys(changes).length) onChange(changes, areaName);
      return withCallback(undefined, callback);
    },
    clear: (callback) => { data.clear(); return withCallback(undefined, callback); }
  };
}

// chrome.runtime messages are JSON-serialized: functions and undefined drop.
function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function listenerSet() {
  const listeners = [];
  return { listeners, addListener: (fn) => listeners.push(fn), removeListener: (fn) => {
    const index = listeners.indexOf(fn);
    if (index >= 0) listeners.splice(index, 1);
  } };
}

// Math with a seeded random: runtime jitter (retry backoff) stays reproducible.
function seededMath(random) {
  const math = Object.create(Math);
  math.random = () => random();
  return math;
}

function baseGlobals(clock, owner, random) {
  return {
    console, Math: seededMath(random), JSON, Map, Set, WeakMap, WeakSet, URL, URLSearchParams, Promise, Error,
    TypeError, RangeError, Array, Object, String, Number, Boolean, RegExp, Symbol, Intl,
    Uint8Array, Uint32Array, TextEncoder, TextDecoder, AbortController, DOMException,
    structuredClone, queueMicrotask, encodeURIComponent, decodeURIComponent, isFinite, isNaN,
    parseInt, parseFloat,
    crypto: { getRandomValues: (array) => { for (let i = 0; i < array.length; i++) array[i] = (i * 2654435761) >>> 0; return array; } },
    Date: simDateClass(clock),
    ...timerApi(clock, owner)
  };
}

function loadFiles(context, files) {
  vm.createContext(context);
  for (const file of files) vm.runInContext(SOURCES.get(file), context, { filename: file });
  return context;
}

class World {
  constructor(options) {
    this.seed = Number(options.seed) >>> 0;
    this.random = createRandom(options.seed);
    this.clock = new Clock();
    this.events = [];
    this.onEvent = options.onEvent || (() => {});
    // Storage change listeners are tagged by owner so a reloaded page stops
    // hearing changes, as a navigated content script does.
    this.storageListeners = [];
    const emitChange = (changes, area) => {
      for (const entry of this.storageListeners.slice()) {
        this.clock.schedule(entry.owner, 0, () => entry.fn(structuredClone(changes), area));
      }
    };
    this.sync = storageArea(options.sync, emitChange, "sync");
    this.local = storageArea(options.local, emitChange, "local");
    this.session = storageArea({}, emitChange, "session");
    this.fetch = options.fetch;
    this.backgroundListeners = listenerSet();
    this.contentListeners = null;
    this.contentGeneration = 0;
    this.lastToBackground = 0;
    this.lastToContent = 0;
    this.loadBackground();
  }

  storageEvents(owner) {
    return {
      addListener: (fn) => this.storageListeners.push({ owner, fn }),
      removeListener: (fn) => {
        this.storageListeners = this.storageListeners.filter((entry) => entry.fn !== fn);
      }
    };
  }

  emit(kind, data) {
    const event = { t: this.clock.now, kind, ...data };
    this.onEvent(event);
  }

  // Chrome serializes every message; delivery is asynchronous and in order per
  // direction. Progress messages are separate sends and may be delayed further.
  delay(lastKey, reorderable) {
    const jitter = this.random.int(0, 3) + (reorderable && this.random.chance(0.05) ? this.random.int(1, 25) : 0);
    const at = this.clock.now + jitter;
    if (reorderable) return at - this.clock.now;
    this[lastKey] = Math.max(this[lastKey], at);
    return this[lastKey] - this.clock.now;
  }

  loadBackground() {
    const clock = this.clock;
    const world = this;
    const chrome = {
      runtime: {
        id: EXTENSION_ID,
        lastError: undefined,
        onMessage: this.backgroundListeners,
        onInstalled: listenerSet(),
        getManifest: () => manifest
      },
      tabs: {
        sendMessage: (tabId, message, optionsOrCallback, maybeCallback) => {
          const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
          world.deliverToContent(message, callback);
        }
      },
      permissions: { contains: async () => true, onAdded: listenerSet() },
      webRequest: Object.fromEntries(["onBeforeSendHeaders", "onErrorOccurred", "onCompleted"]
        .map((name) => [name, listenerSet()])),
      storage: { sync: this.sync, local: this.local, session: this.session, onChanged: this.storageEvents("background") },
      i18n: { getMessage: () => "" }
    };
    const context = {
      ...baseGlobals(clock, "background", createRandom(this.seed ^ 0x51ed270b)),
      chrome,
      fetch: (url, init) => world.fetch(url, init),
      importScripts: () => {}
    };
    context.self = context;
    context.globalThis = context;
    this.background = loadFiles(context, BACKGROUND_FILES);
    // Read-only view of lexical state for the invariant checker.
    vm.runInContext("globalThis.__sim = { get aiControllers() { return aiControllers; }, " +
      "get aiActiveByTab() { return aiActiveByTab; } };", context);
    this.backgroundChrome = chrome;
  }

  // A page load: a fresh content runtime in the same tab. The previous one's
  // timers and listeners die with it, exactly like a navigation.
  loadContent(hooks) {
    if (this.content) {
      const previous = `content:${this.contentGeneration}`;
      this.clock.dropOwner(previous);
      this.storageListeners = this.storageListeners.filter((entry) => entry.owner !== previous);
    }
    this.contentGeneration++;
    const owner = `content:${this.contentGeneration}`;
    const clock = this.clock;
    const world = this;
    const generation = this.contentGeneration;
    const listeners = listenerSet();
    this.contentListeners = listeners;
    const chrome = {
      runtime: {
        id: EXTENSION_ID,
        lastError: undefined,
        onMessage: listeners,
        sendMessage: (message, callback) => world.deliverToBackground(message, callback, generation, chrome)
      },
      storage: { sync: this.sync, local: this.local, onChanged: this.storageEvents(owner) },
      i18n: { getMessage: () => "" }
    };
    const element = () => ({
      style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild() {}, removeChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
      removeEventListener() {}, querySelector: () => null, isConnected: true, clientWidth: 1100,
      getContext: () => ({ measureText: (text) => ({ width: String(text || "").length * 9 }), font: "" })
    });
    const context = {
      ...baseGlobals(clock, owner, createRandom(this.seed ^ (0x2545f491 + this.contentGeneration))),
      chrome,
      location: { href: PAGE_URL },
      document: {
        documentElement: element(), body: element(), readyState: "complete", hidden: false,
        createElement: element, querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {}, fullscreenElement: null
      },
      requestAnimationFrame: (fn) => clock.schedule(owner, 16, () => fn(clock.now), false),
      cancelAnimationFrame: (id) => clock.cancel(id),
      innerWidth: 1280,
      postMessage: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      MutationObserver: class { observe() {} disconnect() {} }
    };
    context.window = context;
    context.globalThis = context;
    // Shared modules first, then the content runtime in manifest order.
    const sharedFiles = CONTENT_SCRIPT.js.filter((file) => file.startsWith("shared"));
    for (const file of sharedFiles) if (!SOURCES.has(file)) SOURCES.set(file, read(file));
    loadFiles(context, [...sharedFiles, ...CONTENT_FILES.filter((file) => !file.startsWith("shared"))]);
    vm.runInContext("globalThis.__sim = { get session() { return captionSession; }, " +
      "get settings() { return settings; } };", context);
    if (hooks) hooks(context, owner);
    this.content = context;
    this.contentChrome = chrome;
    return context;
  }

  deliverToBackground(message, callback, generation, contentChrome) {
    const payload = jsonClone(message);
    this.emit("to-background", { message: payload });
    const sender = { tab: { id: TAB_ID, url: PAGE_URL }, url: PAGE_URL, frameId: 0, id: EXTENSION_ID };
    const reply = (response, lastError) => {
      if (typeof callback !== "function") return;
      const delay = this.delay("lastToContent", false);
      this.clock.schedule(`content:${generation}`, delay, () => {
        if (generation !== this.contentGeneration) return;
        contentChrome.runtime.lastError = lastError;
        try { callback(jsonClone(response)); }
        finally { contentChrome.runtime.lastError = undefined; }
      });
    };
    this.clock.schedule("transport", this.delay("lastToBackground", false), () => {
      let responded = false;
      let keepOpen = false;
      const sendResponse = (response) => {
        if (responded) return;
        responded = true;
        this.emit("background-reply", { request: payload, response });
        reply(response, undefined);
      };
      for (const listener of this.backgroundListeners.listeners) {
        if (listener(payload, sender, sendResponse) === true) keepOpen = true;
      }
      if (!responded && !keepOpen) {
        responded = true;
        reply(undefined, { message: "The message port closed before a response was received." });
      }
    });
  }

  deliverToContent(message, callback) {
    const payload = jsonClone(message);
    const generation = this.contentGeneration;
    const duplicate = payload && payload.type === "translationBatchProgress" && this.random.chance(0.02);
    const send = () => {
      this.clock.schedule("transport", this.delay("lastToContent", true), () => {
        if (generation !== this.contentGeneration || !this.contentListeners) {
          if (typeof callback === "function") callback(undefined);
          return;
        }
        this.emit("to-content", { message: payload });
        let responded = false;
        const sendResponse = (response) => {
          if (responded) return;
          responded = true;
          if (typeof callback === "function") callback(response);
        };
        for (const listener of this.contentListeners.listeners) listener(payload, {}, sendResponse);
        if (!responded && typeof callback === "function") callback(undefined);
      });
    };
    send();
    if (duplicate) send();
  }
}

module.exports = { World, createRandom, EPOCH_MS, TAB_ID, PAGE_URL };
