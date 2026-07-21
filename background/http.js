// AI HTTP streaming, retry and cancellation transport.
"use strict";

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
      catch (_e) { throw new Error("AI service returned invalid completion JSON"); }
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
      throw new Error("AI streaming response has no readable body");
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
        stopDeadline = Date.now() + DEEPSEEK_STREAM_COMPLETION_GRACE_MS;
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
      const parsed = YTDS_SHARED.deepSeekSseEvents(buffer, !!part.done);
      buffer = parsed.rest;
      let observerStopped = false;
      for (const event of parsed.events) {
        if (event === "[DONE]") {
          done = true;
          break;
        }
        let chunk;
        try { chunk = JSON.parse(event); }
        catch (_e) { throw new Error("AI service returned invalid SSE JSON"); }
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
    if (!done && !content) throw new Error("AI SSE stream ended without content");
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
    throw err;
  } finally {
    clearTimeout(timer);
    clearTimeout(connectTimer);
    if (externalSignal) externalSignal.removeEventListener("abort", abortFromExternal);
  }
}

function registerDeepSeekController(
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
  const set = deepseekControllers.get(tabId) || new Set();
  set.add(entry);
  deepseekControllers.set(tabId, set);
  return () => {
    set.delete(entry);
    if (!set.size) deepseekControllers.delete(tabId);
  };
}

function cancelDeepSeekRequestForSender(sender, videoId, requestId) {
  const tabId = sender && sender.tab && sender.tab.id;
  const set = deepseekControllers.get(tabId);
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

function cancelDeepSeekForSender(sender, videoId, beforeFocusGeneration) {
  const tabId = sender && sender.tab && sender.tab.id;
  const set = deepseekControllers.get(tabId);
  if (!set) return;
  const cutoff = Number(beforeFocusGeneration);
  for (const entry of Array.from(set)) {
    const matchesVideo = !videoId || entry.videoId === String(videoId);
    const isOlderFocus = !Number.isFinite(cutoff) || entry.focusGeneration < cutoff;
    if (matchesVideo && isOlderFocus) entry.controller.abort();
  }
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
  const endpointKind = YTDS_SHARED.aiEndpointKind(baseUrl);
  const model = String(stored.aiModel || stored.deepseekModel ||
    YTDS_SHARED.AI_DEFAULT_MODEL).trim().slice(0, 160);
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
    thinking: YTDS_SHARED.normalizeAiThinking(stored.aiThinking || stored.deepseekThinking),
    extraBody: parsedExtra.ok ? parsedExtra.value : {},
    extraBodyCanonical: parsedExtra.ok ? parsedExtra.canonical : "{}",
    contextPast: YTDS_SHARED.normalizeAiContextCount(stored.deepseekContextPast, 1),
    contextFuture: YTDS_SHARED.normalizeAiContextCount(stored.deepseekContextFuture, 1)
  };
}

async function aiRawCompletion(
  config, messages, externalSignal, maxTokens, temperature, traceValue
) {
  if (!config.endpoint || !config.model) {
    const err = new Error("AI API Base URL or model is not configured");
    err.needsConfig = true;
    throw err;
  }
  const stored = await chrome.storage.local.get({
    aiApiKeys: {}, aiApiKey: "", deepseekApiKey: ""
  });
  const keys = stored.aiApiKeys && typeof stored.aiApiKeys === "object"
    ? stored.aiApiKeys : {};
  const credentialScope = YTDS_SHARED.aiCredentialScope(config.baseUrl);
  const legacyKey = config.endpointKind === "deepseek"
    ? stored.aiApiKey || stored.deepseekApiKey || "" : "";
  const apiKey = String(keys[credentialScope] || legacyKey).trim();
  if (config.endpointKind === "deepseek" && !apiKey) {
    const err = new Error("AI API key is not configured");
    err.needsKey = true;
    throw err;
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const trace = traceValue && typeof traceValue === "object" ? traceValue : {};
  const requestOptions = {
      method: "POST",
      headers,
      body: JSON.stringify(YTDS_SHARED.aiChatCompletionBody(
        config, messages, maxTokens || 2048, temperature == null ? 0.2 : temperature,
        { jsonLines: !!trace.jsonLines }
      ))
    };

  let res;
  let responseText = "";
  let responseUsage = null;
  const attempts = [];
  const timeoutMs = config.thinking === "disabled"
    ? DEEPSEEK_TIMEOUT_FAST_MS : DEEPSEEK_TIMEOUT_THINKING_MS;
  const requestClass = String(trace.requestClass || "");
  const connectTimeoutMs = requestClass.startsWith("urgent")
    ? DEEPSEEK_CONNECT_TIMEOUT_URGENT_MS : DEEPSEEK_CONNECT_TIMEOUT_PREFETCH_MS;
  for (let attempt = 0; attempt < DEEPSEEK_MAX_ATTEMPTS; attempt++) {
    const attemptNumber = attempt + 1;
    const networkTraceId = aiNetworkAttemptTraceId(trace.requestId, attemptNumber);
    const attemptInfo = { attempt: attemptNumber, timeoutMs, connectTimeoutMs, networkTraceId };
    attempts.push(attemptInfo);
    if (typeof trace.onAttemptStart === "function") trace.onAttemptStart(attemptNumber);
    if (trace.debug) appendDebug("background", "deepseek-http-attempt-start", {
      requestId: trace.requestId || "",
      requestClass: trace.requestClass || "",
      attempt: attemptNumber,
      timeoutMs,
      connectTimeoutMs,
      networkTraceId,
      requestChars: requestOptions.body.length
    });
    try {
      const attemptOptions = {
        ...requestOptions,
        headers: { ...requestOptions.headers, [AI_NETWORK_TRACE_HEADER]: networkTraceId }
      };
      const result = await fetchAiStreamWithTimeout(
        config.endpoint, attemptOptions, timeoutMs, connectTimeoutMs, externalSignal,
        (response, firstByteMs) => {
          attemptInfo.firstByteMs = firstByteMs;
          attemptInfo.status = response.status;
          if (trace.debug) appendDebug("background", "deepseek-http-first-byte", {
            requestId: trace.requestId || "",
            requestClass: trace.requestClass || "",
            attempt: attemptNumber,
            firstByteMs,
            status: response.status
          });
        },
        typeof trace.onTextDelta === "function" ? trace.onTextDelta : null
      );
      res = result.response;
      responseText = result.text;
      responseUsage = result.usage || null;
      attemptInfo.totalMs = result.totalMs;
      attemptInfo.bodyMs = Math.max(0, result.totalMs - result.firstByteMs);
      attemptInfo.responseChars = responseText.length;
      attemptInfo.earlyStopped = !!result.earlyStopped;
      attemptInfo.earlyStopReason = String(result.earlyStopReason || "");
      if (trace.debug) appendDebug("background", "deepseek-http-body-complete", {
        requestId: trace.requestId || "",
        requestClass: trace.requestClass || "",
        attempt: attemptNumber,
        status: res.status,
        firstByteMs: result.firstByteMs,
        bodyMs: attemptInfo.bodyMs,
        totalMs: result.totalMs,
        responseChars: responseText.length,
        earlyStopped: attemptInfo.earlyStopped,
        earlyStopReason: attemptInfo.earlyStopReason
      });
    } catch (cause) {
      attemptInfo.phase = cause && cause.phase || "unknown";
      attemptInfo.totalMs = Number(cause && cause.elapsedMs) || 0;
      attemptInfo.timeout = !!(cause && cause.timedOut);
      attemptInfo.connectTimeout = !!(cause && cause.connectTimedOut);
      // webRequest's onErrorOccurred normally precedes the rejected Fetch
      // promise, but yield once so its net::ERR_* detail can join this attempt.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const networkFailure = aiNetworkFailureForTrace(networkTraceId);
      if (networkFailure) attemptInfo.netError = networkFailure.error;
      const cancelled = !!(externalSignal && externalSignal.aborted);
      const hasStreamProgress = typeof trace.hasStreamProgress === "function" &&
        trace.hasStreamProgress();
      const willRetry = !cancelled && !hasStreamProgress &&
        attempt + 1 < DEEPSEEK_MAX_ATTEMPTS;
      const delayMs = willRetry ? retryDelayMs(null, attempt) : 0;
      if (trace.debug) appendDebug("background", "deepseek-http-attempt-error", {
        requestId: trace.requestId || "",
        requestClass: trace.requestClass || "",
        attempt: attemptNumber,
        phase: attemptInfo.phase,
        durationMs: attemptInfo.totalMs,
        timeout: attemptInfo.timeout,
        connectTimeout: attemptInfo.connectTimeout,
        connectTimeoutMs,
        cancelled,
        willRetry,
        retryDelayMs: delayMs,
        error: String(cause),
        netError: attemptInfo.netError || "",
        networkTraceId
      });
      if (willRetry) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      const err = new Error((cause && (cause.name === "AbortError" || cause.timedOut))
        ? (externalSignal && externalSignal.aborted
            ? "AI request cancelled" : "AI request timed out")
        : "AI request failed");
      err.netfail = true;
      err.cancelled = !!(externalSignal && externalSignal.aborted);
      err.timeout = !!(cause && (cause.name === "AbortError" || cause.timedOut) && !err.cancelled);
      err.connectTimeout = !!(cause && cause.connectTimedOut && !err.cancelled);
      err.httpDiagnostics = { attempts };
      throw err;
    }
    if (res.status === 401 || res.status === 403) {
      const err = new Error("AI API key was rejected");
      err.needsKey = true;
      err.httpDiagnostics = { attempts };
      throw err;
    }
    if ([408, 429, 500, 502, 503, 504].includes(res.status) &&
        attempt + 1 < DEEPSEEK_MAX_ATTEMPTS) {
      const delayMs = retryDelayMs(res, attempt);
      attemptInfo.retryStatus = res.status;
      attemptInfo.retryDelayMs = delayMs;
      if (trace.debug) appendDebug("background", "deepseek-http-retry", {
        requestId: trace.requestId || "",
        requestClass: trace.requestClass || "",
        attempt: attemptNumber,
        status: res.status,
        retryDelayMs: delayMs
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    const err = new Error(`AI HTTP ${res ? res.status : "unknown"}`);
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
    err.httpDiagnostics = { attempts };
    throw err;
  }
  return { raw, diagnostics: { attempts, usage: normalizedUsage } };
}
