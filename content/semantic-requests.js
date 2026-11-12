// Semantic request ownership, cancellation and retry state machine.
"use strict";

// ---- ownership: the only writer of semanticRequestMeta / transInflight ----
// semanticRequestMeta maps an inflight key to its live request owner.
// transInflight is "this key is busy": every owner key, plus keys held by a
// pending retry. A retry hold is a token: only the timer that took it can
// release it, so a stale timer can never free a key a newer owner now holds.
function aiRequestHolds() {
  if (!(captionSession.semanticRequestHolds instanceof Map)) captionSession.semanticRequestHolds = new Map();
  return captionSession.semanticRequestHolds;
}
function claimAiRequestOwner(inflightKey, request) {
  aiRequestHolds().delete(inflightKey);
  captionSession.semanticRequestMeta.set(inflightKey, request);
  captionSession.transInflight.add(inflightKey);
}
// Releases the owner of a key; with `request`, only if it is still the owner.
function releaseAiRequestOwner(inflightKey, request) {
  if (request && captionSession.semanticRequestMeta.get(inflightKey) !== request) return false;
  const released = captionSession.semanticRequestMeta.delete(inflightKey);
  if (!aiRequestHolds().has(inflightKey)) captionSession.transInflight.delete(inflightKey);
  return released;
}
function releaseAiRequestOwnerOf(request) {
  for (const [key, value] of captionSession.semanticRequestMeta.entries()) {
    if (value === request) return releaseAiRequestOwner(key, request) ? key : "";
  }
  return "";
}
function holdAiRequestKey(inflightKey) {
  const hold = Object.freeze({ inflightKey });
  aiRequestHolds().set(inflightKey, hold);
  captionSession.transInflight.add(inflightKey);
  return hold;
}
function releaseAiRequestHold(hold) {
  if (!hold || aiRequestHolds().get(hold.inflightKey) !== hold) return false;
  aiRequestHolds().delete(hold.inflightKey);
  if (!captionSession.semanticRequestMeta.has(hold.inflightKey)) captionSession.transInflight.delete(hold.inflightKey);
  return true;
}
// Drops owners and holds of every key the predicate selects.
function revokeAiRequestKeys(predicate) {
  for (const key of Array.from(captionSession.transInflight)) {
    if (!predicate(key)) continue;
    captionSession.semanticRequestMeta.delete(key);
    aiRequestHolds().delete(key);
    captionSession.transInflight.delete(key);
  }
}

// Provider latency as this page measures it (request start -> first committed
// progress, committed items per second), kept across videos for one
// endpoint and model. Every "is this writer stuck / too slow" decision below
// is a predicted-time comparison in YTDS_SHARED.schedule*; there are no
// per-provider, per-speed or per-item thresholds.
function aiLatencyStats() {
  const key = `${settings.aiBaseUrl || ""}|${settings.aiModel || ""}`;
  if (!captionSession.semanticLatency || captionSession.semanticLatency.key !== key) {
    captionSession.semanticLatency = YTDS_SHARED.scheduleLatencyCreate(key);
  }
  return captionSession.semanticLatency;
}
function aiLatencyEstimate() {
  return YTDS_SHARED.scheduleLatencyEstimate(aiLatencyStats());
}
// The one place a writer's committed progress is recorded. Only progress
// streamed from the provider measures its latency: a response cache hit or
// an adopted finished prefetch arrives at once and says nothing about it.
function noteAiRequestProgress(request, nextCursor, streamed) {
  const now = Date.now();
  if (streamed) {
    const stats = aiLatencyStats();
    if (!(Number(request.firstProgressAt) > 0)) {
      request.firstProgressAt = now;
      request.firstProgressCursor = Number(request.progressCursor);
      YTDS_SHARED.scheduleLatencyNote(stats, { firstMs: now - Number(request.startedAt) });
    } else {
      YTDS_SHARED.scheduleLatencyNote(stats, { id: request.requestId,
        items: nextCursor - Number(request.firstProgressCursor), ms: now - Number(request.firstProgressAt) });
    }
  }
  request.lastProgressAt = now;
  request.progressCursor = nextCursor;
}

function aiRequestHasProgress(request) {
  if (!request) return false;
  const requestStart = Number(request.requestStart);
  const progressCursor = Number(request.progressCursor);
  if (!Number.isInteger(requestStart) || !Number.isInteger(progressCursor) ||
      progressCursor <= requestStart) return false;
  return YTDS_SHARED.scheduleProgressFresh({ now: Date.now(), lastProgressAt: request.lastProgressAt,
    estimate: aiLatencyEstimate() });
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
  // Playback has passed its whole range: it keeps its slot only while its
  // first progress is still expected (the provider's usual wait).
  const target = Number(targetGroup);
  const requestEnd = Number(request.requestEnd);
  return Number.isInteger(target) && Number.isInteger(requestEnd) && target > requestEnd &&
    YTDS_SHARED.scheduleFirstOverdue({ now: Date.now(), startedAt: request.startedAt,
      estimate: aiLatencyEstimate(), expectedOnly: true });
}
// The visible writer is replaced only when it is stuck (see shared/schedule.js).
function aiRequestIsPlaybackLagging(request, state, targetGroup) {
  if (!request || !request.urgent || !state || typeof getVideo !== "function") return false;
  if (typeof captionSession === "object" && captionSession && captionSession.transCache &&
      typeof groupKey === "function" && captionSession.transCache.has(groupKey(targetGroup))) {
    return false;
  }
  const target = Number(targetGroup);
  if (!Number.isInteger(target) || !Number.isInteger(Number(state.cursor)) || target <= Number(state.cursor)) return false;
  return YTDS_SHARED.scheduleWriterStuck({
    now: Date.now(), requestStart: Number(request.requestStart),
    progressCursor: Number(request.progressCursor), startedAt: request.startedAt,
    lastProgressAt: request.lastProgressAt, estimate: aiLatencyEstimate()
  });
}
function aiSeekBacktrackItems() {
  const base = Math.max(0, Math.floor(Number(AI_SEEK_BACKTRACK_ITEMS) || 0));
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  // Read-only lead-in before a seek target, shrinking with playback speed.
  return Math.round(base / Math.max(1, Number.isFinite(rate) ? rate : 1));
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
  claimAiRequestOwner(inflightKey, {
    requestId,
    urgent: !!urgent,
    startedAt: Date.now(),
    lastProgressAt: 0,
    progressCursor: start,
    progressTranslations: [],
    progressRecoveryTranslations: []
  });
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
  releaseAiRequestOwner(inflightKey, current);
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
    releaseAiRequestOwner(key);
  }
  const state = typeof semanticCommitState === "function" ? semanticCommitState(wanted) : null;
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
    releaseAiRequestOwner(key);
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
    releaseAiRequestOwner(inflightKey);
    return true;
  };
  for (const [key, request] of Array.from(captionSession.semanticRequestMeta.entries())) {
    if (!request || !request.prefetch || request.regionIndex !== wanted) continue;
    cancel(key, request);
  }
  const state = typeof semanticCommitState === "function"
    ? semanticCommitState(wanted) : null;
  if (state) {
    aiPrefetchState(state);
    for (const [start, stored] of Array.from(state.prefetchResponses.entries())) {
      const request = stored && stored.request;
      if (request && aiRequestIsStaleForTarget(request, target)) {
        state.prefetchResponses.delete(start);
      }
    }
  }
}
// Ranges a region already has a writer for: live requests and finished
// speculative responses waiting for the cursor. Both are paid for, so a new
// speculative window must never overlap either.
function aiCoveredRequestRanges(regionIndex) {
  const ranges = [];
  for (const request of captionSession.semanticRequestMeta.values()) {
    if (request && request.regionIndex === regionIndex) ranges.push(request);
  }
  const state = typeof semanticCommitState === "function" ? semanticCommitState(regionIndex) : null;
  if (state && state.prefetchResponses) {
    for (const stored of state.prefetchResponses.values()) {
      if (stored && stored.request) ranges.push(stored.request);
    }
  }
  return ranges;
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


// Live commit requests whose range contains `group`, keyed by inflight key.
// Live commit writers the scheduler would send again right after a seek to
// `group`: the writer whose range covers the target, and every lookahead lane
// that runs from its region's cursor at or ahead of the target within reach.
function aiCommitRequestsWantedAfterSeek(group) {
  const kept = new Map();
  const target = Number(group);
  const groupToRegion = captionSession.semanticGroupToCommitRegion;
  const regions = captionSession.semanticCommitRegions;
  const targetRegion = groupToRegion && Number.isInteger(target) ? groupToRegion[target] : undefined;
  if (!Number.isInteger(targetRegion) || !regions) return kept;
  // One lookahead batch of hysteresis: playback keeps advancing after the
  // seek, so a lane just past the reach is wanted again within moments
  // (sim seed 9021: cancelled one item beyond reach, restarted 10 ms later).
  const batchItems = typeof AI_LOOKAHEAD_ITEMS_PER_BATCH === "number" ? AI_LOOKAHEAD_ITEMS_PER_BATCH : 32;
  const reach = target + (typeof aiLookaheadItems === "function" ? aiLookaheadItems() : 0) + batchItems;
  for (const [key, request] of captionSession.semanticRequestMeta.entries()) {
    if (!request || request.prefetch || key !== `dsb:${request.regionIndex}` ||
        request.reqEpoch !== captionSession.cueEpoch ||
        !isCaptionSessionCurrent(request.sessionToken)) continue;
    const start = Number(request.requestStart);
    const covers = request.regionIndex === targetRegion && start <= target && target <= Number(request.requestEnd);
    const state = captionSession.semanticCommitStateByRegion &&
      captionSession.semanticCommitStateByRegion.get(request.regionIndex);
    const lookaheadLane = request.regionIndex >= targetRegion && !!state && state.cursor === start &&
      start >= target && start <= reach;
    if (covers || lookaheadLane) kept.set(key, request);
  }
  return kept;
}
// Hand requests kept across a seek to the new session. Ownership moves to the
// new token; focusGeneration stays the transport identity the worker echoes.
function adoptAiRequestsAfterSeek(kept) {
  for (const [key, request] of kept.entries()) {
    Object.assign(request, {
      sessionToken: captureCaptionSession(),
      reqEpoch: captionSession.cueEpoch
    });
    claimAiRequestOwner(key, request);
    emitCaptionStateTransition("semantic-request", "adopted", {
      requestId: request.requestId,
      reason: "seek-target-covered",
      requestStart: request.requestStart,
      requestEnd: request.requestEnd
    });
  }
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
    releaseAiRequestOwner(inflightKey);
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
    : /^(?:HTTP_\d+|AI_CONFIG_MISSING|AI_KEY_MISSING|AI_HOST_PERMISSION_MISSING|AI_OUTPUT_EXHAUSTED|AI_PROVIDER_FILTERED)$/.test(errorInfo.code) ? 0 : AI_COLD_RETRY_DELAYS_MS.length;
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
  const retryHold = holdAiRequestKey(inflightKey);
  emitDebug("batch-retry", {
    start, end, attempt: attempt + 1, delayMs, rateLimited,
    reason: String(reason || "")
  });
  emitCaptionStateTransition("semantic-retry", "scheduled", { start, end, attempt: attempt + 1, delayMs, reason: String(reason || "") });
  setTimeout(() => {
    releaseAiRequestHold(retryHold);
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
