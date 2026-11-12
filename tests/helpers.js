"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SHARED_FILES = Object.freeze([
  "shared/youtube-url.js",
  "shared/core.js",
  "shared/diagnostics.js",
  "shared/cues.js",
  "shared/schedule.js",
  "shared/jsonl.js",
  "shared/translation.js",
  "shared/alignment.js",
  "shared/display.js",
  "shared/stream.js",
  "shared.js"
]);

const CONTENT_FILES = Object.freeze([
  "content/state-ui.js",
  "content/player-toggle.js",
  "content/diagnostics.js",
  "content/session.js",
  "content/semantic-policy.js",
  "content/cue-playback.js",
  "content/display.js",
  "content/semantic-requests.js",
  "content/semantic-results.js",
  "content/semantic-lookahead.js",
  "content/semantic.js",
  "content/translation-ledger.js",
  "content/cue-indicator.js",
  "content/export.js",
  "content/bridge.js",
  "content/lifecycle.js"
]);

const BACKGROUND_FILES = Object.freeze([
  "background/state.js",
  "background/network.js",
  "background/http.js",
  "background/translation.js",
  "background/messages.js"
]);

const POPUP_FILES = Object.freeze([
  "popup/ai-profiles.js",
  "popup/config-transfer.js",
  "popup/ai-controls.js",
  "popup.js"
]);

// The MAIN world shares the page's JS realm; it loads only what inject/* uses.
const MAIN_SHARED_FILES = Object.freeze([
  "shared/youtube-url.js",
  "shared.js"
]);

const MAIN_FILES = Object.freeze([
  "inject/caption-tracks.js",
  "inject/track-transport.js",
  "inject/translation-track.js",
  "inject/network-hooks.js",
  "inject.js"
]);

function readSourceFiles(files) {
  const root = path.resolve(__dirname, "..");
  return files.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
}

function loadShared() {
  // URL is a Web API rather than an ECMAScript intrinsic, so an empty Node VM
  // context does not provide it even though every extension execution world
  // does. Inject the browser-standard constructors used by shared/core.js.
  const context = { URL, URLSearchParams };
  vm.createContext(context);
  for (const file of SHARED_FILES) {
    vm.runInContext(readSourceFiles([file]), context, { filename: file });
  }
  return context.YTDS_SHARED;
}

// The shipped content constants (every top-level AI_* / SEMANTIC_* const in
// content/state-ui.js), so test harnesses never carry a drifting copy.
let contentConstantsCache = null;
function contentConstants() {
  if (!contentConstantsCache) {
    const lines = fs.readFileSync(path.resolve(__dirname, "..", "content/state-ui.js"), "utf8")
      .split("\n").filter((line) => /^const (AI_|SEMANTIC_)\w+ = [^;]*;/.test(line));
    const names = lines.map((line) => line.match(/^const (\w+)/)[1]);
    const context = { Object };
    vm.createContext(context);
    contentConstantsCache = Object.freeze(vm.runInContext(
      lines.join("\n") + `\n({ ${names.join(", ")} })`, context));
  }
  return { ...contentConstantsCache };
}

function loadSharedGlobal() {
  const root = path.resolve(__dirname, "..");
  for (const file of SHARED_FILES) require(path.join(root, file));
  return globalThis.YTDS_SHARED;
}

module.exports = {
  SHARED_FILES,
  MAIN_SHARED_FILES,
  MAIN_FILES,
  CONTENT_FILES,
  BACKGROUND_FILES,
  POPUP_FILES,
  readSourceFiles,
  loadShared,
  loadSharedGlobal,
  contentConstants
};
