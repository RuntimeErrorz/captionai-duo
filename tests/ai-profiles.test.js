"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "popup/ai-profiles.js"), "utf8");

function profileContext(localSeed = {}) {
  const local = structuredClone(localSeed);
  const syncWrites = [];
  const context = vm.createContext({
    YTDS_SHARED: loadShared(),
    state: {
      targetLang: "zh-CN",
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
      aiExtraBodyRevision: 4,
      deepseekContextPast: 1,
      deepseekContextFuture: 1,
      deepseekPrefetchBatches: 2
    },
    chrome: {
      storage: {
        local: {
          async get(defaults) { return { ...defaults, ...structuredClone(local) }; },
          async set(patch) { Object.assign(local, structuredClone(patch)); },
          async remove(keys) { for (const key of keys) delete local[key]; }
        },
        sync: {
          async set(patch) { syncWrites.push(structuredClone(patch)); }
        }
      }
    },
    crypto: { randomUUID: () => "generated-id" },
    t: (_key, fallback) => fallback,
    structuredClone,
    URL,
    Date,
    Math
  });
  vm.runInContext(source, context, { filename: "popup/ai-profiles.js" });
  return { context, local, syncWrites };
}

test("configuration profiles normalize every model setting", () => {
  const { context } = profileContext();
  const profile = vm.runInContext(`normalizeAiConfigProfile({
    id: "gemini-free",
    targetLang: "ja",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.1-flash-lite-preview",
    thinking: "max",
    apiKey: "gemini-secret",
    extraBody: '{"reasoning_effort":"low"}',
    contextPast: 3,
    contextFuture: 4,
    prefetchBatches: 5
  }, 0)`, context);
  assert.equal(profile.name, "Gemini");
  assert.equal(profile.targetLang, "ja");
  assert.equal(profile.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal("thinking" in profile, false);
  assert.equal(profile.apiKey, "gemini-secret");
  assert.equal(profile.extraBody, '{"reasoning_effort":"low"}');
  assert.equal(profile.contextPast, 3);
  assert.equal(profile.contextFuture, 4);
  assert.equal(profile.prefetchBatches, 5);
});

test("switching a profile materializes secrets locally and emits one unified revision", async () => {
  const { context, local, syncWrites } = profileContext({
    aiApiKeys: { deepseek: "old-key" },
    aiExtraBodyProfiles: {}
  });
  context.profile = {
    id: "gemini-free",
    name: "Gemini free",
    targetLang: "ko",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.1-flash-lite-preview",
    apiKey: "gemini-secret",
    extraBody: '{"reasoning_effort":"low"}',
    contextPast: 3,
    contextFuture: 4,
    prefetchBatches: 5
  };
  await vm.runInContext("materializeAiConfigProfile(profile, true)", context);

  const credentialScope = loadShared().aiCredentialScope(context.profile.baseUrl);
  const requestScope = loadShared().aiRequestProfileScope(
    context.profile.baseUrl, context.profile.model
  );
  assert.equal(local.aiApiKeys[credentialScope], "gemini-secret");
  assert.equal(local.aiExtraBodyProfiles[requestScope], '{"reasoning_effort":"low"}');
  assert.equal(syncWrites.length, 1);
  assert.deepEqual(Object.keys(syncWrites[0]).sort(), [
    "aiBaseUrl", "aiExtraBodyRevision", "aiModel", "deepseekContextFuture",
    "deepseekContextPast", "deepseekPrefetchBatches", "targetLang"
  ]);
  assert.equal(syncWrites[0].aiExtraBodyRevision, 5);
  assert.equal(syncWrites[0].targetLang, "ko");
  assert.equal(syncWrites[0].deepseekContextPast, 3);
  assert.equal(syncWrites[0].deepseekContextFuture, 4);
  assert.equal(syncWrites[0].deepseekPrefetchBatches, 5);
  assert.equal(JSON.stringify(syncWrites[0]).includes("gemini-secret"), false);
});

test("profile renaming is inline and never opens a native prompt", () => {
  assert.doesNotMatch(source, /\bprompt\s*\(/);
  assert.match(source, /aiProfileNameEditor/);
  assert.match(source, /event\.key === "Enter"/);
  assert.match(source, /event\.key === "Escape"/);
});

test("profile order changes locally without switching the active profile", async () => {
  const { context, local, syncWrites } = profileContext();
  vm.runInContext(`aiConfigProfileStore = {
    activeId: "second",
    profiles: [
      { id: "first", name: "First" },
      { id: "second", name: "Second" },
      { id: "third", name: "Third" }
    ]
  }`, context);

  assert.equal(vm.runInContext('reorderAiConfigProfiles("third", "first")', context), true);
  await vm.runInContext("persistAiConfigProfileStore()", context);

  assert.deepEqual(
    structuredClone(local.aiConfigProfileStoreV1.profiles.map((profile) => profile.id)),
    ["third", "first", "second"]
  );
  assert.equal(local.aiConfigProfileStoreV1.activeId, "second");
  assert.equal(syncWrites.length, 0);
});
