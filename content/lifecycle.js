// Teardown, YouTube SPA navigation and boot.
"use strict";

// =========================================================================
// STATE / TEARDOWN / SPA NAV
// =========================================================================
function teardownAll(reason) {
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
  captionSession.currentVideoId = videoIdFromLocation();
  captionSession.weEnabledCC = false;        // fresh video — re-evaluate caption state
  teardownAll("navigation");
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
  emitDebug("content-boot", {
    enabled: !!settings.enabled,
    currentVideoId: captionSession.currentVideoId || "",
    readyState: document.readyState
  });
  applyStateToDom(true);
  syncCaptions();            // auto-enable YouTube CC so subtitles show on load
  scheduleCueRecovery(INITIAL_CUE_RECOVERY_MS);
});
