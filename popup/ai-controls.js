// AI connection controls, host-permission requests, and engine status.
"use strict";

const AI_STATUS_FRESH_MS = 10 * 60 * 1000;

// Numeric AI tuning fields: input id / sync key, normalizer, profile field.
const AI_TUNING_FIELDS = Object.freeze([
  ["aiContextPast", (value) => YTDS_SHARED.normalizeAiContextCount(value, state.aiContextPast), "contextPast"],
  ["aiContextFuture", (value) => YTDS_SHARED.normalizeAiContextCount(value, state.aiContextFuture), "contextFuture"],
  ["aiPrefetchBatches", (value) => YTDS_SHARED.normalizeAiPrefetchBatches(value), "prefetchBatches"],
  ["aiRequestItems", (value) => YTDS_SHARED.normalizeAiRequestItems(value, state.aiRequestItems), "requestItems"]
]);

function aiHostPermissionOrigins(baseUrl) {
  const pattern = YTDS_SHARED.aiHostPermissionPattern(baseUrl);
  return pattern ? [pattern] : [];
}

async function hasAiHostPermission(baseUrl) {
  const origins = aiHostPermissionOrigins(baseUrl);
  if (!origins.length) return false;
  if (!chrome.permissions || typeof chrome.permissions.contains !== "function") return true;
  try { return await chrome.permissions.contains({ origins }); }
  catch (_e) { return false; }
}

// Must run inside the click/change gesture. Chrome may close the popup while
// its prompt is open; the background then sees permissions.onAdded and bumps
// the request revision, so open video tabs still retry after a grant.
async function requestAiHostPermission(baseUrl) {
  const origins = aiHostPermissionOrigins(baseUrl);
  if (!origins.length || !chrome.permissions ||
      typeof chrome.permissions.request !== "function") return false;
  try { return await chrome.permissions.request({ origins }); }
  catch (_e) { return false; }
}

function showEngineWarning(el, text, canGrant) {
  el.textContent = text;
  el.classList.add("warn");
  el.hidden = false;
  const grant = $("aiGrantPermission");
  if (grant) grant.hidden = !canGrant;
}

function aiStatusSummary(kind) {
  const messages = {
    timeout: t("aiStatusTimeout", "AI 请求超时，扩展已自动重试。"),
    limited: t("aiStatusLimited", "AI 请求过多，已暂时放慢。"),
    partial: t("aiStatusPartial", "部分字幕翻译失败，请查看译文中的错误码。"),
    key: t("aiStatusKey", "API Key 无效，请重新填写。"),
    permission: t("aiPermissionMissing", "需要授权扩展访问这个 API 地址。"),
    error: t("aiStatusError", "AI 请求失败，请查看译文中的错误码。")
  };
  return messages[kind] || messages.error;
}

async function refreshEngineStatus() {
  const el = $("aiStatus");
  if (!el) return;
  el.hidden = true;
  el.classList.remove("warn", "ok");
  const grant = $("aiGrantPermission");
  if (grant) grant.hidden = true;

  const baseUrl = YTDS_SHARED.normalizeAiBaseUrl(state.aiBaseUrl);
  if (!baseUrl || !String(state.aiModel || "").trim()) {
    showEngineWarning(el, t("aiBaseMissing", "请输入有效的 API Base URL 和模型名。"), false);
    return;
  }
  if (!await hasAiHostPermission(baseUrl)) {
    showEngineWarning(el, t("aiPermissionMissing", "需要授权扩展访问这个 API 地址。"), true);
    return;
  }
  const apiKey = await loadCurrentAiApiKey();
  const endpointKind = YTDS_SHARED.aiEndpointKind(baseUrl);
  if (endpointKind === "deepseek" && !apiKey) {
    showEngineWarning(el, t("aiKeyMissing", "请先填写 API Key。"), false);
    return;
  }
  try {
    if (!chrome.storage.session) return;
    const got = await chrome.storage.session.get(["ytdsAiStatus"]);
    const status = got && got.ytdsAiStatus;
    if (!status || Date.now() - Number(status.ts || 0) >= AI_STATUS_FRESH_MS) return;
    const code = status.errorCode ? YTDS_SHARED.aiErrorDescriptor(status).code : "";
    if (code === "AI_CANCELLED") return;
    const summary = aiStatusSummary(status.kind);
    showEngineWarning(el, code ? `${summary} [${code}]` : summary, false);
  } catch (_e) { /* session status unavailable */ }
}

async function clearAiSessionStatus() {
  if (chrome.storage.session) {
    await chrome.storage.session.remove(["ytdsAiStatus"]).catch(() => {});
  }
}

function wireAiTuningField([id, normalize, profileField]) {
  $(id).addEventListener("change", async (e) => {
    const value = normalize(e.target.value);
    e.target.value = String(value);
    setKey(id, value);
    await updateActiveAiConfigProfile({ [profileField]: value });
  });
}

function wireAiConnectionControls() {
  $("targetLang").addEventListener("change", async (e) => {
    const value = YTDS_SHARED.normalizeTargetLang(e.target.value);
    setKey("targetLang", value);
    await updateActiveAiConfigProfile({ targetLang: value });
  });

  $("aiBaseUrl").addEventListener("change", async (e) => {
    const value = e.target.value.trim();
    const normalized = YTDS_SHARED.normalizeAiBaseUrl(value);
    // Start the prompt before the slower saves, while the change gesture is fresh.
    const permissionRequest = normalized && !await hasAiHostPermission(normalized)
      ? requestAiHostPermission(normalized) : Promise.resolve(true);
    await flushAiExtraBodySave();
    setKey("aiBaseUrl", normalized || value);
    e.target.value = state.aiBaseUrl;
    const [apiKey, extraBody] = await Promise.all([
      loadCurrentAiApiKey(), loadCurrentAiExtraBody()
    ]);
    await updateActiveAiConfigProfile({
      baseUrl: state.aiBaseUrl, apiKey, extraBody
    });
    await permissionRequest;
    refreshEngineStatus();
  });
  $("aiGrantPermission").addEventListener("click", async () => {
    if (await requestAiHostPermission(state.aiBaseUrl)) await clearAiSessionStatus();
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
      await clearAiSessionStatus();
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
    await clearAiSessionStatus();
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
  AI_TUNING_FIELDS.forEach(wireAiTuningField);
}
