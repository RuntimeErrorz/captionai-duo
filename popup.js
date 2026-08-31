// popup.js
// Loads/saves settings to chrome.storage.sync; content.js applies them live.

// ---- shared settings model (MUST match content.js DEFAULTS) --------------
const DEFAULTS = YTDS_SHARED.DEFAULTS;

const $ = (id) => document.getElementById(id);
let state = { ...DEFAULTS };

let activeLine = "trans";        // which line the tab editor is bound to
let activeWorkspace = "translation"; // translation | display | tools
let exportVariant = "bi";        // SRT export content: "bi" | "orig" | "trans" (local, not stored)
let captionTrackRefreshSerial = 0;

// ---- i18n ----------------------------------------------------------------
// Safe wrapper: returns the localized message, or the fallback if the key is
// missing/empty so the hardcoded markup keeps working in any environment.
function t(key, fallback, substitutions) {
  try {
    const m = chrome.i18n && (substitutions === undefined
      ? chrome.i18n.getMessage(key) : chrome.i18n.getMessage(key, substitutions));
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
    const m = t(el.dataset.i18n, "");
    if (m) el.textContent = m;
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const m = t(el.getAttribute("data-i18n-html"), "");
    if (m) el.innerHTML = m;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const m = t(el.getAttribute("data-i18n-title"), "");
    if (m) el.title = m;
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const m = t(el.getAttribute("data-i18n-aria"), "");
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
  return Object.keys(patch).length
    ? chrome.storage.sync.set(patch)
    : Promise.resolve();
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

function normalizedLanguageCode(value) {
  return String(value || "").trim().replace(/_/g, "-").toLowerCase();
}

function isLanguageCodeLabel(label, languageCode) {
  const left = normalizedLanguageCode(label);
  const right = normalizedLanguageCode(languageCode);
  if (!left || !right || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/.test(left) ||
      !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/.test(right)) return false;
  return left === right || left.split("-")[0] === right.split("-")[0];
}

function displayLanguageName(languageCode) {
  let locale = "en";
  try {
    locale = chrome.i18n && typeof chrome.i18n.getUILanguage === "function"
      ? chrome.i18n.getUILanguage() || locale : locale;
  } catch (_e) { /* use the stable English fallback */ }
  try {
    if (typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function") {
      const display = new Intl.DisplayNames([locale], { type: "language" }).of(languageCode);
      if (display) return display;
    }
  } catch (_e) { /* use the language code when the runtime lacks DisplayNames */ }
  return languageCode;
}

function fallbackCaptionTrackLabel(languageCode, kind) {
  const language = displayLanguageName(languageCode);
  return kind === "asr"
    ? t("captionTrackAutoGenerated", `${language} (auto-generated)`, [language])
    : language;
}

function safeCaptionTrack(value) {
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || "").trim().slice(0, 160);
  const languageCode = String(value.languageCode || "").trim().slice(0, 24);
  const kind = value.kind === "asr" ? "asr" : "manual";
  const rawLabel = String(value.label || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const label = rawLabel && !isLanguageCodeLabel(rawLabel, languageCode)
    ? rawLabel : fallbackCaptionTrackLabel(languageCode, kind);
  if (!id || !/^[A-Za-z0-9._:-]+$/.test(id) ||
      !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(languageCode) || !label) return null;
  return { id, languageCode, label, kind };
}

function paintCaptionTrackOptions(response) {
  const select = $("captionTrackSelect");
  const translationSelect = $("translationTrackSelect");
  const hint = $("captionTrackHint");
  if (!select || !translationSelect || !hint) return;
  const tracks = Array.isArray(response && response.tracks)
    ? response.tracks.map(safeCaptionTrack).filter(Boolean).slice(0, 100) : [];
  const wanted = String(response && response.selectedTrackId || "auto");
  const preferredTrackId = String(response && response.preferredTrackId || "");
  const displayedTrackId = wanted === "auto" ? preferredTrackId : wanted;
  const originalOptions = [];
  const ai = document.createElement("option");
  ai.value = "ai";
  ai.textContent = t("translationTrackAi", "AI 翻译");
  const translationOptions = [ai];
  for (const track of tracks) {
    const label = track.label;
    const originalOption = document.createElement("option");
    originalOption.value = track.id;
    originalOption.textContent = label;
    originalOptions.push(originalOption);
    const translationOption = document.createElement("option");
    translationOption.value = track.id;
    translationOption.textContent = label;
    translationOptions.push(translationOption);
  }
  select.replaceChildren(...originalOptions);
  translationSelect.replaceChildren(...translationOptions);
  const wantedTranslation = String(response && response.selectedTranslationTrackId || "ai");
  select.value = originalOptions.some((option) => option.value === displayedTrackId)
    ? displayedTrackId : "";
  translationSelect.value = translationOptions.some((option) => option.value === wantedTranslation)
    ? wantedTranslation : "ai";
  // An empty catalog is expected while a video has no captions or while
  // YouTube is still exposing its track list. Keep the selector usable and
  // avoid turning that normal state into a persistent warning.
  hint.textContent = "";
  hint.hidden = true;
  hint.classList.remove("warn");
}

async function refreshCaptionTracks(retries) {
  const serial = ++captionTrackRefreshSerial;
  const retryCount = Number.isInteger(retries) ? retries : 2;
  const tab = await getActiveTab();
  const response = tab && tab.id != null
    ? await sendToTab(tab.id, { type: "getCaptionTracks" }) : null;
  if (serial !== captionTrackRefreshSerial) return;
  if (response && response.ok) {
    paintCaptionTrackOptions(response);
    if ((!response.tracks || !response.tracks.length) && retryCount > 0) {
      setTimeout(() => refreshCaptionTracks(retryCount - 1), 350);
    }
    return;
  }
  paintCaptionTrackOptions({ tracks: [], selectedTrackId: "auto" });
}

function activateWorkspace(workspace, scrollToTop) {
  const allowed = new Set(["translation", "display", "tools"]);
  activeWorkspace = allowed.has(workspace) ? workspace : "translation";
  document.body.dataset.workspace = activeWorkspace;
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
  showDebugMsg(t("debugLoading", "正在读取诊断日志…"), null);
  const resp = await sendRuntime({ type: "getDebugLogs" });
  if (!resp || !resp.ok || !resp.logs) {
    showDebugMsg(t("debugEmpty", "暂无诊断日志，请先启用并复现问题。"), "err");
    return;
  }
  const ok = await copyText(resp.logs);
  showDebugMsg(ok ? "" : t("debugCopyFailed", "复制失败，请重试。"), ok ? null : "err");
}

// ---- configuration backup -----------------------------------------------
function setConfigTransferBusy(busy) {
  $("exportConfig").disabled = busy;
  $("importConfig").disabled = busy;
}

async function onExportConfig() {
  setConfigTransferBusy(true);
  try {
    await flushSyncPatch();
    const backup = await readCurrentConfigBackup();
    const json = JSON.stringify(backup, null, 2) + "\n";
    const blobUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    const date = backup.exportedAt.slice(0, 10);
    link.href = blobUrl;
    link.download = `captionai-duo-settings-${date}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  } catch (_e) {
    alert(t("configExportFailed", "配置导出失败，请重试。"));
  } finally {
    setConfigTransferBusy(false);
  }
}

async function onImportConfigFile(event) {
  const input = event.currentTarget;
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  setConfigTransferBusy(true);
  try {
    if (file.size > CONFIG_BACKUP_MAX_BYTES) throw new Error("invalid-size");
    const backup = parseConfigBackupText(await file.text());
    if (!confirm(t(
      "configImportConfirm",
      "导入会替换当前全部设置、配置方案和 API 密钥。确定继续吗？"
    ))) return;
    const restored = await restoreConfigBackup(backup);
    state = { ...restored.settings };
    aiConfigProfileReady = false;
    await initializeAiConfigProfiles(restored.local);
    bindUI();
    await Promise.all([loadCurrentAiApiKey(), loadCurrentAiExtraBody()]);
    refreshEngineStatus();
  } catch (_e) {
    alert(t("configImportFailed", "无法导入：文件不是有效的 CaptionAI Duo 配置备份。"));
  } finally {
    setConfigTransferBusy(false);
  }
}

async function onClearDebug() {
  const resp = await sendRuntime({ type: "clearDebugLogs" });
  showDebugMsg(resp && resp.ok ? "" :
    t("debugClearFailed", "诊断日志清空失败，请重试。"), resp && resp.ok ? null : "err");
}

// ---- Token usage ---------------------------------------------------------
const tokenFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactTokenFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1
});

function normalizeTokenCount(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function paintTokenCount(id, value) {
  const count = normalizeTokenCount(value);
  const exact = tokenFormatter.format(count);
  const element = $(id);
  element.textContent = exact.length > 5 ? compactTokenFormatter.format(count) : exact;
  element.title = exact;
  element.setAttribute("aria-label", exact);
}

function paintAiTokenUsage(value) {
  const usage = value && typeof value === "object" ? value : {};
  paintTokenCount("tokenTotal", usage.totalTokens);
  paintTokenCount("tokenInput", usage.promptTokens);
  paintTokenCount("tokenOutput", usage.completionTokens);
  paintTokenCount("tokenCacheHit", usage.cacheHitTokens);
  paintTokenCount("tokenCacheMiss", usage.cacheMissTokens);
  paintTokenCount("tokenReasoning", usage.reasoningTokens);
  paintTokenCount("tokenRequests",
    (Number(usage.reportedRequests) || 0) + (Number(usage.unreportedRequests) || 0)
  );
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
  try {
    if (chrome.storage.session) {
      const got = await chrome.storage.session.get(["ytdsAiStatus", "ytdsDeepSeekStatus"]);
      const status = got && (got.ytdsAiStatus || got.ytdsDeepSeekStatus);
      if (status && Date.now() - Number(status.ts || 0) < 10 * 60 * 1000) {
        const messages = {
          timeout: t("aiStatusTimeout", "AI 请求超时，扩展已自动重试。"),
          limited: t("aiStatusLimited", "AI 请求过多，已暂时放慢。"),
          partial: t("aiStatusPartial", "部分字幕翻译失败，请查看译文中的错误码。"),
          key: t("aiStatusKey", "API Key 无效，请重新填写。"),
          error: t("aiStatusError", "AI 请求失败，请查看译文中的错误码。")
        };
        const summary = messages[status.kind] || messages.error;
        const code = status.errorCode ? YTDS_SHARED.aiErrorDescriptor(status).code : "";
        if (code === "AI_CANCELLED") return;
        el.textContent = code ? `${summary} [${code}]` : summary;
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
  $("debugEnabled").checked = !!state.debugEnabled;
  $("targetLang").value = state.targetLang;
  $("aiBaseUrl").value = state.aiBaseUrl;
  $("aiModel").value = state.aiModel;
  $("deepseekContextPast").value = String(state.deepseekContextPast);
  $("deepseekContextFuture").value = String(state.deepseekContextFuture);
  $("deepseekPrefetchBatches").value = String(state.deepseekPrefetchBatches);
  $("rowGap").value = state.rowGap;
  $("rowGapV").textContent = state.rowGap + "px";
  paintSegs();
  paintExportSeg();
  paintAiConfigProfileManager();
  bindLineControls();
  activateWorkspace(activeWorkspace, false);
}

// ---- wire events ---------------------------------------------------------
function wire() {
  wireAiConfigProfileManager();
  document.querySelectorAll(".workspace-tab").forEach((button) => {
    button.addEventListener("click", () => {
      activateWorkspace(button.dataset.workspace, true);
      if (button.dataset.workspace === "translation") refreshCaptionTracks(2);
    });
  });
  $("targetLang").addEventListener("change", async (e) => {
    const value = YTDS_SHARED.normalizeTargetLang(e.target.value);
    setKey("targetLang", value);
    await updateActiveAiConfigProfile({ targetLang: value });
  });

  $("aiBaseUrl").addEventListener("change", async (e) => {
    await flushAiExtraBodySave();
    const value = e.target.value.trim();
    const normalized = YTDS_SHARED.normalizeAiBaseUrl(value);
    setKey("aiBaseUrl", normalized || value);
    e.target.value = state.aiBaseUrl;
    const [apiKey, extraBody] = await Promise.all([
      loadCurrentAiApiKey(), loadCurrentAiExtraBody()
    ]);
    await updateActiveAiConfigProfile({
      baseUrl: state.aiBaseUrl, apiKey, extraBody
    });
    refreshEngineStatus();
  });
  $("aiModel").addEventListener("change", async (e) => {
    await flushAiExtraBodySave();
    setKey("aiModel", e.target.value.trim());
    const extraBody = await loadCurrentAiExtraBody();
    await updateActiveAiConfigProfile({ model: state.aiModel, extraBody });
    refreshEngineStatus();
  });
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
  $("aiExtraBody").addEventListener("input", (e) =>
    scheduleAiExtraBodySave(e.currentTarget.value));
  $("aiExtraBody").addEventListener("change", flushAiExtraBodySave);
  $("aiExtraBody").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      flushAiExtraBodySave();
    }
  });
  $("deepseekContextPast").addEventListener("change", async (e) => {
    const value = YTDS_SHARED.normalizeAiContextCount(e.target.value, state.deepseekContextPast);
    e.target.value = String(value);
    setKey("deepseekContextPast", value);
    await updateActiveAiConfigProfile({ contextPast: value });
  });
  $("deepseekContextFuture").addEventListener("change", async (e) => {
    const value = YTDS_SHARED.normalizeAiContextCount(e.target.value, state.deepseekContextFuture);
    e.target.value = String(value);
    setKey("deepseekContextFuture", value);
    await updateActiveAiConfigProfile({ contextFuture: value });
  });
  $("deepseekPrefetchBatches").addEventListener("change", async (e) => {
    const value = YTDS_SHARED.normalizeDeepseekPrefetchBatches(e.target.value);
    e.target.value = String(value);
    setKey("deepseekPrefetchBatches", value);
    await updateActiveAiConfigProfile({ prefetchBatches: value });
  });

  $("debugEnabled").addEventListener("change", (e) => {
    setKey("debugEnabled", e.target.checked);
    showDebugMsg(e.target.checked
      ? t("debugStarted", "诊断日志已启用，请刷新视频页面并复现问题。")
      : t("debugStopped", "诊断日志已停止，现有诊断日志仍可复制。"), "ok");
  });
  $("copyDebug").addEventListener("click", onCopyDebug);
  $("clearDebug").addEventListener("click", onClearDebug);
  $("resetTokenUsage").addEventListener("click", onResetTokenUsage);
  $("exportConfig").addEventListener("click", onExportConfig);
  $("importConfig").addEventListener("click", () => $("configFileInput").click());
  $("configFileInput").addEventListener("change", onImportConfigFile);

  // segmented: order
  document.querySelectorAll("#order button").forEach((b) =>
    b.addEventListener("click", () => { setKey("order", b.dataset.val); paintSegs(); }));

  $("captionTrackSelect").addEventListener("change", async (e) => {
    const tab = await getActiveTab();
    const response = tab && tab.id != null
      ? await sendToTab(tab.id, { type: "setCaptionTrack", trackId: e.target.value }) : null;
    if (!response || !response.ok) refreshCaptionTracks(1);
  });
  $("translationTrackSelect").addEventListener("change", async (e) => {
    const tab = await getActiveTab();
    const response = tab && tab.id != null
      ? await sendToTab(tab.id, { type: "setTranslationTrack", trackId: e.target.value }) : null;
    if (!response || !response.ok) refreshCaptionTracks(1);
  });

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
  $("reset").addEventListener("click", async () => {
    const revision = Math.max(0, Number(state.aiExtraBodyRevision) || 0) + 1;
    state = { ...DEFAULTS, aiExtraBodyRevision: revision };
    await Promise.all([
      chrome.storage.sync.set(state),
      chrome.storage.local.remove(["aiExtraBodyProfiles", AI_CONFIG_PROFILE_STORE_KEY])
    ]);
    aiConfigProfileReady = false;
    await initializeAiConfigProfiles();
    bindUI();
    await loadCurrentAiExtraBody();
    refreshEngineStatus();
  });
}

// ---- boot ----------------------------------------------------------------
applyI18n();                       // localize static markup before first paint
window.addEventListener("pagehide", () => {
  flushSyncPatch();
  flushAiExtraBodySave();
});
chrome.storage.sync.get(null, (got) => {
  got = got || {};
  state = { ...DEFAULTS, ...got };
  state.targetLang = YTDS_SHARED.normalizeTargetLang(state.targetLang);
  const normalizedBase = YTDS_SHARED.normalizeAiBaseUrl(state.aiBaseUrl);
  if (normalizedBase) state.aiBaseUrl = normalizedBase;
  state.aiModel = String(state.aiModel || "").trim();
  state.deepseekContextPast =
    YTDS_SHARED.normalizeAiContextCount(state.deepseekContextPast, DEFAULTS.deepseekContextPast);
  state.deepseekContextFuture =
    YTDS_SHARED.normalizeAiContextCount(state.deepseekContextFuture, DEFAULTS.deepseekContextFuture);
  state.deepseekPrefetchBatches =
    YTDS_SHARED.normalizeDeepseekPrefetchBatches(state.deepseekPrefetchBatches);
  chrome.storage.local.get({
    aiApiKeys: {}, aiExtraBodyProfiles: {},
    [AI_CONFIG_PROFILE_STORE_KEY]: null
  }, async (local) => {
    await initializeAiConfigProfiles(local);
    bindUI();
    await Promise.all([loadCurrentAiApiKey(), loadCurrentAiExtraBody()]);
    wire();
    refreshCaptionTracks(2);
    refreshEngineStatus();
    refreshAiTokenUsage();
  });
});
