"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SHARED_FILES = Object.freeze([
  "shared/core.js",
  "shared/diagnostics.js",
  "shared/cues.js",
  "shared/translation.js",
  "shared/display.js",
  "shared/stream.js",
  "shared.js"
]);

const CONTENT_FILES = Object.freeze([
  "content/state-ui.js",
  "content/diagnostics.js",
  "content/session.js",
  "content/cue-playback.js",
  "content/display.js",
  "content/semantic-requests.js",
  "content/semantic.js",
  "content/fallback.js",
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
  "popup.js"
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

function loadSharedGlobal() {
  const root = path.resolve(__dirname, "..");
  for (const file of SHARED_FILES) require(path.join(root, file));
  return globalThis.YTDS_SHARED;
}

module.exports = {
  SHARED_FILES,
  CONTENT_FILES,
  BACKGROUND_FILES,
  POPUP_FILES,
  readSourceFiles,
  loadShared,
  loadSharedGlobal
};
