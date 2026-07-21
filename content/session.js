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
    deepseekUnitCache: new Map(),
    deepseekSourceCache: new Map(),
    deepseekAlignedChunksCache: new Map(),
    deepseekDisplayCache: new Map(),
    deepseekRequestMeta: new Map(),
    deepseekRequestSerial: 0,
    deepseekCommitRegions: [],
    deepseekGroupToCommitRegion: [],
    deepseekCommitStateByRegion: new Map(),
    semanticLayoutWidth: 0,
    semanticResizeObserver: null,
    semanticReflowFrame: null,
    displayMeasureCanvas: null,
    transInflight: new Set(),
    deepseekRetryCounts: new Map(),
    deepseekExhaustedRegions: new Map(),
    deepseekFocusGeneration: 0,
    deepseekFocusedBatchIndex: -1,
    deepseekSeekSettleTimer: null,
    deepseekSeekSettling: false,
    deepseekPendingSeekTimeMs: 0,
    sentGroups: null,
    cueToGroup: null,
    cueToGroups: null,
    deepseekBatchWindows: [],
    deepseekGroupToBatch: [],
    activeGroupIdx: -1,
    cueTrackKind: "",
    cueSourceLang: "",
    cueTrackSignature: "",
    duplicateCueEvents: 0,
    pendingTimer: null,
    pendingIndicatorKey: "",
    pollTimer: null,
    debounceTimer: null,
    lastSource: "",
    lastTransSource: "",
    lastReqToken: 0,
    fallbackRequestId: "",
    fallbackSessionToken: null,
    currentVideoId: String(initialVideoId || ""),
    nocuesFallback: false,
    configNonce: 0,
    nonceFallback: 0,
    cueRecoveryTimer: null,
    cueRecoveryAttempt: 0,
    lastDebugCueIdx: -1,
    weEnabledCC: false
  };
  state.token = Object.freeze({
    revision: state.revision,
    reason: "boot",
    videoId: state.currentVideoId,
    focusGeneration: state.deepseekFocusGeneration
  });
  return state;
}

let captionSession = createCaptionSessionState(videoIdFromLocation());

function captureCaptionSession() {
  return captionSession.token;
}

function isCaptionSessionCurrent(token) {
  return !!token && token === captionSession.token;
}

// Rotate one opaque identity for every event that revokes asynchronous repaint
// authority. Serialized fields remain transport identity and diagnostics only.
function invalidateCaptionSession(reason) {
  captionSession.revision++;
  captionSession.cueEpoch++;
  captionSession.token = Object.freeze({
    revision: captionSession.revision,
    reason: String(reason || "invalidated"),
    videoId: String(captionSession.cueVideoId || captionSession.currentVideoId || ""),
    focusGeneration: Math.max(0, Number(captionSession.deepseekFocusGeneration) || 0)
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
  cancelFallbackRequest();
  captionSession.fallbackSessionToken = null;
  captionSession.lastReqToken++;
  captionSession.lastTransSource = "";

  captionSession.transCache.clear();
  captionSession.deepseekUnitCache.clear();
  captionSession.deepseekSourceCache.clear();
  captionSession.deepseekAlignedChunksCache.clear();
  captionSession.deepseekDisplayCache.clear();
  captionSession.deepseekRequestMeta.clear();
  captionSession.transInflight.clear();
  captionSession.deepseekRetryCounts.clear();
  captionSession.deepseekExhaustedRegions.clear();
  resetDeepseekCommitTimeline();
  clearDeepseekSeekSettle();
  clearPendingTimer();
  captionSession.deepseekFocusedBatchIndex = -1;
  captionSession.semanticLayoutWidth = 0;
  captionSession.activeGroupIdx = -1;
  if (captionSession.cueTimer) captionSession.activeCueIdx = -1;
  return token;
}
