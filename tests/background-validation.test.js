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
});

test("urgent segmentation uses the compact prompt without changing the JSONL contract", async () => {
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
    appendDebug: () => {},
    aiRawCompletion: async (_config, messages, _signal, maxTokens, _temperature, trace) => {
      prompts.push({
        content: messages[0].content,
        requestClass: trace.requestClass,
        maxTokens
      });
      trace.onTextDelta(
        '{"type":"unit","chunks":[{"ids":["0"],"translation":"译文"}]}\n' +
        '{"type":"done"}\n', true
      );
      return { raw: "", diagnostics: { attempts: [] } };
    }
  };
  vm.createContext(context);
  vm.runInContext(translationSource, context, { filename: "background/translation.js" });
  const fetch = vm.runInContext("deepseekSegmentBatchFetch", context);
  const items = [{
    id: "0", cueId: "0", text: "source", startMs: 0, endMs: 500,
    pauseAfterMs: 0, softAfter: false, hardAfter: false
  }];
  const config = { contextPast: 1, contextFuture: 1 };

  await fetch(items, "zh-CN", "en", [], [], config, null, { requestClass: "urgent" });
  await fetch(items, "zh-CN", "en", [], [], config, null, { requestClass: "prefetch" });
  await fetch(items, "zh-CN", "en", [], [], config, null, { requestClass: "prefetch-fast" });

  const deepseekConfig = { ...config, endpointKind: "deepseek" };
  await fetch(items, "zh-CN", "en", [], [], deepseekConfig, null, { requestClass: "urgent" });
  await fetch(items, "zh-CN", "en", [], [], deepseekConfig, null, { requestClass: "prefetch-fast" });

  assert.equal(prompts.length, 5);
  assert.equal(prompts[0].requestClass, "urgent");
  assert.equal(prompts[1].requestClass, "prefetch");
  assert.equal(prompts[2].requestClass, "prefetch-fast");
  assert.equal(prompts[0].maxTokens, 2048);
  assert.equal(prompts[1].maxTokens, 4096);
  assert.equal(prompts[2].maxTokens, 2048);
  assert.equal(prompts[3].maxTokens, 4096);
  assert.equal(prompts[4].maxTokens, 4096);
  assert.ok(prompts[0].content.length < prompts[1].content.length);
  assert.equal(prompts[0].content, prompts[2].content);
  assert.match(prompts[0].content, /JSONL/);
  assert.match(prompts[0].content, /strict ordered prefix/);
  assert.match(prompts[0].content, /\{"type":"done"\}/);
});
