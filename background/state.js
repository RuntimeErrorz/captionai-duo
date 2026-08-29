// Service-worker state, caches, diagnostics, validation and concurrency.
"use strict";

// background.js — translation service worker
// Routes cross-origin translation requests here so host_permissions apply
// and content scripts never hit page-CORS restrictions.
//
// AI requests use bounded, fully diagnosed HTTP retries; content.js
// separately retries a rejected semantic page.

const DEEPSEEK_BATCH_INFLIGHT = new Map();

const DEEPSEEK_TIMEOUT_FAST_MS = 30000;
const DEEPSEEK_TIMEOUT_THINKING_MS = 90000;
// Waiting for response headers is a different failure mode from consuming a
// healthy SSE body. Retry a dead route promptly while still allowing the
// complete response body to use the normal model deadline.
const DEEPSEEK_CONNECT_TIMEOUT_URGENT_MS = 8000;
const DEEPSEEK_CONNECT_TIMEOUT_PREFETCH_MS = 12000;
const DEEPSEEK_STREAM_COMPLETION_GRACE_MS = 750;
const DEEPSEEK_MAX_ATTEMPTS = 3;
const DEEPSEEK_MAX_ACTIVE_REQUESTS_PER_TAB = 12;
const COMPATIBLE_MAX_ACTIVE_REQUESTS_PER_TAB = 4;
const MAX_TRANSLATE_CHARS = 4000;
// Accelerated playback needs a longer semantic runway than ordinary playback.
// Keep the normal planner cap at 160, while accepting the larger urgent window
// that content uses at >=1.75x. The source-character and model-token bounds
// remain independent safety limits.
const MAX_BATCH_ITEMS = 320;
const MAX_PROMPT_SOURCE_CHARS = 28000;
const AI_PROMPT_CACHE_VERSION = "prompt-v34-deepseek-array-jsonl";
const AI_RESPONSE_CACHE_KEY = "ytdsAiResponseCacheV1";
const AI_RESPONSE_CACHE_MAX_ENTRIES = 96;
const AI_RESPONSE_CACHE_MAX_CHARS = 2000000;
const AI_TOKEN_USAGE_KEY = "ytdsAiTokenUsageV1";

// chrome.storage.session needs Chromium >= 102 (manifest sets that minimum,
// but Chromium forks may lag) — degrade to in-memory state without it.
const sessionStore = (chrome.storage && chrome.storage.session) || null;
const debugStore = sessionStore || (chrome.storage && chrome.storage.local) || null;
// Keep enough headroom for a 30-minute reproduction at the current event
// rate. Detailed request/response/display payloads are retained below, while
// the age window has an extra 15-minute margin.
const DEBUG_MIN_RETENTION_MS = 30 * 60 * 1000;
const DEBUG_RETENTION_MS = DEBUG_MIN_RETENTION_MS + 15 * 60 * 1000;
// Detailed request/response text is intentionally retained for local testing.
// Keep the age window above the requested 30-minute reproduction while giving
// raw semantic responses enough room to remain useful in the exported bundle.
const DEBUG_MAX = 50000;
const DEBUG_MAX_CHARS = 24000000;
const DEBUG_MAX_ENTRY_CHARS = 120000;
const DEBUG_BUNDLE_SCHEMA_VERSION = 1;
let debugLogs = [];
let debugChars = 0;
let debugPending = [];
let debugKnownSecrets = [];
let debugReady = false;
let debugFlushTimer = null;
let debugSequence = 0;
const deepseekActiveByTab = new Map();
const deepseekControllers = new Map();
const aiResponseCache = new Map();
let aiResponseCacheChars = 0;
const emptyAiTokenUsage = () => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  reasoningTokens: 0,
  reportedRequests: 0,
  unreportedRequests: 0,
  updatedAt: 0
});
let aiTokenUsage = emptyAiTokenUsage();
let aiTokenUsagePersist = Promise.resolve();
const aiTokenUsageReady = sessionStore
  ? sessionStore.get({ [AI_TOKEN_USAGE_KEY]: null }).then((got) => {
      const stored = got && got[AI_TOKEN_USAGE_KEY];
      if (!stored || typeof stored !== "object") return;
      for (const key of Object.keys(aiTokenUsage)) {
        const value = Number(stored[key]);
        if (Number.isFinite(value)) aiTokenUsage[key] = Math.max(0, Math.round(value));
      }
    }).catch(() => {})
  : Promise.resolve();
function debugSecretsFromLocalStorage(stored) {
  const secrets = new Set();
  const add = (value) => {
    const text = String(value || "").trim();
    if (text.length >= 4) secrets.add(text);
  };
  const keys = stored && stored.aiApiKeys;
  if (keys && typeof keys === "object") Object.values(keys).forEach(add);
  add(stored && stored.aiApiKey);
  add(stored && stored.deepseekApiKey);
  const profileStore = stored && stored.aiConfigProfileStoreV1;
  const profiles = profileStore && Array.isArray(profileStore.profiles)
    ? profileStore.profiles : [];
  for (const profile of profiles) add(profile && profile.apiKey);
  return Array.from(secrets).sort((a, b) => b.length - a.length);
}

async function refreshDebugKnownSecrets() {
  const localStore = chrome.storage && chrome.storage.local;
  if (!localStore) { debugKnownSecrets = []; return; }
  try {
    const stored = await localStore.get({
      aiApiKeys: {}, aiApiKey: "", deepseekApiKey: "", aiConfigProfileStoreV1: null
    });
    debugKnownSecrets = debugSecretsFromLocalStorage(stored);
  } catch (_e) {
    debugKnownSecrets = [];
  }
}

function sanitizeDebugValue(value) {
  return YTDS_SHARED.sanitizeDiagnosticValue(value, {
    secrets: debugKnownSecrets,
    maxArray: 512,
    maxKeys: 128,
    maxStringChars: 30000
  });
}

function sanitizeDebugEntry(entry) {
  const value = entry && typeof entry === "object" ? entry : {};
  const event = String(sanitizeDebugValue(value.event || "event")).slice(0, 96);
  const data = sanitizeDebugValue(value.data == null ? null : value.data);
  return {
    protocolVersion: DEBUG_BUNDLE_SCHEMA_VERSION,
    sequence: Math.max(0, Math.floor(Number(value.sequence) || 0)),
    ts: String(sanitizeDebugValue(value.ts || new Date().toISOString())).slice(0, 48),
    scope: String(sanitizeDebugValue(value.scope || "background")).slice(0, 48),
    event,
    data
  };
}

const debugHydrated = refreshDebugKnownSecrets().then(async () => {
  let storedLogs = [];
  if (debugStore) {
    try {
      const got = await debugStore.get({ ytdsDebugLogs: [] });
      storedLogs = Array.isArray(got && got.ytdsDebugLogs)
        ? got.ytdsDebugLogs.slice(-DEBUG_MAX) : [];
    } catch (_e) { /* in-memory diagnostics still work */ }
  }
  debugSequence = 0;
  debugLogs = [...storedLogs, ...debugPending].map((entry) =>
    sanitizeDebugEntry({ ...entry, sequence: ++debugSequence }));
  debugPending = [];
  debugReady = true;
  debugChars = debugLogs.reduce((n, entry) => n + JSON.stringify(entry).length, 0);
  trimDebugLogs();
});

if (chrome.storage && chrome.storage.onChanged &&
    typeof chrome.storage.onChanged.addListener === "function") {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const credentialKeys = new Set([
      "aiApiKeys", "aiApiKey", "deepseekApiKey", "aiConfigProfileStoreV1"
    ]);
    if (areaName !== "local" || !Object.keys(changes || {}).some(
      (key) => credentialKeys.has(key)
    )) return;
    const changedCredentials = {};
    for (const key of credentialKeys) {
      if (changes[key]) changedCredentials[key] = changes[key].newValue;
    }
    debugKnownSecrets = Array.from(new Set([
      ...debugKnownSecrets, ...debugSecretsFromLocalStorage(changedCredentials)
    ])).sort((a, b) => b.length - a.length);
    debugLogs = debugLogs.map(sanitizeDebugEntry);
    if (debugStore) {
      debugStore.set({ ytdsDebugLogs: debugLogs.slice(-DEBUG_MAX) }).catch(() => {});
    }
    refreshDebugKnownSecrets().then(() => {
      debugLogs = debugLogs.map(sanitizeDebugEntry);
      debugChars = debugLogs.reduce((n, entry) => n + JSON.stringify(entry).length, 0);
      trimDebugLogs();
      if (debugStore) {
        debugStore.set({ ytdsDebugLogs: debugLogs.slice(-DEBUG_MAX) }).catch(() => {});
      }
    });
  });
}

const aiResponseCacheReady = sessionStore
  ? sessionStore.get({ [AI_RESPONSE_CACHE_KEY]: [] }).then((got) => {
      const entries = Array.isArray(got && got[AI_RESPONSE_CACHE_KEY])
        ? got[AI_RESPONSE_CACHE_KEY] : [];
      for (const entry of entries) {
        if (!entry || typeof entry.key !== "string" ||
            !entry.value || !Array.isArray(entry.value.translations)) continue;
        const chars = JSON.stringify(entry.value).length;
        if (chars > AI_RESPONSE_CACHE_MAX_CHARS) continue;
        aiResponseCache.set(entry.key, { value: entry.value, chars });
        aiResponseCacheChars += chars;
      }
      trimAiResponseCache();
    }).catch(() => {})
  : Promise.resolve();

function trimAiResponseCache() {
  while (aiResponseCache.size > AI_RESPONSE_CACHE_MAX_ENTRIES ||
         aiResponseCacheChars > AI_RESPONSE_CACHE_MAX_CHARS) {
    const first = aiResponseCache.entries().next().value;
    if (!first) break;
    aiResponseCache.delete(first[0]);
    aiResponseCacheChars -= Number(first[1] && first[1].chars) || 0;
  }
  if (aiResponseCacheChars < 0) aiResponseCacheChars = 0;
}

function persistAiTokenUsage(snapshot) {
  if (!sessionStore) return Promise.resolve();
  aiTokenUsagePersist = aiTokenUsagePersist.catch(() => {}).then(() =>
    sessionStore.set({ [AI_TOKEN_USAGE_KEY]: snapshot })
  );
  return aiTokenUsagePersist.catch(() => {});
}

async function recordAiTokenUsage(rawUsage) {
  await aiTokenUsageReady;
  const usage = YTDS_SHARED.normalizeAiTokenUsage(rawUsage);
  if (usage) {
    for (const key of [
      "promptTokens", "completionTokens", "totalTokens",
      "cacheHitTokens", "cacheMissTokens", "reasoningTokens"
    ]) aiTokenUsage[key] += usage[key];
    aiTokenUsage.reportedRequests++;
  } else {
    aiTokenUsage.unreportedRequests++;
  }
  aiTokenUsage.updatedAt = Date.now();
  await persistAiTokenUsage({ ...aiTokenUsage });
  return usage;
}

async function currentAiTokenUsage() {
  await aiTokenUsageReady;
  return { ...aiTokenUsage };
}

async function resetAiTokenUsage() {
  await aiTokenUsageReady;
  aiTokenUsage = emptyAiTokenUsage();
  await persistAiTokenUsage({ ...aiTokenUsage });
  return { ...aiTokenUsage };
}

function persistAiResponseCache() {
  if (!sessionStore) return;
  const entries = Array.from(aiResponseCache, ([key, entry]) => ({
    key,
    value: entry.value
  }));
  sessionStore.set({ [AI_RESPONSE_CACHE_KEY]: entries }).catch(() => {});
}

function hashCacheText(value, seed) {
  const text = String(value || "");
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function aiResponseCacheId(config, items, targetLang, sourceLang, contextBefore, contextAfter) {
  const currentItems = Array.isArray(items) ? items.filter(Boolean) : [];
  const preparedContext = YTDS_SHARED.preparePromptContexts(
    contextBefore, contextAfter, config.contextPast, config.contextFuture,
    currentItems, MAX_PROMPT_SOURCE_CHARS
  );
  const canonical = JSON.stringify({
    version: AI_PROMPT_CACHE_VERSION,
    endpoint: String(config.endpoint || ""),
    endpointKind: String(config.endpointKind || ""),
    model: String(config.model || ""),
    extraBody: config.extraBodyCanonical || "{}",
    targetLang: String(targetLang || ""),
    sourceLang: String(sourceLang || ""),
    current: YTDS_SHARED.compactAiPromptCueRows(currentItems),
    // The model sees request-local positions, but cached translations still
    // contain the caller's absolute IDs. Keep those coordinates in the cache
    // identity so equal text at different timeline locations cannot collide.
    absoluteIds: currentItems.map((item) => String(item && item.id || "")),
    past: YTDS_SHARED.compactAiPromptContextRows(preparedContext.past),
    future: YTDS_SHARED.compactAiPromptContextRows(preparedContext.future)
  });
  return `${canonical.length}:${hashCacheText(canonical, 2166136261).toString(36)}:` +
    hashCacheText(canonical, 3339675911).toString(36);
}

function cloneCachedTranslations(value, cacheHit) {
  const source = value && Array.isArray(value.translations) ? value.translations : [];
  const translations = source.map((item) => ({
    ...item,
    ...(Array.isArray(item && item.alignedChunks) ? {
      alignedChunks: item.alignedChunks.map((chunk) => ({
        ...chunk,
        ids: Array.isArray(chunk && chunk.ids) ? chunk.ids.slice() : []
      }))
    } : {})
  }));
  Object.defineProperty(translations, "deferredIds", {
    value: Array.isArray(value && value.deferredIds) ? value.deferredIds.slice() : []
  });
  Object.defineProperty(translations, "failures", { value: [] });
  Object.defineProperty(translations, "httpDiagnostics", {
    value: { attempts: [], cacheHit: !!cacheHit }
  });
  return translations;
}

async function readAiResponseCache(key) {
  await aiResponseCacheReady;
  const entry = aiResponseCache.get(key);
  if (!entry) return null;
  aiResponseCache.delete(key);
  aiResponseCache.set(key, entry);
  return cloneCachedTranslations(entry.value, true);
}

async function writeAiResponseCache(key, translations) {
  await aiResponseCacheReady;
  const value = {
    translations: Array.from(translations || [], (item) => ({ ...item })),
    deferredIds: Array.isArray(translations && translations.deferredIds)
      ? translations.deferredIds.slice() : []
  };
  const chars = JSON.stringify(value).length;
  if (!value.translations.length || chars > AI_RESPONSE_CACHE_MAX_CHARS) return;
  const previous = aiResponseCache.get(key);
  if (previous) aiResponseCacheChars -= previous.chars;
  aiResponseCache.delete(key);
  aiResponseCache.set(key, { value, chars });
  aiResponseCacheChars += chars;
  trimAiResponseCache();
  persistAiResponseCache();
}

function appendDebug(scope, event, data) {
  let entry = sanitizeDebugEntry({
    sequence: ++debugSequence,
    ts: new Date().toISOString(),
    scope: String(scope || "background"),
    event: String(event || "event"),
    data: data == null ? null : data
  });
  let serialized = "";
  try { serialized = JSON.stringify(entry); } catch (_e) { serialized = ""; }
  if (!serialized || serialized.length > DEBUG_MAX_ENTRY_CHARS) {
    entry = sanitizeDebugEntry({
      sequence: entry.sequence,
      ts: entry.ts,
      scope: entry.scope,
      event: entry.event,
      data: {
        truncated: true,
        originalChars: serialized.length,
        keys: data && typeof data === "object" ? Object.keys(data).slice(0, 24) : []
      }
    });
    serialized = JSON.stringify(entry);
  }
  if (!debugReady) { debugPending.push(entry); return; }
  debugLogs.push(entry);
  debugChars += serialized.length;
  trimDebugLogs();
  if (!debugStore || debugFlushTimer) return;
  debugFlushTimer = setTimeout(() => {
    debugFlushTimer = null;
    debugStore.set({ ytdsDebugLogs: debugLogs.slice(-DEBUG_MAX) }).catch(() => {});
  }, 500);
}

function trimDebugLogs() {
  const cutoff = Date.now() - DEBUG_RETENTION_MS;
  const isTooOld = (entry) => {
    const timestamp = Date.parse(String(entry && entry.ts || ""));
    return Number.isFinite(timestamp) && timestamp < cutoff;
  };
  while (debugLogs.length &&
      (debugLogs.length > DEBUG_MAX || debugChars > DEBUG_MAX_CHARS ||
       isTooOld(debugLogs[0]))) {
    const removed = debugLogs.shift();
    if (removed) debugChars -= JSON.stringify(removed).length;
  }
  if (debugChars < 0) debugChars = 0;
}

async function exportDebugLogs() {
  await debugHydrated;
  // Re-sanitize at the final boundary so legacy session entries and a key
  // added after the event was recorded cannot leak through the clipboard.
  await refreshDebugKnownSecrets();
  const entries = debugLogs.map(sanitizeDebugEntry);
  const firstTs = entries.length ? entries[0].ts : "";
  const lastTs = entries.length ? entries[entries.length - 1].ts : "";
  const firstMs = Date.parse(firstTs);
  const lastMs = Date.parse(lastTs);
  return JSON.stringify({
    schemaVersion: DEBUG_BUNDLE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    extensionVersion: String(chrome.runtime.getManifest().version || ""),
    entryCount: entries.length,
    coverageMs: Number.isFinite(firstMs) && Number.isFinite(lastMs)
      ? Math.max(0, lastMs - firstMs) : 0,
    firstEntryAt: firstTs,
    lastEntryAt: lastTs,
    entries
  }, null, 2);
}

async function clearDebugLogs() {
  await debugHydrated;
  debugLogs = [];
  debugChars = 0;
  if (debugStore) await debugStore.set({ ytdsDebugLogs: [] }).catch(() => {});
}

function isYoutubeSender(sender) {
  return senderPageUrls(sender).some(YTDS_SHARED.isYoutubePageUrl);
}

function senderPageUrls(sender) {
  // tab.url reflects the current SPA location more reliably; sender.url can
  // still be the restored/home document URL during the browser's first video.
  return [
    sender && sender.tab && sender.tab.url,
    sender && sender.url
  ].filter((value) => typeof value === "string" && value);
}

function cleanTargetLang(value) {
  return YTDS_SHARED.TARGET_LANGS.includes(value) ? value : "";
}

function cleanSourceLang(value) {
  const lang = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(lang)
    ? lang.slice(0, 24) : "";
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && text.length <= MAX_TRANSLATE_CHARS ? text : "";
}

function cleanContext(value, limit, forcedTemporal) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > limit) return null;
  const out = [];
  for (const entry of value) {
    const text = cleanText(entry && entry.text);
    if (!text) return null;
    out.push({
      id: entry && entry.id != null ? String(entry.id).slice(0, 24) : "",
      text,
      current: !!(entry && entry.current),
      temporal: forcedTemporal === "future" ? "future" : "past"
    });
  }
  return out;
}

function cleanBatchItems(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_BATCH_ITEMS) return null;
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const id = String(entry && entry.id);
    const cueId = String(entry && entry.cueId);
    const text = cleanText(entry && entry.text);
    const startMs = Number(entry && entry.startMs);
    const endMs = Number(entry && entry.endMs);
    if (!/^\d{1,8}$/.test(id) || !/^\d{1,8}$/.test(cueId) || seen.has(id) || !text ||
        !Number.isFinite(startMs) || !Number.isFinite(endMs) ||
        startMs < 0 || endMs < startMs || endMs > 7 * 24 * 60 * 60 * 1000) return null;
    seen.add(id);
    out.push({
      id,
      cueId,
      text,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      pauseAfterMs: Math.max(0, Math.min(600000,
        Math.round(Number(entry && entry.pauseAfterMs) || 0))),
      softAfter: !!(entry && entry.softAfter),
      hardAfter: !!(entry && entry.hardAfter)
    });
  }
  return out;
}

function acquireDeepSeekSlot(sender, urgent, endpointKind) {
  const key = sender && sender.tab && Number.isInteger(sender.tab.id)
    ? `tab:${sender.tab.id}` : "extension";
  const state = deepseekActiveByTab.get(key) || { active: 0 };
  const maxActive = endpointKind === "deepseek"
    ? DEEPSEEK_MAX_ACTIVE_REQUESTS_PER_TAB
    : COMPATIBLE_MAX_ACTIVE_REQUESTS_PER_TAB;
  const status = YTDS_SHARED.deepSeekConcurrencyStatus(
    state.active, maxActive, !!urgent
  );
  if (!status.allowed) {
    const err = new Error("AI local concurrency guard busy");
    err.rateLimited = true;
    err.retryAfterMs = status.retryAfterMs;
    err.limitReason = status.reason;
    throw err;
  }
  state.active++;
  deepseekActiveByTab.set(key, state);
  return () => {
    state.active = Math.max(0, state.active - 1);
    if (!state.active) deepseekActiveByTab.delete(key);
  };
}

function persistAiStatus(kind, _message, errorCode) {
  if (!sessionStore) return;
  sessionStore.set({
    ytdsAiStatus: kind ? {
      kind,
      // The popup only needs the normalized code. Do not persist provider
      // error text, which may echo prompt data or credentials.
      message: "",
      errorCode: String(errorCode || "").slice(0, 64),
      ts: Date.now()
    } : null
  }).catch(() => {});
}

function retryDelayMs(res, attempt) {
  const retryAfter = res && Number(res.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(10000, retryAfter * 1000);
  return Math.min(5000, 600 * Math.pow(2, attempt)) + Math.round(Math.random() * 250);
}

// Keep the deadline alive through the complete SSE body. Network chunks are
// arbitrary byte slices, so YTDS_SHARED.deepSeekSseEvents buffers until a full
// blank-line-delimited event is available before any JSON is parsed.
