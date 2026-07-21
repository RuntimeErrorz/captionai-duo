// Rendered-caption fallback mode.
"use strict";

// =========================================================================
// FALLBACK MODE (v1 rendered-scrape)
// =========================================================================
function cancelFallbackRequest() {
  if (!captionSession.fallbackRequestId) return;
  sendRuntimeMessage({
    type: "cancelDeepSeekRequest",
    videoId: captionSession.currentVideoId,
    requestId: captionSession.fallbackRequestId
  });
  captionSession.fallbackRequestId = "";
  captionSession.fallbackSessionToken = null;
}

function scheduleTranslate(text) {
  if (captionSession.debounceTimer) clearTimeout(captionSession.debounceTimer);
  const scheduledSessionToken = captureCaptionSession();
  captionSession.debounceTimer = setTimeout(() => {
    if (!isCaptionSessionCurrent(scheduledSessionToken)) return;
    if (text !== captionSession.lastSource) return;        // caption already moved on
    if (text === captionSession.lastTransSource) return;   // identical text already shown
    const token = ++captionSession.lastReqToken;
    cancelFallbackRequest();
    const requestId = `fallback:${token}`;
    const requestSessionToken = captureCaptionSession();
    captionSession.fallbackRequestId = requestId;
    captionSession.fallbackSessionToken = requestSessionToken;
    sendRuntimeMessage(
      {
        type: "translateBatch",
        requestId,
        videoId: captionSession.currentVideoId,
        targetLang: settings.targetLang,
        sourceLang: captionSession.cueSourceLang,
        urgent: true,
        focusGeneration: captionSession.deepseekFocusGeneration,
        items: [{ id: "0", cueId: "0", text, startMs: 0, endMs: 1000, hardAfter: true }],
        contextBefore: [],
        contextAfter: []
      },
      (resp, runtimeError) => {
        if (captionSession.fallbackRequestId === requestId) {
          captionSession.fallbackRequestId = "";
          if (captionSession.fallbackSessionToken === requestSessionToken) captionSession.fallbackSessionToken = null;
        }
        if (runtimeError) return;
        if (!isCaptionSessionCurrent(requestSessionToken)) return;
        if (token !== captionSession.lastReqToken) return;
        if (text !== captionSession.lastSource) return;
        const translated = resp && resp.ok && Array.isArray(resp.translations) &&
          resp.translations[0] && resp.translations[0].translation;
        if (translated) {
          setTranslation(translated, text);
        }
      }
    );
  }, DEBOUNCE_MS);
}

function fallbackTick() {
  if (!extensionContextAlive()) { stopForInvalidatedExtensionContext(); return; }
  if (!settings.enabled) return;
  const text = readNativeCaption();
  if (text === captionSession.lastSource) return;
  cancelFallbackRequest();
  captionSession.lastSource = text;

  if (!text) {
    if (captionSession.debounceTimer) clearTimeout(captionSession.debounceTimer);
    setOriginal("");
    setTranslation("", "");
    return;
  }

  stopCueRecovery();
  setOriginal(text);
  scheduleTranslate(text);
}

function startFallback() {
  if (captionSession.pollTimer) return;
  ensureOverlay();
  captionSession.pollTimer = setInterval(fallbackTick, 200);
}

function stopFallback() {
  if (captionSession.pollTimer) { clearInterval(captionSession.pollTimer); captionSession.pollTimer = null; }
  if (captionSession.debounceTimer) { clearTimeout(captionSession.debounceTimer); captionSession.debounceTimer = null; }
  cancelFallbackRequest();
  captionSession.lastReqToken++;
  captionSession.lastSource = "";
  captionSession.lastTransSource = "";
}

function onNoCues(data) {
  if (!data || !captionSession.currentVideoId || data.videoId !== captionSession.currentVideoId) return;
  if (!Number.isInteger(data.nonce) || data.nonce !== captionSession.configNonce) return;
  captionSession.nocuesFallback = true;
  stopCueLoop();
  resetCaptionSessionState("fallback-mode");
  captionSession.cueList = null;
  captionSession.sentGroups = null;
  captionSession.cueToGroup = null;
  captionSession.cueToGroups = null;
  captionSession.deepseekBatchWindows = [];
  captionSession.deepseekGroupToBatch = [];
  captionSession.cueTrackKind = "";
  captionSession.cueSourceLang = "";
  captionSession.cueTrackSignature = "";
  captionSession.duplicateCueEvents = 0;
  emitDebug("cues-unavailable", {
    reason: String(data.reason || "unknown"),
    detail: String(data.detail || "").slice(0, 240),
    captionButton: captionButtonDebugState()
  });
  if (settings.enabled) {
    startFallback();
    scheduleCueRecovery();
  }
}
