// Semantic request ownership, cancellation and retry state machine.
"use strict";

const AI_STALE_PREFETCH_GRACE_MS = 2500;
const AI_PLAYBACK_STARTUP_GRACE_MS = 6000;
// A request-limited provider may need ~8 s before its first byte.
const AI_REQUEST_LIMITED_STARTUP_GRACE_MS = 14000;
const AI_PLAYBACK_PROGRESS_GRACE_MS = 4000;
const AI_HIGH_SPEED_STARTUP_GRACE_MS = 3500;
const AI_HIGH_SPEED_PROGRESS_GRACE_MS = 2500;
const AI_STREAM_HANDOFF_MIN_ITEMS = 64;
const AI_HIGH_SPEED_STREAM_HANDOFF_MIN_ITEMS = 16;
const AI_STREAM_HANDOFF_MAX_REMAINING_ITEMS = 48;
const AI_SPECULATIVE_REQUEST_ITEMS = 96;

function aiRequestHasProgress(request) {
  if (!request) return false;
  const requestStart = Number(request.requestStart);
  const progressCursor = Number(request.progressCursor);
  const lastProgressAt = Number(request.lastProgressAt);
  if (!Number.isInteger(requestStart) || !Number.isInteger(progressCursor) ||
      progressCursor <= requestStart || !Number.isFinite(lastProgressAt) ||
      lastProgressAt <= 0) return false;
  return Date.now() - lastProgressAt < AI_STALE_PREFETCH_GRACE_MS;
}
function aiRequestHasBufferedProgress(request) {
  if (!request || !request.prefetch || !Array.isArray(request.progressTranslations)) return false;
  const requestStart = Number(request.requestStart);
  if (!Number.isInteger(requestStart)) return false;
  return request.progressTranslations.some((item) => Number(item && item.id) === requestStart);
}
function aiRequestIsStaleForTarget(request, targetGroup) {
  if (!request || request.urgent || aiRequestHasProgress(request) ||
      (request.prefetch && aiRequestHasBufferedProgress(request))) return false;
  const target = Number(targetGroup);
  const requestEnd = Number(request.requestEnd);
  const startedAt = Number(request.startedAt);
  return Number.isInteger(target) && Number.isInteger(requestEnd) && target > requestEnd &&
    Number.isFinite(startedAt) && Date.now() - startedAt >= AI_STALE_PREFETCH_GRACE_MS;
}
function aiRequestIsPlaybackLagging(request, state, targetGroup) {
  if (!request || !request.urgent || !state || typeof getVideo !== "function") return false;
  if (typeof captionSession === "object" && captionSession && captionSession.transCache &&
      typeof groupKey === "function" && captionSession.transCache.has(groupKey(targetGroup))) {
    return false;
  }
  const rate = Number(getVideo() && getVideo().playbackRate);
  const highSpeed = rate >= 2.5;
  const requestLimited = typeof aiRequestLimited === "function" && aiRequestLimited();
  const lagThreshold = requestLimited ? 48 : (highSpeed ? 24 : (rate >= 1.75 ? 48 : 0));
  const target = Number(targetGroup);
  const cursor = Number(state.cursor);
  const requestStart = Number(request.requestStart);
  const progressCursor = Number(request.progressCursor);
  const startedAt = Number(request.startedAt);
  const lastProgressAt = Number(request.lastProgressAt);
  const hasStreamProgress = Number.isInteger(requestStart) &&
    Number.isInteger(progressCursor) && progressCursor > requestStart &&
    Number.isFinite(lastProgressAt) && lastProgressAt > startedAt;
  const referenceAt = hasStreamProgress ? lastProgressAt : startedAt;
  const startupGraceMs = requestLimited
    ? AI_REQUEST_LIMITED_STARTUP_GRACE_MS
    : (highSpeed ? AI_HIGH_SPEED_STARTUP_GRACE_MS : AI_PLAYBACK_STARTUP_GRACE_MS);
  const progressGraceMs = requestLimited
    ? AI_PLAYBACK_PROGRESS_GRACE_MS
    : (highSpeed ? AI_HIGH_SPEED_PROGRESS_GRACE_MS : AI_PLAYBACK_PROGRESS_GRACE_MS);
  const graceMs = hasStreamProgress ? progressGraceMs : startupGraceMs;
  return lagThreshold > 0 && Number.isInteger(target) && Number.isInteger(cursor) &&
    target - cursor >= lagThreshold && Number.isFinite(referenceAt) &&
    Date.now() - referenceAt >= graceMs;
}
function aiSeekBacktrackItems() {
  const base = Math.max(0, Math.floor(Number(AI_SEEK_BACKTRACK_ITEMS) || 0));
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  if (Number.isFinite(rate) && rate >= 2.5) return Math.min(base, 24);
  if (Number.isFinite(rate) && rate >= 1.75) return Math.min(base, 40);
  return base;
}
function aiLeadingUnitReachesRequestEnd(translationsValue, requestStartValue, requestEndValue) {
  const translations = Array.isArray(translationsValue) ? translationsValue : [];
  const requestStart = Number(requestStartValue);
  const requestEnd = Number(requestEndValue);
  if (!Number.isInteger(requestStart) || !Number.isInteger(requestEnd) || requestEnd < requestStart) {
    return false;
  }
  const first = translations.find((item) => Number(item && item.id) === requestStart);
  const unitId = String(first && first.unitId || "");
  return !!unitId && translations.some((item) =>
    Number(item && item.id) === requestEnd && String(item && item.unitId || "") === unitId
  );
}
function aiAlignedRecoveryInput(translationsValue, requestStartValue) {
  const translations = Array.isArray(translationsValue) ? translationsValue : [];
  const requestStart = Number(requestStartValue);
  if (!Number.isInteger(requestStart) || requestStart < 0) return translations;
  const visibleUnitIds = new Set(translations
    .filter((item) => Number(item && item.id) >= requestStart)
    .map((item) => String(item && item.unitId || ""))
    .filter(Boolean));
  return translations.filter((item) => {
    const id = Number(item && item.id);
    if (id >= requestStart) return true;
    return visibleUnitIds.has(String(item && item.unitId || ""));
  });
}
function aiStreamHandoffReady(request, state, maxRequestItems, normalMaxRequestItems) {
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  const accelerated = Number.isFinite(rate) && rate >= 1.75;
  if (!request || !state || !request.urgent ||
      (typeof aiRequestLimited === "function" && aiRequestLimited()) ||
      (!accelerated && Number(maxRequestItems) <= Number(normalMaxRequestItems))) return false;
  const requestStart = Number(request.requestStart);
  const requestEnd = Number(request.requestEnd);
  const cursor = Number(state.cursor);
  const targetThrough = Number(state.targetThrough);
  if (![requestStart, requestEnd, cursor, targetThrough].every(Number.isInteger)) return false;
  const minItems = Number.isFinite(rate) && rate >= 2.5
    ? AI_HIGH_SPEED_STREAM_HANDOFF_MIN_ITEMS
    : AI_STREAM_HANDOFF_MIN_ITEMS;
  return cursor - requestStart >= minItems &&
    requestEnd - cursor <= AI_STREAM_HANDOFF_MAX_REMAINING_ITEMS &&
    targetThrough - cursor >= minItems;
}
function handoffAiStream(regionIndex, request, state) {
  const inflightKey = `dsb:${regionIndex}`;
  if (!request || captionSession.semanticRequestMeta.get(inflightKey) !== request ||
      !state || state.cursor > state.targetThrough || state.cursor > state.limitEnd) return false;
  const continuationStart = state.cursor;
  request.streamHandoff = true;
  captionSession.semanticRequestMeta.delete(inflightKey);
  captionSession.transInflight.delete(inflightKey);
  emitCaptionStateTransition("semantic-request", "stream-handoff", {
    requestId: request.requestId,
    regionIndex,
    continuationStart
  });
  emitDebug("semantic-stream-handoff", {
    requestId: request.requestId,
    regionIndex,
    continuationStart,
    previousRequestEnd: request.requestEnd
  });
  const launch = () => {
    if (!isCaptionSessionCurrent(request.sessionToken) ||
        request.reqEpoch !== captionSession.cueEpoch ||
        request.reqVid !== captionSession.cueVideoId ||
        captionSession.semanticFocusGeneration !== request.focusGeneration ||
        state.cursor !== continuationStart || state.cursor > state.targetThrough ||
        state.cursor > state.limitEnd) return;
    aiRequestBatch(continuationStart, false, true, { bypassCache: true });
  };
  const sent = sendRuntimeMessage({
    type: "cancelAiTranslationRequest",
    videoId: captionSession.cueVideoId,
    requestId: request.requestId
  }, () => queueMicrotask(launch));
  if (!sent) queueMicrotask(launch);
  return true;
}
function aiBatchRetryKey(start, end, videoId, epoch) {
  return `${videoId}:${epoch}:${start}:${end}`;
}
function beginAiRequest(inflightKey, kind, start, end, urgent) {
  const existing = captionSession.semanticRequestMeta.get(inflightKey);
  if (existing) {
    if (!urgent || existing.urgent) return "";
    existing.urgent = true;
    existing.promotedAt = Date.now();
    emitCaptionStateTransition("semantic-request", "promoted", {
      requestId: existing.requestId, kind, start, end
    });
    emitDebug("ai-request-promoted", {
      kind, start, end, reusedRequestId: existing.requestId
    });
    return "";
  } else if (captionSession.transInflight.has(inflightKey)) {
    return "";
  }
  const requestId = `${kind}:${captionSession.semanticFocusGeneration}:${++captionSession.semanticRequestSerial}:${start}-${end}`;
  captionSession.semanticRequestMeta.set(inflightKey, {
    requestId,
    urgent: !!urgent,
    startedAt: Date.now(),
    lastProgressAt: 0,
    progressCursor: start,
    progressTranslations: [],
    progressRecoveryTranslations: []
  });
  captionSession.transInflight.add(inflightKey);
  emitCaptionStateTransition("semantic-request", "started", {
    requestId, kind, start, end, urgent: !!urgent
  });
  return requestId;
}
function finishAiRequest(inflightKey, requestId) {
  const current = captionSession.semanticRequestMeta.get(inflightKey);
  if (!current || current.requestId !== requestId) {
    emitCaptionStateTransition("semantic-request", "discarded", {
      requestId: String(requestId || ""),
      reason: current ? "request-owner-changed" : "request-owner-missing"
    });
    return null;
  }
  captionSession.semanticRequestMeta.delete(inflightKey);
  captionSession.transInflight.delete(inflightKey);
  emitCaptionStateTransition("semantic-request", "settled", {
    requestId,
    urgent: !!current.urgent
  });
  return current;
}
function aiPrefetchState(state) {
  if (!state || typeof state !== "object") return null;
  if (!Array.isArray(state.prefetchQueue)) state.prefetchQueue = [];
  if (!(state.prefetchQueued instanceof Set)) state.prefetchQueued = new Set();
  if (!(state.prefetchResponses instanceof Map)) state.prefetchResponses = new Map();
  return state;
}
function cancelAiRegionRequests(regionIndex, preserveFromValue) {
  const wanted = Number(regionIndex);
  const preserveFrom = Number.isInteger(Number(preserveFromValue)) ? Number(preserveFromValue) : -1;
  if (!Number.isInteger(wanted)) return;
  const prefix = `dsp:${wanted}:`;
  for (const [key, request] of Array.from(captionSession.semanticRequestMeta.entries())) {
    if (key !== `dsb:${wanted}` && !String(key).startsWith(prefix)) continue;
    if (preserveFrom >= 0 && request && request.prefetch &&
        Number(request.requestEnd) >= preserveFrom) continue;
    if (request && request.requestId) sendRuntimeMessage({
      type: "cancelAiTranslationRequest",
      videoId: captionSession.cueVideoId,
      requestId: request.requestId
    });
    captionSession.semanticRequestMeta.delete(key);
    captionSession.transInflight.delete(key);
  }
  const state = typeof aiCommitState === "function" ? aiCommitState(wanted) : null;
  if (state) { aiPrefetchState(state);
    if (preserveFrom < 0) {
      state.prefetchQueue.length = 0; state.prefetchQueued.clear(); state.prefetchResponses.clear();
    } else {
      state.prefetchQueue = state.prefetchQueue.filter((start) => start >= preserveFrom);
      state.prefetchQueued = new Set(state.prefetchQueue);
      for (const [start, stored] of Array.from(state.prefetchResponses.entries()))
        if (!stored || Number(stored.request && stored.request.requestEnd) < preserveFrom) state.prefetchResponses.delete(start);
    }
  }
}
function cancelAiRequestsBeforeRegion(regionIndex) {
  const wanted = Number(regionIndex);
  if (!Number.isInteger(wanted)) return;
  for (const [key, request] of Array.from(captionSession.semanticRequestMeta.entries())) {
    if (!request || !Number.isInteger(request.regionIndex) || request.regionIndex >= wanted) continue;
    if (request.requestId) sendRuntimeMessage({
      type: "cancelAiTranslationRequest",
      videoId: captionSession.cueVideoId,
      requestId: request.requestId
    });
    emitCaptionStateTransition("semantic-request", "cancelled", {
      requestId: request.requestId,
      reason: "obsolete-region-priority",
      previousRegionIndex: request.regionIndex,
      regionIndex: wanted
    });
    captionSession.semanticRequestMeta.delete(key);
    captionSession.transInflight.delete(key);
  }
  if (!(captionSession.semanticCommitStateByRegion instanceof Map)) return;
  for (const [index, state] of captionSession.semanticCommitStateByRegion.entries()) {
    if (Number(index) >= wanted) continue;
    aiPrefetchState(state);
    state.prefetchQueue.length = 0;
    state.prefetchQueued.clear();
    state.prefetchResponses.clear();
  }
}
function cancelAiStaleSpeculativeRequests(regionIndex, targetGroup) {
  const wanted = Number(regionIndex);
  const target = Number(targetGroup);
  if (!Number.isInteger(wanted) || !Number.isInteger(target)) return;
  const cancel = (inflightKey, request) => {
    if (!request || !aiRequestIsStaleForTarget(request, target)) return false;
    if (request.requestId) sendRuntimeMessage({
      type: "cancelAiTranslationRequest",
      videoId: captionSession.cueVideoId,
      requestId: request.requestId
    });
    emitCaptionStateTransition("semantic-request", "cancelled", {
      requestId: request.requestId,
      reason: "stale-prefetch-target-passed",
      regionIndex: wanted,
      targetGroup: target,
      requestStart: request.requestStart,
      requestEnd: request.requestEnd
    });
    captionSession.semanticRequestMeta.delete(inflightKey);
    captionSession.transInflight.delete(inflightKey);
    return true;
  };
  for (const [key, request] of Array.from(captionSession.semanticRequestMeta.entries())) {
    if (!request || !request.prefetch || request.regionIndex !== wanted) continue;
    cancel(key, request);
  }
  const state = typeof aiCommitState === "function"
    ? aiCommitState(wanted) : null;
  if (state) {
    aiPrefetchState(state);
    for (const [start, stored] of Array.from(state.prefetchResponses.entries())) {
      const request = stored && stored.request;
      if (request && aiRequestIsStaleForTarget(request, target)) {
        state.prefetchResponses.delete(start);
      }
    }
    pumpAiSpeculativeRequests(wanted, state);
  }
}
function aiActiveSpeculativeRequestCount() {
  return Array.from(captionSession.semanticRequestMeta.values())
    .filter((request) => request && request.prefetch).length;
}
function clearAiSpeculativeBackoff(reasonFilter) {
  if (reasonFilter && captionSession.semanticSpeculativeBackoffReason !== reasonFilter) return;
  captionSession.semanticSpeculativeBackoffUntil = 0;
  captionSession.semanticSpeculativeBackoffReason = "";
  if (captionSession.semanticSpeculativeResumeTimer) {
    clearTimeout(captionSession.semanticSpeculativeResumeTimer);
    captionSession.semanticSpeculativeResumeTimer = null;
  }
}
function scheduleAiSpeculativeResume() {
  const until = Number(captionSession.semanticSpeculativeBackoffUntil);
  if (!Number.isFinite(until) || until <= Date.now() ||
      captionSession.semanticSpeculativeResumeTimer) return;
  const delay = Math.max(1, Math.min(60000, until - Date.now()));
  captionSession.semanticSpeculativeResumeTimer = setTimeout(() => {
    captionSession.semanticSpeculativeResumeTimer = null;
    if (Date.now() < Number(captionSession.semanticSpeculativeBackoffUntil)) {
      scheduleAiSpeculativeResume();
      return;
    }
    if (captionSession.semanticSpeculativeBackoffReason === "local-concurrency" &&
        captionSession.semanticRequestMeta.size > 0) return;
    clearAiSpeculativeBackoff();
    for (const [regionIndex, state] of captionSession.semanticCommitStateByRegion.entries()) {
      pumpAiSpeculativeRequests(regionIndex, state);
    }
  }, delay);
}
function aiSpeculativeBackoffActive() {
  const until = Number(captionSession.semanticSpeculativeBackoffUntil);
  if (!Number.isFinite(until) || until <= Date.now()) {
    clearAiSpeculativeBackoff();
    return false;
  }
  scheduleAiSpeculativeResume();
  return true;
}
function noteAiSpeculativeRateLimit(response, runtimeError) {
  const responseLimited = !!(response && response.rateLimited);
  const errorLimited = !!(runtimeError && runtimeError.rateLimited);
  if (!responseLimited && !errorLimited) return false;
  const reason = String(response && response.limitReason ||
    runtimeError && runtimeError.limitReason || "");
  captionSession.semanticSpeculativeBackoffReason = reason;
  const retryAfter = Number(response && response.retryAfterMs) ||
    Number(runtimeError && runtimeError.retryAfterMs) || 1500;
  const delay = Math.max(500, Math.min(10000, retryAfter));
  const until = Date.now() + delay;
  captionSession.semanticSpeculativeBackoffUntil = Math.max(
    Number(captionSession.semanticSpeculativeBackoffUntil) || 0, until
  );
  scheduleAiSpeculativeResume();
  emitDebug("semantic-speculative-backoff", { delayMs: delay, reason });
  return true;
}
// Ranges a region already has a writer for: live requests and finished
// speculative responses waiting for the cursor. Both are paid for, so a new
// speculative window must never overlap either.
function aiCoveredRequestRanges(regionIndex) {
  const ranges = [];
  for (const request of captionSession.semanticRequestMeta.values()) {
    if (request && request.regionIndex === regionIndex) ranges.push(request);
  }
  const state = typeof aiCommitState === "function" ? aiCommitState(regionIndex) : null;
  if (state && state.prefetchResponses) {
    for (const stored of state.prefetchResponses.values()) {
      if (stored && stored.request) ranges.push(stored.request);
    }
  }
  return ranges;
}
function aiSpeculativeRangeOverlaps(regionIndex, start, end) {
  return aiCoveredRequestRanges(regionIndex).some((request) =>
    request.requestStart <= end && request.requestEnd >= start
  );
}
function aiSpeculativeStartAfterActive(regionIndex, startValue) {
  let start = Math.floor(Number(startValue));
  if (!Number.isInteger(start)) return start;
  const ranges = aiCoveredRequestRanges(regionIndex);
  let changed = true;
  while (changed) {
    changed = false;
    for (const request of ranges) {
      if (request.requestStart > start || request.requestEnd < start) continue;
      const next = Number(request.requestEnd) + 1;
      if (next > start) { start = next; changed = true; }
    }
  }
  return start;
}
function queueAiSpeculativeRequest(regionIndex, startValue) {
  const start = Math.floor(Number(startValue));
  const state = typeof aiCommitState === "function"
    ? aiCommitState(regionIndex) : null;
  if (!state || !Number.isInteger(start) || start <= state.cursor || start > state.limitEnd) return;
  aiPrefetchState(state);
  if (state.prefetchQueued.has(start) || state.prefetchResponses.has(start) || Array.from(captionSession.semanticRequestMeta.values()).some((request) => request && request.regionIndex === regionIndex && Number(request.requestStart) === start)) return;
  state.prefetchQueued.add(start);
  state.prefetchQueue.push(start);
  pumpAiSpeculativeRequests(regionIndex, state);
}
function pumpAiSpeculativeRequests(regionIndex, stateValue) {
  const state = aiPrefetchState(stateValue);
  if (!state || aiSpeculativeBackoffActive()) return;
  while (state.prefetchQueue.length &&
      aiActiveSpeculativeRequestCount() < aiMaxSpeculativeRequests()) {
    let start = state.prefetchQueue.shift();
    state.prefetchQueued.delete(start);
    if (!Number.isInteger(start) || start <= state.cursor || start > state.limitEnd ||
        state.prefetchResponses.has(start)) continue;
    start = aiSpeculativeStartAfterActive(regionIndex, start);
    if (start <= state.cursor || start > state.limitEnd) continue;
    const requestLimited = typeof aiRequestLimited === "function" && aiRequestLimited();
    const itemCount = requestLimited ? aiSteadyRequestItems() : Math.min(
      aiMaxRequestItems(),
      Number.isFinite(Number(getVideo() && getVideo().playbackRate)) &&
          Number(getVideo() && getVideo().playbackRate) >= 1.75
        ? AI_SPECULATIVE_REQUEST_ITEMS : aiSteadyRequestItems()
    );
    const end = Math.min(state.limitEnd, start + Math.max(1, itemCount) - 1);
    if (aiSpeculativeRangeOverlaps(regionIndex, start, end)) continue;
    if (!launchAiSpeculativeRequest(regionIndex, state, start, end)) continue;
  }
}
function takeAiPrefetchedResponse(stateValue) {
  const state = aiPrefetchState(stateValue);
  if (!state) return null;
  for (const [start, stored] of Array.from(state.prefetchResponses.entries())
      .sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const value = Number(start);
    if (value < state.cursor) { state.prefetchResponses.delete(start); continue; }
    if (value !== state.cursor) break;
    state.prefetchResponses.delete(start);
    if (!stored || !stored.request || !stored.response) return null;
    return { request: { ...stored.request, prefetch: false, urgent: true,
      promotedFromPrefetch: true, commitFloor: state.cursor }, response: stored.response };
  }
  return null;
}
function aiTrimPrefetchCandidate(requestValue, responseValue, cursorValue) {
  const cursor = Math.floor(Number(cursorValue));
  if (!requestValue || !responseValue || !Number.isInteger(cursor) ||
      !Array.isArray(responseValue.translations)) return null;
  const units = new Map();
  for (const item of responseValue.translations) {
    const id = Number(item && item.id);
    if (!Number.isInteger(id)) continue;
    const unitId = String(item && item.unitId || `semantic-${id}-${id}`);
    const unit = units.get(unitId) || { first: id, items: [] };
    unit.first = Math.min(unit.first, id);
    unit.items.push(item);
    units.set(unitId, unit);
  }
  const kept = Array.from(units.values())
    .filter((unit) => unit.first >= cursor)
    .sort((a, b) => a.first - b.first);
  if (!kept.length) return null;
  const translations = kept.flatMap((unit) => unit.items.sort((a, b) => Number(a.id) - Number(b.id)));
  const start = kept[0].first;
  return {
    start,
    request: { ...requestValue, requestStart: start, commitFloor: Math.max(cursor, start) },
    response: { ...responseValue, translations, ...(responseValue.error !== undefined ? { error: responseValue.error } : {}), ...(responseValue.errorCode !== undefined ? { errorCode: responseValue.errorCode } : {}), ...(responseValue.providerCode !== undefined ? { providerCode: responseValue.providerCode } : {}), ...(responseValue.streamError !== undefined ? { streamError: responseValue.streamError } : {}) }
  };
}
function reconcileAiPrefetchCandidates(stateValue, cursorValue) {
  const state = aiPrefetchState(stateValue);
  const cursor = Math.floor(Number(cursorValue));
  if (!state || !Number.isInteger(cursor)) return;
  for (const [key, stored] of Array.from(state.prefetchResponses.entries())) {
    const candidate = aiTrimPrefetchCandidate(stored && stored.request, stored && stored.response, cursor);
    state.prefetchResponses.delete(key);
    if (!candidate) continue;
    state.prefetchResponses.set(candidate.start, candidate);
    if (Number(key) !== candidate.start) emitDebug("semantic-prefetch-candidate-trimmed", {
      previousStart: Number(key), nextStart: candidate.start, cursor
    });
  }
}
function storeAiPrefetchCandidate(stateValue, request, response) {
  const state = aiPrefetchState(stateValue);
  if (!state) return null;
  const candidate = aiTrimPrefetchCandidate(request, response, state.cursor);
  if (!candidate) return null;
  reconcileAiPrefetchCandidates(state, state.cursor);
  state.prefetchResponses.set(candidate.start, candidate);
  return candidate;
}
function aiNextFuturePrefetchStart(regionIndex, stateValue, cursorValue) {
  const state = aiPrefetchState(stateValue);
  const cursor = Math.floor(Number(cursorValue));
  if (!state || !Number.isInteger(cursor)) return -1;
  let next = Number.POSITIVE_INFINITY;
  for (const start of state.prefetchResponses.keys()) {
    const value = Math.floor(Number(start));
    if (Number.isInteger(value) && value > cursor) next = Math.min(next, value);
  }
  for (const request of captionSession.semanticRequestMeta.values()) {
    const value = Math.floor(Number(request && request.requestStart));
    if (request && request.prefetch && request.regionIndex === regionIndex &&
        Number.isInteger(value) && value > cursor) next = Math.min(next, value);
  }
  return Number.isFinite(next) ? next : -1;
}
function semanticBridgeRequestItems(requestStartValue, futureStartValue, maxValue, limitEndValue) {
  const guardItems = typeof SEMANTIC_COMMIT_GUARD_ITEMS !== "undefined"
    ? SEMANTIC_COMMIT_GUARD_ITEMS : AI_COMMIT_GUARD_ITEMS;
  const minRunwayItems = typeof SEMANTIC_MIN_COMMIT_RUNWAY_ITEMS !== "undefined"
    ? SEMANTIC_MIN_COMMIT_RUNWAY_ITEMS : AI_MIN_COMMIT_RUNWAY_ITEMS;
  return YTDS_SHARED.semanticBridgeRequestItems(
    requestStartValue, futureStartValue, maxValue, limitEndValue, guardItems, minRunwayItems
  );
}
const aiBridgeRequestItems = semanticBridgeRequestItems;


function launchAiSpeculativeRequest(regionIndex, state, startValue, endValue) {
  const start = Math.floor(Number(startValue));
  let requestEnd = Math.min(state.limitEnd, Math.floor(Number(endValue)));
  if (!Number.isInteger(start) || !Number.isInteger(requestEnd) || requestEnd < start) return false;
  const inflightKey = `dsp:${regionIndex}:${start}`;
  if (captionSession.semanticRequestMeta.has(inflightKey)) return false;
  const items = [];
  let currentChars = 0;
  for (let id = start; id <= requestEnd; id++) {
    const entry = aiBatchEntry(id, false);
    const nextChars = String(entry.text || "").length;
    if (items.length && currentChars + nextChars > AI_MAX_CURRENT_CHARS) break;
    items.push(entry);
    currentChars += nextChars;
  }
  if (!items.length) return false;
  requestEnd = start + items.length - 1;
  const requestId = beginAiRequest(inflightKey, "prefetch", start, requestEnd, false);
  if (!requestId) return false;
  const requestSessionToken = captureCaptionSession();
  const request = captionSession.semanticRequestMeta.get(inflightKey);
  const { contextBefore, contextAfter } = aiContextsForRange(start, requestEnd);
  const requestMeta = {
    prefetch: true, regionIndex, requestStart: start, requestEnd,
    commitFloor: state.commitFloor, limitEnd: state.limitEnd,
    effectiveGuardItems: YTDS_SHARED.semanticEffectiveGuardItems(items.length, AI_COMMIT_GUARD_ITEMS),
    reqVid: captionSession.cueVideoId, reqEpoch: captionSession.cueEpoch,
    sessionToken: requestSessionToken, focusGeneration: captionSession.semanticFocusGeneration,
    fastPath: true, itemCount: items.length, targetAwareItems: items.length,
    maxRequestItems: aiMaxRequestItems()
  };
  if (request && request.requestId === requestId) Object.assign(request, requestMeta);
  const batchIndex = captionSession.semanticGroupToBatch[start];
  const batch = captionSession.semanticBatchWindows[batchIndex];
  sendRuntimeMessage({
    type: "translateBatch", endpointKind: aiEndpointKind(),
    requestLimited: typeof aiRequestLimited === "function" && aiRequestLimited(),
    commitGuardLocal: typeof aiCommitGuardLocal === "function"
      ? aiCommitGuardLocal(start, requestEnd, state.limitEnd, requestMeta.effectiveGuardItems) : -1,
    debug: !!settings.debugEnabled, requestId,
    videoId: captionSession.cueVideoId,
    videoTimeMs: Math.round(((getVideo() && getVideo().currentTime) || 0) * 1000),
    targetLang: settings.targetLang, sourceLang: captionSession.cueSourceLang,
    coreStart: start, coreEnd: Math.min(requestEnd, batch ? batch.end : requestEnd),
    requestStart: start, requestEnd, bypassCache: false, urgent: false,
    focusGeneration: captionSession.semanticFocusGeneration, fastPath: true, items,
    contextBefore, contextAfter
  }, (resp, runtimeError) => {
    const finished = finishAiRequest(inflightKey, requestId);
    if (finished) handleAiBatchResult(finished, resp, runtimeError);
  });
  return true;
}
function aiRequestById(requestId) {
  const wanted = String(requestId || "");
  if (!wanted) return null;
  for (const [inflightKey, request] of captionSession.semanticRequestMeta.entries()) {
    if (request && request.requestId === wanted) return { inflightKey, request };
  }
  return null;
}
function cancelAiPrefetchRequests() {
  for (const [inflightKey, request] of Array.from(captionSession.semanticRequestMeta.entries())) {
    if (!request || request.urgent) continue;
    sendRuntimeMessage({
      type: "cancelAiTranslationRequest",
      videoId: captionSession.cueVideoId,
      requestId: request.requestId
    });
    emitCaptionStateTransition("semantic-request", "cancelled", {
      requestId: request.requestId,
      reason: "prefetch-disabled"
    });
    captionSession.semanticRequestMeta.delete(inflightKey);
    captionSession.transInflight.delete(inflightKey);
  }
  for (const state of captionSession.semanticCommitStateByRegion.values()) {
    aiPrefetchState(state);
    state.prefetchQueue.length = 0;
    state.prefetchQueued.clear();
    state.prefetchResponses.clear();
  }
}
function scheduleAiBatchRetry(
  gIdx, start, end, videoId, epoch, reason, retryOptions
) {
  const key = aiBatchRetryKey(start, end, videoId, epoch);
  const attempt = captionSession.semanticRetryCounts.get(key) || 0;
  const rateLimited = !!(retryOptions && retryOptions.rateLimited);
  const errorInfo = YTDS_SHARED.aiErrorDescriptor(retryOptions && retryOptions.error || retryOptions || { message: reason });
  const errorMessage = YTDS_SHARED.aiErrorMessage(retryOptions && retryOptions.error != null ? retryOptions.error : retryOptions, reason);
  const maxAttempts = rateLimited ? AI_RATE_RETRY_LIMIT
    : /^(?:HTTP_\d+|AI_CONFIG_MISSING|AI_KEY_MISSING|AI_HOST_PERMISSION_MISSING)$/.test(errorInfo.code) ? 0 : AI_COLD_RETRY_DELAYS_MS.length;
  // The worker's local concurrency cap only means "wait for a free slot";
  // nothing failed, so it must never exhaust the region's retry budget.
  const localWait = rateLimited && String(
    retryOptions && retryOptions.error && retryOptions.error.limitReason || ""
  ) === "local-concurrency";
  if (!localWait && attempt >= maxAttempts) {
    const regionIndex = captionSession.semanticGroupToCommitRegion[gIdx];
    if (Number.isInteger(regionIndex)) {
      captionSession.semanticExhaustedRegions.set(regionIndex, {
        start, end, videoId, epoch, reason: String(reason || ""), errorMessage,
        errorCode: errorInfo.code, providerCode: errorInfo.providerCode
      });
    }
    emitCaptionStateTransition("semantic-retry", "exhausted", {
      start, end, attempts: attempt, reason: String(reason || "")
    });
    emitDebug("batch-retry-exhausted", { start, end, reason: String(reason || ""), errorCode: errorInfo.code });
    if (captionSession.activeGroupIdx >= 0 &&
        captionSession.semanticGroupToCommitRegion[captionSession.activeGroupIdx] === regionIndex &&
        captionSession.activeCueIdx >= 0 && captionSession.cueList) {
      clearPendingTimer();
      const source = sourceForDisplayedCue(
        captionSession.activeCueIdx, captionSession.cueList[captionSession.activeCueIdx]
      );
      setTranslation(aiTranslationErrorText(captionSession.semanticExhaustedRegions.get(regionIndex)), source, "error");
    }
    return;
  }
  const requestedDelay = Number(retryOptions && retryOptions.retryAfterMs);
  const delayMs = rateLimited
    ? Math.max(500, Math.min(61000, Number.isFinite(requestedDelay) && requestedDelay > 0 ? Math.ceil(requestedDelay) : 1500))
    : AI_COLD_RETRY_DELAYS_MS[attempt];
  const regionIndex = captionSession.semanticGroupToCommitRegion[gIdx];
  const inflightKey = `dsb:${regionIndex}`;
  const scheduledFocusGeneration = captionSession.semanticFocusGeneration;
  const scheduledSessionToken = captureCaptionSession();
  if (!localWait) captionSession.semanticRetryCounts.set(key, attempt + 1);
  captionSession.transInflight.add(inflightKey);
  emitDebug("batch-retry", {
    start, end, attempt: attempt + 1, delayMs, rateLimited,
    reason: String(reason || "")
  });
  emitCaptionStateTransition("semantic-retry", "scheduled", { start, end, attempt: attempt + 1, delayMs, reason: String(reason || "") });
  setTimeout(() => {
    captionSession.transInflight.delete(inflightKey);
    if (!isCaptionSessionCurrent(scheduledSessionToken) ||
        epoch !== captionSession.cueEpoch || videoId !== captionSession.cueVideoId) {
      captionSession.semanticRetryCounts.delete(key);
      emitCaptionStateTransition("semantic-retry", "discarded", { start, end, attempt: attempt + 1, reason: "session-or-track-invalidated" });
      return;
    }
    if (scheduledFocusGeneration !== captionSession.semanticFocusGeneration) {
      captionSession.semanticRetryCounts.delete(key);
      emitCaptionStateTransition("semantic-retry", "discarded", { start, end, attempt: attempt + 1, reason: "focus-invalidated" });
      return;
    }
    emitCaptionStateTransition("semantic-retry", "resumed", { start, end, attempt: attempt + 1 });
    aiRequestBatch(gIdx, true, !!(retryOptions && retryOptions.urgent), { bypassCache: !!(retryOptions && retryOptions.bypassCache) });
  }, delayMs);
}
