// Teardown, YouTube SPA navigation and boot.
"use strict";

// =========================================================================
// STATE / TEARDOWN / SPA NAV
// =========================================================================
function teardownAll(reason) {
  emitCaptionStateTransition("content-lifecycle", "teardown", {
    reason: String(reason || "teardown")
  });
  stopCueLoop();
  stopFallback();
  resetCaptionSessionState(reason || "teardown");
  removeOverlay();
  captionSession.cueList = null;
  captionSession.cueVideoId = "";
  captionSession.activeCueIdx = -1;
  captionSession.sentGroups = null;
  captionSession.cueToGroup = null;
  captionSession.cueToGroups = null;
  captionSession.deepseekBatchWindows = [];
  captionSession.deepseekGroupToBatch = [];
  captionSession.cueTrackKind = "";
  captionSession.cueSourceLang = "";
  captionSession.cueTrackSignature = "";
  captionSession.duplicateCueEvents = 0;
  captionSession.lastDebugCueIdx = -1;
  stopCueRecovery();
  captionSession.nocuesFallback = false;
}

function applyStateToDom(sendConfiguration) {
  document.documentElement.classList.toggle("ytds-active", !!settings.enabled);
  if (!settings.enabled) {
    teardownAll();
  } else {
    // ensure overlay exists; cue mode will fill it once cues arrive,
    // fallback fills it if we end up scraping.
    ensureOverlay();
    if (captionSession.nocuesFallback) startFallback();
    if (sendConfiguration) sendConfig("state");
  }
}

function onNav() {
  const nextVideoId = videoIdFromLocation();
  // A cold YouTube load emits yt-navigate-finish after the content runtime has
  // already booted for that exact video. Treat it as player readiness, not a
  // cross-video navigation: tearing down here discards freshly received cues
  // and asks the MAIN bridge to consume the same proof-bearing URL twice.
  if (nextVideoId && nextVideoId === captionSession.currentVideoId) {
    emitCaptionStateTransition("content-lifecycle", "same-video-navigation", {
      videoId: nextVideoId,
      hasCues: !!(captionSession.cueList && captionSession.cueList.length)
    });
    if (settings.enabled) {
      ensureOverlay();
      if (!captionSession.cueList) {
        sendConfig("same-video-navigation", true);
        scheduleCueRecovery(INITIAL_CUE_RECOVERY_MS);
      }
      syncCaptions();
    }
    return;
  }
  captionSession.currentVideoId = nextVideoId;
  captionSession.weEnabledCC = false;        // fresh video — re-evaluate caption state
  teardownAll("navigation");
  emitCaptionStateTransition("content-lifecycle", "navigation", {
    videoId: captionSession.currentVideoId || ""
  });
  if (settings.enabled) {
    ensureOverlay();
    emitDebug("cue-navigation", { videoId: captionSession.currentVideoId || "" });
    sendConfig("navigation"); // ask inject.js for cues on the new video
    scheduleCueRecovery(INITIAL_CUE_RECOVERY_MS);
    syncCaptions();           // auto-turn on YouTube CC so subs actually show
  }
}

// single listener instances (added once; never accumulate)
window.addEventListener("yt-navigate-finish", onNav, true);
window.addEventListener("message", onInjectMessage, false);
document.addEventListener("fullscreenchange", () => {
  if (overlay) styleOverlay();
  scheduleDeepseekDisplayReflow(true);
}, false);
window.addEventListener("resize", () => scheduleDeepseekDisplayReflow(true), false);
if (document.fonts && typeof document.fonts.addEventListener === "function") {
  document.fonts.addEventListener("loadingdone", () => scheduleDeepseekDisplayReflow(true));
}

// ---- boot ----------------------------------------------------------------
loadSettings().then(() => {
  emitCaptionStateTransition("content-lifecycle", "booted", {
    enabled: !!settings.enabled,
    readyState: document.readyState
  });
  emitDebug("content-boot", {
    enabled: !!settings.enabled,
    currentVideoId: captionSession.currentVideoId || "",
    readyState: document.readyState
  });
  applyStateToDom(true);
  syncCaptions();            // auto-enable YouTube CC so subtitles show on load
  scheduleCueRecovery(INITIAL_CUE_RECOVERY_MS);
});
