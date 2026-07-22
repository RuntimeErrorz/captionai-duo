// MV3 service-worker entry: deterministic module order, no bundler required.
importScripts(
  "shared/core.js",
  "shared/diagnostics.js",
  "shared/cues.js",
  "shared/translation.js",
  "shared/display.js",
  "shared/stream.js",
  "shared.js",
  "background/state.js",
  "background/network.js",
  "background/http.js",
  "background/translation.js",
  "background/messages.js"
);
