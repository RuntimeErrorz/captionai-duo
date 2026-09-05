const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const stateSource = fs.readFileSync(
  path.resolve(__dirname, "../background/state.js"), "utf8"
);
const translationSource = fs.readFileSync(
  path.resolve(__dirname, "../background/translation.js"), "utf8"
);

function loadCleanBatchItems() {
  const storage = {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {}
  };
  const context = {
    Array,
    Date,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    URL,
    URLSearchParams,
    YTDS_SHARED: loadShared(),
    chrome: {
      runtime: { getManifest: () => ({ version: "test" }) },
      storage: {
        session: storage,
        local: storage,
        onChanged: { addListener: () => {} }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(stateSource, context, { filename: "background/state.js" });
  return vm.runInContext("cleanBatchItems", context);
}

function batchItems(count) {
  return Array.from({ length: count }, (_value, id) => ({
    id: String(id),
    cueId: String(id),
    text: `source ${id}`,
    startMs: id * 400,
    endMs: id * 400 + 350,
    pauseAfterMs: 0,
    softAfter: false,
    hardAfter: id === count - 1
  }));
}

function loadConcurrencyHarness() {
  const storage = {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {}
  };
  const context = {
    Array,
    Date,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    URL,
    URLSearchParams,
    YTDS_SHARED: loadShared(),
    chrome: {
      runtime: { getManifest: () => ({ version: "test" }) },
      storage: {
        session: storage,
        local: storage,
        onChanged: { addListener: () => {} }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(stateSource, context, { filename: "background/state.js" });
  return context;
}

test("background validation admits the accelerated 320-item runway", () => {
  const clean = loadCleanBatchItems();
  assert.equal(clean(batchItems(320)).length, 320);
  assert.equal(clean(batchItems(321)), null);
});

test("provider-specific concurrency admits DeepSeek runway without overdriving compatible APIs", () => {
  const context = loadConcurrencyHarness();
  const sender = { tab: { id: 17 } };
  const deepseekReleases = [];
  for (let i = 0; i < 12; i++) {
    deepseekReleases.push(context.acquireDeepSeekSlot(sender, false, "deepseek"));
  }
  assert.throws(
    () => context.acquireDeepSeekSlot(sender, false, "deepseek"),
    /local concurrency guard busy/
  );
  for (const release of deepseekReleases) release();

  const compatibleReleases = [];
  for (let i = 0; i < 4; i++) {
    compatibleReleases.push(context.acquireDeepSeekSlot(sender, false, "compatible"));
  }
  assert.throws(
    () => context.acquireDeepSeekSlot(sender, false, "compatible"),
    /local concurrency guard busy/
  );
  const urgentRelease = context.acquireDeepSeekSlot(sender, true, "compatible");
  assert.equal(typeof urgentRelease, "function");
  urgentRelease();
  for (const release of compatibleReleases) release();

  const geminiRelease = context.acquireDeepSeekSlot(sender, false, "gemini");
  assert.throws(
    () => context.acquireDeepSeekSlot(sender, false, "gemini"),
    /local concurrency guard busy/
  );
  geminiRelease();
});

test("all segmentation lanes use compact alignment ranges", async () => {
  const prompts = [];
  const context = {
    AbortController,
    Array,
    Date,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    YTDS_SHARED: loadShared(),
    MAX_PROMPT_SOURCE_CHARS: 28000,
    aiRawCompletion: async (_config, messages, _signal, maxTokens, _temperature, trace) => {
      prompts.push({
        content: messages[0].content,
        request: messages[1].content,
        requestClass: trace.requestClass,
        maxTokens
      });
      const unit = '[[0,0,"译文"]]\n';
      trace.onTextDelta(
        unit +
        '[]\n', true
      );
      return { raw: "", diagnostics: { attempts: [] } };
    }
  };
  vm.createContext(context);
  vm.runInContext(translationSource, context, { filename: "background/translation.js" });
  const fetch = vm.runInContext("deepseekSegmentBatchFetch", context);
  const items = [{
    id: "500", cueId: "cue-500", text: "source", startMs: 0, endMs: 500,
    pauseAfterMs: 0, softAfter: false, hardAfter: false
  }];
  const config = { contextPast: 1, contextFuture: 1 };

  await fetch(items, "zh-CN", "en", [], [], config, null, { requestClass: "urgent" });
  await fetch(items, "zh-CN", "en", [], [], config, null, { requestClass: "prefetch" });
  await fetch(items, "zh-CN", "en", [], [], config, null, { requestClass: "prefetch-fast" });

  const deepseekConfig = { ...config, endpointKind: "deepseek" };
  await fetch(items, "zh-CN", "en", [], [], deepseekConfig, null, { requestClass: "urgent" });
  await fetch(items, "zh-CN", "en", [], [], deepseekConfig, null, { requestClass: "prefetch-fast" });
  await fetch(items, "zh-CN", "en", [], [], deepseekConfig, null, { requestClass: "prefetch" });

  assert.equal(prompts.length, 6);
  assert.equal(prompts[0].requestClass, "urgent");
  assert.equal(prompts[1].requestClass, "prefetch");
  assert.equal(prompts[2].requestClass, "prefetch-fast");
  assert.equal(prompts[0].maxTokens, 2048);
  assert.equal(prompts[1].maxTokens, 4096);
  assert.equal(prompts[2].maxTokens, 2048);
  assert.equal(prompts[3].maxTokens, 4096);
  assert.equal(prompts[4].maxTokens, 4096);
  assert.equal(prompts[5].maxTokens, 4096);
  assert.ok(prompts[0].content.length < prompts[1].content.length);
  assert.equal(prompts[0].content, prompts[2].content);
  assert.equal(prompts[3].content, prompts[4].content);
  assert.equal(prompts[4].content, prompts[5].content);
  assert.ok(prompts[3].content.length > prompts[0].content.length);
  assert.match(prompts[0].content, /JSONL/);
  assert.match(prompts[0].content, /strict ordered prefix/);
  assert.match(prompts[0].content, /empty array is the only completion marker/);
  assert.match(prompts[0].content, /Punctuation carries meaning/);
  assert.match(prompts[0].content, /never silently concatenate two completed source sentences/);
  assert.match(prompts[0].content, /must not force a new display page/);
  assert.match(prompts[0].content, /\[\[0,1,"\.\.\."\]\]/);
  assert.match(prompts[0].content, /zero-based and local to this request/);
  assert.match(prompts[0].content, /\[position,text\]/);
  assert.match(prompts[0].request, /CURRENT_CUES:\n\[\[0,"source"\]\]/);
  assert.doesNotMatch(prompts[0].request, /CURRENT_CUES:\n\[\[500/);
  assert.match(prompts[2].content, /never enumerate an ids array/i);
  assert.match(prompts[3].content, /Punctuation carries meaning/);
  assert.match(prompts[3].content, /\[\[0,1,"\.\.\."\]/);
  assert.match(prompts[3].content, /zero-based and local to this request/);
  assert.match(prompts[3].content, /never enumerate an ids array/i);
  assert.match(prompts[5].content, /never translate it as a period/);
});

test("detailed semantic diagnostics retain the raw JSONL response", async () => {
  const debug = [];
  const raw = '[[0,0,"完整译文"]]\n[]\n';
  const context = {
    Array,
    Date,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    YTDS_SHARED: loadShared(),
    MAX_PROMPT_SOURCE_CHARS: 28000,
    appendDebug: (...args) => debug.push(args),
    aiRawCompletion: async (_config, _messages, _signal, _maxTokens, _temperature, trace) => {
      trace.onTextDelta(raw, true);
      return { raw, diagnostics: { attempts: [] } };
    }
  };
  vm.createContext(context);
  vm.runInContext(translationSource, context, { filename: "background/translation.js" });
  const fetch = vm.runInContext("deepseekSegmentBatchFetch", context);
  const result = await fetch([{
    id: "0", cueId: "cue-0", text: "source", startMs: 0, endMs: 500,
    pauseAfterMs: 0, softAfter: false, hardAfter: false
  }], "zh-CN", "en", [], [], {}, null, {
    debug: true,
    requestId: "commit:0:1:0-0",
    requestClass: "urgent"
  });

  const rawEvent = debug.find((entry) => entry[1] === "semantic-jsonl-raw-response");
  assert.ok(rawEvent);
  assert.equal(rawEvent[2].format, "jsonl");
  assert.equal(rawEvent[2].responseChars, raw.length);
  assert.equal(rawEvent[2].rawResponse, raw);
  assert.equal(result[0].translation, "完整译文");
});

test("a cancelled partial JSONL stream remains a cancellation, not a partial result", async () => {
  const context = {
    Array,
    Date,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    YTDS_SHARED: loadShared(),
    MAX_PROMPT_SOURCE_CHARS: 28000,
    aiRawCompletion: async (_config, _messages, _signal, _maxTokens, _temperature, trace) => {
      trace.onTextDelta(
        '[[0,0,"已完成"]]\n',
        false
      );
      const error = new Error("AI request cancelled");
      error.cancelled = true;
      error.errorCode = "AI_CANCELLED";
      throw error;
    }
  };
  vm.createContext(context);
  vm.runInContext(translationSource, context, { filename: "background/translation.js" });
  const fetch = vm.runInContext("deepseekSegmentBatchFetch", context);
  const items = [{
    id: "0", cueId: "0", text: "source", startMs: 0, endMs: 500,
    pauseAfterMs: 0, softAfter: false, hardAfter: true
  }];

  await assert.rejects(
    fetch(items, "zh-CN", "en", [], [], { contextPast: 1, contextFuture: 1 }, null, {
      requestClass: "urgent"
    }),
    (error) => error.errorCode === "AI_CANCELLED" && error.cancelled === true
  );
});

test("a transport failure after malformed JSONL keeps the JSONL diagnostic code", async () => {
  const context = {
    Array,
    Date,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    YTDS_SHARED: loadShared(),
    MAX_PROMPT_SOURCE_CHARS: 28000,
    aiRawCompletion: async (_config, _messages, _signal, _maxTokens, _temperature, trace) => {
      trace.onTextDelta(
        '[[0,0,"已完成"]]\n' +
        '[[2,2,"跳号"]]\n',
        false
      );
      const error = new Error("AI request failed");
      error.netfail = true;
      error.errorCode = "AI_NETWORK_ERROR";
      error.httpDiagnostics = { attempts: [{ netError: "net::ERR_FAILED" }] };
      throw error;
    }
  };
  vm.createContext(context);
  vm.runInContext(translationSource, context, { filename: "background/translation.js" });
  const fetch = vm.runInContext("deepseekSegmentBatchFetch", context);
  const items = [
    { id: "0", cueId: "0", text: "first", startMs: 0, endMs: 500, hardAfter: false },
    { id: "1", cueId: "1", text: "second", startMs: 500, endMs: 1000, hardAfter: false },
    { id: "2", cueId: "2", text: "third", startMs: 1000, endMs: 1500, hardAfter: true }
  ];

  const result = await fetch(items, "zh-CN", "en", [], [], {
    contextPast: 1, contextFuture: 1
  }, null, { requestClass: "urgent" });

  assert.equal(result.errorCode, "AI_JSONL_INVALID");
  assert.equal(result.error, "unexpected JSONL position 2 at offset 1");
  assert.equal(result.streamPartial, true);
  assert.equal(result.length, 1);
  assert.deepEqual(result.deferredIds, ["1", "2"]);
});
