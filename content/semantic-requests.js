// Semantic request ownership, cancellation and retry state machine.
"use strict";

const DEEPSEEK_STALE_PREFETCH_GRACE_MS = 2500;
const DEEPSEEK_PLAYBACK_STARTUP_GRACE_MS = 6000;
const DEEPSEEK_PLAYBACK_PROGRESS_GRACE_MS = 4000;
const DEEPSEEK_HIGH_SPEED_STARTUP_GRACE_MS = 3500;
const DEEPSEEK_HIGH_SPEED_PROGRESS_GRACE_MS = 2500;
const DEEPSEEK_STREAM_HANDOFF_MIN_ITEMS = 64;
const DEEPSEEK_HIGH_SPEED_STREAM_HANDOFF_MIN_ITEMS = 16;
const DEEPSEEK_STREAM_HANDOFF_MAX_REMAINING_ITEMS = 48;
const DEEPSEEK_MAX_SPECULATIVE_REQUESTS = 2;
const DEEPSEEK_ACCELERATED_MAX_SPECULATIVE_REQUESTS = 7;
const DEEPSEEK_HIGH_SPEED_MAX_SPECULATIVE_REQUESTS = 11;
const COMPATIBLE_ACCELERATED_MAX_SPECULATIVE_REQUESTS = 2;
const COMPATIBLE_HIGH_SPEED_MAX_SPECULATIVE_REQUESTS = 3;
const DEEPSEEK_SPECULATIVE_REQUEST_ITEMS = 96;

function deepseekEndpointKind() {
  const baseUrl = typeof settings === "object" && settings ? settings.aiBaseUrl : "";
  return typeof YTDS_SHARED.aiEndpointKind === "function"
    ? YTDS_SHARED.aiEndpointKind(baseUrl) : "deepseek";
}

function deepseekMaxSpeculativeRequests() {
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  const deepseek = deepseekEndpointKind() === "deepseek";
  if (Number.isFinite(rate) && rate >= 2.5) {
    return deepseek
      ? DEEPSEEK_HIGH_SPEED_MAX_SPECULATIVE_REQUESTS
      : COMPATIBLE_HIGH_SPEED_MAX_SPECULATIVE_REQUESTS;
  }
  if (Number.isFinite(rate) && rate >= 1.75) {
    return deepseek
      ? DEEPSEEK_ACCELERATED_MAX_SPECULATIVE_REQUESTS
      : COMPATIBLE_ACCELERATED_MAX_SPECULATIVE_REQUESTS;
  }
  return deepseek ? DEEPSEEK_MAX_SPECULATIVE_REQUESTS : 1;
}

function deepseekRequestHasProgress(request) {
  if (!request) return false;
  // Buffered model output is not playback progress. A request can receive
  // left-guard context or a provisional outer unit for several seconds while
  // the monotonic commit cursor remains unchanged. Only a committed cursor
  // advance may extend the grace period or keep stale prefetch alive.
  const requestStart = Number(request.requestStart);
  const progressCursor = Number(request.progressCursor);
  const lastProgressAt = Number(request.lastProgressAt);
  if (!Number.isInteger(requestStart) || !Number.isInteger(progressCursor) ||
      progressCursor <= requestStart || !Number.isFinite(lastProgressAt) ||
      lastProgressAt <= 0) return false;
  return Date.now() - lastProgressAt < DEEPSEEK_STALE_PREFETCH_GRACE_MS;
}

function deepseekRequestHasBufferedProgress(request) {
  if (!request || !request.prefetch || !Array.isArray(request.progressTranslations)) return false;
  const requestStart = Number(request.requestStart);
  if (!Number.isInteger(requestStart)) return false;
  return request.progressTranslations.some((item) => Number(item && item.id) === requestStart);
}

function deepseekRequestIsStaleForTarget(request, targetGroup) {
  if (!request || request.urgent || deepseekRequestHasProgress(request) ||
      (request.prefetch && deepseekRequestHasBufferedProgress(request))) return false;
  const target = Number(targetGroup);
  const requestEnd = Number(request.requestEnd);
  const startedAt = Number(request.startedAt);
  return Number.isInteger(target) && Number.isInteger(requestEnd) && target > requestEnd &&
    Number.isFinite(startedAt) && Date.now() - startedAt >= DEEPSEEK_STALE_PREFETCH_GRACE_MS;
}

function deepseekRequestIsPlaybackLagging(request, state, targetGroup) {
  if (!request || !request.urgent || !state || typeof getVideo !== "function") return false;
  const rate = Number(getVideo() && getVideo().playbackRate);
  const highSpeed = rate >= 2.5;
  const lagThreshold = highSpeed ? 24 : rate >= 1.75 ? 48 : 0;
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
  const graceMs = hasStreamProgress
    ? highSpeed ? DEEPSEEK_HIGH_SPEED_PROGRESS_GRACE_MS : DEEPSEEK_PLAYBACK_PROGRESS_GRACE_MS
    : highSpeed ? DEEPSEEK_HIGH_SPEED_STARTUP_GRACE_MS : DEEPSEEK_PLAYBACK_STARTUP_GRACE_MS;
  return lagThreshold > 0 && Number.isInteger(target) && Number.isInteger(cursor) &&
    target - cursor >= lagThreshold && Number.isFinite(referenceAt) &&
    Date.now() - referenceAt >= graceMs;
}

function deepseekSeekBacktrackItems() {
  const base = Math.max(0, Math.floor(Number(DEEPSEEK_SEEK_BACKTRACK_ITEMS) || 0));
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  if (Number.isFinite(rate) && rate >= 2.5) return Math.min(base, 24);
  if (Number.isFinite(rate) && rate >= 1.75) return Math.min(base, 40);
  return base;
}

function deepseekAcceleratedUrgentRequestItems() {
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  const deepseek = deepseekEndpointKind() === "deepseek";
  if (Number.isFinite(rate) && rate >= 2.5) {
    return deepseek
      ? DEEPSEEK_HIGH_SPEED_URGENT_REQUEST_ITEMS
      : COMPATIBLE_HIGH_SPEED_URGENT_REQUEST_ITEMS;
  }
  return deepseek
    ? DEEPSEEK_ACCELERATED_URGENT_REQUEST_ITEMS
    : COMPATIBLE_ACCELERATED_URGENT_REQUEST_ITEMS;
}

function deepseekLeadingUnitReachesRequestEnd(translationsValue, requestStartValue, requestEndValue) {
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

function deepseekAlignedRecoveryInput(translationsValue, requestStartValue) {
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
    // Keep the complete outer unit so semanticUnitsFromAlignedChunks can
    // validate its aligned-chunk coverage; commit planning still filters the
    // left-side members against requestStart.
    return visibleUnitIds.has(String(item && item.unitId || ""));
  });
}

function deepseekStreamHandoffReady(request, state, maxRequestItems, normalMaxRequestItems) {
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  const accelerated = Number.isFinite(rate) && rate >= 1.75;
  if (!request || !state || !request.urgent ||
      (!accelerated && Number(maxRequestItems) <= Number(normalMaxRequestItems))) return false;
  const requestStart = Number(request.requestStart);
  const requestEnd = Number(request.requestEnd);
  const cursor = Number(state.cursor);
  const targetThrough = Number(state.targetThrough);
  if (![requestStart, requestEnd, cursor, targetThrough].every(Number.isInteger)) return false;
  const minItems = Number.isFinite(rate) && rate >= 2.5
    ? DEEPSEEK_HIGH_SPEED_STREAM_HANDOFF_MIN_ITEMS
    : DEEPSEEK_STREAM_HANDOFF_MIN_ITEMS;
  return cursor - requestStart >= minItems &&
    requestEnd - cursor <= DEEPSEEK_STREAM_HANDOFF_MAX_REMAINING_ITEMS &&
    targetThrough - cursor >= minItems;
}

function handoffDeepseekStream(regionIndex, request, state) {
  const inflightKey = `dsb:${regionIndex}`;
  if (!request || captionSession.deepseekRequestMeta.get(inflightKey) !== request ||
      !state || state.cursor > state.targetThrough || state.cursor > state.limitEnd) return false;
  const continuationStart = state.cursor;
  request.streamHandoff = true;
  captionSession.deepseekRequestMeta.delete(inflightKey);
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
        captionSession.deepseekFocusGeneration !== request.focusGeneration ||
        state.cursor !== continuationStart || state.cursor > state.targetThrough ||
        state.cursor > state.limitEnd) return;
    // The continuation is the next visible playback range, not speculative
    // look-ahead. Keep it urgent so a full prefetch queue cannot turn a safe
    // streamed prefix back into a playback stall; the continuation remains
    // bounded by the accelerated request cap and source-character budget.
    deepseekRequestBatch(continuationStart, false, true, { bypassCache: true });
  };
  const sent = sendRuntimeMessage({
    type: "cancelDeepSeekRequest",
    videoId: captionSession.cueVideoId,
    requestId: request.requestId
  }, () => queueMicrotask(launch));
  if (!sent) queueMicrotask(launch);
  return true;
}

function deepseekBatchRetryKey(start, end, videoId, epoch) {
  return `${videoId}:${epoch}:${start}:${end}`;
}

function beginDeepseekRequest(inflightKey, kind, start, end, urgent) {
  const existing = captionSession.deepseekRequestMeta.get(inflightKey);
  if (existing) {
    if (!urgent || existing.urgent) return "";
    // Priority matters while waiting for a local slot, not after Fetch has
    // started. Reuse live work instead of restarting a slow response.
    existing.urgent = true;
    existing.promotedAt = Date.now();
    emitCaptionStateTransition("semantic-request", "promoted", {
      requestId: existing.requestId, kind, start, end
    });
    emitDebug("deepseek-request-promoted", {
      kind, start, end, reusedRequestId: existing.requestId
    });
    return "";
  } else if (captionSession.transInflight.has(inflightKey)) {
    return "";
  }
  const requestId = `${kind}:${captionSession.deepseekFocusGeneration}:${++captionSession.deepseekRequestSerial}:${start}-${end}`;
  captionSession.deepseekRequestMeta.set(inflightKey, {
    requestId,
    urgent: !!urgent,
    startedAt: Date.now(),
    lastProgressAt: 0,
    progressCursor: start,
    progressTranslations: [],
    // Keep the complete streamed response range for aligned-chunk recovery.
    // progressTranslations is trimmed after each commit, but a later chunk
    // may still need the outer unit's earlier anchor to validate coverage.
    progressRecoveryTranslations: []
  });
  captionSession.transInflight.add(inflightKey);
  emitCaptionStateTransition("semantic-request", "started", {
    requestId, kind, start, end, urgent: !!urgent
  });
  return requestId;
}

function finishDeepseekRequest(inflightKey, requestId) {
  const current = captionSession.deepseekRequestMeta.get(inflightKey);
  if (!current || current.requestId !== requestId) {
    emitCaptionStateTransition("semantic-request", "discarded", {
      requestId: String(requestId || ""),
      reason: current ? "request-owner-changed" : "request-owner-missing"
    });
    return null;
  }
  captionSession.deepseekRequestMeta.delete(inflightKey);
  captionSession.transInflight.delete(inflightKey);
  emitCaptionStateTransition("semantic-request", "settled", {
    requestId,
    urgent: !!current.urgent
  });
  return current;
}

function deepseekPrefetchState(state) {
  if (!state || typeof state !== "object") return null;
  if (!Array.isArray(state.prefetchQueue)) state.prefetchQueue = [];
  if (!(state.prefetchQueued instanceof Set)) state.prefetchQueued = new Set();
  if (!(state.prefetchResponses instanceof Map)) state.prefetchResponses = new Map();
  return state;
}

function cancelDeepseekRegionRequests(regionIndex, preserveFromValue) {
  const wanted = Number(regionIndex);
  const preserveFrom = Number.isInteger(Number(preserveFromValue)) ? Number(preserveFromValue) : -1;
  if (!Number.isInteger(wanted)) return;
  const prefix = `dsp:${wanted}:`;
  for (const [key, request] of Array.from(captionSession.deepseekRequestMeta.entries())) {
    if (key !== `dsb:${wanted}` && !String(key).startsWith(prefix)) continue;
    if (preserveFrom >= 0 && request && request.prefetch &&
        Number(request.requestEnd) >= preserveFrom) continue;
    if (request && request.requestId) sendRuntimeMessage({
      type: "cancelDeepSeekRequest",
      videoId: captionSession.cueVideoId,
      requestId: request.requestId
    });
    captionSession.deepseekRequestMeta.delete(key);
    captionSession.transInflight.delete(key);
  }
  const state = typeof deepseekCommitState === "function" ? deepseekCommitState(wanted) : null;
  if (state) { deepseekPrefetchState(state);
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

// A hard semantic boundary is also a scheduling boundary. Once playback enters
// a new region, writers for earlier regions cannot help the visible cursor and
// can hold a provider connection while the new region is trying to build its
// runway. Future regions are deliberately retained: they are the accelerated
// playback runway and can be staged until the monotonic cursor reaches them.
function cancelDeepseekRequestsBeforeRegion(regionIndex) {
  const wanted = Number(regionIndex);
  if (!Number.isInteger(wanted)) return;
  for (const [key, request] of Array.from(captionSession.deepseekRequestMeta.entries())) {
    if (!request || !Number.isInteger(request.regionIndex) || request.regionIndex >= wanted) continue;
    if (request.requestId) sendRuntimeMessage({
      type: "cancelDeepSeekRequest",
      videoId: captionSession.cueVideoId,
      requestId: request.requestId
    });
    emitCaptionStateTransition("semantic-request", "cancelled", {
      requestId: request.requestId,
      reason: "obsolete-region-priority",
      previousRegionIndex: request.regionIndex,
      regionIndex: wanted
    });
    captionSession.deepseekRequestMeta.delete(key);
    captionSession.transInflight.delete(key);
  }
  if (!(captionSession.deepseekCommitStateByRegion instanceof Map)) return;
  for (const [index, state] of captionSession.deepseekCommitStateByRegion.entries()) {
    if (Number(index) >= wanted) continue;
    deepseekPrefetchState(state);
    state.prefetchQueue.length = 0;
    state.prefetchQueued.clear();
    state.prefetchResponses.clear();
  }
}

// A future range that playback has already passed cannot become the next
// monotonic writer. Release it before the urgent lane asks for a replacement;
// otherwise a slow provider response can keep consuming one of the limited
// prefetch slots while the visible cursor is waiting elsewhere.
function cancelDeepseekStaleSpeculativeRequests(regionIndex, targetGroup) {
  const wanted = Number(regionIndex);
  const target = Number(targetGroup);
  if (!Number.isInteger(wanted) || !Number.isInteger(target)) return;
  const cancel = (inflightKey, request) => {
    if (!request || !deepseekRequestIsStaleForTarget(request, target)) return false;
    if (request.requestId) sendRuntimeMessage({
      type: "cancelDeepSeekRequest",
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
    captionSession.deepseekRequestMeta.delete(inflightKey);
    captionSession.transInflight.delete(inflightKey);
    return true;
  };
  for (const [key, request] of Array.from(captionSession.deepseekRequestMeta.entries())) {
    if (!request || !request.prefetch || request.regionIndex !== wanted) continue;
    cancel(key, request);
  }
  const state = typeof deepseekCommitState === "function"
    ? deepseekCommitState(wanted) : null;
  if (state) {
    deepseekPrefetchState(state);
    for (const [start, stored] of Array.from(state.prefetchResponses.entries())) {
      const request = stored && stored.request;
      if (request && deepseekRequestIsStaleForTarget(request, target)) {
        state.prefetchResponses.delete(start);
      }
    }
    pumpDeepseekSpeculativeRequests(wanted, state);
  }
}

function deepseekActiveSpeculativeRequestCount() {
  return Array.from(captionSession.deepseekRequestMeta.values())
    .filter((request) => request && request.prefetch).length;
}

function scheduleDeepseekSpeculativeResume() {
  const until = Number(captionSession.deepseekSpeculativeBackoffUntil);
  if (!Number.isFinite(until) || until <= Date.now() ||
      captionSession.deepseekSpeculativeResumeTimer) return;
  const delay = Math.max(1, Math.min(60000, until - Date.now()));
  captionSession.deepseekSpeculativeResumeTimer = setTimeout(() => {
    captionSession.deepseekSpeculativeResumeTimer = null;
    if (Date.now() < Number(captionSession.deepseekSpeculativeBackoffUntil)) {
      scheduleDeepseekSpeculativeResume();
      return;
    }
    captionSession.deepseekSpeculativeBackoffUntil = 0;
    for (const [regionIndex, state] of captionSession.deepseekCommitStateByRegion.entries()) {
      pumpDeepseekSpeculativeRequests(regionIndex, state);
    }
  }, delay);
}

function deepseekSpeculativeBackoffActive() {
  const until = Number(captionSession.deepseekSpeculativeBackoffUntil);
  if (!Number.isFinite(until) || until <= Date.now()) {
    captionSession.deepseekSpeculativeBackoffUntil = 0;
    return false;
  }
  scheduleDeepseekSpeculativeResume();
  return true;
}

function noteDeepseekSpeculativeRateLimit(response, runtimeError) {
  const responseLimited = !!(response && response.rateLimited);
  const errorLimited = !!(runtimeError && runtimeError.rateLimited);
  if (!responseLimited && !errorLimited) return false;
  const reason = String(response && response.limitReason ||
    runtimeError && runtimeError.limitReason || "");
  if (reason === "local-concurrency") return false;
  const retryAfter = Number(response && response.retryAfterMs) ||
    Number(runtimeError && runtimeError.retryAfterMs) || 1500;
  const delay = Math.max(500, Math.min(10000, retryAfter));
  const until = Date.now() + delay;
  captionSession.deepseekSpeculativeBackoffUntil = Math.max(
    Number(captionSession.deepseekSpeculativeBackoffUntil) || 0, until
  );
  scheduleDeepseekSpeculativeResume();
  emitDebug("semantic-speculative-backoff", { delayMs: delay, reason });
  return true;
}

function deepseekSpeculativeRangeOverlaps(regionIndex, start, end) {
  return Array.from(captionSession.deepseekRequestMeta.values()).some((request) =>
    request && request.regionIndex === regionIndex && request.requestStart <= end &&
    request.requestEnd >= start
  );
}

function deepseekSpeculativeStartAfterActive(regionIndex, startValue) {
  let start = Math.floor(Number(startValue));
  if (!Number.isInteger(start)) return start;
  let changed = true;
  while (changed) {
    changed = false;
    for (const request of captionSession.deepseekRequestMeta.values()) {
      if (!request || request.regionIndex !== regionIndex ||
          request.requestStart > start || request.requestEnd < start) continue;
      const next = Number(request.requestEnd) + 1;
      if (next > start) { start = next; changed = true; }
    }
  }
  return start;
}

function queueDeepseekSpeculativeRequest(regionIndex, startValue) {
  const start = Math.floor(Number(startValue));
  const state = typeof deepseekCommitState === "function"
    ? deepseekCommitState(regionIndex) : null;
  if (!state || !Number.isInteger(start) || start <= state.cursor || start > state.limitEnd) return;
  deepseekPrefetchState(state);
  if (state.prefetchQueued.has(start) || state.prefetchResponses.has(start)) return;
  state.prefetchQueued.add(start);
  state.prefetchQueue.push(start);
  pumpDeepseekSpeculativeRequests(regionIndex, state);
}

function pumpDeepseekSpeculativeRequests(regionIndex, stateValue) {
  const state = deepseekPrefetchState(stateValue);
  if (!state || deepseekSpeculativeBackoffActive()) return;
  while (state.prefetchQueue.length &&
      deepseekActiveSpeculativeRequestCount() < deepseekMaxSpeculativeRequests()) {
    let start = state.prefetchQueue.shift();
    state.prefetchQueued.delete(start);
    if (!Number.isInteger(start) || start <= state.cursor || start > state.limitEnd ||
        state.prefetchResponses.has(start)) continue;
    start = deepseekSpeculativeStartAfterActive(regionIndex, start);
    if (start <= state.cursor || start > state.limitEnd) continue;
    const itemCount = Math.min(
      deepseekMaxRequestItems(),
      Number.isFinite(Number(getVideo() && getVideo().playbackRate)) &&
          Number(getVideo() && getVideo().playbackRate) >= 1.75
        ? DEEPSEEK_SPECULATIVE_REQUEST_ITEMS : DEEPSEEK_REQUEST_ITEMS
    );
    const end = Math.min(state.limitEnd, start + Math.max(1, itemCount) - 1);
    if (deepseekSpeculativeRangeOverlaps(regionIndex, start, end)) continue;
    if (!launchDeepseekSpeculativeRequest(regionIndex, state, start, end)) continue;
  }
}

function takeDeepseekPrefetchedResponse(stateValue) {
  const state = deepseekPrefetchState(stateValue);
  if (!state) return null;
  for (const [start, stored] of Array.from(state.prefetchResponses.entries())
      .sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (Number(start) < state.cursor) {
      state.prefetchResponses.delete(start);
      continue;
    }
    if (Number(start) === state.cursor) {
      state.prefetchResponses.delete(start);
      return stored;
    }
    break;
  }
  return null;
}

// Bridge to the next future response without making its exact start stale.
function deepseekNextFuturePrefetchStart(regionIndex, stateValue, cursorValue) {
  const state = deepseekPrefetchState(stateValue);
  const cursor = Math.floor(Number(cursorValue));
  if (!state || !Number.isInteger(cursor)) return -1;
  let next = Number.POSITIVE_INFINITY;
  for (const start of state.prefetchResponses.keys()) {
    const value = Math.floor(Number(start));
    if (Number.isInteger(value) && value > cursor) next = Math.min(next, value);
  }
  for (const request of captionSession.deepseekRequestMeta.values()) {
    const value = Math.floor(Number(request && request.requestStart));
    if (request && request.prefetch && request.regionIndex === regionIndex &&
        Number.isInteger(value) && value > cursor) next = Math.min(next, value);
  }
  return Number.isFinite(next) ? next : -1;
}

function deepseekBridgeRequestItems(requestStartValue, futureStartValue, maxValue, limitEndValue) {
  const requestStart = Math.floor(Number(requestStartValue));
  const futureStart = Math.floor(Number(futureStartValue));
  const maxItems = Math.max(1, Math.floor(Number(maxValue) || 1));
  const limitEnd = Math.floor(Number(limitEndValue));
  if (![requestStart, futureStart, limitEnd].every(Number.isInteger) ||
      futureStart <= requestStart || requestStart > limitEnd) return 0;
  const gap = futureStart - requestStart;
  let count = Math.min(maxItems, limitEnd - requestStart + 1, Math.max(1, gap));
  // Include the first future item when the cursor is immediately before a
  // staged range. Without that one-item overlap, a semantic unit that crosses
  // the join has no way to be resolved by either writer.
  const minimumJoinItems = Math.min(
    maxItems, limitEnd - requestStart + 1, Math.max(1, gap + 1)
  );
  while (count < minimumJoinItems) count++;
  while (count < maxItems && count < limitEnd - requestStart + 1 &&
      count - Math.min(DEEPSEEK_COMMIT_GUARD_ITEMS, Math.floor(count / 3)) < gap) {
    count++;
  }
  return count;
}

function handleDeepseekBatchResult(request, resp, runtimeError) {
  if (!request || !Number.isInteger(request.regionIndex)) return;
  const regionIndex = request.regionIndex;
  const requestStart = Number(request.requestStart);
  const requestEnd = Number(request.requestEnd);
  const reqVid = request.reqVid;
  const reqEpoch = request.reqEpoch;
  const requestId = String(request.requestId || "");
  const effectiveUrgent = !!request.urgent;
  const state = deepseekCommitState(regionIndex);
  if (!state || !isCaptionSessionCurrent(request.sessionToken)) return;
  deepseekPrefetchState(state);
  state.prefetchResponses.delete(requestStart);
  const bufferedResponse = deepseekResponseWithBufferedProgress(request, resp, state);
  if (bufferedResponse && bufferedResponse !== resp) {
    resp = bufferedResponse;
    runtimeError = null;
  }

  if (runtimeError) {
    if (request.prefetch) {
      const rateLimited = noteDeepseekSpeculativeRateLimit(null, runtimeError);
      if (rateLimited) queueDeepseekSpeculativeRequest(regionIndex, requestStart);
      pumpDeepseekSpeculativeRequests(regionIndex, state);
      if (state.cursor === requestStart) deepseekRequestBatch(requestStart, true, true, {
        bypassCache: true
      });
      return;
    }
    if (state.cursor > requestStart) {
      repaintActiveDeepseekTranslation();
      if (state.cursor <= state.targetThrough && state.cursor <= state.limitEnd) {
        queueMicrotask(() => pumpDeepseekCommitRegion(
          regionIndex, deepseekKeepAcceleratedUrgentLane(effectiveUrgent, state)
        ));
      }
    } else {
      scheduleDeepSeekBatchRetry(
        requestStart, requestStart, requestEnd, reqVid, reqEpoch,
        runtimeError.message || "runtime unavailable", { urgent: effectiveUrgent }
      );
    }
    return;
  }
  if (reqEpoch !== captionSession.cueEpoch || reqVid !== captionSession.cueVideoId) return;
  if (!resp || !resp.ok || !Array.isArray(resp.translations)) {
    if (request.prefetch) {
      const rateLimited = noteDeepseekSpeculativeRateLimit(resp, runtimeError);
      if (rateLimited) queueDeepseekSpeculativeRequest(regionIndex, requestStart);
      pumpDeepseekSpeculativeRequests(regionIndex, state);
      if (state.cursor === requestStart) deepseekRequestBatch(requestStart, true, true, {
        bypassCache: true
      });
      return;
    }
    const error = resp && resp.error || "empty background response";
    emitDebug("batch-rejected", {
      regionIndex, requestStart, requestEnd, error,
      needsKey: !!(resp && resp.needsKey), timeout: !!(resp && resp.timeout),
      rateLimited: !!(resp && resp.rateLimited),
      retryAfterMs: Number(resp && resp.retryAfterMs) || 0,
      limitReason: String(resp && resp.limitReason || "")
    });
    emitCaptionStateTransition("semantic-response", "rejected", {
      requestId, reason: String(error || "rejected"),
      retryable: !!(!resp || resp.netfail || resp.timeout || resp.rateLimited)
    });
    if (state.cursor > requestStart) {
      repaintActiveDeepseekTranslation();
      if (state.cursor <= state.targetThrough && state.cursor <= state.limitEnd) {
        queueMicrotask(() => pumpDeepseekCommitRegion(
          regionIndex, deepseekKeepAcceleratedUrgentLane(effectiveUrgent, state)
        ));
      }
    } else if (!resp || resp.netfail || resp.timeout || resp.rateLimited ||
        error === "invalid translation batch" || error === "untrusted sender") {
      scheduleDeepSeekBatchRetry(requestStart, requestStart, requestEnd, reqVid, reqEpoch, error, {
        rateLimited: !!(resp && resp.rateLimited),
        retryAfterMs: Number(resp && resp.retryAfterMs) || 0,
        urgent: effectiveUrgent
      });
    }
    return;
  }
  if (request.prefetch && state.cursor < requestStart) {
    state.prefetchResponses.set(requestStart, { request, response: resp });
    pumpDeepseekSpeculativeRequests(regionIndex, state);
    return;
  }
  if (request.prefetch && state.cursor > requestEnd) {
    pumpDeepseekSpeculativeRequests(regionIndex, state);
    return;
  }

  emitDebug("deepseek-batch-response", {
    regionIndex, requestStart, requestEnd,
    itemCount: Number(request.itemCount) || 0,
    urgent: effectiveUrgent,
    modelDeferredIds: Array.isArray(resp.deferredIds) ? resp.deferredIds : [],
    httpDiagnostics: resp.httpDiagnostics || { attempts: [] }
  });
  emitCaptionStateTransition("semantic-response", "accepted", {
    requestId, translationCount: resp.translations.length, partial: !!resp.partial
  });
  const finalStart = state.cursor;
  const finalTranslations = resp.translations.filter(
    (item) => Number(item && item.id) >= finalStart
  );
  let nextCursor = commitDeepseekResponsePrefix(
    regionIndex, finalStart, requestEnd, state.commitFloor, request.limitEnd,
    finalTranslations, request.effectiveGuardItems
  );
  if (!Number.isInteger(nextCursor)) return;
  const maxRequestItems = Number(request.maxRequestItems) || deepseekMaxRequestItems();
  const requestItems = Number(request.itemCount) || Number(request.targetAwareItems) || 0;
  const canExpand = requestEnd < request.limitEnd && requestItems < maxRequestItems;
  const canRecoverAlignedChunks = effectiveUrgent || !canExpand;
  if (nextCursor === finalStart && canRecoverAlignedChunks) {
    const recoveredTranslations = YTDS_SHARED.semanticUnitsFromAlignedChunks(
      deepseekAlignedRecoveryInput(resp.translations, finalStart)
    );
    const recoveredCursor = commitDeepseekResponsePrefix(
      regionIndex, finalStart, requestEnd, state.commitFloor, request.limitEnd,
      recoveredTranslations, request.effectiveGuardItems
    );
    if (Number.isInteger(recoveredCursor) && recoveredCursor > finalStart) {
      nextCursor = recoveredCursor;
      emitDebug("semantic-aligned-chunk-recovery", {
        regionIndex, requestStart, requestEnd, previousCursor: finalStart, nextCursor
      });
    }
  }
  if (nextCursor > finalStart) {
    request.lastProgressAt = Date.now();
    request.progressCursor = nextCursor;
    state.cursor = nextCursor;
    state.commitFloor = nextCursor;
    state.windowItems = DEEPSEEK_REQUEST_ITEMS;
    state.recoveryWindowItems = false; state.noProgressRange = "";
  }
  const madeProgress = state.cursor > requestStart;
  const noProgressRange = `${finalStart}:${requestEnd}`;
  const repeatedNoProgress = !request.prefetch && !madeProgress && state.noProgressRange === noProgressRange;
  if (!request.prefetch && !madeProgress) state.noProgressRange = noProgressRange;
  if (madeProgress) {
    captionSession.deepseekRetryCounts.delete(deepseekBatchRetryKey(
      requestStart, requestEnd, reqVid, reqEpoch
    ));
    captionSession.deepseekExhaustedRegions.delete(regionIndex);
  } else if (canExpand && !request.prefetch && !repeatedNoProgress) {
    captionSession.deepseekRetryCounts.delete(deepseekBatchRetryKey(
      requestStart, requestEnd, reqVid, reqEpoch
    ));
    captionSession.deepseekExhaustedRegions.delete(regionIndex);
    const leadingUnitReachesEnd = deepseekLeadingUnitReachesRequestEnd(
      finalTranslations, finalStart, requestEnd
    );
    state.windowItems = leadingUnitReachesEnd
      ? maxRequestItems : Math.min(maxRequestItems, requestItems + 32);
    state.recoveryWindowItems = true;
    emitDebug("semantic-commit-window-expanded", {
      regionIndex, cursor: state.cursor, windowItems: state.windowItems,
      reason: leadingUnitReachesEnd ? "leading-unit-reaches-window-end" : "adaptive-no-progress"
    });
  } else if (!request.prefetch) {
    scheduleDeepSeekBatchRetry(
      requestStart, requestStart, requestEnd, reqVid, reqEpoch,
      "no immutable semantic prefix", { urgent: effectiveUrgent, bypassCache: true }
    );
    repaintActiveDeepseekTranslation();
    return;
  }
  pumpDeepseekSpeculativeRequests(regionIndex, state);
  repaintActiveDeepseekTranslation();
  if (state.cursor <= state.targetThrough && state.cursor <= state.limitEnd) {
    queueMicrotask(() => pumpDeepseekCommitRegion(
      regionIndex, deepseekKeepAcceleratedUrgentLane(effectiveUrgent, state)
    ));
  }
}

function launchDeepseekSpeculativeRequest(regionIndex, state, startValue, endValue) {
  const start = Math.floor(Number(startValue));
  let requestEnd = Math.min(state.limitEnd, Math.floor(Number(endValue)));
  if (!Number.isInteger(start) || !Number.isInteger(requestEnd) || requestEnd < start) return false;
  const inflightKey = `dsp:${regionIndex}:${start}`;
  if (captionSession.deepseekRequestMeta.has(inflightKey)) return false;
  const items = [];
  let currentChars = 0;
  for (let id = start; id <= requestEnd; id++) {
    const entry = deepseekBatchEntry(id, false);
    const nextChars = String(entry.text || "").length;
    if (items.length && currentChars + nextChars > DEEPSEEK_MAX_CURRENT_CHARS) break;
    items.push(entry);
    currentChars += nextChars;
  }
  if (!items.length) return false;
  requestEnd = start + items.length - 1;
  const requestId = beginDeepseekRequest(
    inflightKey, "prefetch", start, requestEnd, false
  );
  if (!requestId) return false;
  const requestSessionToken = captureCaptionSession();
  const request = captionSession.deepseekRequestMeta.get(inflightKey);
  const { contextBefore, contextAfter } = deepseekContextsForRange(start, requestEnd);
  const requestMeta = {
    prefetch: true, regionIndex, requestStart: start, requestEnd,
    commitFloor: state.commitFloor, limitEnd: state.limitEnd,
    effectiveGuardItems: Math.min(DEEPSEEK_COMMIT_GUARD_ITEMS,
      Math.max(0, Math.floor(items.length / 3))),
    reqVid: captionSession.cueVideoId, reqEpoch: captionSession.cueEpoch,
    sessionToken: requestSessionToken, focusGeneration: captionSession.deepseekFocusGeneration,
    fastPath: true,
    itemCount: items.length, targetAwareItems: items.length,
    maxRequestItems: deepseekMaxRequestItems()
  };
  if (request && request.requestId === requestId) Object.assign(request, requestMeta);
  const batchIndex = captionSession.deepseekGroupToBatch[start];
  const batch = captionSession.deepseekBatchWindows[batchIndex];
  sendRuntimeMessage({
    type: "translateBatch", endpointKind: deepseekEndpointKind(),
    debug: !!settings.debugEnabled, requestId,
    videoId: captionSession.cueVideoId,
    videoTimeMs: Math.round(((getVideo() && getVideo().currentTime) || 0) * 1000),
    targetLang: settings.targetLang, sourceLang: captionSession.cueSourceLang,
    coreStart: start, coreEnd: Math.min(requestEnd, batch ? batch.end : requestEnd),
    requestStart: start, requestEnd, bypassCache: false, urgent: false,
    focusGeneration: captionSession.deepseekFocusGeneration, fastPath: true, items,
    contextBefore, contextAfter
  }, (resp, runtimeError) => {
    const finished = finishDeepseekRequest(inflightKey, requestId);
    if (finished) handleDeepseekBatchResult(finished, resp, runtimeError);
  });
  return true;
}

function deepseekRequestById(requestId) {
  const wanted = String(requestId || "");
  if (!wanted) return null;
  for (const [inflightKey, request] of captionSession.deepseekRequestMeta.entries()) {
    if (request && request.requestId === wanted) return { inflightKey, request };
  }
  return null;
}

function cancelDeepseekPrefetchRequests() {
  for (const [inflightKey, request] of Array.from(captionSession.deepseekRequestMeta.entries())) {
    if (!request || request.urgent) continue;
    sendRuntimeMessage({
      type: "cancelDeepSeekRequest",
      videoId: captionSession.cueVideoId,
      requestId: request.requestId
    });
    emitCaptionStateTransition("semantic-request", "cancelled", {
      requestId: request.requestId,
      reason: "prefetch-disabled"
    });
    captionSession.deepseekRequestMeta.delete(inflightKey);
    captionSession.transInflight.delete(inflightKey);
  }
  for (const state of captionSession.deepseekCommitStateByRegion.values()) {
    deepseekPrefetchState(state);
    state.prefetchQueue.length = 0;
    state.prefetchQueued.clear();
    state.prefetchResponses.clear();
  }
}

function scheduleDeepSeekBatchRetry(
  gIdx, start, end, videoId, epoch, reason, retryOptions
) {
  const key = deepseekBatchRetryKey(start, end, videoId, epoch);
  const attempt = captionSession.deepseekRetryCounts.get(key) || 0;
  const rateLimited = !!(retryOptions && retryOptions.rateLimited);
  const maxAttempts = rateLimited
    ? DEEPSEEK_RATE_RETRY_LIMIT : DEEPSEEK_COLD_RETRY_DELAYS_MS.length;
  if (attempt >= maxAttempts) {
    const regionIndex = captionSession.deepseekGroupToCommitRegion[gIdx];
    if (Number.isInteger(regionIndex)) {
      captionSession.deepseekExhaustedRegions.set(regionIndex, {
        start, end, videoId, epoch, reason: String(reason || "")
      });
    }
    emitCaptionStateTransition("semantic-retry", "exhausted", {
      start, end, attempts: attempt, reason: String(reason || "")
    });
    emitDebug("batch-retry-exhausted", { start, end, reason: String(reason || "") });
    if (captionSession.activeGroupIdx >= 0 &&
        captionSession.deepseekGroupToCommitRegion[captionSession.activeGroupIdx] === regionIndex &&
        captionSession.activeCueIdx >= 0 && captionSession.cueList) {
      clearPendingTimer();
      const source = sourceForDisplayedCue(
        captionSession.activeCueIdx, captionSession.cueList[captionSession.activeCueIdx]
      );
      setTranslation(t("translationUnavailable", "Translation temporarily unavailable"), source);
    }
    return;
  }
  const requestedDelay = Number(retryOptions && retryOptions.retryAfterMs);
  const delayMs = rateLimited
    ? Math.max(500, Math.min(61000,
        Number.isFinite(requestedDelay) && requestedDelay > 0 ? Math.ceil(requestedDelay) : 1500))
    : DEEPSEEK_COLD_RETRY_DELAYS_MS[attempt];
  const regionIndex = captionSession.deepseekGroupToCommitRegion[gIdx];
  // One lock per semantic region preserves its single-writer commit cursor.
  const inflightKey = `dsb:${regionIndex}`;
  const scheduledFocusGeneration = captionSession.deepseekFocusGeneration;
  const scheduledSessionToken = captureCaptionSession();
  captionSession.deepseekRetryCounts.set(key, attempt + 1);
  captionSession.transInflight.add(inflightKey);
  emitDebug("batch-retry", {
    start, end, attempt: attempt + 1, delayMs, rateLimited,
    reason: String(reason || "")
  });
  emitCaptionStateTransition("semantic-retry", "scheduled", {
    start, end, attempt: attempt + 1, delayMs, reason: String(reason || "")
  });
  setTimeout(() => {
    captionSession.transInflight.delete(inflightKey);
    if (!isCaptionSessionCurrent(scheduledSessionToken) ||
        epoch !== captionSession.cueEpoch || videoId !== captionSession.cueVideoId) {
      captionSession.deepseekRetryCounts.delete(key);
      emitCaptionStateTransition("semantic-retry", "discarded", {
        start, end, attempt: attempt + 1, reason: "session-or-track-invalidated"
      });
      return;
    }
    if (scheduledFocusGeneration !== captionSession.deepseekFocusGeneration) {
      captionSession.deepseekRetryCounts.delete(key);
      emitCaptionStateTransition("semantic-retry", "discarded", {
        start, end, attempt: attempt + 1, reason: "focus-invalidated"
      });
      return;
    }
    emitCaptionStateTransition("semantic-retry", "resumed", {
      start, end, attempt: attempt + 1
    });
    deepseekRequestBatch(gIdx, true, !!(retryOptions && retryOptions.urgent), {
      bypassCache: !!(retryOptions && retryOptions.bypassCache)
    });
  }, delayMs);
}
