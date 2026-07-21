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
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
      aiThinking: "disabled",
      aiExtraBodyRevision: 4
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

test("connection profiles normalize a complete provider configuration", () => {
  const { context } = profileContext();
  const profile = vm.runInContext(`normalizeAiConfigProfile({
    id: "gemini-free",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.1-flash-lite-preview",
    thinking: "disabled",
    apiKey: "gemini-secret",
    extraBody: '{"reasoning_effort":"low"}'
  }, 0)`, context);
  assert.equal(profile.name, "Gemini");
  assert.equal(profile.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(profile.apiKey, "gemini-secret");
  assert.equal(profile.extraBody, '{"reasoning_effort":"low"}');
});

test("switching a profile materializes secrets locally and emits one unified revision", async () => {
  const { context, local, syncWrites } = profileContext({
    aiApiKeys: { deepseek: "old-key" },
    aiExtraBodyProfiles: {}
  });
  context.profile = {
    id: "gemini-free",
    name: "Gemini free",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.1-flash-lite-preview",
    thinking: "disabled",
    apiKey: "gemini-secret",
    extraBody: '{"reasoning_effort":"low"}'
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
    "aiBaseUrl", "aiExtraBodyRevision", "aiModel", "aiThinking"
  ]);
  assert.equal(syncWrites[0].aiExtraBodyRevision, 5);
  assert.equal(JSON.stringify(syncWrites[0]).includes("gemini-secret"), false);
});
