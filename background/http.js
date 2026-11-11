// AI HTTP streaming, retry and cancellation transport.
"use strict";

// Provider request quotas (e.g. Gemini free tier 15 RPM) must be shared across
// tabs, not managed by a single YouTube tab. Space starts globally and leave a
// small margin; larger content windows reduce the resulting latency.
const GEMINI_MIN_REQUEST_INTERVAL_MS = 4200;
const AI_REQUEST_RATE_STATE = new Map();
const GEMINI_REQUEST_RATE_STATE = AI_REQUEST_RATE_STATE;

function aiProviderRequestIntervalMs(config) {
  const customRpm = Number(
    (config && config.rateLimitRpm) ??
    (config && config.extraBody && (config.extraBody.rate_limit_rpm || config.extraBody.rpm))
  );
  if (Number.isFinite(customRpm) && customRpm > 0) {
    return Math.max(0, Math.ceil(60000 / customRpm));
  }
  const custom = Number(
    (config && config.rateLimitIntervalMs) ??
    (config && config.extraBody && config.extraBody.rate_limit_interval_ms)
  );
  if (Number.isFinite(custom) && custom > 0) {
    return Math.max(0, Math.ceil(custom));
  }
  const providerKind = config && config.endpointKind === "gemini"
    ? "gemini"
    : typeof YTDS_SHARED.aiProviderKind === "function"
      ? YTDS_SHARED.aiProviderKind(config && config.baseUrl, config && config.model)
      : "";
  if (providerKind === "gemini") return GEMINI_MIN_REQUEST_INTERVAL_MS;
  return 0;
}

function aiRequestCancelledError() {
  const error = new Error("AI request cancelled");
  error.name = "AbortError";
  error.cancelled = true;
  error.errorCode = "AI_CANCELLED";
  return error;
}

function aiRequestPreemptedError() {
  const error = new Error("AI request preempted by urgent request");
  error.name = "AbortError";
  error.cancelled = true;
  error.preempted = true;
  error.errorCode = "AI_CANCELLED";
  return error;
}

function waitForAiRateDelay(delayValue, signal) {
  const delay = Math.max(0, Math.ceil(Number(delayValue) || 0));
  if (!delay) {
    if (signal && signal.aborted) return Promise.reject(aiRequestCancelledError());
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    let onAbort = null;
    const cleanup = () => {
      if (timer != null) clearTimeout(timer);
      timer = null;
      if (signal && onAbort && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const done = () => { cleanup(); resolve(); };
    onAbort = () => { cleanup(); reject(aiRequestCancelledError()); };
    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(done, delay);
  });
}

function aiRequestRateKey(config) {
  return `${String(config && config.baseUrl || config && config.endpoint || "")}\n` +
    `${String(config && config.model || "")}`;
}

function getOrCreateAiRateState(key) {
  let state = AI_REQUEST_RATE_STATE.get(key);
  if (!state) {
    state = {
      lastStartedAt: null,
      active: null,
      queue: [],
      cleanupTimer: null
    };
    AI_REQUEST_RATE_STATE.set(key, state);
  }
  if (state.cleanupTimer != null) {
    clearTimeout(state.cleanupTimer);
    state.cleanupTimer = null;
  }
  return state;
}

function pumpAiRateQueue(key, state, intervalMs) {
  if (state.active) {
    if (!state.active.isUrgent && state.queue.some((item) => item.isUrgent)) {
      const preempted = state.active;
      state.active = null;
      if (preempted.timer != null) clearTimeout(preempted.timer);
      if (preempted.cleanupSignal) preempted.cleanupSignal();
      preempted.reject(aiRequestPreemptedError());
    } else {
      return;
    }
  }

  if (state.queue.length === 0) {
    if (state.cleanupTimer == null && Number.isFinite(state.lastStartedAt)) {
      state.cleanupTimer = setTimeout(() => {
        state.cleanupTimer = null;
        if (state.active == null && state.queue.length === 0 &&
            Date.now() - state.lastStartedAt >= intervalMs) {
          AI_REQUEST_RATE_STATE.delete(key);
        }
      }, intervalMs);
    }
    return;
  }

  const urgentIndex = state.queue.findIndex((item) => item.isUrgent);
  const nextIndex = urgentIndex >= 0 ? urgentIndex : 0;
  const next = state.queue.splice(nextIndex, 1)[0];
  if (next.cleanupSignal) next.cleanupSignal();

  if (next.signal && next.signal.aborted) {
    next.reject(aiRequestCancelledError());
    pumpAiRateQueue(key, state, intervalMs);
    return;
  }

  const waitMs = Number.isFinite(state.lastStartedAt)
    ? Math.max(0, state.lastStartedAt + intervalMs - Date.now()) : 0;

  if (waitMs <= 0) {
    state.lastStartedAt = Date.now();
    next.resolve(0);
    pumpAiRateQueue(key, state, intervalMs);
    return;
  }

  const active = {
    isUrgent: next.isUrgent,
    timer: null,
    cleanupSignal: null,
    reject: next.reject
  };
  state.active = active;

  const onAbort = () => {
    if (state.active === active) {
      state.active = null;
      if (active.timer != null) clearTimeout(active.timer);
      if (active.cleanupSignal) active.cleanupSignal();
      next.reject(aiRequestCancelledError());
      pumpAiRateQueue(key, state, intervalMs);
    }
  };

  if (next.signal && typeof next.signal.addEventListener === "function") {
    if (next.signal.aborted) {
      onAbort();
      return;
    }
    next.signal.addEventListener("abort", onAbort, { once: true });
    active.cleanupSignal = () => {
      if (typeof next.signal.removeEventListener === "function") {
        next.signal.removeEventListener("abort", onAbort);
      }
    };
  }

  active.timer = setTimeout(() => {
    if (state.active === active) {
      state.active = null;
      if (active.cleanupSignal) active.cleanupSignal();
      state.lastStartedAt = Date.now();
      next.resolve(waitMs);
      pumpAiRateQueue(key, state, intervalMs);
    }
  }, waitMs);
}

function waitForAiRequestSlot(config, signal, isUrgent = false) {
  const intervalMs = aiProviderRequestIntervalMs(config);
  if (intervalMs <= 0) return Promise.resolve(0);
  if (signal && signal.aborted) return Promise.reject(aiRequestCancelledError());

  const key = aiRequestRateKey(config);
  const state = getOrCreateAiRateState(key);

  return new Promise((resolve, reject) => {
    const item = {
      isUrgent: !!isUrgent,
      signal,
      resolve,
      reject,
      cleanupSignal: null
    };
    if (signal && typeof signal.addEventListener === "function") {
      const onAbort = () => {
        const idx = state.queue.indexOf(item);
        if (idx >= 0) {
          state.queue.splice(idx, 1);
          if (item.cleanupSignal) item.cleanupSignal();
          item.reject(aiRequestCancelledError());
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      item.cleanupSignal = () => {
        if (typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onAbort);
        }
      };
    }
    state.queue.push(item);
    pumpAiRateQueue(key, state, intervalMs);
  });
}

async function fetchAiStreamWithTimeout(
  url, options, timeoutMs, connectTimeoutMs, externalSignal, onHeaders, onTextDelta
) {
  const controller = new AbortController();
  const started = Date.now();
  let response = null;
  let timedOut = false;
  let connectTimedOut = false;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const connectTimer = setTimeout(() => {
    connectTimedOut = true;
    controller.abort();
  }, Math.min(timeoutMs, Math.max(50, Number(connectTimeoutMs) || timeoutMs)));
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(connectTimer);
    const firstByteMs = Date.now() - started;
    if (typeof onHeaders === "function") onHeaders(response, firstByteMs);
    if (!response.ok) {
      const text = await response.text();
      return { response, text, firstByteMs, totalMs: Date.now() - started };
    }
    const contentType = String(response.headers.get("Content-Type") || "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      const payloadText = await response.text();
      let payload;
      try { payload = JSON.parse(payloadText); }
      catch (_e) {
        const error = new Error("AI service returned invalid completion JSON");
        error.errorCode = "AI_RESPONSE_INVALID_JSON";
        throw error;
      }
      const text = YTDS_SHARED.aiCompletionText(payload);
      if (typeof onTextDelta === "function") {
        onTextDelta(text, true);
      }
      return {
        response,
        text,
        usage: payload && (payload.usage || payload.usageMetadata ||
          payload.usage_metadata || payload.interaction && payload.interaction.usage) || null,
        streamed: false,
        firstByteMs,
        totalMs: Date.now() - started
      };
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      const error = new Error("AI streaming response has no readable body");
      error.errorCode = "AI_STREAM_BODY_UNREADABLE";
      throw error;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage = null;
    let done = false;
    let stopDeadline = 0;
    let earlyStopped = false;
    let earlyStopReason = "";
    const applyStreamControl = (control) => {
      if (!control || typeof control !== "object") return false;
      if ((control.coverageComplete || control.protocolDone) && !stopDeadline) {
        stopDeadline = Date.now() + AI_STREAM_COMPLETION_GRACE_MS;
      }
      if (control.stop) {
        earlyStopped = true;
        earlyStopReason = String(control.reason || "observer-stop");
        return true;
      }
      return false;
    };
    const readNextPart = async () => {
      if (!stopDeadline) return reader.read();
      const remainingMs = stopDeadline - Date.now();
      if (remainingMs <= 0) return { ytdsGraceExpired: true };
      let graceTimer = null;
      try {
        return await Promise.race([
          reader.read(),
          new Promise((resolve) => {
            graceTimer = setTimeout(
              () => resolve({ ytdsGraceExpired: true }), remainingMs
            );
          })
        ]);
      } finally {
        if (graceTimer) clearTimeout(graceTimer);
      }
    };
    while (!done) {
      const part = await readNextPart();
      if (part && part.ytdsGraceExpired) {
        earlyStopped = true;
        earlyStopReason = "completion-grace-expired";
        try { await reader.cancel(earlyStopReason); } catch (_e) { /* already closed */ }
        break;
      }
      buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done });
      const parsed = YTDS_SHARED.aiSseEvents(buffer, !!part.done);
      buffer = parsed.rest;
      let observerStopped = false;
      for (const event of parsed.events) {
        if (event === "[DONE]") {
          done = true;
          break;
        }
        let chunk;
        try { chunk = JSON.parse(event); }
        catch (_e) {
          const error = new Error("AI service returned invalid SSE JSON");
          error.errorCode = "AI_SSE_INVALID_JSON";
          throw error;
        }
        const chunkUsage = chunk && (chunk.usage || chunk.usageMetadata ||
          chunk.usage_metadata || chunk.interaction && chunk.interaction.usage);
        if (chunkUsage) usage = chunkUsage;
        const delta = YTDS_SHARED.aiCompletionText(chunk);
        content += delta;
        if (delta && typeof onTextDelta === "function" &&
            applyStreamControl(onTextDelta(delta, false))) {
          observerStopped = true;
          break;
        }
      }
      if (observerStopped) {
        try { await reader.cancel(earlyStopReason); } catch (_e) { /* already closed */ }
        break;
      }
      if (part.done) break;
    }
    // Some compatible servers close a valid SSE body without a final [DONE].
    if (!done && !content) {
      const error = new Error("AI SSE stream ended without content");
      error.errorCode = "AI_SSE_EMPTY";
      throw error;
    }
    if (!earlyStopped && typeof onTextDelta === "function") onTextDelta("", true);
    return {
      response,
      text: content,
      usage,
      streamed: true,
      earlyStopped,
      earlyStopReason,
      firstByteMs,
      totalMs: Date.now() - started
    };
  } catch (cause) {
    const err = new Error(cause && cause.message || "AI HTTP attempt failed");
    err.name = cause && cause.name || "Error";
    err.phase = response ? "body" : "connect";
    err.elapsedMs = Date.now() - started;
    err.timedOut = timedOut;
    err.connectTimedOut = connectTimedOut;
    err.errorCode = String(cause && cause.errorCode || "");
    throw err;
  } finally {
    clearTimeout(timer);
    clearTimeout(connectTimer);
    if (externalSignal) externalSignal.removeEventListener("abort", abortFromExternal);
  }
}

function registerAiController(
  sender, videoId, controller, focusGeneration, requestId, urgent
) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (!Number.isInteger(tabId)) return () => {};
  const entry = {
    videoId: String(videoId || ""),
    focusGeneration: Math.max(0, Math.floor(Number(focusGeneration) || 0)),
    requestId: String(requestId || ""),
    urgent: !!urgent,
    controller
  };
  const set = aiControllers.get(tabId) || new Set();
  set.add(entry);
  aiControllers.set(tabId, set);
  return () => {
    set.delete(entry);
    if (!set.size) aiControllers.delete(tabId);
  };
}

function cancelAiRequestForSender(sender, videoId, requestId) {
  const tabId = sender && sender.tab && sender.tab.id;
  const set = aiControllers.get(tabId);
  const wanted = String(requestId || "");
  if (!set || !wanted) return false;
  let cancelled = false;
  for (const entry of Array.from(set)) {
    if (entry.videoId === String(videoId || "") && entry.requestId === wanted) {
      entry.controller.abort();
      cancelled = true;
    }
  }
  return cancelled;
}

function cancelAiForSender(sender, videoId, beforeFocusGeneration) {
  const tabId = sender && sender.tab && sender.tab.id;
  const set = aiControllers.get(tabId);
  if (!set) return;
  const cutoff = Number(beforeFocusGeneration);
  for (const entry of Array.from(set)) {
    const matchesVideo = !videoId || entry.videoId === String(videoId);
    const isOlderFocus = !Number.isFinite(cutoff) || entry.focusGeneration < cutoff;
    if (matchesVideo && isOlderFocus) entry.controller.abort();
  }
}

function aiProviderErrorCode(responseText) {
  let payload;
  try { payload = JSON.parse(String(responseText || "")); }
  catch (_e) { return ""; }
  const nested = payload && payload.error;
  const candidates = [
    nested && typeof nested === "object" ? nested.code : "",
    nested && typeof nested === "object" ? nested.type : "",
    typeof nested === "string" ? nested : "",
    payload && payload.code,
    payload && payload.type
  ];
  for (const value of candidates) {
    const code = String(value == null ? "" : value).trim();
    if (code.length <= 64 && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(code)) return code;
  }
  return "";
}

function annotateAiHttpError(errorValue, response, responseText) {
  const error = errorValue instanceof Error ? errorValue : new Error(String(errorValue || "AI HTTP request failed"));
  const status = Number(response && response.status);
  error.httpStatus = Number.isInteger(status) ? status : 0;
  error.errorCode = Number.isInteger(status) && status >= 100 && status <= 599
    ? `HTTP_${status}` : "AI_HTTP_UNKNOWN";
  const providerCode = aiProviderErrorCode(responseText);
  if (providerCode) error.providerCode = providerCode;
  return error;
}

function sendTranslationBatchProgress(sender, payload) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (!Number.isInteger(tabId)) return;
  const callback = () => { void chrome.runtime.lastError; };
  try {
    if (Number.isInteger(sender.frameId)) {
      chrome.tabs.sendMessage(tabId, payload, { frameId: sender.frameId }, callback);
    } else {
      chrome.tabs.sendMessage(tabId, payload, callback);
    }
  } catch (_e) { /* content frame closed or navigated */ }
}

async function getAiConfig() {
  const [stored, local] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get({ aiExtraBodyProfiles: {} })
  ]);
  const baseUrl = YTDS_SHARED.normalizeAiBaseUrl(stored.aiBaseUrl);
  const model = String(stored.aiModel || YTDS_SHARED.AI_DEFAULT_MODEL).trim().slice(0, 160);
  const endpointKind = typeof YTDS_SHARED.aiProviderKind === "function"
    ? YTDS_SHARED.aiProviderKind(baseUrl, model)
    : YTDS_SHARED.aiEndpointKind(baseUrl);
  const profiles = local.aiExtraBodyProfiles && typeof local.aiExtraBodyProfiles === "object"
    ? local.aiExtraBodyProfiles : {};
  const profileScope = YTDS_SHARED.aiRequestProfileScope(baseUrl, model);
  const parsedExtra = YTDS_SHARED.parseAiExtraBody(
    profileScope ? profiles[profileScope] || "" : ""
  );
  return {
    endpointKind,
    baseUrl,
    endpoint: YTDS_SHARED.aiChatCompletionsUrl(baseUrl),
    model,
    extraBody: parsedExtra.ok ? parsedExtra.value : {},
    extraBodyCanonical: parsedExtra.ok ? parsedExtra.canonical : "{}",
    contextPast: YTDS_SHARED.normalizeAiContextCount(stored.aiContextPast, 1),
    contextFuture: YTDS_SHARED.normalizeAiContextCount(stored.aiContextFuture, 1)
  };
}

function aiDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function aiApiKeyForConfig(config) {
  const stored = await chrome.storage.local.get({ aiApiKeys: {} });
  const keys = stored.aiApiKeys && typeof stored.aiApiKeys === "object"
    ? stored.aiApiKeys : {};
  const apiKey = String(keys[YTDS_SHARED.aiCredentialScope(config.baseUrl)] || "").trim();
  if (config.endpointKind === "deepseek" && !apiKey) {
    const err = new Error("AI API key is not configured");
    err.needsKey = true;
    err.errorCode = "AI_KEY_MISSING";
    throw err;
  }
  return apiKey;
}

async function ensureAiHostPermission(config) {
  const permissions = chrome.permissions;
  if (!permissions || typeof permissions.contains !== "function") return;
  const pattern = YTDS_SHARED.aiHostPermissionPattern(config.baseUrl);
  if (pattern && await permissions.contains({ origins: [pattern] })) return;
  const err = new Error("AI API host permission has not been granted");
  err.needsPermission = true;
  err.errorCode = "AI_HOST_PERMISSION_MISSING";
  throw err;
}

function aiCompletionRequestOptions(config, apiKey, messages, maxTokens, temperature, jsonLines) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return {
    method: "POST",
    headers,
    body: JSON.stringify(YTDS_SHARED.aiChatCompletionBody(
      config, messages, maxTokens || 2048, temperature == null ? 0.2 : temperature,
      { jsonLines }
    ))
  };
}

function recordAiAttemptResult(attemptInfo, result) {
  const text = String(result.text || "");
  attemptInfo.totalMs = result.totalMs;
  attemptInfo.bodyMs = Math.max(0, result.totalMs - result.firstByteMs);
  attemptInfo.responseChars = text.length;
  attemptInfo.earlyStopped = !!result.earlyStopped;
  attemptInfo.earlyStopReason = String(result.earlyStopReason || "");
  if (!result.response.ok) {
    const providerCode = aiProviderErrorCode(text);
    if (providerCode) attemptInfo.providerCode = providerCode;
  }
}

function aiAttemptNetworkError(cause, cancelled, attemptInfo, attempts) {
  const aborted = !!(cause && (cause.name === "AbortError" || cause.timedOut));
  const err = new Error(aborted
    ? (cancelled ? "AI request cancelled" : "AI request timed out")
    : "AI request failed");
  err.netfail = true;
  err.cancelled = cancelled;
  err.timeout = aborted && !cancelled;
  err.connectTimeout = !!(cause && cause.connectTimedOut && !cancelled);
  err.errorCode = cancelled ? "AI_CANCELLED" :
    String(cause && cause.errorCode || "") ||
    (attemptInfo.netError || (err.connectTimeout ? "AI_CONNECT_TIMEOUT" :
      err.timeout ? "AI_TIMEOUT" : "AI_NETWORK_ERROR"));
  if (attemptInfo.netError) err.netError = attemptInfo.netError;
  err.httpDiagnostics = { attempts };
  return err;
}

function aiAttemptTraceFields(trace, attemptInfo) {
  return {
    requestId: trace.requestId || "",
    requestClass: trace.requestClass || "",
    attempt: attemptInfo.attempt
  };
}

async function fetchAiCompletionAttempt(config, requestOptions, attemptInfo, trace, externalSignal) {
  const attemptOptions = {
    ...requestOptions,
    headers: { ...requestOptions.headers, [AI_NETWORK_TRACE_HEADER]: attemptInfo.networkTraceId }
  };
  const result = await fetchAiStreamWithTimeout(
    config.endpoint, attemptOptions, attemptInfo.timeoutMs, attemptInfo.connectTimeoutMs,
    externalSignal,
    (response, firstByteMs) => {
      attemptInfo.firstByteMs = firstByteMs;
      attemptInfo.status = response.status;
      if (trace.debug) appendDebug("background", "ai-http-first-byte", {
        ...aiAttemptTraceFields(trace, attemptInfo),
        firstByteMs,
        status: response.status
      });
    },
    typeof trace.onTextDelta === "function" ? trace.onTextDelta : null
  );
  recordAiAttemptResult(attemptInfo, result);
  if (trace.debug) appendDebug("background", "ai-http-body-complete", {
    ...aiAttemptTraceFields(trace, attemptInfo),
    status: result.response.status,
    firstByteMs: result.firstByteMs,
    bodyMs: attemptInfo.bodyMs,
    totalMs: result.totalMs,
    responseChars: String(result.text || "").length,
    earlyStopped: attemptInfo.earlyStopped,
    earlyStopReason: attemptInfo.earlyStopReason
  });
  return result;
}

// Network-level failures retry only while nothing has streamed: once units
// were delivered, a replay could duplicate or reorder committed captions.
async function noteAiAttemptFailure(cause, attemptInfo, trace, externalSignal, attempt) {
  attemptInfo.phase = cause && cause.phase || "unknown";
  attemptInfo.totalMs = Number(cause && cause.elapsedMs) || 0;
  attemptInfo.timeout = !!(cause && cause.timedOut);
  attemptInfo.connectTimeout = !!(cause && cause.connectTimedOut);
  // webRequest's onErrorOccurred normally precedes the rejected Fetch
  // promise, but yield once so its net::ERR_* detail can join this attempt.
  await aiDelay(0);
  const networkFailure = aiNetworkFailureForTrace(attemptInfo.networkTraceId);
  if (networkFailure) attemptInfo.netError = networkFailure.error;
  const cancelled = !!(externalSignal && externalSignal.aborted) || !!(cause && cause.cancelled);
  const hasStreamProgress = typeof trace.hasStreamProgress === "function" &&
    trace.hasStreamProgress();
  const willRetry = !cancelled && !hasStreamProgress && attempt + 1 < AI_MAX_ATTEMPTS;
  const delayMs = willRetry ? retryDelayMs(null, attempt) : 0;
  if (trace.debug) appendDebug("background", "ai-http-attempt-error", {
    ...aiAttemptTraceFields(trace, attemptInfo),
    phase: attemptInfo.phase,
    durationMs: attemptInfo.totalMs,
    timeout: attemptInfo.timeout,
    connectTimeout: attemptInfo.connectTimeout,
    connectTimeoutMs: attemptInfo.connectTimeoutMs,
    cancelled,
    willRetry,
    retryDelayMs: delayMs,
    error: String(cause),
    netError: attemptInfo.netError || "",
    networkTraceId: attemptInfo.networkTraceId
  });
  return { cancelled, willRetry, delayMs };
}

async function aiRawCompletion(
  config, messages, externalSignal, maxTokens, temperature, traceValue
) {
  if (!config.endpoint || !config.model) {
    const err = new Error("AI API Base URL or model is not configured");
    err.needsConfig = true;
    err.errorCode = "AI_CONFIG_MISSING";
    throw err;
  }
  const apiKey = await aiApiKeyForConfig(config);
  await ensureAiHostPermission(config);
  const trace = traceValue && typeof traceValue === "object" ? traceValue : {};
  const requestOptions = aiCompletionRequestOptions(
    config, apiKey, messages, maxTokens, temperature, !!trace.jsonLines
  );

  let res;
  let responseText = "";
  let responseUsage = null;
  const attempts = [];
  const timeoutMs = YTDS_SHARED.aiExtraBodyUsesThinking(config.extraBody)
    ? AI_TIMEOUT_THINKING_MS : AI_TIMEOUT_FAST_MS;
  const requestClass = String(trace.requestClass || "");
  const connectTimeoutMs = requestClass.startsWith("urgent")
    ? AI_CONNECT_TIMEOUT_URGENT_MS : AI_CONNECT_TIMEOUT_PREFETCH_MS;
  for (let attempt = 0; attempt < AI_MAX_ATTEMPTS; attempt++) {
    const attemptNumber = attempt + 1;
    const networkTraceId = aiNetworkAttemptTraceId(trace.requestId, attemptNumber);
    const attemptInfo = { attempt: attemptNumber, timeoutMs, connectTimeoutMs, networkTraceId };
    attempts.push(attemptInfo);
    const isUrgent = !!(trace.urgent || requestClass.startsWith("urgent"));
    try {
      attemptInfo.rateWaitMs = await waitForAiRequestSlot(config, externalSignal, isUrgent);
    } catch (slotErr) {
      slotErr.httpDiagnostics = { attempts };
      throw slotErr;
    }
    if (typeof trace.onAttemptStart === "function") trace.onAttemptStart(attemptNumber);
    if (trace.debug) appendDebug("background", "ai-http-attempt-start", {
      requestId: trace.requestId || "",
      requestClass: trace.requestClass || "",
      attempt: attemptNumber,
      timeoutMs,
      connectTimeoutMs,
      networkTraceId,
      rateWaitMs: attemptInfo.rateWaitMs,
      requestChars: requestOptions.body.length
    });
    try {
      const result = await fetchAiCompletionAttempt(
        config, requestOptions, attemptInfo, trace, externalSignal
      );
      res = result.response;
      responseText = result.text;
      responseUsage = result.usage || null;
    } catch (cause) {
      const failure = await noteAiAttemptFailure(cause, attemptInfo, trace, externalSignal, attempt);
      if (failure.willRetry) {
        await aiDelay(failure.delayMs);
        continue;
      }
      throw aiAttemptNetworkError(cause, failure.cancelled, attemptInfo, attempts);
    }
    if (res.status === 401 || res.status === 403) {
      const err = annotateAiHttpError(new Error("AI API key was rejected"), res, responseText);
      err.needsKey = true;
      err.httpDiagnostics = { attempts };
      throw err;
    }
    if ([408, 429, 500, 502, 503, 504].includes(res.status) &&
        attempt + 1 < AI_MAX_ATTEMPTS) {
      const delayMs = retryDelayMs(res, attempt);
      attemptInfo.retryStatus = res.status;
      attemptInfo.retryDelayMs = delayMs;
      if (trace.debug) appendDebug("background", "ai-http-retry", {
        requestId: trace.requestId || "",
        requestClass: trace.requestClass || "",
        attempt: attemptNumber,
        status: res.status,
        retryDelayMs: delayMs
      });
      await aiDelay(delayMs);
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    const err = annotateAiHttpError(
      new Error(`AI HTTP ${res ? res.status : "unknown"}`), res, responseText
    );
    err.rateLimited = !!(res && res.status === 429);
    err.httpDiagnostics = { attempts };
    throw err;
  }

  const normalizedUsage = await recordAiTokenUsage(responseUsage);
  const completedAttempt = attempts[attempts.length - 1];
  if (completedAttempt && normalizedUsage) completedAttempt.usage = normalizedUsage;

  const raw = responseText;
  if (!raw) {
    const err = new Error("AI service returned an empty translation");
    err.errorCode = "AI_RESPONSE_EMPTY";
    err.httpDiagnostics = { attempts };
    throw err;
  }
  return { raw, diagnostics: { attempts, usage: normalizedUsage } };
}
