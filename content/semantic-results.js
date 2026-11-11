// Semantic translation batch results: cancellation, failure retry, and the
// commit of accepted responses into the region timeline.
"use strict";

function aiBatchCancelled(runtimeError, resp) {
  return !!(runtimeError && (runtimeError.cancelled ||
      YTDS_SHARED.aiErrorDescriptor(runtimeError).code === "AI_CANCELLED")) ||
    !!(resp && resp.cancelled) || YTDS_SHARED.aiErrorDescriptor(resp).code === "AI_CANCELLED";
}

function aiUrgentCommitPending(state) {
  return state.cursor <= state.targetThrough && state.cursor <= state.limitEnd;
}

// After a lane settles, keep lookahead moving: continue this region or start
// the next one, measured from the playback position.
function continueAiLookahead(fromGroup) {
  const active = captionSession.activeGroupIdx;
  const anchor = Number.isInteger(active) && active >= 0 ? active : fromGroup;
  queueMicrotask(() => advanceAiLookahead(anchor));
}

function queueAiCommitPump(ctx) {
  queueMicrotask(() => pumpAiCommitRegion(
    ctx.regionIndex, aiKeepUrgentLane(ctx.urgent, ctx.state)
  ));
}

function handleAiBatchCancelled(ctx) {
  const { request, state, regionIndex, requestStart } = ctx;
  emitCaptionStateTransition("semantic-response", "cancelled", {
    requestId: ctx.requestId, requestStart, requestEnd: ctx.requestEnd
  });
  const hasActiveCommit = Array.from(captionSession.semanticRequestMeta.values()).some((r) => r && !r.prefetch);
  if (request.prefetch && !hasActiveCommit) pumpAiSpeculativeRequests(regionIndex, state);
  else { clearPendingTimer(); repaintActiveAiTranslation(); }
  if (aiUrgentCommitPending(state) && (!request.prefetch || state.cursor === requestStart)) {
    queueMicrotask(() => pumpAiCommitRegion(regionIndex,
      request.prefetch ? true : aiKeepUrgentLane(ctx.urgent, state)));
  }
}

// A failed speculative request never retries itself: it re-queues behind a
// rate limit, and if the commit cursor already waits on it, the commit lane
// fetches the same range directly.
function handleAiPrefetchFailure(ctx, resp, runtimeError) {
  const { regionIndex, state, requestStart } = ctx;
  if (noteAiSpeculativeRateLimit(resp, runtimeError)) {
    queueAiSpeculativeRequest(regionIndex, requestStart);
  }
  pumpAiSpeculativeRequests(regionIndex, state);
  if (state.cursor === requestStart) aiRequestBatch(requestStart, true, true, { bypassCache: true });
}

// A failed commit request either continues from progress streamed before
// the failure or retries its whole range.
function continueOrRetryAiCommit(ctx, scheduleRetry) {
  if (ctx.state.cursor > ctx.requestStart) {
    repaintActiveAiTranslation();
    if (aiCommitPending(ctx.state)) queueAiCommitPump(ctx);
    return;
  }
  if (scheduleRetry()) repaintActiveAiTranslation();
}

function handleAiBatchRuntimeError(ctx, runtimeError) {
  if (ctx.request.prefetch) {
    handleAiPrefetchFailure(ctx, null, runtimeError);
    return;
  }
  continueOrRetryAiCommit(ctx, () => {
    scheduleAiBatchRetry(
      ctx.requestStart, ctx.requestStart, ctx.requestEnd, ctx.reqVid, ctx.reqEpoch,
      runtimeError.message || "runtime unavailable", { urgent: ctx.urgent, error: runtimeError }
    );
    return true;
  });
}

function handleAiBatchRejected(ctx, resp, runtimeError) {
  if (ctx.request.prefetch) {
    handleAiPrefetchFailure(ctx, resp, runtimeError);
    return;
  }
  const { regionIndex, requestStart, requestEnd } = ctx;
  const error = resp && resp.error || "empty background response";
  emitDebug("batch-rejected", {
    regionIndex, requestStart, requestEnd, error, errorCode: resp && resp.errorCode || "", providerCode: resp && resp.providerCode || "",
    needsKey: !!(resp && resp.needsKey), timeout: !!(resp && resp.timeout),
    rateLimited: !!(resp && resp.rateLimited),
    retryAfterMs: Number(resp && resp.retryAfterMs) || 0,
    limitReason: String(resp && resp.limitReason || "")
  });
  emitCaptionStateTransition("semantic-response", "rejected", {
    requestId: ctx.requestId, reason: String(error || "rejected"),
    retryable: !!(!resp || resp.netfail || resp.timeout || resp.rateLimited)
  });
  continueOrRetryAiCommit(ctx, () => {
    if (resp && resp.cancelled) return false;
    scheduleAiBatchRetry(requestStart, requestStart, requestEnd, ctx.reqVid, ctx.reqEpoch, error, {
      rateLimited: !!(resp && resp.rateLimited),
      retryAfterMs: Number(resp && resp.retryAfterMs) || 0,
      urgent: ctx.urgent, error: resp
    });
    return true;
  });
}

// Commit the immutable prefix of an accepted response; fall back to aligned
// chunk recovery when the semantic units alone cannot advance the cursor.
function commitAcceptedAiResponse(ctx, resp, finalStart, finalTranslations, canRecoverAlignedChunks) {
  const { request, state, regionIndex, requestStart, requestEnd } = ctx;
  let nextCursor = commitAiResponsePrefix(
    regionIndex, finalStart, requestEnd, state.commitFloor, request.limitEnd,
    finalTranslations, request.effectiveGuardItems, AI_MIN_COMMIT_RUNWAY_ITEMS
  );
  if (!Number.isInteger(nextCursor)) return null;
  if (nextCursor === finalStart && canRecoverAlignedChunks) {
    const recoveredTranslations = YTDS_SHARED.semanticUnitsFromAlignedChunks(
      aiAlignedRecoveryInput(resp.translations, finalStart)
    );
    const recoveredCursor = commitAiResponsePrefix(
      regionIndex, finalStart, requestEnd, state.commitFloor, request.limitEnd,
      recoveredTranslations, request.effectiveGuardItems, AI_MIN_COMMIT_RUNWAY_ITEMS
    );
    if (Number.isInteger(recoveredCursor) && recoveredCursor > finalStart) {
      nextCursor = recoveredCursor;
      emitDebug("semantic-aligned-chunk-recovery", {
        regionIndex, requestStart, requestEnd, previousCursor: finalStart, nextCursor
      });
    }
  }
  return nextCursor;
}

function advanceAiCommitCursor(ctx, resp, nextCursor) {
  const { request, state } = ctx;
  request.lastProgressAt = Date.now();
  request.progressCursor = nextCursor;
  state.cursor = nextCursor;
  state.commitFloor = nextCursor;
  if (typeof aiSkipCommittedBlock === "function") aiSkipCommittedBlock(ctx.regionIndex, state);
  reconcileAiPrefetchCandidates(state, state.cursor);
  if (request.promotedFromPrefetch) storeAiPrefetchCandidate(state, request, resp);
  const hadDeferrals = Array.isArray(resp && resp.deferredIds) && resp.deferredIds.length > 0;
  state.windowItems = hadDeferrals
    ? Math.min(aiUrgentRequestItems(), 96)
    : aiSteadyRequestItems();
  state.recoveryWindowItems = false; state.noProgressRange = "";
}

function clearAiRegionRetryState(ctx) {
  captionSession.semanticRetryCounts.delete(aiBatchRetryKey(
    ctx.requestStart, ctx.requestEnd, ctx.reqVid, ctx.reqEpoch
  ));
  captionSession.semanticExhaustedRegions.delete(ctx.regionIndex);
}

function handleAiBatchAccepted(ctx, resp) {
  const { request, state, regionIndex, requestStart, requestEnd } = ctx;
  emitDebug("ai-batch-response", {
    regionIndex, requestStart, requestEnd,
    itemCount: Number(request.itemCount) || 0,
    urgent: ctx.urgent,
    modelDeferredIds: Array.isArray(resp.deferredIds) ? resp.deferredIds : [], errorCode: resp.errorCode || "", providerCode: resp.providerCode || "",
    httpDiagnostics: resp.httpDiagnostics || { attempts: [] }
  });
  emitCaptionStateTransition("semantic-response", "accepted", {
    requestId: ctx.requestId, translationCount: resp.translations.length, partial: !!resp.partial
  });
  const finalStart = state.cursor;
  const finalTranslations = resp.translations.filter(
    (item) => Number(item && item.id) >= finalStart
  );
  const maxRequestItems = Number(request.maxRequestItems) || aiMaxRequestItems();
  const requestItems = Number(request.itemCount) || Number(request.targetAwareItems) || 0;
  const canExpand = requestEnd < request.limitEnd && requestItems < maxRequestItems;
  const nextCursor = commitAcceptedAiResponse(
    ctx, resp, finalStart, finalTranslations, ctx.urgent || !canExpand
  );
  if (nextCursor == null) return;
  if (nextCursor > finalStart) advanceAiCommitCursor(ctx, resp, nextCursor);

  const madeProgress = state.cursor > requestStart;
  const noProgressRange = `${finalStart}:${requestEnd}`;
  const repeatedNoProgress = !request.prefetch && !madeProgress && state.noProgressRange === noProgressRange;
  if (!request.prefetch && !madeProgress) state.noProgressRange = noProgressRange;
  if (madeProgress) {
    clearAiRegionRetryState(ctx);
  } else if (canExpand && !request.prefetch && !repeatedNoProgress) {
    clearAiRegionRetryState(ctx);
    const leadingUnitReachesEnd = aiLeadingUnitReachesRequestEnd(
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
    scheduleAiBatchRetry(
      requestStart, requestStart, requestEnd, ctx.reqVid, ctx.reqEpoch,
      "no immutable semantic prefix", { urgent: ctx.urgent, bypassCache: true, error: resp && resp.error || "", errorCode: resp && resp.errorCode || "AI_NO_PROGRESS", providerCode: resp && resp.providerCode }
    );
    repaintActiveAiTranslation();
    return;
  }
  // The visible commit lane goes first; speculative lanes resume after it.
  if (!aiUrgentCommitPending(state)) pumpAiSpeculativeRequests(regionIndex, state);
  repaintActiveAiTranslation();
  if (aiCommitPending(state)) queueAiCommitPump(ctx);
  else continueAiLookahead(state.cursor);
}

function handleAiBatchResult(request, resp, runtimeError) {
  if (!request || !Number.isInteger(request.regionIndex)) return;
  const regionIndex = request.regionIndex;
  const requestId = String(request.requestId || "");
  const state = aiCommitState(regionIndex);
  if (!state || !isCaptionSessionCurrent(request.sessionToken)) return;
  const ctx = {
    request,
    state,
    regionIndex,
    requestId,
    requestStart: Number(request.requestStart),
    // A request spanning later regions commits only inside its own region;
    // the rest is handed to those regions below.
    requestEnd: Math.min(Number(request.requestEnd),
      Number.isInteger(request.limitEnd) ? request.limitEnd : Number(request.requestEnd)),
    reqVid: request.reqVid,
    reqEpoch: request.reqEpoch,
    urgent: !!request.urgent
  };
  aiPrefetchState(state);
  for (const [key, stored] of Array.from(state.prefetchResponses.entries())) {
    if (stored && stored.request && (stored.request === request ||
        String(stored.request.requestId || "") === requestId)) state.prefetchResponses.delete(key);
  }
  const originalRuntimeError = runtimeError;
  const bufferedResponse = aiResponseWithBufferedProgress(request, resp, state);
  if (bufferedResponse && bufferedResponse !== resp) { resp = bufferedResponse; runtimeError = null; }
  const isLocalConcurrency = (resp && resp.limitReason === "local-concurrency") ||
    (runtimeError && runtimeError.limitReason === "local-concurrency");
  if (!isLocalConcurrency) clearAiSpeculativeBackoff("local-concurrency");
  if (typeof aiUpdateDisplayError === "function") {
    aiUpdateDisplayError(regionIndex, request, originalRuntimeError, resp);
  }
  if (aiBatchCancelled(runtimeError, resp)) { handleAiBatchCancelled(ctx); return; }
  if (runtimeError) { handleAiBatchRuntimeError(ctx, runtimeError); return; }
  if (ctx.reqEpoch !== captionSession.cueEpoch || ctx.reqVid !== captionSession.cueVideoId) return;
  if (!resp || !resp.ok || !Array.isArray(resp.translations)) {
    handleAiBatchRejected(ctx, resp, runtimeError);
    return;
  }
  if (typeof distributeAiSpanResponse === "function") distributeAiSpanResponse(request, resp);
  if (request.prefetch) {
    const stored = storeAiPrefetchCandidate(state, request, resp);
    pumpAiSpeculativeRequests(regionIndex, state);
    if (stored && state.cursor === stored.start) {
      queueMicrotask(() => pumpAiCommitRegion(regionIndex, true));
    }
    return;
  }
  handleAiBatchAccepted(ctx, resp);
}
