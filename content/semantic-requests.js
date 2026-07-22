// Semantic request ownership, cancellation and retry state machine.
"use strict";

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
    progressTranslations: []
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
