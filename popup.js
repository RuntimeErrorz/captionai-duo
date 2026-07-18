// popup.js
// Loads/saves settings to chrome.storage.sync; content.js applies them live.

// ---- shared settings model (MUST match content.js DEFAULTS) --------------
const DEFAULTS = YTDS_SHARED.DEFAULTS;

const $ = (id) => document.getElementById(id);
let state = { ...DEFAULTS };

let activeLine = "trans";        // which line the tab editor is bound to
let activeWorkspace = "translation"; // translation | display | tools
let exportVariant = "bi";        // SRT export content: "bi" | "orig" | "trans" (local, not stored)

// ---- i18n ----------------------------------------------------------------
// Safe wrapper: returns the localized message, or the fallback if the key is
// missing/empty so the hardcoded markup keeps working in any environment.
function t(key, fallback) {
  try {
    const m = chrome.i18n && chrome.i18n.getMessage(key);
    if (m) return m;
  } catch (_e) { /* ignore */ }
  return fallback;
}

// Walk the DOM once and fill every data-i18n* attribute. Only overwrite when
// the looked-up message is non-empty, so a missing key leaves the hardcoded
// fallback text in place.
function applyI18n() {
  // Keep the document language in sync with the actual UI locale so screen
  // readers / hyphenation match the rendered text (default_locale is "en").
  try {
    const ui = chrome.i18n && chrome.i18n.getUILanguage();
    if (ui) document.documentElement.lang = ui;
  } catch (_e) { /* ignore */ }
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.dataset.i18n);
    if (m) el.textContent = m;
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-html"));
    if (m) el.innerHTML = m;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-title"));
    if (m) el.title = m;
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-aria"));
    if (m) el.setAttribute("aria-label", m);
  });
}

// per-line key prefixing so one set of controls edits either line.
// The per-tab "show this line" label is resolved live via t() in
// bindLineControls so it follows the active locale.
const LINE = {
  trans: {
    show: "showTranslation", font: "transFont", size: "transSize", fullscreenSize: "transFullscreenSize",
    color: "transColor", bg: "transBg", bgOpacity: "transBgOpacity",
    stroke: "transStroke", strokeOpacity: "transStrokeOpacity", strokeWidth: "transStrokeWidth"
  },
  orig: {
    show: "showOriginal", font: "origFont", size: "origSize", fullscreenSize: "origFullscreenSize",
    color: "origColor", bg: "origBg", bgOpacity: "origBgOpacity",
    stroke: "origStroke", strokeOpacity: "origStrokeOpacity", strokeWidth: "origStrokeWidth"
  }
};

// ---- persistence ---------------------------------------------------------
let pendingSyncPatch = {};
let syncSaveTimer = null;
let pendingLivePatch = {};
let livePatchTimer = null;

function flushSyncPatch() {
  if (syncSaveTimer) { clearTimeout(syncSaveTimer); syncSaveTimer = null; }
  const patch = pendingSyncPatch;
  pendingSyncPatch = {};
  if (Object.keys(patch).length) chrome.storage.sync.set(patch);
}

function pushLivePatch(key, val) {
  pendingLivePatch[key] = val;
  if (livePatchTimer) return;
  livePatchTimer = setTimeout(async () => {
    livePatchTimer = null;
    const patch = pendingLivePatch;
    pendingLivePatch = {};
    const tab = await getActiveTab();
    if (tab && tab.id != null) await sendToTab(tab.id, { type: "settingsPatch", patch });
  }, 0);
}

function setKey(key, val, continuous) {
  state[key] = val;
  pushLivePatch(key, val);
  if (continuous) {
    pendingSyncPatch[key] = val;
    if (syncSaveTimer) clearTimeout(syncSaveTimer);
    syncSaveTimer = setTimeout(flushSyncPatch, 180);
  } else {
    pendingSyncPatch[key] = val;
    flushSyncPatch();
  }
}

// ---- segmented controls --------------------------------------------------
function paintSegs() {
  const sync = (sel, val) =>
    document.querySelectorAll(sel + " button").forEach((b) => {
      const on = b.dataset.val === val;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on)); // expose state to screen readers
    });
  sync("#order", state.order);
}

// ---- export (SRT download) -----------------------------------------------
// The export variant is a transient choice (not persisted, so it stays out of
// the shared DEFAULTS contract between popup.js and content.js).
function paintExportSeg() {
  document.querySelectorAll("#exportVariant button").forEach((b) => {
    const on = b.dataset.val === exportVariant;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

// Active tab id only — the tab id needs no "tabs" permission. We avoid reading
// tab.url (which would) and instead detect a non-YouTube page by a null reply
// from sendToTab (no content script there to answer).
function getActiveTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(tabs && tabs[0]);
      });
    } catch (_e) { resolve(null); }
  });
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }   // no content script
        resolve(resp);
      });
    } catch (_e) { resolve(null); }
  });
}

function activateWorkspace(workspace, scrollToTop) {
  const allowed = new Set(["translation", "display", "tools"]);
  activeWorkspace = allowed.has(workspace) ? workspace : "translation";
  document.querySelectorAll("[data-workspace-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.workspacePanel !== activeWorkspace;
  });
  document.querySelectorAll(".workspace-tab").forEach((button) => {
    const on = button.dataset.workspace === activeWorkspace;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
  });
  const footer = $("toolsFooter");
  if (footer) footer.hidden = activeWorkspace !== "tools";
  if (scrollToTop) {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }
}

function sendRuntime(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    } catch (_e) { resolve(null); }
  });
}

function containsOriginPermission(origin) {
  return new Promise((resolve) => {
    if (!origin || !chrome.permissions) { resolve(false); return; }
    try {
      chrome.permissions.contains({ origins: [origin] }, (granted) => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        resolve(!!granted);
      });
    } catch (_e) { resolve(false); }
  });
}

function requestOriginPermission(origin) {
  return new Promise((resolve) => {
    if (!origin || !chrome.permissions) { resolve(false); return; }
    try {
      chrome.permissions.request({ origins: [origin] }, (granted) => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        resolve(!!granted);
      });
    } catch (_e) { resolve(false); }
  });
}

function paintAiBaseUrl() {
  const baseUrl = YTDS_SHARED.normalizeAiBaseUrl(state.aiBaseUrl);
  $("authorizeAiBase").hidden =
    YTDS_SHARED.aiEndpointKind(baseUrl) === "deepseek";
}

async function readAiCredentialState() {
  const stored = await chrome.storage.local.get({
    aiApiKeys: {}, aiApiKey: "", deepseekApiKey: ""
  });
  const keys = stored.aiApiKeys && typeof stored.aiApiKeys === "object"
    ? { ...stored.aiApiKeys } : {};
  if (!keys.deepseek && (stored.aiApiKey || stored.deepseekApiKey)) {
    keys.deepseek = String(stored.aiApiKey || stored.deepseekApiKey).trim();
  }
  return keys;
}

async function loadCurrentAiApiKey() {
  const keys = await readAiCredentialState();
  const scope = YTDS_SHARED.aiCredentialScope(state.aiBaseUrl);
  $("aiApiKey").value = scope ? String(keys[scope] || "") : "";
  return String(scope && keys[scope] || "").trim();
}

async function saveCurrentAiApiKey(value) {
  const scope = YTDS_SHARED.aiCredentialScope(state.aiBaseUrl);
  if (!scope) return false;
  const keys = await readAiCredentialState();
  const key = String(value || "").trim();
  if (key) keys[scope] = key;
  else delete keys[scope];
  await chrome.storage.local.set({ aiApiKeys: keys });
  if (scope === "deepseek") {
    await chrome.storage.local.remove(["aiApiKey", "deepseekApiKey"]);
  }
  return true;
}

function setAiStatus(text, kind) {
  const el = $("aiStatus");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("warn", kind === "warn");
  el.classList.toggle("ok", kind === "ok");
  el.hidden = !text;
}

async function authorizeCurrentAiBase() {
  const normalized = YTDS_SHARED.normalizeAiBaseUrl(state.aiBaseUrl);
  if (!normalized) {
    setAiStatus(t("aiBaseMissing", "请输入有效的 API Base URL。"), "warn");
    return false;
  }
  if (normalized !== state.aiBaseUrl) {
    setKey("aiBaseUrl", normalized);
    $("aiBaseUrl").value = normalized;
  }
  const origin = YTDS_SHARED.aiOriginPattern(normalized);
  // Call request() directly from the button gesture. Asking for an already
  // granted origin is harmless and avoids losing Chrome's user-gesture token.
  const granted = origin === "https://api.deepseek.com/*"
    ? true : await requestOriginPermission(origin);
  setAiStatus(granted
    ? t("aiPermissionGranted", "API 地址已授权。")
    : t("aiPermissionDenied", "未获得 API 地址授权。"), granted ? "ok" : "warn");
  return granted;
}

function showDebugMsg(text, kind) {
  const el = $("debugMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
  el.hidden = !text;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_e2) { return false; }
  }
}

async function onCopyDebug() {
  showDebugMsg(t("debugLoading", "正在读取日志…"), null);
  const resp = await sendRuntime({ type: "getDebugLogs" });
  if (!resp || !resp.ok || !resp.logs) {
    showDebugMsg(t("debugEmpty", "暂无日志，请先启用并复现问题。"), "err");
    return;
  }
  const ok = await copyText(resp.logs);
  showDebugMsg(ok
    ? t("debugCopied", "日志已复制，可以直接发给我。")
    : t("debugCopyFailed", "复制失败，请重试。"), ok ? "ok" : "err");
}

async function onClearDebug() {
  const resp = await sendRuntime({ type: "clearDebugLogs" });
  showDebugMsg(resp && resp.ok
    ? t("debugCleared", "日志已清空。")
    : t("debugClearFailed", "清空失败，请重试。"), resp && resp.ok ? "ok" : "err");
}

// ---- Token usage ---------------------------------------------------------
const tokenFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function formatTokenCount(value) {
  return tokenFormatter.format(Math.max(0, Math.round(Number(value) || 0)));
}

function paintAiTokenUsage(value) {
  const usage = value && typeof value === "object" ? value : {};
  $("tokenTotal").textContent = formatTokenCount(usage.totalTokens);
  $("tokenInput").textContent = formatTokenCount(usage.promptTokens);
  $("tokenOutput").textContent = formatTokenCount(usage.completionTokens);
  $("tokenCacheHit").textContent = formatTokenCount(usage.cacheHitTokens);
  $("tokenCacheMiss").textContent = formatTokenCount(usage.cacheMissTokens);
  $("tokenReasoning").textContent = formatTokenCount(usage.reasoningTokens);
  $("tokenRequests").textContent = formatTokenCount(
    (Number(usage.reportedRequests) || 0) + (Number(usage.unreportedRequests) || 0)
  );
  const reported = formatTokenCount(usage.reportedRequests);
  const unreported = Math.max(0, Math.round(Number(usage.unreportedRequests) || 0));
  $("tokenMeta").textContent = `${reported} ${t("tokenReportedRequests", "reported responses")}` +
    (unreported ? ` · ${formatTokenCount(unreported)} ${t("tokenUnreportedRequests", "unreported responses")}` : "");
}

async function refreshAiTokenUsage() {
  const resp = await sendRuntime({ type: "getAiTokenUsage" });
  if (resp && resp.ok) paintAiTokenUsage(resp.usage);
}

async function onResetTokenUsage() {
  const resp = await sendRuntime({ type: "resetAiTokenUsage" });
  if (resp && resp.ok) paintAiTokenUsage(resp.usage);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.ytdsAiTokenUsageV1) {
    paintAiTokenUsage(changes.ytdsAiTokenUsageV1.newValue);
  }
});

// ---- AI service status line ----------------------------------------------
async function refreshEngineStatus() {
  const el = $("aiStatus");
  if (!el) return;
  el.hidden = true;
  el.classList.remove("warn", "ok");

  const baseUrl = YTDS_SHARED.normalizeAiBaseUrl(state.aiBaseUrl);
  if (!baseUrl || !String(state.aiModel || "").trim()) {
    el.textContent = t("aiBaseMissing", "请输入有效的 API Base URL 和模型名。");
    el.classList.add("warn");
    el.hidden = false;
    return;
  }
  const apiKey = await loadCurrentAiApiKey();
  const endpointKind = YTDS_SHARED.aiEndpointKind(baseUrl);
  if (endpointKind === "deepseek" && !apiKey) {
    el.textContent = t("aiKeyMissing", "请先填写 API Key。");
    el.classList.add("warn");
    el.hidden = false;
    return;
  }
  if (endpointKind === "compatible") {
    const origin = YTDS_SHARED.aiOriginPattern(baseUrl);
    if (!await containsOriginPermission(origin)) {
      el.textContent = t("aiPermissionMissing", "请授权访问当前 API 地址。");
      el.classList.add("warn");
      el.hidden = false;
      return;
    }
  }
  try {
    if (chrome.storage.session) {
      const got = await chrome.storage.session.get(["ytdsAiStatus", "ytdsDeepSeekStatus"]);
      const status = got && (got.ytdsAiStatus || got.ytdsDeepSeekStatus);
      if (status && Date.now() - Number(status.ts || 0) < 10 * 60 * 1000) {
        const messages = {
          timeout: t("aiStatusTimeout", "AI 请求超时，扩展已自动重试。"),
          limited: t("aiStatusLimited", "AI 请求过多，已暂时放慢。"),
          partial: t("aiStatusPartial", "部分字幕翻译失败，播放到该处时会自动重试。"),
          key: t("aiStatusKey", "API Key 无效，请重新填写。"),
          error: t("aiStatusError", "AI 服务暂时不可用，播放时会自动重试。")
        };
        el.textContent = messages[status.kind] || messages.error;
        el.classList.add("warn");
        el.hidden = false;
      }
    }
  } catch (_e) { /* session status unavailable */ }
}

function showExportMsg(text, kind) {
  const el = $("exportMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
  el.hidden = !text;
}

async function onExportClick() {
  const btn = $("exportBtn");
  const label = btn.textContent;
  showExportMsg("", null);
  btn.disabled = true;
  btn.textContent = t("exportWorking", "正在生成…");
  try {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) {
      showExportMsg(t("exportNotYoutube", "请在 YouTube 视频页面使用导出。"), "err");
      return;
    }
    const resp = await sendToTab(tab.id, { type: "exportSrt", variant: exportVariant });
    if (resp == null) {
      showExportMsg(t("exportNotYoutube", "请在 YouTube 视频页面使用导出。"), "err");
    } else if (resp.ok) {
      const source = resp.source === "ai" || resp.source === "deepseek"
        ? t("exportSourceAi", "AI 译文") : "";
      showExportMsg(t("exportDone", "已下载字幕") + " (" + (resp.count || 0) + ")" +
        (source ? " · " + source : ""), "ok");
    } else if (resp.reason === "notrans") {
      showExportMsg(t("exportNoTrans", "AI 译文尚未完整缓存，请播放或预加载完整视频后再试。"), "err");
    } else {
      showExportMsg(t("exportNoCues", "没有可下载的字幕，先播放几秒让字幕加载，再试一次。"), "err");
    }
  } catch (_e) {
    showExportMsg(t("exportFailed", "导出失败，刷新页面后重试。"), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---- per-line tab editor -------------------------------------------------
function bindLineControls() {
  const m = LINE[activeLine];
  $("lineShowLabel").textContent =
    t("lineShow", activeLine === "trans" ? "显示译文" : "显示原文");
  $("lineShow").checked = !!state[m.show];
  $("lineFont").value = state[m.font];
  $("lineSize").value = state[m.size];
  $("lineSizeV").textContent = state[m.size] + "px";
  $("lineFullscreenSize").value = state[m.fullscreenSize];
  $("lineFullscreenSizeV").textContent = state[m.fullscreenSize] + "px";
  $("lineColor").value = state[m.color];
  $("lineBg").value = state[m.bg];
  $("lineStroke").value = state[m.stroke];
  $("lineBgOpacity").value = state[m.bgOpacity];
  $("lineBgOpacityV").textContent = Math.round(state[m.bgOpacity] * 100) + "%";
  $("lineStrokeOpacity").value = state[m.strokeOpacity];
  $("lineStrokeOpacityV").textContent = Math.round(state[m.strokeOpacity] * 100) + "%";
  $("lineStrokeWidth").value = state[m.strokeWidth];
  $("lineStrokeWidthV").textContent = Number(state[m.strokeWidth]).toFixed(1) + "px";

  let activeTabId = "";
  document.querySelectorAll("#lineTabs .tab").forEach((b) => {
    const on = b.dataset.line === activeLine;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on)); // expose tab state to screen readers
    if (on) activeTabId = b.id;
  });
  // point the panel at whichever tab is now active
  const panel = $("lineEditor");
  if (panel && activeTabId) panel.setAttribute("aria-labelledby", activeTabId);
}

// ---- bind whole UI from state -------------------------------------------
function bindUI() {
  $("enabled").checked = state.enabled;
  $("debugEnabled").checked = !!state.debugEnabled;
  $("targetLang").value = state.targetLang;
  $("aiBaseUrl").value = state.aiBaseUrl;
  $("aiModel").value = state.aiModel;
  $("aiThinking").value = state.aiThinking;
  $("deepseekContextPast").value = String(state.deepseekContextPast);
  $("deepseekContextFuture").value = String(state.deepseekContextFuture);
  $("deepseekPrefetchBatches").value = String(state.deepseekPrefetchBatches);
  $("rowGap").value = state.rowGap;
  $("rowGapV").textContent = state.rowGap + "px";
  paintSegs();
  paintExportSeg();
  paintAiBaseUrl();
  bindLineControls();
  activateWorkspace(activeWorkspace, false);
}

// ---- wire events ---------------------------------------------------------
function wire() {
  document.querySelectorAll(".workspace-tab").forEach((button) => {
    button.addEventListener("click", () => activateWorkspace(button.dataset.workspace, true));
  });
  $("enabled").addEventListener("change", (e) => setKey("enabled", e.target.checked));
  $("targetLang").addEventListener("change", (e) => setKey("targetLang", e.target.value));

  $("aiBaseUrl").addEventListener("change", (e) => {
    const value = e.target.value.trim();
    const normalized = YTDS_SHARED.normalizeAiBaseUrl(value);
    setKey("aiBaseUrl", normalized || value);
    e.target.value = state.aiBaseUrl;
    paintAiBaseUrl();
    loadCurrentAiApiKey().then(refreshEngineStatus);
  });
  $("authorizeAiBase").addEventListener("click", authorizeCurrentAiBase);
  $("aiModel").addEventListener("change", (e) => {
    setKey("aiModel", e.target.value.trim());
    refreshEngineStatus();
  });
  $("aiThinking").addEventListener("change", (e) =>
    setKey("aiThinking", YTDS_SHARED.normalizeAiThinking(e.target.value)));

  $("aiApiKey").addEventListener("change", async (e) => {
    if (await saveCurrentAiApiKey(e.target.value)) {
      if (chrome.storage.session) {
        await chrome.storage.session.remove(["ytdsAiStatus", "ytdsDeepSeekStatus"]).catch(() => {});
      }
      refreshEngineStatus();
    }
  });
  $("toggleApiKey").addEventListener("click", () => {
    const input = $("aiApiKey");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    $("toggleApiKey").textContent = showing
      ? t("showApiKey", "显示") : t("hideApiKey", "隐藏");
  });
  $("clearApiKey").addEventListener("click", async () => {
    await saveCurrentAiApiKey("");
    if (chrome.storage.session) await chrome.storage.session.remove(["ytdsAiStatus", "ytdsDeepSeekStatus"]).catch(() => {});
    $("aiApiKey").value = "";
    $("aiApiKey").type = "password";
    $("toggleApiKey").textContent = t("showApiKey", "显示");
    refreshEngineStatus();
  });
  $("deepseekContextPast").addEventListener("change", (e) => {
    const value = YTDS_SHARED.normalizeAiContextCount(e.target.value, state.deepseekContextPast);
    e.target.value = String(value);
    setKey("deepseekContextPast", value);
  });
  $("deepseekContextFuture").addEventListener("change", (e) => {
    const value = YTDS_SHARED.normalizeAiContextCount(e.target.value, state.deepseekContextFuture);
    e.target.value = String(value);
    setKey("deepseekContextFuture", value);
  });
  $("deepseekPrefetchBatches").addEventListener("change", (e) => {
    const value = YTDS_SHARED.normalizeDeepseekPrefetchBatches(e.target.value);
    e.target.value = String(value);
    setKey("deepseekPrefetchBatches", value);
  });

  $("debugEnabled").addEventListener("change", (e) => {
    setKey("debugEnabled", e.target.checked);
    showDebugMsg(e.target.checked
      ? t("debugStarted", "调试日志已启用，请刷新视频页面并复现问题。")
      : t("debugStopped", "调试日志已停止，现有日志仍可复制。"), "ok");
  });
  $("copyDebug").addEventListener("click", onCopyDebug);
  $("clearDebug").addEventListener("click", onClearDebug);
  $("resetTokenUsage").addEventListener("click", onResetTokenUsage);

  // segmented: order
  document.querySelectorAll("#order button").forEach((b) =>
    b.addEventListener("click", () => { setKey("order", b.dataset.val); paintSegs(); }));

  // row gap
  $("rowGap").addEventListener("input", (e) => {
    $("rowGapV").textContent = e.target.value + "px";
    setKey("rowGap", +e.target.value, true);
  });

  // tabs
  document.querySelectorAll("#lineTabs .tab").forEach((b) =>
    b.addEventListener("click", () => { activeLine = b.dataset.line; bindLineControls(); }));

  // per-line controls write to the ACTIVE line's keys
  $("lineShow").addEventListener("change", (e) => setKey(LINE[activeLine].show, e.target.checked));
  $("lineFont").addEventListener("change", (e) => setKey(LINE[activeLine].font, e.target.value));
  $("lineSize").addEventListener("input", (e) => {
    $("lineSizeV").textContent = e.target.value + "px";
    setKey(LINE[activeLine].size, +e.target.value, true);
  });
  $("lineFullscreenSize").addEventListener("input", (e) => {
    $("lineFullscreenSizeV").textContent = e.target.value + "px";
    setKey(LINE[activeLine].fullscreenSize, +e.target.value, true);
  });
  $("lineColor").addEventListener("input", (e) => setKey(LINE[activeLine].color, e.target.value, true));
  $("lineBg").addEventListener("input", (e) => setKey(LINE[activeLine].bg, e.target.value, true));
  $("lineStroke").addEventListener("input", (e) => setKey(LINE[activeLine].stroke, e.target.value, true));
  $("lineBgOpacity").addEventListener("input", (e) => {
    $("lineBgOpacityV").textContent = Math.round(+e.target.value * 100) + "%";
    setKey(LINE[activeLine].bgOpacity, +e.target.value, true);
  });
  $("lineStrokeOpacity").addEventListener("input", (e) => {
    $("lineStrokeOpacityV").textContent = Math.round(+e.target.value * 100) + "%";
    setKey(LINE[activeLine].strokeOpacity, +e.target.value, true);
  });
  $("lineStrokeWidth").addEventListener("input", (e) => {
    $("lineStrokeWidthV").textContent = (+e.target.value).toFixed(1) + "px";
    setKey(LINE[activeLine].strokeWidth, +e.target.value, true);
  });

  ["rowGap", "lineSize", "lineFullscreenSize", "lineColor", "lineBg", "lineStroke",
   "lineBgOpacity", "lineStrokeOpacity", "lineStrokeWidth"].forEach((id) =>
    $(id).addEventListener("change", flushSyncPatch));

  // export (SRT download)
  document.querySelectorAll("#exportVariant button").forEach((b) =>
    b.addEventListener("click", () => { exportVariant = b.dataset.val; paintExportSeg(); }));
  $("exportBtn").addEventListener("click", onExportClick);

  // reset all
  $("reset").addEventListener("click", () => {
    state = { ...DEFAULTS };
    chrome.storage.sync.set(DEFAULTS);
    bindUI();
    refreshEngineStatus();
  });
}

// ---- boot ----------------------------------------------------------------
applyI18n();                       // localize static markup before first paint
window.addEventListener("pagehide", flushSyncPatch);
chrome.storage.sync.get(null, (got) => {
  got = got || {};
  state = { ...DEFAULTS, ...got };
  const migration = {};
  const normalizedTargetLang = YTDS_SHARED.normalizeTargetLang(state.targetLang);
  if (normalizedTargetLang !== state.targetLang) migration.targetLang = normalizedTargetLang;
  if (!Object.prototype.hasOwnProperty.call(got, "aiBaseUrl")) {
    migration.aiBaseUrl = YTDS_SHARED.AI_DEFAULT_BASE_URL;
  }
  if (!Object.prototype.hasOwnProperty.call(got, "aiModel") && got.deepseekModel) {
    migration.aiModel = got.deepseekModel;
  }
  if (!Object.prototype.hasOwnProperty.call(got, "aiThinking") && got.deepseekThinking) {
    migration.aiThinking = got.deepseekThinking;
  }
  Object.assign(state, migration);
  const normalizedBase = YTDS_SHARED.normalizeAiBaseUrl(state.aiBaseUrl);
  if (normalizedBase) state.aiBaseUrl = normalizedBase;
  state.aiModel = String(state.aiModel || "").trim();
  state.aiThinking = YTDS_SHARED.normalizeAiThinking(state.aiThinking);
  state.deepseekContextPast =
    YTDS_SHARED.normalizeAiContextCount(state.deepseekContextPast, DEFAULTS.deepseekContextPast);
  state.deepseekContextFuture =
    YTDS_SHARED.normalizeAiContextCount(state.deepseekContextFuture, DEFAULTS.deepseekContextFuture);
  state.deepseekPrefetchBatches =
    YTDS_SHARED.normalizeDeepseekPrefetchBatches(state.deepseekPrefetchBatches);
  // migrate legacy global bgOpacity onto per-line defaults
  if (typeof got.bgOpacity === "number") {
    if (typeof got.origBgOpacity !== "number") state.origBgOpacity = got.bgOpacity;
    if (typeof got.transBgOpacity !== "number") state.transBgOpacity = got.bgOpacity;
  }
  // Move untouched legacy visual defaults to the clearer subtitle treatment.
  // Exact-value checks preserve settings that the user actually customized.
  if (Number(got.visualDefaultsVersion || 0) < 2) {
    if (!Object.prototype.hasOwnProperty.call(got, "order") || got.order === "orig-top") {
      migration.order = "trans-top";
    }
    if (!Object.prototype.hasOwnProperty.call(got, "transColor") ||
        String(got.transColor).toLowerCase() === "#ffe98a") {
      migration.transColor = "#ffffff";
    }
    const oldTransBgOpacity = Object.prototype.hasOwnProperty.call(got, "transBgOpacity")
      ? Number(got.transBgOpacity) : Number(got.bgOpacity);
    if (!Number.isFinite(oldTransBgOpacity) || oldTransBgOpacity === 0.6) {
      migration.transBgOpacity = 0;
    }
    if (!Object.prototype.hasOwnProperty.call(got, "transStrokeOpacity") ||
        Number(got.transStrokeOpacity) === 0) {
      migration.transStrokeOpacity = 1;
    }
    migration.visualDefaultsVersion = 2;
    Object.assign(state, migration);
  }
  if (Number(got.contextDefaultsVersion || 0) < 2) {
    if (!Object.prototype.hasOwnProperty.call(got, "deepseekContextPast") ||
        Number(got.deepseekContextPast) === 5) {
      migration.deepseekContextPast = 1;
    }
    if (!Object.prototype.hasOwnProperty.call(got, "deepseekContextFuture") ||
        Number(got.deepseekContextFuture) === 0) {
      migration.deepseekContextFuture = 1;
    }
    migration.contextDefaultsVersion = 2;
    Object.assign(state, migration);
  }
  if (Number(got.lineDefaultsVersion || 0) < 2) {
    if (!Object.prototype.hasOwnProperty.call(got, "origSize") || Number(got.origSize) === 22) {
      migration.origSize = 24;
    }
    if (!Object.prototype.hasOwnProperty.call(got, "origFullscreenSize") ||
        Number(got.origFullscreenSize) === 30) {
      migration.origFullscreenSize = 34;
    }
    const oldOrigBgOpacity = Object.prototype.hasOwnProperty.call(got, "origBgOpacity")
      ? Number(got.origBgOpacity) : Number(got.bgOpacity);
    if (!Number.isFinite(oldOrigBgOpacity) || oldOrigBgOpacity === 0.6) {
      migration.origBgOpacity = 0;
    }
    if (!Object.prototype.hasOwnProperty.call(got, "origStrokeOpacity") ||
        Number(got.origStrokeOpacity) === 0) {
      migration.origStrokeOpacity = 1;
    }
    migration.lineDefaultsVersion = 2;
    Object.assign(state, migration);
  }
  if (Object.keys(migration).length) chrome.storage.sync.set(migration);
  if (Object.prototype.hasOwnProperty.call(got, "aiProvider")) {
    chrome.storage.sync.remove("aiProvider");
  }
  chrome.storage.local.get({ aiApiKeys: {}, aiApiKey: "", deepseekApiKey: "" }, (local) => {
    const keys = local.aiApiKeys && typeof local.aiApiKeys === "object" ? { ...local.aiApiKeys } : {};
    if (!keys.deepseek && (local.aiApiKey || local.deepseekApiKey)) {
      keys.deepseek = String(local.aiApiKey || local.deepseekApiKey).trim();
      chrome.storage.local.set({ aiApiKeys: keys }, () => {
        chrome.storage.local.remove(["aiApiKey", "deepseekApiKey"]);
      });
    }
    bindUI();
    const scope = YTDS_SHARED.aiCredentialScope(state.aiBaseUrl);
    $("aiApiKey").value = scope ? String(keys[scope] || "") : "";
    wire();
    refreshEngineStatus();
    refreshAiTokenUsage();
  });
});
