"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const root = path.resolve(__dirname, "..");
const profileSource = fs.readFileSync(path.join(root, "popup/ai-profiles.js"), "utf8");
const transferSource = fs.readFileSync(path.join(root, "popup/config-transfer.js"), "utf8");

function transferContext(seed = {}) {
  const sync = structuredClone(seed.sync || {});
  const local = structuredClone(seed.local || {});
  const writes = [];
  let nextId = 0;
  const context = vm.createContext({
    YTDS_SHARED: loadShared(),
    state: {
      targetLang: "zh-CN",
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
      aiExtraBodyRevision: 0,
      deepseekContextPast: 1,
      deepseekContextFuture: 1,
      deepseekPrefetchBatches: 2
    },
    chrome: {
      storage: {
        sync: {
          async get(defaults) {
            return defaults === null ? structuredClone(sync)
              : { ...defaults, ...structuredClone(sync) };
          },
          async set(patch) {
            writes.push(["sync.set", structuredClone(patch)]);
            Object.assign(sync, structuredClone(patch));
          },
          async remove(keys) {
            writes.push(["sync.remove", structuredClone(keys)]);
            for (const key of [].concat(keys)) delete sync[key];
          }
        },
        local: {
          async get(keys) {
            if (Array.isArray(keys)) {
              return Object.fromEntries(keys.filter((key) => key in local)
                .map((key) => [key, structuredClone(local[key])]));
            }
            return { ...keys, ...structuredClone(local) };
          },
          async set(patch) {
            writes.push(["local.set", structuredClone(patch)]);
            Object.assign(local, structuredClone(patch));
          },
          async remove(keys) {
            writes.push(["local.remove", structuredClone(keys)]);
            for (const key of [].concat(keys)) delete local[key];
          }
        }
      }
    },
    crypto: { randomUUID: () => `generated-${++nextId}` },
    t: (_key, fallback) => fallback,
    structuredClone,
    TextEncoder,
    URL,
    Date,
    Math,
    Set
  });
  vm.runInContext(profileSource, context, { filename: "popup/ai-profiles.js" });
  vm.runInContext(transferSource, context, { filename: "popup/config-transfer.js" });
  return { context, sync, local, writes };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const profileStore = {
  activeId: "gemini",
  profiles: [
    {
      id: "deepseek",
      name: "DeepSeek",
      targetLang: "zh-CN",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      thinking: "high",
      apiKey: "deepseek-secret",
      extraBody: "{}",
      contextPast: 1,
      contextFuture: 1,
      prefetchBatches: 2
    },
    {
      id: "gemini",
      name: "Gemini",
      targetLang: "ja",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-flash",
      apiKey: "gemini-secret",
      extraBody: "{\"reasoning_effort\":\"low\"}",
      contextPast: 3,
      contextFuture: 4,
      prefetchBatches: 5
    }
  ]
};

test("configuration backup round-trips settings, profiles, and API keys", () => {
  const { context } = transferContext();
  context.syncSeed = {
    ...loadShared().DEFAULTS,
    enabled: false,
    targetLang: "ja",
    rowGap: 17,
    aiExtraBodyRevision: 8,
    aiThinking: "max"
  };
  context.localSeed = {
    aiApiKeys: { deepseek: "deepseek-secret", "https://google.example": "gemini-secret" },
    aiExtraBodyProfiles: { "scope:one": "{\"temperature\":0.4}" },
    aiConfigProfileStoreV1: profileStore
  };
  const backup = vm.runInContext(
    "createConfigBackup(syncSeed, localSeed, Date.UTC(2026, 6, 23))", context
  );
  context.serialized = JSON.stringify(backup);
  const restored = vm.runInContext("parseConfigBackupText(serialized)", context);

  assert.equal(restored.format, "captionai-duo-settings");
  assert.equal(restored.version, 1);
  assert.equal(restored.settings.enabled, false);
  assert.equal(restored.settings.targetLang, "ja");
  assert.equal(restored.settings.deepseekContextPast, 3);
  assert.equal(restored.settings.deepseekContextFuture, 4);
  assert.equal(restored.settings.deepseekPrefetchBatches, 5);
  assert.equal(restored.settings.rowGap, 17);
  assert.equal("aiThinking" in restored.settings, false);
  assert.equal(restored.local.aiApiKeys.deepseek, "deepseek-secret");
  assert.equal(restored.local.aiConfigProfileStoreV1.activeId, "gemini");
  assert.equal(
    restored.local.aiConfigProfileStoreV1.profiles[1].targetLang, "ja"
  );
  assert.equal("thinking" in restored.local.aiConfigProfileStoreV1.profiles[0], false);
  assert.deepEqual(
    plain(restored.local.aiConfigProfileStoreV1.profiles.map((profile) => profile.apiKey)),
    ["deepseek-secret", "gemini-secret"]
  );
});

test("restore allow-lists storage fields and emits one newer configuration revision", async () => {
  const { context, sync, local, writes } = transferContext({
    sync: { aiExtraBodyRevision: 12, unrelatedSyncData: "keep" },
    local: { unrelatedLocalData: "keep", aiApiKey: "legacy" }
  });
  context.backup = vm.runInContext(`createConfigBackup({
    ...YTDS_SHARED.DEFAULTS,
    targetLang: "ko",
    aiExtraBodyRevision: 3
  }, {
    aiApiKeys: { deepseek: "restored-secret" },
    aiExtraBodyProfiles: {},
    aiConfigProfileStoreV1: ${JSON.stringify(profileStore)}
  }, Date.UTC(2026, 6, 23))`, context);
  context.backup.local.untrusted = { injected: true };
  context.backup.settings.untrusted = "injected";

  await vm.runInContext("restoreConfigBackup(backup)", context);

  assert.equal(sync.targetLang, "ja");
  assert.equal(sync.deepseekContextPast, 3);
  assert.equal(sync.deepseekContextFuture, 4);
  assert.equal(sync.deepseekPrefetchBatches, 5);
  assert.equal(sync.aiExtraBodyRevision, 13);
  assert.equal(sync.untrusted, undefined);
  assert.equal(sync.unrelatedSyncData, "keep");
  assert.equal(local.aiApiKeys.deepseek, "restored-secret");
  assert.equal(local.untrusted, undefined);
  assert.equal(local.unrelatedLocalData, "keep");
  assert.equal(local.aiApiKey, undefined);
  assert.equal(writes.filter(([kind]) => kind === "sync.set").length, 1);
});

test("invalid backup is rejected before storage is changed", async () => {
  const { context, writes } = transferContext();
  context.invalid = {
    format: "some-other-extension",
    version: 1,
    settings: {},
    local: { aiConfigProfileStoreV1: profileStore }
  };
  await assert.rejects(
    vm.runInContext("restoreConfigBackup(invalid)", context),
    /unsupported-backup/
  );
  assert.deepEqual(writes, []);
});
