// Chrome runtime message router.
"use strict";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "getAiTokenUsage") {
    currentAiTokenUsage().then((usage) => sendResponse({ ok: true, usage }));
    return true;
  }
  if (msg && msg.type === "resetAiTokenUsage") {
    resetAiTokenUsage().then((usage) => sendResponse({ ok: true, usage }));
    return true;
  }
  if (msg && msg.type === "debugLog") {
    let serialized = "";
    try { serialized = JSON.stringify(msg.data); } catch (_e) { /* rejected below */ }
    if (!isYoutubeSender(sender) || !serialized) {
      sendResponse({ ok: false, error: "invalid debug message" });
      return;
    }
    if (serialized.length > 50000) {
      appendDebug("content", msg.event, {
        truncated: true,
        originalChars: serialized.length,
        keys: msg.data && typeof msg.data === "object"
          ? Object.keys(msg.data).slice(0, 24) : []
      });
      sendResponse({ ok: true, truncated: true });
      return;
    }
    appendDebug("content", msg.event, msg.data);
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === "getDebugLogs") {
    exportDebugLogs().then((logs) => sendResponse({ ok: true, logs }));
    return true;
  }
  if (msg && msg.type === "clearDebugLogs") {
    clearDebugLogs().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg && msg.type === "cancelDeepSeek") {
    if (!isYoutubeSender(sender)) {
      sendResponse({ ok: false, error: "untrusted sender" });
      return;
    }
    cancelDeepSeekForSender(sender, msg.videoId, msg.beforeFocusGeneration);
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === "cancelDeepSeekRequest") {
    const requestId = String(msg.requestId || "");
    if (!isYoutubeSender(sender) || !/^[A-Za-z0-9:_-]{1,128}$/.test(requestId) ||
        !YTDS_SHARED.videoIdMatchesPageUrls(msg.videoId, senderPageUrls(sender))) {
      sendResponse({ ok: false, error: "invalid cancellation request" });
      return;
    }
    sendResponse({
      ok: true,
      cancelled: cancelDeepSeekRequestForSender(sender, msg.videoId, requestId)
    });
    return;
  }
  if (msg && msg.type === "translateBatch") {
    if (!isYoutubeSender(sender)) {
      sendResponse({ ok: false, error: "untrusted sender" });
      return;
    }
    const items = cleanBatchItems(msg.items);
    const targetLang = cleanTargetLang(msg.targetLang);
    const sourceLang = cleanSourceLang(msg.sourceLang);
    const contextBefore = cleanContext(msg.contextBefore, 20, "past");
    const contextAfter = cleanContext(msg.contextAfter, 20, "future");
    const requestId = String(msg.requestId || "");
    if (!items || !targetLang || contextBefore == null || contextAfter == null ||
        !/^[A-Za-z0-9:_-]{1,128}$/.test(requestId) ||
        !YTDS_SHARED.videoIdMatchesPageUrls(msg.videoId, senderPageUrls(sender))) {
      sendResponse({ ok: false, error: "invalid translation batch" });
      return;
    }
    let release;
    try { release = acquireDeepSeekSlot(sender, !!msg.urgent); }
    catch (err) {
      persistAiStatus("limited", err.message);
      sendResponse({
        ok: false,
        error: String(err),
        rateLimited: true,
        retryAfterMs: Number(err && err.retryAfterMs) || 1500,
        limitReason: String(err && err.limitReason || "")
      });
      return;
    }
    const controller = new AbortController();
    const focusGeneration = Math.max(0, Math.floor(Number(msg.focusGeneration) || 0));
    const unregisterController = registerDeepSeekController(
      sender, msg.videoId, controller, focusGeneration, requestId, !!msg.urgent
    );
    const batchStarted = Date.now();
    if (msg.debug) appendDebug("background", "batch-start", {
      videoId: msg.videoId || "",
      videoTimeMs: msg.videoTimeMs,
      targetLang,
      coreStart: Number(msg.coreStart),
      coreEnd: Number(msg.coreEnd),
      requestStart: Number(msg.requestStart),
      requestEnd: Number(msg.requestEnd),
      repair: !!msg.repair,
      bypassCache: !!msg.bypassCache,
      urgent: !!msg.urgent,
      requestId,
      requestClass: msg.urgent ? "urgent" : "prefetch",
      focusGeneration,
      itemCount: items.length,
      sourceChars: items.reduce((sum, item) => sum + String(item.text || "").length, 0),
      firstId: items.length ? String(items[0].id) : "",
      lastId: items.length ? String(items[items.length - 1].id) : "",
      contextBeforeCount: contextBefore.length,
      contextAfterCount: contextAfter.length
    });
    const scope = `${sender.tab.id}:${String(msg.videoId || "").slice(0, 32)}:focus:${focusGeneration}`;
    deepseekTranslateBatch(
      items, targetLang, sourceLang, contextBefore, contextAfter, !!msg.debug, scope, controller.signal,
      {
        requestId,
        urgent: !!msg.urgent,
        bypassCache: !!msg.bypassCache,
        onProgress: (translations) => sendTranslationBatchProgress(sender, {
          type: "translationBatchProgress",
          requestId,
          videoId: String(msg.videoId || ""),
          focusGeneration,
          translations
        })
      }
    )
      .then((translations) => {
        const failures = translations.failures || [];
        const deferredIds = translations.deferredIds || [];
        const streamPartial = !!translations.streamPartial;
        const httpDiagnostics = translations.httpDiagnostics || { attempts: [] };
        if (msg.debug) appendDebug("background", "batch-complete", {
          durationMs: Date.now() - batchStarted,
          translationCount: translations.length,
          unitCount: new Set(translations.map((item) => item && item.unitId).filter(Boolean)).size,
          deferredCount: deferredIds.length,
          attemptCount: Array.isArray(httpDiagnostics.attempts) ? httpDiagnostics.attempts.length : 0,
          streamPartial,
          failures: failures.map(String)
        });
        persistAiStatus(failures.length ? "partial" : "", failures[0]);
        sendResponse({
          ok: true,
          translations,
          deferredIds,
          httpDiagnostics,
          partial: failures.length > 0 || streamPartial,
          streamPartial
        });
      })
      .catch((err) => {
        if (!(err && err.cancelled)) {
          persistAiStatus(err && err.needsKey ? "key" :
            err && err.timeout ? "timeout" : err && err.rateLimited ? "limited" : "error", err);
        }
        if (msg.debug) appendDebug("background", "batch-error", {
          durationMs: Date.now() - batchStarted,
          error: String(err),
          httpDiagnostics: err && err.httpDiagnostics || { attempts: [] }
        });
        sendResponse({
          ok: false,
          error: String(err),
          netfail: !!(err && err.netfail),
          needsKey: !!(err && err.needsKey),
          timeout: !!(err && err.timeout),
          connectTimeout: !!(err && err.connectTimeout),
          rateLimited: !!(err && err.rateLimited),
          retryAfterMs: Number(err && err.retryAfterMs) || 0,
          limitReason: String(err && err.limitReason || ""),
          cancelled: !!(err && err.cancelled),
          httpDiagnostics: err && err.httpDiagnostics || { attempts: [] }
        });
      })
      .finally(() => {
        unregisterController();
        release();
      });
    return true;
  }
});
