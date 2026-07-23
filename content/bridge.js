// Bridge messages from the MAIN-world timedtext interceptor.
"use strict";

// =========================================================================
// BRIDGE <- inject.js
// =========================================================================
const INJECT_DIAGNOSTIC_EVENTS = new Set([
  "bridge-config-received",
  "timedtext-captured",
  "cue-fetch-start",
  "cue-fetch-success",
  "cue-fetch-empty",
  "cue-fetch-error",
  "player-timedtext-response",
  "timedtext-watchdog-expired"
]);

function onInjectMessage(evt) {
  if (evt.source !== window) return;
  if (evt.origin !== location.origin) return;
  const d = evt.data;
  if (!d || d.source !== "ytds-inject") return;
  if (d.type === "diagnostic") {
    if (d.videoId !== captionSession.currentVideoId || !settings.enabled ||
        !INJECT_DIAGNOSTIC_EVENTS.has(d.event)) return;
    emitDebug(`inject-${d.event}`, Object.assign({
      messageNonce: Number(d.nonce) || 0,
      currentNonce: captionSession.configNonce,
      staleNonce: d.nonce !== captionSession.configNonce
    }, d.data && typeof d.data === "object" ? d.data : {}));
    return;
  }
  if (!Number.isInteger(d.nonce) || d.nonce !== captionSession.configNonce) return;
  if (d.videoId !== captionSession.currentVideoId) return;
  if (!settings.enabled) return;

  if (d.type === "cues") onCues(d);
  else if (d.type === "nocues") onNoCues(d);
}

function sendConfig(reason, reuseNonce) {
  try {
    const nonce = reuseNonce && Number.isInteger(captionSession.configNonce) && captionSession.configNonce > 0
      ? captionSession.configNonce : nextConfigNonce();
    captionSession.configNonce = nonce;
    emitDebug("cue-config-sent", {
      nonce,
      reason: String(reason || "request"),
      captionButton: captionButtonDebugState()
    });
    window.postMessage({
      source: "ytds-content",
      type: "config",
      nonce
    }, location.origin);
  } catch (_e) { /* ignore */ }
}
