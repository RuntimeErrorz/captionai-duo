"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const root = path.resolve(__dirname, "..");
const stateSource = fs.readFileSync(path.join(root, "background/state.js"), "utf8");
const sessionSource = fs.readFileSync(path.join(root, "content/session.js"), "utf8");
const contentDiagnosticsSource = fs.readFileSync(
  path.join(root, "content/diagnostics.js"), "utf8"
);

function memoryStorage(seed = {}) {
  const values = { ...seed };
  return {
    values,
    async get(defaults) {
      const result = { ...defaults };
      for (const key of Object.keys(defaults || {})) {
        if (Object.prototype.hasOwnProperty.call(values, key)) result[key] = values[key];
      }
      return result;
    },
    async set(patch) { Object.assign(values, patch); }
  };
}

test("diagnostic sanitizer recursively removes credentials and complete profiles", () => {
  const shared = loadShared();
  const secret = "opaque-user-key-123";
  const input = {
    promptTokens: 42,
    headers: [
      { name: "Authorization", value: `Bearer ${secret}` },
      { name: "Content-Type", value: "application/json" }
    ],
    endpoint: `https://example.test/v1?api_key=${secret}&mode=fast`,
    error: `provider echoed ${secret} and Bearer second-secret-value`,
    arbitraryKeys: { [secret]: "must not survive as a property name" },
    profile: {
      name: "private profile",
      baseUrl: "https://example.test/v1",
      model: "private-model",
      apiKey: secret,
      extraBody: "{}"
    }
  };
  Object.defineProperty(input.arbitraryKeys, "__proto__", {
    value: "must not alter the diagnostic object prototype", enumerable: true
  });
  input.self = input;

  const sanitized = shared.sanitizeDiagnosticValue(input, { secrets: [secret] });
  const serialized = JSON.stringify(sanitized);

  assert.equal(sanitized.promptTokens, 42);
  assert.equal(sanitized.headers[0].value, "[REDACTED]");
  assert.equal(sanitized.headers[1].value, "application/json");
  assert.equal(sanitized.profile.redacted, "connection-profile");
  assert.equal(sanitized.self, "[CIRCULAR]");
  assert.equal(sanitized.arbitraryKeys["[UNSAFE_KEY]"],
    "must not alter the diagnostic object prototype");
  assert.doesNotMatch(serialized, /opaque-user-key-123|second-secret-value/);
  assert.match(sanitized.endpoint, /api_key=%5BREDACTED%5D/);
  assert.equal(input.profile.apiKey, secret, "sanitization must not mutate runtime data");
});

test("debug export is a versioned bundle and re-sanitizes persisted legacy entries", async () => {
  const secret = "nonstandard-private-value";
  const session = memoryStorage({
    ytdsDebugLogs: [{
      ts: new Date().toISOString(),
      scope: "background",
      event: "legacy-error",
      data: { error: `echo: ${secret}` }
    }]
  });
  const local = memoryStorage({
    aiApiKeys: { "https://example.test": secret },
    aiConfigProfileStoreV1: {
      activeId: "p1",
      profiles: [{
        id: "p1", name: "Private", baseUrl: "https://example.test",
        model: "model", apiKey: secret, extraBody: "{}"
      }]
    }
  });
  const context = {
    Object, String, Number, Math, Map, Set, Date, JSON, Promise, URL, URLSearchParams,
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
    YTDS_SHARED: loadShared(),
    chrome: {
      runtime: { getManifest: () => ({ version: "1.2.3" }) },
      storage: { session, local }
    }
  };
  vm.createContext(context);
  vm.runInContext(stateSource, context, { filename: "background/state.js" });
  const append = vm.runInContext("appendDebug", context);
  const exportLogs = vm.runInContext("exportDebugLogs", context);

  append("background", "request-error", {
    error: `provider repeated ${secret}`,
    authorization: `Bearer ${secret}`,
    promptTokens: 9
  });
  const bundle = JSON.parse(await exportLogs());
  const serialized = JSON.stringify(bundle);

  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.extensionVersion, "1.2.3");
  assert.equal(bundle.entryCount, 2);
  assert.deepEqual(bundle.entries.map((entry) => entry.sequence), [1, 2]);
  assert.equal(bundle.entries[0].protocolVersion, 1);
  assert.equal(bundle.entries[1].data.promptTokens, 9);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /\[REDACTED\]/);
});

test("diagnostic retention keeps a 30-minute window and reports its coverage", async () => {
  const session = memoryStorage();
  const local = memoryStorage();
  const startMs = Date.parse("2026-08-29T00:00:00.000Z");
  let nowMs = startMs;
  class TestDate extends Date {
    constructor(...args) { super(args.length ? args[0] : nowMs); }
    static now() { return nowMs; }
  }
  const context = {
    Object, String, Number, Math, Map, Set, Date: TestDate, JSON, Promise,
    URL, URLSearchParams,
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
    YTDS_SHARED: loadShared(),
    chrome: {
      runtime: { getManifest: () => ({ version: "1.2.3" }) },
      storage: { session, local }
    }
  };
  vm.createContext(context);
  vm.runInContext(stateSource, context, { filename: "background/state.js" });
  const append = vm.runInContext("appendDebug", context);
  const exportLogs = vm.runInContext("exportDebugLogs", context);

  for (let index = 0; index <= 30 * 60; index++) {
    nowMs = startMs + index * 1000;
    append("background", "heartbeat", { index });
  }

  const bundle = JSON.parse(await exportLogs());
  assert.equal(bundle.entryCount, 30 * 60 + 1);
  assert.equal(bundle.coverageMs, 30 * 60 * 1000);
  assert.equal(bundle.firstEntryAt, "2026-08-29T00:00:00.000Z");
  assert.equal(bundle.lastEntryAt, "2026-08-29T00:30:00.000Z");
});

test("detailed diagnostic exports retain request, response and rendered text", async () => {
  const session = memoryStorage();
  const local = memoryStorage();
  const context = {
    Object, String, Number, Math, Map, Set, Date, JSON, Promise,
    URL, URLSearchParams,
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
    YTDS_SHARED: loadShared(),
    chrome: {
      runtime: { getManifest: () => ({ version: "1.2.3" }) },
      storage: { session, local }
    }
  };
  vm.createContext(context);
  vm.runInContext(stateSource, context, { filename: "background/state.js" });
  const append = vm.runInContext("appendDebug", context);
  const exportLogs = vm.runInContext("exportDebugLogs", context);

  append("background", "semantic-batch-request", {
    requestId: "prefetch:1:2:0-1",
    model: "deepseek-v4-flash",
    endpointKind: "deepseek",
    currentRows: [[0, "hello"], [1, "world"]],
    contextBefore: [["c0", "past context"]],
    contextAfter: [["c1", "future context"]]
  });
  append("content", "translation-painted", {
    cueIdx: 1,
    source: "a long source sentence",
    previousTranslation: "旧译文",
    translation: "一条长译文"
  });
  append("background", "semantic-batch-response", {
    requestId: "prefetch:1:2:0-1",
    deferredIds: ["2"],
    units: [{
      unitId: "semantic-0-1",
      ids: ["0", "1"],
      translation: "你好世界"
    }]
  });
  const rawJsonl = '[[0,1,"你好世界"]]\n[]\n';
  append("background", "semantic-jsonl-raw-response", {
    requestId: "prefetch:1:2:0-1",
    format: "jsonl",
    responseChars: rawJsonl.length,
    rawResponse: rawJsonl
  });
  append("background", "semantic-jsonl-rejected", {
    requestId: "prefetch:1:2:0-1",
    reason: "invalid JSONL chunk",
    line: "[[0,0,\"坏输出\"]]",
    completedItems: 0
  });

  const bundle = JSON.parse(await exportLogs());
  const request = bundle.entries.find((entry) => entry.event === "semantic-batch-request");
  const painted = bundle.entries.find((entry) => entry.event === "translation-painted");
  const response = bundle.entries.find((entry) => entry.event === "semantic-batch-response");
  const raw = bundle.entries.find((entry) => entry.event === "semantic-jsonl-raw-response");
  const rejected = bundle.entries.find((entry) => entry.event === "semantic-jsonl-rejected");
  assert.deepEqual(request.data.currentRows, [[0, "hello"], [1, "world"]]);
  assert.deepEqual(request.data.contextBefore, [["c0", "past context"]]);
  assert.deepEqual(request.data.contextAfter, [["c1", "future context"]]);
  assert.equal(painted.data.source, "a long source sentence");
  assert.equal(painted.data.previousTranslation, "旧译文");
  assert.equal(painted.data.translation, "一条长译文");
  assert.equal(painted.data.translation.length, 5);
  assert.deepEqual(response.data.deferredIds, ["2"]);
  assert.deepEqual(response.data.units, [{
    unitId: "semantic-0-1", ids: ["0", "1"], translation: "你好世界"
  }]);
  assert.equal(raw.data.rawResponse, rawJsonl);
  assert.equal(rejected.data.line, "[[0,0,\"坏输出\"]]");
});

test("caption invalidation emits an ordered state transition with both revisions", () => {
  const events = [];
  let session;
  const context = {
    Object, String, Number, Math, Map, Set,
    videoIdFromLocation: () => "video",
    extensionContextAlive: () => true,
    sendRuntimeMessage: () => {},
    resetDeepseekCommitTimeline: () => {},
    clearDeepseekSeekSettle: () => {},
    clearPendingTimer: () => {},
    emitDebug: (event, data) => events.push({ event, data }),
    setContentDebugContextProvider: (provider) => { context.provider = provider; }
  };
  vm.createContext(context);
  vm.runInContext(sessionSource, context, { filename: "content/session.js" });
  session = vm.runInContext("captionSession", context);
  session.cueVideoId = "video";
  const reset = vm.runInContext("resetCaptionSessionState", context);

  reset("settings-change");
  reset("navigation");

  assert.equal(typeof context.provider, "function");
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((entry) => entry.event), ["state-transition", "state-transition"]);
  assert.deepEqual(events.map((entry) => entry.data.transition), ["invalidated", "invalidated"]);
  assert.deepEqual(events.map((entry) => entry.data.previousRevision), [0, 1]);
  assert.deepEqual(events.map((entry) => entry.data.nextRevision), [1, 2]);
  assert.deepEqual(events.map((entry) => entry.data.reason), ["settings-change", "navigation"]);
  assert.equal(context.provider().sessionRevision, 2);
});

test("content diagnostics add ordered session context before crossing worlds", () => {
  const messages = [];
  const context = {
    Object, String, Number, Math,
    settings: { debugEnabled: true },
    captionSession: { cueVideoId: "video", currentVideoId: "video" },
    getVideo: () => ({ currentTime: 12.345 }),
    sendRuntimeMessage: (message) => messages.push(message),
    YTDS_SHARED: loadShared()
  };
  vm.createContext(context);
  vm.runInContext(contentDiagnosticsSource, context, { filename: "content/diagnostics.js" });
  const setProvider = vm.runInContext("setContentDebugContextProvider", context);
  const emit = vm.runInContext("emitDebug", context);
  setProvider(() => ({ sessionRevision: 7, cueEpoch: 11, focusGeneration: 3 }));

  emit("state-transition", { machine: "semantic-request", transition: "started" });
  emit("state-transition", {
    machine: "semantic-response", transition: "discarded",
    authorization: "Bearer should-not-cross-worlds"
  });

  assert.deepEqual(messages.map((message) => message.data.sequence), [1, 2]);
  assert.equal(messages[0].data.protocolVersion, 1);
  assert.equal(messages[0].data.session.sessionRevision, 7);
  assert.equal(messages[0].data.videoTimeMs, 12345);
  assert.equal(messages[1].data.authorization, "[REDACTED]");
});
