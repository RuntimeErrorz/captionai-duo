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
  "translation-fetch-start",
  "translation-fetch-success",
  "translation-fetch-error",
  "player-timedtext-response",
  "timedtext-watchdog-expired"
]);

function onInjectMessage(evt) {
  if (evt.source !== window) return;
  if (evt.origin !== location.origin) return;
  const d = evt.data;
  if (!d || d.source !== "ytds-inject") return;
  if (d.type === "caption-tracks") {
    if (d.videoId !== captionSession.currentVideoId) return;
    const tracks = Array.isArray(d.tracks) ? d.tracks.map(normalizeCaptionTrack).filter(Boolean) : [];
    captionSession.availableCaptionTracks = tracks;
    const preferred = normalizeCaptionTrackSelection(d.preferredTrackId);
    captionSession.preferredCaptionTrackId = tracks.some((track) => track.id === preferred)
      ? preferred : tracks.length === 1 ? tracks[0].id : "";
    const reported = normalizeCaptionTrackSelection(d.selectedTrackId);
    if (reported === "auto" || tracks.some((track) => track.id === reported)) {
      captionSession.selectedCaptionTrackId = reported;
    }
    const reportedTranslation = normalizeTranslationTrackSelection(d.selectedTranslationTrackId);
    if (reportedTranslation === "ai" || tracks.some((track) => track.id === reportedTranslation)) {
      captionSession.selectedTranslationTrackId = reportedTranslation;
    } else if (!tracks.some((track) => track.id === captionSession.selectedTranslationTrackId)) {
      captionSession.selectedTranslationTrackId = "ai";
    }
    emitDebug("caption-track-catalog", {
      reason: String(d.catalogReason || "changed").slice(0, 40),
      trackCount: tracks.length,
      tracks: tracks.map((track) => ({
        id: track.id,
        languageCode: track.languageCode,
        label: track.label,
        kind: track.kind,
        labelFallback: String(track.label || "").toLowerCase() ===
          String(track.languageCode || "").toLowerCase()
      }))
    });
    return;
  }
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
  else if (d.type === "translation-cues") onManualTranslationCues(d);
  else if (d.type === "translation-nocues" || d.type === "translation-cleared") {
    if (d.type === "translation-cleared" ||
        d.captionTrackId === captionSession.selectedTranslationTrackId) {
      clearManualTranslationCues();
    }
  }
}

function sendConfig(reason, reuseNonce) {
  try {
    const nonce = reuseNonce && Number.isInteger(captionSession.configNonce) && captionSession.configNonce > 0
      ? captionSession.configNonce : nextConfigNonce();
    captionSession.configNonce = nonce;
    emitDebug("cue-config-sent", {
      nonce,
      reason: String(reason || "request"),
      captionTrackId: normalizeCaptionTrackSelection(captionSession.selectedCaptionTrackId) || "auto",
      translationTrackId: normalizeTranslationTrackSelection(captionSession.selectedTranslationTrackId) || "ai",
      captionButton: captionButtonDebugState()
    });
    window.postMessage({
      source: "ytds-content",
      type: "config",
      nonce,
      captionTrackId: normalizeCaptionTrackSelection(captionSession.selectedCaptionTrackId) || "auto",
      translationTrackId: normalizeTranslationTrackSelection(captionSession.selectedTranslationTrackId) || "ai"
    }, location.origin);
  } catch (_e) { /* ignore */ }
}

function normalizeCaptionTrackSelection(value) {
  const text = String(value || "").trim().slice(0, 160);
  if (!text || text === "auto") return "auto";
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : "";
}

function normalizeTranslationTrackSelection(value) {
  const text = String(value || "").trim().slice(0, 160);
  if (!text || text === "ai") return "ai";
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : "";
}

function onNoCues(data) {
  if (!data || !captionSession.currentVideoId || data.videoId !== captionSession.currentVideoId) return;
  if (!Number.isInteger(data.nonce) || data.nonce !== captionSession.configNonce) return;
  stopCueLoop();
  resetCaptionSessionState("caption-cues-unavailable");
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
  captionSession.cueTrackId = "";
  captionSession.cueTrackSignature = "";
  emitDebug("cues-unavailable", {
    reason: String(data.reason || "unknown"),
    detail: String(data.detail || "").slice(0, 240),
    requestFreshSource: !!data.requestFreshSource,
    captionButton: captionButtonDebugState()
  });
  if (!settings.enabled) return;
  if (data.requestFreshSource) forceCaptionReload("empty-player-source");
  scheduleCueRecovery();
}

function normalizeCaptionTrack(value) {
  if (!value || typeof value !== "object") return null;
  const id = normalizeCaptionTrackSelection(value.id);
  const languageCode = String(value.languageCode || "").trim().slice(0, 24);
  const label = String(value.label || languageCode).replace(/\s+/g, " ").trim().slice(0, 120);
  if (!id || id === "auto" ||
      !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(languageCode) || !label) return null;
  return { id, languageCode, label, kind: value.kind === "asr" ? "asr" : "manual" };
}

// A valid cue response is also authoritative evidence that the current video
// has an active caption track. Keep that evidence in the content-side catalog
// so a navigation cannot leave the popup empty when YouTube's player response
// arrives later (or omits its caption-track renderer altogether).
function rememberCaptionTrackFromCue(data) {
  if (!data || typeof data !== "object") return false;
  const languageCode = String(data.sourceLang || "").trim().replace(/_/g, "-").slice(0, 24);
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(languageCode)) return false;
  const kind = data.trackKind === "asr" ? "asr" : "manual";
  const reportedId = normalizeCaptionTrackSelection(data.captionTrackId);
  const id = reportedId && reportedId !== "auto"
    ? reportedId : `track:${languageCode.toLowerCase()}:${kind}:observed`;
  const tracks = Array.isArray(captionSession.availableCaptionTracks)
    ? captionSession.availableCaptionTracks : [];
  let track = tracks.find((item) => item && item.id === id);
  if (!track) {
    const sameKind = tracks.filter((item) => item &&
      item.languageCode === languageCode && item.kind === kind);
    if (sameKind.length === 1) track = sameKind[0];
  }
  let changed = false;
  if (!track) {
    if (tracks.length >= 100) return false;
    track = { id, languageCode, label: languageCode, kind };
    captionSession.availableCaptionTracks = tracks.concat(track);
    changed = true;
  }
  if (captionSession.selectedCaptionTrackId === "auto" &&
      (!captionSession.preferredCaptionTrackId ||
       !captionSession.availableCaptionTracks.some((item) =>
         item.id === captionSession.preferredCaptionTrackId))) {
    captionSession.preferredCaptionTrackId = track.id;
    changed = true;
  }
  return changed;
}

function requestCaptionTrackCatalog(force) {
  try {
    window.postMessage({
      source: "ytds-content",
      type: "caption-tracks-request",
      videoId: String(captionSession.currentVideoId || ""),
      nonce: Number(captionSession.configNonce) || 0,
      force: force === true
    }, location.origin);
  } catch (_e) { /* ignore */ }
}

function captionTrackResponse() {
  return {
    ok: true,
    videoId: captionSession.currentVideoId,
    tracks: captionSession.availableCaptionTracks.map((track) => ({ ...track })),
    preferredTrackId: captionSession.preferredCaptionTrackId,
    selectedTrackId: normalizeCaptionTrackSelection(captionSession.selectedCaptionTrackId) || "auto",
    selectedTranslationTrackId:
      normalizeTranslationTrackSelection(captionSession.selectedTranslationTrackId) || "ai"
  };
}

function clearManualTranslationCues() {
  captionSession.translationCueList = null;
  captionSession.translationCueVideoId = "";
  captionSession.translationCueTrackKind = "";
  captionSession.translationCueSourceLang = "";
  captionSession.translationCueTrackId = "";
  captionSession.translationCueSignature = "";
  if (captionSession.cueList) cueTick();
}

function manualTranslationSelected() {
  return captionSession.selectedTranslationTrackId !== "ai";
}

function manualTranslationTextAt(timeMs) {
  const list = captionSession.translationCueList;
  if (!Array.isArray(list) || !list.length) return "";
  let lo = 0, hi = list.length - 1, index = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= timeMs) { index = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  for (let i = index; i >= 0 && index - i <= 8; i--) {
    if (timeMs < list[i].end) return list[i].text;
  }
  return "";
}

function onManualTranslationCues(data) {
  if (!data || data.videoId !== captionSession.currentVideoId ||
      !Number.isInteger(data.nonce) || data.nonce !== captionSession.configNonce ||
      !manualTranslationSelected() || data.captionTrackId !== captionSession.selectedTranslationTrackId) return;
  const list = sanitizeCueList(data.cues);
  if (!list || !list.length) return;
  list.sort((a, b) => a.start - b.start);
  computeCueEnds(list);
  captionSession.translationCueList = list;
  captionSession.translationCueVideoId = data.videoId;
  captionSession.translationCueTrackKind = data.trackKind === "asr" ? "asr" : "manual";
  captionSession.translationCueSourceLang = typeof data.sourceLang === "string"
    ? data.sourceLang.slice(0, 24) : "";
  captionSession.translationCueTrackId = data.captionTrackId;
  captionSession.translationCueSignature = `${data.videoId}|${data.captionTrackId}|${list.length}|${list[0].start}`;
  if (captionSession.cueList) cueTick();
}

function clearCaptionTrackPresentation(clearTranslation = true) {
  stopCueLoop();
  stopCueRecovery();
  resetCaptionSessionState("caption-track-selection");
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
  captionSession.cueTrackId = "";
  captionSession.cueTrackSignature = "";
  if (clearTranslation) clearManualTranslationCues();
  if (overlay) removeOverlay();
  if (settings.enabled) ensureOverlay();
}

function setCaptionTrackSelection(value) {
  const trackId = normalizeCaptionTrackSelection(value);
  if (!trackId) return { ok: false, reason: "invalid-track" };
  if (trackId !== "auto" &&
      !captionSession.availableCaptionTracks.some((track) => track.id === trackId)) {
    return { ok: false, reason: "unknown-track" };
  }
  if (trackId === captionSession.selectedCaptionTrackId) return captionTrackResponse();
  captionSession.selectedCaptionTrackId = trackId;
  // The translation track is independent. Keep its loaded timeline when only
  // the original language changes.
  clearCaptionTrackPresentation(false);
  if (settings.enabled) sendConfig("caption-track-selection");
  return captionTrackResponse();
}

function setCaptionTranslationSelection(value) {
  const trackId = normalizeTranslationTrackSelection(value);
  if (!trackId) return { ok: false, reason: "invalid-track" };
  if (trackId !== "ai" &&
      !captionSession.availableCaptionTracks.some((track) => track.id === trackId)) {
    return { ok: false, reason: "unknown-track" };
  }
  if (trackId === captionSession.selectedTranslationTrackId) return captionTrackResponse();
  captionSession.selectedTranslationTrackId = trackId;
  clearCaptionTrackPresentation();
  if (settings.enabled) sendConfig("translation-track-selection");
  return captionTrackResponse();
}
