// Chrome runtime message router.
"use strict";

const AI_REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const DEBUG_MESSAGE_MAX_CHARS = 50000;

// A full local prefetch slot is ordinary scheduler backpressure, and a
// speculative (non-urgent) provider 429 is retried quietly in the background.
// Neither is evidence the user must act on, so neither surfaces as status;
// the retry response still lets the content state machine resume later.
function classifyAiRateLimit(err, urgent) {
  const rateLimited = !!(err && err.rateLimited);
  const localBackpressure = rateLimited && err.limitReason === "local-concurrency";
  const backgroundRateLimit = !urgent && rateLimited && !localBackpressure;
  return {
    localBackpressure,
    backgroundRateLimit,
    userVisible: !localBackpressure && !backgroundRateLimit
  };
}

function aiFailureStatusKind(err) {
  if (err && err.needsKey) return "key";
  if (err && err.needsPermission) return "permission";
  if (err && err.timeout) return "timeout";
  if (err && err.rateLimited) return "limited";
  return "error";
}

function respondAsync(promise, sendResponse, wrap) {
  promise.then((value) => sendResponse(wrap(value)));
  return true;
}

function handleDebugLog(msg, sender, sendResponse) {
  let serialized = "";
  try { serialized = JSON.stringify(msg.data); } catch (_e) { /* rejected below */ }
  if (!isYoutubeSender(sender) || !serialized) {
    sendResponse({ ok: false, error: "invalid debug message" });
    return false;
  }
  if (serialized.length > DEBUG_MESSAGE_MAX_CHARS) {
    appendDebug("content", msg.event, {
      truncated: true,
      originalChars: serialized.length,
      keys: msg.data && typeof msg.data === "object"
        ? Object.keys(msg.data).slice(0, 24) : []
    });
    sendResponse({ ok: true, truncated: true });
    return false;
  }
  appendDebug("content", msg.event, msg.data);
  sendResponse({ ok: true });
  return false;
}

function handleCancelAiTranslation(msg, sender, sendResponse) {
  if (!isYoutubeSender(sender)) {
    sendResponse({ ok: false, error: "untrusted sender", errorCode: "AI_UNTRUSTED_SENDER" });
    return false;
  }
  cancelAiForSender(sender, msg.videoId, msg.beforeFocusGeneration, msg.keepRequestIds);
  sendResponse({ ok: true });
  return false;
}

function handleCancelAiTranslationRequest(msg, sender, sendResponse) {
  const requestId = String(msg.requestId || "");
  if (!isYoutubeSender(sender) || !AI_REQUEST_ID_PATTERN.test(requestId) ||
      !YTDS_SHARED.videoIdMatchesPageUrls(msg.videoId, senderPageUrls(sender))) {
    sendResponse({ ok: false, error: "invalid cancellation request" });
    return false;
  }
  sendResponse({
    ok: true,
    cancelled: cancelAiRequestForSender(sender, msg.videoId, requestId)
  });
  return false;
}

function parseTranslateBatch(msg, sender) {
  const items = cleanBatchItems(msg.items);
  const targetLang = cleanTargetLang(msg.targetLang);
  const sourceLang = cleanSourceLang(msg.sourceLang);
  const contextBefore = cleanContext(msg.contextBefore, 20, "past");
  const contextAfter = cleanContext(msg.contextAfter, 20, "future");
  const requestId = String(msg.requestId || "");
  if (!items || !targetLang || contextBefore == null || contextAfter == null ||
      !AI_REQUEST_ID_PATTERN.test(requestId) ||
      !YTDS_SHARED.videoIdMatchesPageUrls(msg.videoId, senderPageUrls(sender))) {
    return null;
  }
  return {
    items,
    targetLang,
    sourceLang,
    contextBefore,
    contextAfter,
    requestId,
    videoId: String(msg.videoId || ""),
    urgent: !!msg.urgent,
    fastPath: msg.fastPath === true,
    debug: !!msg.debug,
    maxConcurrency: YTDS_SHARED.normalizeAiMaxConcurrency(msg.maxConcurrency, 4),
    requestLimited: msg.requestLimited === true,
    commitGuardLocal: Number.isInteger(msg.commitGuardLocal) &&
      msg.commitGuardLocal > 0 && msg.commitGuardLocal < items.length
      ? msg.commitGuardLocal : -1,
    focusGeneration: Math.max(0, Math.floor(Number(msg.focusGeneration) || 0))
  };
}

function batchStartDiagnostics(msg, batch) {
  return {
    videoId: batch.videoId,
    videoTimeMs: msg.videoTimeMs,
    targetLang: batch.targetLang,
    coreStart: Number(msg.coreStart),
    coreEnd: Number(msg.coreEnd),
    requestStart: Number(msg.requestStart),
    requestEnd: Number(msg.requestEnd),
    repair: !!msg.repair,
    bypassCache: !!msg.bypassCache,
    urgent: batch.urgent,
    fastPath: !!msg.fastPath,
    requestId: batch.requestId,
    requestClass: batch.urgent ? "urgent" : msg.fastPath ? "prefetch-fast" : "prefetch",
    focusGeneration: batch.focusGeneration,
    itemCount: batch.items.length,
    sourceChars: batch.items.reduce((sum, item) => sum + String(item.text || "").length, 0),
    firstId: batch.items.length ? String(batch.items[0].id) : "",
    lastId: batch.items.length ? String(batch.items[batch.items.length - 1].id) : "",
    contextBeforeCount: batch.contextBefore.length,
    contextAfterCount: batch.contextAfter.length
  };
}

function slotUnavailableResponse(err, batch) {
  const errorInfo = YTDS_SHARED.aiErrorDescriptor(err);
  if (classifyAiRateLimit(err, batch.urgent).userVisible) {
    persistAiStatus("limited", err.message, errorInfo.code);
  }
  return {
    ok: false,
    error: String(err),
    errorCode: errorInfo.code,
    providerCode: errorInfo.providerCode,
    rateLimited: true,
    retryAfterMs: Number(err && err.retryAfterMs) || 1500,
    limitReason: String(err && err.limitReason || "")
  };
}

function batchSuccessResponse(translations, batch, batchStarted) {
  const failures = translations.failures || [];
  const deferredIds = translations.deferredIds || [];
  const streamPartial = !!translations.streamPartial;
  const streamError = String(translations.error || translations.streamError || "");
  const errorInfo = streamError || translations.errorCode
    ? YTDS_SHARED.aiErrorDescriptor({
        errorCode: translations.errorCode || "AI_JSONL_INVALID",
        providerCode: translations.providerCode
      })
    : { code: "", providerCode: "" };
  const cancelled = !!translations.cancelled || errorInfo.code === "AI_CANCELLED";
  const httpDiagnostics = translations.httpDiagnostics || { attempts: [] };
  if (batch.debug) appendDebug("background", "batch-complete", {
    durationMs: Date.now() - batchStarted,
    translationCount: translations.length,
    unitCount: new Set(translations.map((item) => item && item.unitId).filter(Boolean)).size,
    deferredCount: deferredIds.length,
    attemptCount: Array.isArray(httpDiagnostics.attempts) ? httpDiagnostics.attempts.length : 0,
    streamPartial,
    errorCode: errorInfo.code,
    providerCode: errorInfo.providerCode,
    failures: failures.map(String)
  });
  if (!cancelled && !batch.fastPath) {
    persistAiStatus(
      failures.length || streamError || translations.errorCode ? "partial" : "",
      streamError || failures[0], errorInfo.code
    );
  }
  return {
    ok: !cancelled,
    translations,
    ...(streamError || translations.errorCode || cancelled ? { error: streamError, errorCode: errorInfo.code,
      providerCode: errorInfo.providerCode } : {}),
    deferredIds,
    httpDiagnostics,
    partial: !cancelled && (failures.length > 0 || streamPartial),
    streamPartial,
    cancelled
  };
}

function batchFailureResponse(err, batch, batchStarted) {
  const errorInfo = YTDS_SHARED.aiErrorDescriptor(err);
  if (!(err && err.cancelled) && !batch.fastPath &&
      classifyAiRateLimit(err, batch.urgent).userVisible) {
    persistAiStatus(aiFailureStatusKind(err), err, errorInfo.code);
  }
  const httpDiagnostics = err && err.httpDiagnostics || { attempts: [] };
  if (batch.debug) appendDebug("background", "batch-error", {
    durationMs: Date.now() - batchStarted,
    error: String(err),
    errorCode: errorInfo.code,
    providerCode: errorInfo.providerCode,
    httpDiagnostics
  });
  return {
    ok: false,
    error: String(err),
    errorCode: errorInfo.code,
    providerCode: errorInfo.providerCode,
    netfail: !!(err && err.netfail),
    needsKey: !!(err && err.needsKey),
    needsPermission: !!(err && err.needsPermission),
    timeout: !!(err && err.timeout),
    connectTimeout: !!(err && err.connectTimeout),
    rateLimited: !!(err && err.rateLimited),
    retryAfterMs: Number(err && err.retryAfterMs) || 0,
    limitReason: String(err && err.limitReason || ""),
    cancelled: !!(err && err.cancelled),
    httpDiagnostics
  };
}

function handleTranslateBatch(msg, sender, sendResponse) {
  if (!isYoutubeSender(sender)) {
    sendResponse({ ok: false, error: "untrusted sender" });
    return false;
  }
  const batch = parseTranslateBatch(msg, sender);
  if (!batch) {
    sendResponse({ ok: false, error: "invalid translation batch", errorCode: "AI_INVALID_BATCH" });
    return false;
  }
  let release;
  try { release = acquireAiSlot(sender, batch.urgent, batch.maxConcurrency, batch.requestLimited); }
  catch (err) {
    sendResponse(slotUnavailableResponse(err, batch));
    return false;
  }
  const controller = new AbortController();
  const unregisterController = registerAiController(
    sender, msg.videoId, controller, batch.focusGeneration, batch.requestId, batch.urgent
  );
  const batchStarted = Date.now();
  if (batch.debug) appendDebug("background", "batch-start", batchStartDiagnostics(msg, batch));
  const scope = `${sender.tab.id}:${batch.videoId.slice(0, 32)}:focus:${batch.focusGeneration}`;
  aiTranslateBatch(
    batch.items, batch.targetLang, batch.sourceLang, batch.contextBefore, batch.contextAfter,
    batch.debug, scope, controller.signal,
    {
      requestId: batch.requestId,
      urgent: batch.urgent,
      fastPath: !!msg.fastPath,
      bypassCache: !!msg.bypassCache,
      commitGuardLocal: batch.commitGuardLocal,
      onProgress: (translations) => sendTranslationBatchProgress(sender, {
        type: "translationBatchProgress",
        requestId: batch.requestId,
        videoId: batch.videoId,
        focusGeneration: batch.focusGeneration,
        translations
      })
    }
  )
    .then((translations) => sendResponse(batchSuccessResponse(translations, batch, batchStarted)))
    .catch((err) => sendResponse(batchFailureResponse(err, batch, batchStarted)))
    .finally(() => {
      unregisterController();
      release();
    });
  return true;
}

const RUNTIME_MESSAGE_HANDLERS = Object.freeze({
  getAiTokenUsage: (_msg, _sender, sendResponse) =>
    respondAsync(currentAiTokenUsage(), sendResponse, (usage) => ({ ok: true, usage })),
  resetAiTokenUsage: (_msg, _sender, sendResponse) =>
    respondAsync(resetAiTokenUsage(), sendResponse, (usage) => ({ ok: true, usage })),
  debugLog: handleDebugLog,
  getDebugLogs: (_msg, _sender, sendResponse) =>
    respondAsync(exportDebugLogs(), sendResponse, (logs) => ({ ok: true, logs })),
  clearDebugLogs: (_msg, _sender, sendResponse) =>
    respondAsync(clearDebugLogs(), sendResponse, () => ({ ok: true })),
  cancelAiTranslation: handleCancelAiTranslation,
  cancelAiTranslationRequest: handleCancelAiTranslationRequest,
  translateBatch: handleTranslateBatch
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && typeof msg.type === "string" ? msg.type : "";
  const handler = Object.prototype.hasOwnProperty.call(RUNTIME_MESSAGE_HANDLERS, type)
    ? RUNTIME_MESSAGE_HANDLERS[type] : null;
  return handler ? handler(msg, sender, sendResponse) : undefined;
});
