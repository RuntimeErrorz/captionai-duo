"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadShared } = require("./helpers");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const httpSource = fs.readFileSync(path.join(root, "background/http.js"), "utf8");
const shared = loadShared();

// Minimal Chrome match-pattern coverage: scheme, then "*" or an exact host.
function patternCovers(declared, requested) {
  const parse = (pattern) => pattern.match(/^(https?):\/\/([^/]+)\/\*$/);
  const have = parse(declared);
  const want = parse(requested);
  return !!(have && want && have[1] === want[1] && (have[2] === "*" || have[2] === want[2]));
}

test("API host permissions grant all HTTPS domains at install", () => {
  assert.deepEqual(manifest.host_permissions, ["https://*/*"]);
  assert.deepEqual(manifest.optional_host_permissions, [
    "http://localhost/*",
    "http://127.0.0.1/*"
  ]);
  assert.equal(
    shared.aiHostPermissionPattern(shared.AI_DEFAULT_BASE_URL),
    "https://api.deepseek.com/*",
    "the default provider must work without a permission prompt"
  );
  assert.ok(
    patternCovers(manifest.host_permissions[0], shared.aiHostPermissionPattern(shared.AI_DEFAULT_BASE_URL)),
    "host_permissions must cover the default provider"
  );
});

test("every accepted API base maps to a declared host permission pattern", () => {
  const declared = [...manifest.host_permissions, ...manifest.optional_host_permissions];
  const bases = [
    "https://api.deepseek.com",
    "https://generativelanguage.googleapis.com/v1beta/openai",
    "https://gateway.example.org:8443/v1",
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234"
  ];
  for (const base of bases) {
    const pattern = shared.aiHostPermissionPattern(base);
    assert.ok(pattern, base);
    assert.doesNotMatch(pattern, /:\d+\//, "match patterns must not carry a port");
    assert.ok(declared.some((entry) => patternCovers(entry, pattern)), `${base} -> ${pattern}`);
  }
  assert.equal(shared.aiHostPermissionPattern("http://example.com/v1"), "");
  assert.equal(shared.aiHostPermissionPattern("not a url"), "");
});

test("a missing host permission fails before any network request", async () => {
  let fetchCalls = 0;
  const context = {
    AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout,
    fetch: async () => { fetchCalls++; throw new Error("must not fetch"); },
    YTDS_SHARED: shared,
    chrome: {
      storage: { local: { get: async () => ({ aiApiKeys: {} }) } },
      permissions: { contains: async () => false }
    }
  };
  vm.createContext(context);
  vm.runInContext(httpSource, context, { filename: "background/http.js" });
  const aiRawCompletion = vm.runInContext("aiRawCompletion", context);
  await assert.rejects(
    aiRawCompletion({
      endpoint: "https://provider.example/v1/chat/completions",
      baseUrl: "https://provider.example/v1",
      endpointKind: "compatible",
      model: "test-model",
      extraBody: {}
    }, [], null, 256, 0),
    (error) => {
      assert.equal(error.errorCode, "AI_HOST_PERMISSION_MISSING");
      assert.equal(error.needsPermission, true);
      assert.equal(shared.aiErrorDescriptor({ needsPermission: true }).code,
        "AI_HOST_PERMISSION_MISSING");
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});
