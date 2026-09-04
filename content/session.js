// Caption-session state, identity and centralized semantic invalidation.
"use strict";

function createCaptionSessionState(initialVideoId) {
  const state = {
    revision: 0,
    token: null,
    cueList: null,
    cueVideoId: "",
    cueTimer: null,
    cueFrameId: null,
    cueLoopVideo: null,
    activeCueIdx: -1,
    cueEpoch: 0,
    transCache: new Map(),
    semanticUnitCache: new Map(),
    get deepseekUnitCache() { return this.semanticUnitCache; },
    semanticSourceCache: new Map(),
    get deepseekSourceCache() { return this.semanticSourceCache; },
    semanticAlignedChunksCache: new Map(),
    get deepseekAlignedChunksCache() { return this.semanticAlignedChunksCache; },
    semanticDisplayCache: new Map(),
    get deepseekDisplayCache() { return this.semanticDisplayCache; },
    semanticRequestMeta: new Map(),
    get deepseekRequestMeta() { return this.semanticRequestMeta; },
    semanticRequestSerial: 0,
    get deepseekRequestSerial() { return this.semanticRequestSerial; },
    set deepseekRequestSerial(v) { this.semanticRequestSerial = v; },
    semanticCommitRegions: [],
    get deepseekCommitRegions() { return this.semanticCommitRegions; },
    set deepseekCommitRegions(v) { this.semanticCommitRegions = v; },
    semanticGroupToCommitRegion: [],
    get deepseekGroupToCommitRegion() { return this.semanticGroupToCommitRegion; },
    set deepseekGroupToCommitRegion(v) { this.semanticGroupToCommitRegion = v; },
    semanticCommitStateByRegion: new Map(),
    get deepseekCommitStateByRegion() { return this.semanticCommitStateByRegion; },
    semanticLayoutWidth: 0,
    semanticResizeObserver: null,
    semanticReflowFrame: null,
    displayMeasureCanvas: null,
    transInflight: new Set(),
    semanticRetryCounts: new Map(),
    get deepseekRetryCounts() { return this.semanticRetryCounts; },
    semanticExhaustedRegions: new Map(),
    get deepseekExhaustedRegions() { return this.semanticExhaustedRegions; },
    semanticVisibleErrors: new Map(),
    get deepseekVisibleErrors() { return this.semanticVisibleErrors; },
    semanticSpeculativeBackoffUntil: 0,
    get deepseekSpeculativeBackoffUntil() { return this.semanticSpeculativeBackoffUntil; },
    set deepseekSpeculativeBackoffUntil(v) { this.semanticSpeculativeBackoffUntil = v; },
    semanticSpeculativeResumeTimer: null,
    get deepseekSpeculativeResumeTimer() { return this.semanticSpeculativeResumeTimer; },
    set deepseekSpeculativeResumeTimer(v) { this.semanticSpeculativeResumeTimer = v; },
    semanticFocusGeneration: 0,
    get deepseekFocusGeneration() { return this.semanticFocusGeneration; },
    set deepseekFocusGeneration(v) { this.semanticFocusGeneration = v; },
    semanticFocusedBatchIndex: -1,
    get deepseekFocusedBatchIndex() { return this.semanticFocusedBatchIndex; },
    set deepseekFocusedBatchIndex(v) { this.semanticFocusedBatchIndex = v; },
    semanticSeekSettleTimer: null,
    get deepseekSeekSettleTimer() { return this.semanticSeekSettleTimer; },
    set deepseekSeekSettleTimer(v) { this.semanticSeekSettleTimer = v; },
    semanticSeekSettling: false,
    get deepseekSeekSettling() { return this.semanticSeekSettling; },
    set deepseekSeekSettling(v) { this.semanticSeekSettling = v; },
    semanticPendingSeekTimeMs: 0,
    get deepseekPendingSeekTimeMs() { return this.semanticPendingSeekTimeMs; },
    set deepseekPendingSeekTimeMs(v) { this.semanticPendingSeekTimeMs = v; },
    sentGroups: null,
    cueToGroup: null,
    cueToGroups: null,
    semanticBatchWindows: [],
    get deepseekBatchWindows() { return this.semanticBatchWindows; },
    set deepseekBatchWindows(v) { this.semanticBatchWindows = v; },
    semanticGroupToBatch: [],
    get deepseekGroupToBatch() { return this.semanticGroupToBatch; },
    set deepseekGroupToBatch(v) { this.semanticGroupToBatch = v; },
    activeGroupIdx: -1,
    cueTrackKind: "",
    cueSourceLang: "",
    cueTrackId: "",
    cueTrackSignature: "",
    availableCaptionTracks: [],
    preferredCaptionTrackId: "",
    selectedCaptionTrackId: "auto",
    selectedTranslationTrackId: "ai",
    translationCueList: null,
    translationCueVideoId: "",
    translationCueTrackKind: "",
    translationCueSourceLang: "",
    translationCueTrackId: "",
    translationCueSignature: "",
    duplicateCueEvents: 0,
    pendingTimer: null,
    pendingIndicatorKey: "",
    currentVideoId: String(initialVideoId || ""),
    configNonce: 0,
    nonceFallback: 0,
    cueRecoveryTimer: null,
    cueRecoveryAttempt: 0,
    navigationPollTimer: null,
    lastDebugCueIdx: -1,
    weEnabledCC: false
  };
  state.token = Object.freeze({
    revision: state.revision,
    reason: "boot",
    videoId: state.currentVideoId,
    focusGeneration: state.semanticFocusGeneration
  });
  return state;
}

let captionSession = createCaptionSessionState(videoIdFromLocation());

function captionSessionDiagnosticContext() {
  return {
    sessionRevision: Math.max(0, Number(captionSession.revision) || 0),
    sessionReason: String(captionSession.token && captionSession.token.reason || ""),
    cueEpoch: Math.max(0, Number(captionSession.cueEpoch) || 0),
    focusGeneration: Math.max(0, Number(captionSession.semanticFocusGeneration) || 0),
    requestSerial: Math.max(0, Number(captionSession.semanticRequestSerial) || 0),
    inflightRequests: captionSession.semanticRequestMeta.size,
    activeGroup: Number(captionSession.activeGroupIdx),
    activeCue: Number(captionSession.activeCueIdx)
  };
}

if (typeof setContentDebugContextProvider === "function") {
  setContentDebugContextProvider(captionSessionDiagnosticContext);
}

function emitCaptionStateTransition(machine, transition, data) {
  if (typeof emitDebug !== "function") return;
  emitDebug("state-transition", Object.assign({
    machine: String(machine || "caption-session"),
    transition: String(transition || "changed")
  }, data || {}));
}

function captureCaptionSession() {
  return captionSession.token;
}

function isCaptionSessionCurrent(token) {
  return !!token && token === captionSession.token;
}

// Rotate one opaque identity for every event that revokes asynchronous repaint
// authority. Serialized fields remain transport identity and diagnostics only.
function invalidateCaptionSession(reason) {
  const previousToken = captionSession.token;
  const previousInflightRequests = captionSession.semanticRequestMeta.size;
  captionSession.revision++;
  captionSession.cueEpoch++;
  captionSession.token = Object.freeze({
    revision: captionSession.revision,
    reason: String(reason || "invalidated"),
    videoId: String(captionSession.cueVideoId || captionSession.currentVideoId || ""),
    focusGeneration: Math.max(0, Number(captionSession.semanticFocusGeneration) || 0)
  });
  emitCaptionStateTransition("caption-session", "invalidated", {
    reason: String(reason || "invalidated"),
    previousRevision: Math.max(0, Number(previousToken && previousToken.revision) || 0),
    nextRevision: captionSession.revision,
    previousReason: String(previousToken && previousToken.reason || ""),
    revokedInflightRequests: previousInflightRequests
  });
  return captionSession.token;
}

// All full semantic resets go through this owner. Track arrays themselves are
// intentionally left to the lifecycle that replaces or removes the track.
function resetCaptionSessionState(reason, options) {
  const opts = options || {};
  const previousVideoId = String(
    captionSession.cueVideoId || captionSession.currentVideoId || ""
  );
  const token = invalidateCaptionSession(reason);

  if (opts.cancelRemote !== false && previousVideoId && extensionContextAlive()) {
    try { sendRuntimeMessage({ type: "cancelDeepSeek", videoId: previousVideoId }); }
    catch (_e) { /* worker unavailable */ }
  }
  captionSession.transCache.clear();
  captionSession.semanticUnitCache.clear();
  captionSession.semanticSourceCache.clear();
  captionSession.semanticAlignedChunksCache.clear();
  captionSession.semanticDisplayCache.clear();
  captionSession.semanticRequestMeta.clear();
  captionSession.transInflight.clear();
  captionSession.semanticRetryCounts.clear();
  captionSession.semanticExhaustedRegions.clear();
  captionSession.semanticVisibleErrors.clear();
  if (captionSession.semanticSpeculativeResumeTimer) {
    clearTimeout(captionSession.semanticSpeculativeResumeTimer);
    captionSession.semanticSpeculativeResumeTimer = null;
  }
  captionSession.semanticSpeculativeBackoffUntil = 0;
  if (typeof resetSemanticCommitTimeline === "function") resetSemanticCommitTimeline();
  else if (typeof resetDeepseekCommitTimeline === "function") resetDeepseekCommitTimeline();
  clearDeepseekSeekSettle();
  clearPendingTimer();
  captionSession.semanticFocusedBatchIndex = -1;
  captionSession.semanticLayoutWidth = 0;
  captionSession.activeGroupIdx = -1;
  if (captionSession.cueTimer) captionSession.activeCueIdx = -1;
  return token;
}
