"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const {
  SHARED_FILES,
  CONTENT_FILES,
  BACKGROUND_FILES,
  POPUP_FILES,
  readSourceFiles,
  loadShared
} = require("../tests/helpers");

const root = path.resolve(__dirname, "..");
const MAX_RUNTIME_LINES = 900;
const guardrailFiles = [
  "AGENTS.md",
  "content/AGENTS.md",
  "background/AGENTS.md",
  "popup/AGENTS.md",
  "tests/AGENTS.md",
  "docs/VERIFIED_DEVELOPMENT.md",
  "docs/VIBE_CODING_WITH_CODEX.md",
  ".github/workflows/verify.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/copilot-instructions.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml"
];
const runtimeFiles = Array.from(new Set([
  ...SHARED_FILES,
  ...CONTENT_FILES,
  ...BACKGROUND_FILES,
  ...POPUP_FILES,
  "background.js",
  "inject.js",
]));

for (const file of runtimeFiles) {
  const absolute = path.join(root, file);
  assert.equal(fs.existsSync(absolute), true, `missing runtime module: ${file}`);
  const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/).length;
  assert.ok(lines <= MAX_RUNTIME_LINES,
    `${file} has ${lines} lines; split it before exceeding ${MAX_RUNTIME_LINES}`);
  execFileSync(process.execPath, ["--check", absolute], { stdio: "pipe" });
}

for (const file of guardrailFiles) {
  assert.equal(fs.existsSync(path.join(root, file)), true,
    `missing agentic-development guardrail: ${file}`);
}

const rootInstructions = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
assert.match(rootInstructions, /npm run check/);
assert.match(rootInstructions, /phrase-specific/);
const vibeCodingGuide = fs.readFileSync(
  path.join(root, "docs/VIBE_CODING_WITH_CODEX.md"), "utf8"
);
assert.match(vibeCodingGuide, /Vibe Coding/);
assert.match(vibeCodingGuide, /\/plan/);
assert.match(vibeCodingGuide, /\/review/);
assert.match(vibeCodingGuide, /npm run check/);
assert.match(vibeCodingGuide, /https:\/\/learn\.chatgpt\.com\/docs\/reference\/commands/);
const verifyWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/verify.yml"), "utf8"
);
assert.match(verifyWorkflow, /permissions:\s*\n\s*contents: read/);
assert.match(verifyWorkflow, /os: \[ubuntu-latest, windows-latest\]/);
assert.match(verifyWorkflow, /npm run check/);
const pullRequestTemplate = fs.readFileSync(
  path.join(root, ".github/PULL_REQUEST_TEMPLATE.md"), "utf8"
);
assert.match(pullRequestTemplate, /Root cause and invariant/);
assert.match(pullRequestTemplate, /Verification evidence/);

// Compiling the ordered classic-script groups as one program catches duplicate
// global lexical declarations and accidental splits inside a function/block.
new vm.Script(readSourceFiles(CONTENT_FILES), { filename: "content-runtime.js" });
new vm.Script(readSourceFiles(BACKGROUND_FILES), { filename: "background-runtime.js" });
new vm.Script(readSourceFiles(POPUP_FILES), { filename: "popup-runtime.js" });

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert.deepEqual(manifest.content_scripts[0].js, [...SHARED_FILES, "inject.js"]);
assert.deepEqual(manifest.content_scripts[1].js, [...SHARED_FILES, ...CONTENT_FILES]);
assert.equal(manifest.background.service_worker, "background.js");
assert.equal(fs.existsSync(path.join(root, "content.js")), false,
  "content.js must not return as a monolithic entry");

const workerEntry = fs.readFileSync(path.join(root, "background.js"), "utf8");
const workerImports = Array.from(workerEntry.matchAll(/"([^"]+\.js)"/g), (match) => match[1]);
assert.deepEqual(workerImports, [...SHARED_FILES, ...BACKGROUND_FILES]);

const popup = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const popupScripts = Array.from(popup.matchAll(/<script src="([^"]+)"><\/script>/g),
  (match) => match[1]);
assert.deepEqual(popupScripts, [...SHARED_FILES, ...POPUP_FILES]);

const shared = loadShared();
assert.equal(Object.isFrozen(shared), true, "YTDS_SHARED must remain immutable");
assert.equal(typeof shared.preparePromptContexts, "function");
assert.equal(typeof shared.cueReferenceAtoms, "function");
assert.equal(typeof shared.alignedTranslationsFromJsonText, "function");
assert.equal(typeof shared.semanticDisplayPlan, "function");
assert.equal(typeof shared.deepSeekSseEvents, "function");
assert.equal(typeof shared.sanitizeDiagnosticValue, "function");

console.log(`Architecture checks passed: ${runtimeFiles.length} files, max ${MAX_RUNTIME_LINES} lines.`);
