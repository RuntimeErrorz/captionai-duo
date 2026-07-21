// Correlate Fetch failures with Chromium's underlying net::ERR_* diagnostics.
"use strict";

const AI_NETWORK_TRACE_HEADER = "X-CaptionAI-Trace";
const AI_NETWORK_DIAGNOSTIC_TTL_MS = 60000;
const aiNetworkTraceByRequest = new Map();
const aiNetworkFailureByTrace = new Map();

function cleanAiNetworkTraceId(value) {
  return String(value || "").replace(/[^A-Za-z0-9:_.-]/g, "").slice(0, 160);
}

function aiNetworkAttemptTraceId(requestId, attempt) {
  return cleanAiNetworkTraceId(`${requestId || "ai"}.${Math.max(1, Number(attempt) || 1)}`);
}

function pruneAiNetworkDiagnostics(now) {
  const cutoff = (Number(now) || Date.now()) - AI_NETWORK_DIAGNOSTIC_TTL_MS;
  for (const [key, value] of aiNetworkTraceByRequest) {
    if (!value || value.timeStamp < cutoff) aiNetworkTraceByRequest.delete(key);
  }
  for (const [key, value] of aiNetworkFailureByTrace) {
    if (!value || value.timeStamp < cutoff) aiNetworkFailureByTrace.delete(key);
  }
}

function aiNetworkFailureForTrace(traceId) {
  pruneAiNetworkDiagnostics(Date.now());
  return aiNetworkFailureByTrace.get(cleanAiNetworkTraceId(traceId)) || null;
}

function registerAiNetworkDiagnostics() {
  if (!chrome.webRequest || !chrome.webRequest.onBeforeSendHeaders ||
      !chrome.webRequest.onErrorOccurred) return;
  const filter = { urls: ["https://*/*", "http://*/*"] };
  chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
    const headers = Array.isArray(details.requestHeaders) ? details.requestHeaders : [];
    const traceHeader = headers.find(
      (header) => String(header && header.name || "").toLowerCase() ===
        AI_NETWORK_TRACE_HEADER.toLowerCase()
    );
    const traceId = cleanAiNetworkTraceId(traceHeader && traceHeader.value);
    if (!traceId) return;
    pruneAiNetworkDiagnostics(details.timeStamp);
    aiNetworkTraceByRequest.set(details.requestId, {
      traceId,
      timeStamp: Number(details.timeStamp) || Date.now(),
      url: String(details.url || "")
    });
  }, filter, ["requestHeaders"]);

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    const trace = aiNetworkTraceByRequest.get(details.requestId);
    if (!trace) return;
    aiNetworkTraceByRequest.delete(details.requestId);
    const failure = {
      traceId: trace.traceId,
      error: String(details.error || "net::ERR_FAILED"),
      timeStamp: Number(details.timeStamp) || Date.now(),
      fromCache: !!details.fromCache,
      tabId: Number(details.tabId),
      type: String(details.type || "")
    };
    aiNetworkFailureByTrace.set(trace.traceId, failure);
    appendDebug("background", "ai-network-error", failure);
  }, filter);

  const forget = (details) => aiNetworkTraceByRequest.delete(details.requestId);
  if (chrome.webRequest.onCompleted) {
    chrome.webRequest.onCompleted.addListener(forget, filter);
  }
}

registerAiNetworkDiagnostics();
