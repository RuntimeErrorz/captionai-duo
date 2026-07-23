"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const shared = loadShared();
const root = path.resolve(__dirname, "..");

test("extra request profiles are scoped by normalized Base URL and model", () => {
  assert.equal(
    shared.aiRequestProfileScope("https://gateway.example/v1/", " model-a "),
    '["https://gateway.example/v1","model-a"]'
  );
  assert.notEqual(
    shared.aiRequestProfileScope("https://gateway.example/v1", "model-a"),
    shared.aiRequestProfileScope("https://gateway.example/v1", "model-b")
  );
});

test("extra request JSON is canonicalized without losing nested provider options", () => {
  const parsed = shared.parseAiExtraBody(
    '{"top_p":0.8,"enable_thinking":false,"provider":{"route":["fast",2]}}'
  );
  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.canonical,
    '{"enable_thinking":false,"provider":{"route":["fast",2]},"top_p":0.8}'
  );
  assert.deepEqual(JSON.parse(parsed.canonical), {
    enable_thinking: false,
    provider: { route: ["fast", 2] },
    top_p: 0.8
  });
});

test("extra request JSON rejects invalid roots, unsafe keys and core protocol fields", () => {
  assert.equal(shared.parseAiExtraBody("not json").error, "invalidJson");
  assert.equal(shared.parseAiExtraBody("[]").error, "rootObject");
  assert.equal(shared.parseAiExtraBody('{"model":"other"}').error, "reservedKey");
  assert.equal(shared.parseAiExtraBody('{"messages":[]}').error, "reservedKey");
  assert.equal(
    shared.parseAiExtraBody('{"provider":{"__proto__":{"polluted":true}}}').error,
    "forbiddenKey"
  );
});

test("compatible requests merge provider options while preserving the subtitle transport", () => {
  const messages = [{ role: "user", content: "translate" }];
  const body = shared.aiChatCompletionBody({
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-flash",
    extraBody: {
      enable_thinking: false,
      temperature: 0.05,
      stream_options: { include_usage: true }
    }
  }, messages, 777, 0.2, { jsonLines: true });

  assert.equal(body.enable_thinking, false);
  assert.equal(body.temperature, 0.05);
  assert.equal(JSON.stringify(body.stream_options), '{"include_usage":true}');
  assert.equal(body.model, "qwen-flash");
  assert.equal(body.max_tokens, 777);
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, messages);
});

test("invalid programmatic extra parameters cannot replace protected fields", () => {
  const messages = [{ role: "user", content: "safe" }];
  const body = shared.aiChatCompletionBody({
    baseUrl: "https://gateway.example/v1",
    model: "expected",
    extraBody: { model: "wrong", stream: false, temperature: 0.1 }
  }, messages, 321, 0.2, { jsonLines: true });

  assert.equal(body.model, "expected");
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 321);
  assert.deepEqual(body.messages, messages);
  // The whole invalid object is rejected instead of partially applying a
  // configuration the user did not save.
  assert.equal(body.temperature, 0.2);
});

test("background configuration loads the profile for the exact API URL and model", async () => {
  const baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const model = "qwen-flash";
  const scope = shared.aiRequestProfileScope(baseUrl, model);
  const context = {
    YTDS_SHARED: shared,
    chrome: { storage: {
      sync: { get: async () => ({ aiBaseUrl: baseUrl, aiModel: model }) },
      local: { get: async () => ({
        aiExtraBodyProfiles: { [scope]: '{"enable_thinking":false}' }
      }) }
    } }
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(root, "background/http.js"), "utf8"),
    context,
    { filename: "background/http.js" }
  );
  const config = await vm.runInContext("getAiConfig()", context);
  assert.equal(config.extraBodyCanonical, '{"enable_thinking":false}');
  assert.equal(config.extraBody.enable_thinking, false);
});

test("the popup persists local profiles and cache identity includes their canonical JSON", () => {
  const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  const popupJs = ["popup/ai-profiles.js", "popup.js"].map((file) =>
    fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  const cacheSource = fs.readFileSync(path.join(root, "background/state.js"), "utf8");
  const contentSource = fs.readFileSync(path.join(root, "content/state-ui.js"), "utf8");
  assert.match(popupHtml, /id="aiExtraBody"/);
  assert.match(popupJs, /chrome\.storage\.local\.set\(\{ aiExtraBodyProfiles: profiles \}\)/);
  assert.match(popupJs, /setKey\("aiExtraBodyRevision"/);
  assert.match(cacheSource, /extraBody: config\.extraBodyCanonical/);
  assert.match(contentSource, /"aiExtraBodyRevision"/);
});
