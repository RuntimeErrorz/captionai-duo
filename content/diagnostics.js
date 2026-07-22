// Versioned content-runtime diagnostic envelope and session correlation.
"use strict";

let contentDebugSequence = 0;
let contentDebugContextProvider = null;

function setContentDebugContextProvider(provider) {
  contentDebugContextProvider = typeof provider === "function" ? provider : null;
}

function emitDebug(event, data) {
  if (!settings.debugEnabled) return;
  try {
    const session = contentDebugContextProvider ? contentDebugContextProvider() : null;
    const payload = Object.assign({}, data || {}, {
      protocolVersion: 1,
      sequence: ++contentDebugSequence,
      session,
      videoId: captionSession.cueVideoId || captionSession.currentVideoId || "",
      videoTimeMs: Math.round(((getVideo() && getVideo().currentTime) || 0) * 1000)
    });
    sendRuntimeMessage({
      type: "debugLog",
      scope: "content",
      event,
      data: YTDS_SHARED.sanitizeDiagnosticValue(payload)
    });
  } catch (_e) { /* diagnostics must never affect playback */ }
}
