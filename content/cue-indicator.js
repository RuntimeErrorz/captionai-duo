// content/cue-indicator.js — Content script.
// Owns loading indicator timers and cue ingestion dispatch.
"use strict";

function clearPendingTimer() {
  if (captionSession.pendingTimer) {
    clearTimeout(captionSession.pendingTimer);
    captionSession.pendingTimer = null;
  }
  captionSession.pendingIndicatorKey = "";
}

function pendingTranslationScopeKey(gIdx) {
  return YTDS_SHARED.pendingTranslationScopeKey(gIdx, captionSession.deepseekGroupToBatch);
}

// Lexical token groups can advance several times inside 400 ms. The old
// timer captured gIdx and restarted at every token, so a slow DeepSeek batch
// could leave the previous translation visible indefinitely without ever
// reaching the loading indicator. Scope the timer to the semantic API batch
// and inspect the current token only when it fires.
function armPendingTranslationIndicator(gIdx, immediate) {
  const scopeKey = pendingTranslationScopeKey(gIdx);
  if (!scopeKey) return;
  if (captionSession.pendingIndicatorKey !== scopeKey) {
    clearPendingTimer();
    captionSession.pendingIndicatorKey = scopeKey;
  } else if (captionSession.pendingTimer && immediate) {
    clearTimeout(captionSession.pendingTimer);
    captionSession.pendingTimer = null;
  } else if (!immediate) {
    return;
  }
  const pVid = captionSession.cueVideoId;
  const pEpoch = captionSession.cueEpoch;
  const pendingSessionToken = captureCaptionSession();
  const showPending = () => {
    captionSession.pendingTimer = null;
    if (!isCaptionSessionCurrent(pendingSessionToken) ||
        captionSession.pendingIndicatorKey !== scopeKey || pEpoch !== captionSession.cueEpoch || pVid !== captionSession.cueVideoId) {
      if (captionSession.pendingIndicatorKey === scopeKey) captionSession.pendingIndicatorKey = "";
      return;
    }
    if (captionSession.activeGroupIdx < 0 || captionSession.activeCueIdx < 0 || !captionSession.cueList ||
        pendingTranslationScopeKey(captionSession.activeGroupIdx) !== scopeKey) {
      captionSession.pendingIndicatorKey = "";
      return;
    }
    if (captionSession.transCache.has(groupKey(captionSession.activeGroupIdx))) {
      captionSession.pendingIndicatorKey = "";
      return;
    }
    const source = sourceForDisplayedCue(captionSession.activeCueIdx, captionSession.cueList[captionSession.activeCueIdx]);
    setTranslation("…", source);
    // Keep the scope key after firing. Token changes inside this unresolved
    // batch must neither restart the timer nor disturb the indicator.
  };
  if (immediate) showPending();
  else captionSession.pendingTimer = setTimeout(showPending, PENDING_ELLIPSIS_MS);
}

function onCues(data) {
  if (!captionSession.currentVideoId || data.videoId !== captionSession.currentVideoId) return;
  if (!Number.isInteger(data.nonce) || data.nonce !== captionSession.configNonce) return;
  stopCueRecovery();
  // Sort the original json3 cue timeline before assigning lexical coordinates.
  const nextCueList = sanitizeCueList(data.cues);
  if (!nextCueList) { onNoCues(data); return; }
  nextCueList.sort((a, b) => a.start - b.start);
  computeCueEnds(nextCueList);
  const nextVideoId = data.videoId || captionSession.currentVideoId;
  const nextTrackKind = data.trackKind === "asr" ? "asr"
                      : data.trackKind ? "manual" : "";
  const nextSourceLang = typeof data.sourceLang === "string" &&
    /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(data.sourceLang)
    ? data.sourceLang.slice(0, 24) : "";
  const nextTrackId = typeof data.captionTrackId === "string" &&
    /^[A-Za-z0-9._:-]{1,160}$/.test(data.captionTrackId)
    ? data.captionTrackId : "auto";
  if (typeof rememberCaptionTrackFromCue === "function") {
    rememberCaptionTrackFromCue({
      captionTrackId: nextTrackId,
      sourceLang: nextSourceLang,
      trackKind: nextTrackKind
    });
  }
  const nextSignature = cueTrackFingerprint(
    nextVideoId, nextTrackKind, nextSourceLang, nextTrackId, nextCueList
  );
  if (captionSession.cueTimer && captionSession.cueVideoId === nextVideoId && captionSession.cueTrackSignature === nextSignature) {
    captionSession.duplicateCueEvents++;
    if (captionSession.duplicateCueEvents === 1 || captionSession.duplicateCueEvents % 25 === 0) {
      emitDebug("cues-duplicate-ignored", {
        cueCount: nextCueList.length,
        duplicateCount: captionSession.duplicateCueEvents
      });
    }
    return;
  }
  captionSession.duplicateCueEvents = 0;
  captionSession.cueTrackSignature = nextSignature;
  captionSession.cueList = nextCueList;
  captionSession.cueVideoId = nextVideoId;
  captionSession.cueTrackKind = nextTrackKind;
  captionSession.cueSourceLang = nextSourceLang;
  captionSession.cueTrackId = nextTrackId;
  captionSession.lastDebugCueIdx = -1;
  if (!captionSession.cueList.length) { onNoCues(data); return; }
  buildHybridCueGroups(captionSession.cueList);
  emitDebug("cues-loaded", {
    cueCount: captionSession.cueList.length,
    trackKind: captionSession.cueTrackKind,
    sourceLang: captionSession.cueSourceLang,
    groupCount: captionSession.sentGroups ? captionSession.sentGroups.length : 0,
    batchCount: captionSession.deepseekBatchWindows.length,
    regionCount: captionSession.deepseekCommitRegions.length,
    firstCueStartMs: captionSession.cueList.length ? captionSession.cueList[0].start : 0,
    lastCueEndMs: captionSession.cueList.length ? captionSession.cueList[captionSession.cueList.length - 1].end : 0,
    sourceChars: captionSession.cueList.reduce((sum, cue) => sum + String(cue.text || "").length, 0)
  });
  startCueLoop();
}
