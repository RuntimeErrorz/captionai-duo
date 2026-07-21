// Local AI connection profiles and endpoint-specific secrets/options.
"use strict";

const AI_CONFIG_PROFILE_STORE_KEY = "aiConfigProfileStoreV1";
let aiConfigProfileStore = { activeId: "", profiles: [] };
let aiConfigProfileReady = false;
let aiConfigProfilePersist = Promise.resolve();
let aiExtraBodySavePending = false;

function newAiConfigProfileId() {
  try { return crypto.randomUUID(); }
  catch (_e) { return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
}

function aiConfigProfileFallbackName(profile, index) {
  const baseUrl = YTDS_SHARED.normalizeAiBaseUrl(profile && profile.baseUrl);
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === "api.deepseek.com") return "DeepSeek";
    if (host === "generativelanguage.googleapis.com") return "Gemini";
  } catch (_e) { /* incomplete profile */ }
  return String(profile && profile.model || "").trim() ||
    `${t("aiProfileDefaultName", "配置")} ${index + 1}`;
}

function normalizeAiConfigProfile(value, index) {
  const raw = value && typeof value === "object" ? value : {};
  const parsedExtra = YTDS_SHARED.parseAiExtraBody(raw.extraBody || "");
  const profile = {
    id: String(raw.id || "").trim() || newAiConfigProfileId(),
    name: String(raw.name || "").trim().slice(0, 60),
    baseUrl: YTDS_SHARED.normalizeAiBaseUrl(raw.baseUrl) ||
      YTDS_SHARED.AI_DEFAULT_BASE_URL,
    model: String(raw.model || YTDS_SHARED.AI_DEFAULT_MODEL).trim().slice(0, 160),
    thinking: YTDS_SHARED.normalizeAiThinking(raw.thinking),
    apiKey: String(raw.apiKey || "").trim(),
    extraBody: parsedExtra.ok ? parsedExtra.canonical : "{}"
  };
  if (!profile.name) profile.name = aiConfigProfileFallbackName(profile, index);
  return profile;
}

function activeAiConfigProfile() {
  return aiConfigProfileStore.profiles.find(
    (profile) => profile.id === aiConfigProfileStore.activeId
  ) || aiConfigProfileStore.profiles[0] || null;
}

function persistAiConfigProfileStore() {
  const snapshot = {
    activeId: aiConfigProfileStore.activeId,
    profiles: aiConfigProfileStore.profiles.map((profile) => ({ ...profile }))
  };
  aiConfigProfilePersist = aiConfigProfilePersist.catch(() => {}).then(() =>
    chrome.storage.local.set({ [AI_CONFIG_PROFILE_STORE_KEY]: snapshot })
  );
  return aiConfigProfilePersist;
}

function updateActiveAiConfigProfile(patch) {
  const profile = activeAiConfigProfile();
  if (!profile || !patch || typeof patch !== "object") return Promise.resolve();
  Object.assign(profile, patch);
  const normalized = normalizeAiConfigProfile(profile, 0);
  Object.assign(profile, normalized, { id: profile.id });
  paintAiConfigProfileManager();
  return persistAiConfigProfileStore();
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
  await updateActiveAiConfigProfile({ apiKey: key });
  setKey("aiExtraBodyRevision", Math.max(0, Number(state.aiExtraBodyRevision) || 0) + 1);
  return true;
}

async function readAiExtraBodyProfiles() {
  const stored = await chrome.storage.local.get({ aiExtraBodyProfiles: {} });
  return stored.aiExtraBodyProfiles && typeof stored.aiExtraBodyProfiles === "object"
    ? { ...stored.aiExtraBodyProfiles } : {};
}

function aiExtraBodyErrorMessage(parsed) {
  if (parsed && parsed.error === "reservedKey") {
    return t("aiExtraBodyReserved", "额外参数不能覆盖字幕协议的核心字段。");
  }
  if (parsed && parsed.error === "forbiddenKey") {
    return t("aiExtraBodyUnsafe", "参数包含不安全的对象字段。");
  }
  if (parsed && ["tooLarge", "tooDeep", "tooManyKeys"].includes(parsed.error)) {
    return t("aiExtraBodyTooComplex", "参数过大或嵌套过深，请精简后重试。");
  }
  return t("aiExtraBodyInvalid", "请输入有效的 JSON 对象。");
}

function setAiExtraBodyMessage(text, kind) {
  const el = $("aiExtraBodyMsg");
  if (!el) return;
  el.textContent = text || t(
    "aiExtraBodyHint",
    "按当前 API 地址和模型保存在本机，用于传入供应商专有参数。"
  );
  el.classList.toggle("warn", kind === "warn");
  el.classList.toggle("ok", kind === "ok");
}

function prettyAiExtraBody(canonical) {
  try { return JSON.stringify(JSON.parse(canonical || "{}"), null, 2); }
  catch (_e) { return String(canonical || "{}"); }
}

async function loadCurrentAiExtraBody() {
  const scope = YTDS_SHARED.aiRequestProfileScope(state.aiBaseUrl, state.aiModel);
  const profiles = await readAiExtraBodyProfiles();
  if (scope !== YTDS_SHARED.aiRequestProfileScope(state.aiBaseUrl, state.aiModel)) return "{}";
  const raw = scope ? String(profiles[scope] || "") : "";
  const parsed = YTDS_SHARED.parseAiExtraBody(raw);
  const input = $("aiExtraBody");
  input.value = parsed.ok ? prettyAiExtraBody(parsed.canonical) : raw;
  input.setAttribute("aria-invalid", String(!parsed.ok));
  setAiExtraBodyMessage(
    parsed.ok ? "" : aiExtraBodyErrorMessage(parsed),
    parsed.ok ? "" : "warn"
  );
  return parsed.ok ? parsed.canonical : "{}";
}

async function saveCurrentAiExtraBody(value) {
  const input = $("aiExtraBody");
  const scope = YTDS_SHARED.aiRequestProfileScope(state.aiBaseUrl, state.aiModel);
  const parsed = YTDS_SHARED.parseAiExtraBody(value);
  if (!scope || !parsed.ok) {
    input.setAttribute("aria-invalid", "true");
    setAiExtraBodyMessage(
      scope ? aiExtraBodyErrorMessage(parsed)
        : t("aiBaseMissing", "请输入有效的 API Base URL 和模型名。"),
      "warn"
    );
    return false;
  }
  if (aiExtraBodySavePending) return false;
  aiExtraBodySavePending = true;
  const button = $("saveAiExtraBody");
  if (button) button.disabled = true;
  try {
    const profiles = await readAiExtraBodyProfiles();
    const previous = YTDS_SHARED.parseAiExtraBody(profiles[scope] || "");
    if (parsed.canonical === "{}") delete profiles[scope];
    else profiles[scope] = parsed.canonical;
    await chrome.storage.local.set({ aiExtraBodyProfiles: profiles });
    await updateActiveAiConfigProfile({ extraBody: parsed.canonical });
    input.value = prettyAiExtraBody(parsed.canonical);
    input.setAttribute("aria-invalid", "false");
    if (!previous.ok || previous.canonical !== parsed.canonical) {
      setKey("aiExtraBodyRevision", Math.max(0, Number(state.aiExtraBodyRevision) || 0) + 1);
      setAiExtraBodyMessage(
        t("aiExtraBodySaved", "额外请求参数已保存，当前视频将重新翻译。"), "ok"
      );
    } else setAiExtraBodyMessage("", "");
    return true;
  } catch (_e) {
    setAiExtraBodyMessage(t("aiExtraBodySaveFailed", "参数保存失败，请重试。"), "warn");
    return false;
  } finally {
    aiExtraBodySavePending = false;
    if (button) button.disabled = false;
  }
}

function paintAiConfigProfileManager() {
  const select = $("aiProfileSelect");
  if (!select || !aiConfigProfileReady) return;
  const selected = aiConfigProfileStore.activeId;
  select.replaceChildren(...aiConfigProfileStore.profiles.map((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    return option;
  }));
  select.value = selected;
  const profile = activeAiConfigProfile();
  $("aiProfileName").value = profile ? profile.name : "";
  $("deleteAiProfile").disabled = aiConfigProfileStore.profiles.length <= 1;
}

async function materializeAiConfigProfile(profile, forceRevision) {
  const [keys, extras] = await Promise.all([
    readAiCredentialState(), readAiExtraBodyProfiles()
  ]);
  const credentialScope = YTDS_SHARED.aiCredentialScope(profile.baseUrl);
  const requestScope = YTDS_SHARED.aiRequestProfileScope(profile.baseUrl, profile.model);
  const previousKey = String(keys[credentialScope] || "").trim();
  const previousExtra = YTDS_SHARED.parseAiExtraBody(extras[requestScope] || "");
  if (profile.apiKey) keys[credentialScope] = profile.apiKey;
  else delete keys[credentialScope];
  if (profile.extraBody && profile.extraBody !== "{}") extras[requestScope] = profile.extraBody;
  else delete extras[requestScope];
  await chrome.storage.local.set({ aiApiKeys: keys, aiExtraBodyProfiles: extras });

  const changed = state.aiBaseUrl !== profile.baseUrl || state.aiModel !== profile.model ||
    state.aiThinking !== profile.thinking;
  const materialChanged = previousKey !== profile.apiKey || !previousExtra.ok ||
    previousExtra.canonical !== profile.extraBody;
  state.aiBaseUrl = profile.baseUrl;
  state.aiModel = profile.model;
  state.aiThinking = profile.thinking;
  if (changed || materialChanged || forceRevision) {
    state.aiExtraBodyRevision = Math.max(0, Number(state.aiExtraBodyRevision) || 0) + 1;
    await chrome.storage.sync.set({
      aiBaseUrl: state.aiBaseUrl,
      aiModel: state.aiModel,
      aiThinking: state.aiThinking,
      aiExtraBodyRevision: state.aiExtraBodyRevision
    });
  }
}

async function initializeAiConfigProfiles(localValue) {
  const local = localValue && typeof localValue === "object" ? localValue :
    await chrome.storage.local.get({
      [AI_CONFIG_PROFILE_STORE_KEY]: null, aiApiKeys: {}, aiExtraBodyProfiles: {}
    });
  const rawStore = local[AI_CONFIG_PROFILE_STORE_KEY];
  const rawProfiles = rawStore && Array.isArray(rawStore.profiles) ? rawStore.profiles : [];
  const profiles = rawProfiles.map(normalizeAiConfigProfile);
  if (!profiles.length) {
    const keys = local.aiApiKeys && typeof local.aiApiKeys === "object" ? local.aiApiKeys : {};
    const extras = local.aiExtraBodyProfiles && typeof local.aiExtraBodyProfiles === "object"
      ? local.aiExtraBodyProfiles : {};
    const credentialScope = YTDS_SHARED.aiCredentialScope(state.aiBaseUrl);
    const requestScope = YTDS_SHARED.aiRequestProfileScope(state.aiBaseUrl, state.aiModel);
    profiles.push(normalizeAiConfigProfile({
      name: aiConfigProfileFallbackName(state, 0),
      baseUrl: state.aiBaseUrl,
      model: state.aiModel,
      thinking: state.aiThinking,
      apiKey: keys[credentialScope] || "",
      extraBody: extras[requestScope] || "{}"
    }, 0));
  }
  const wanted = String(rawStore && rawStore.activeId || "");
  aiConfigProfileStore = {
    activeId: profiles.some((profile) => profile.id === wanted) ? wanted : profiles[0].id,
    profiles
  };
  aiConfigProfileReady = true;
  await persistAiConfigProfileStore();
  await materializeAiConfigProfile(activeAiConfigProfile(), false);
  paintAiConfigProfileManager();
}

async function refreshAfterAiProfileSwitch() {
  bindUI();
  paintAiConfigProfileManager();
  await Promise.all([loadCurrentAiApiKey(), loadCurrentAiExtraBody()]);
  refreshEngineStatus();
}

async function switchAiConfigProfile(id) {
  const profile = aiConfigProfileStore.profiles.find((entry) => entry.id === id);
  if (!profile || profile.id === aiConfigProfileStore.activeId) return;
  aiConfigProfileStore.activeId = profile.id;
  await persistAiConfigProfileStore();
  await materializeAiConfigProfile(profile, true);
  await refreshAfterAiProfileSwitch();
}

async function createAiConfigProfile() {
  const source = activeAiConfigProfile();
  const baseName = t("aiProfileNewName", "新配置");
  let suffix = aiConfigProfileStore.profiles.length + 1;
  let name = `${baseName} ${suffix}`;
  const names = new Set(aiConfigProfileStore.profiles.map((profile) => profile.name));
  while (names.has(name)) name = `${baseName} ${++suffix}`;
  const profile = normalizeAiConfigProfile({ ...source, id: newAiConfigProfileId(), name }, 0);
  aiConfigProfileStore.profiles.push(profile);
  aiConfigProfileStore.activeId = profile.id;
  await persistAiConfigProfileStore();
  await materializeAiConfigProfile(profile, false);
  await refreshAfterAiProfileSwitch();
  $("aiProfileName").select();
}

async function deleteActiveAiConfigProfile() {
  if (aiConfigProfileStore.profiles.length <= 1) return;
  if (!confirm(t("aiProfileDeleteConfirm", "确定删除当前配置吗？"))) return;
  const index = aiConfigProfileStore.profiles.findIndex(
    (profile) => profile.id === aiConfigProfileStore.activeId
  );
  aiConfigProfileStore.profiles.splice(Math.max(0, index), 1);
  const next = aiConfigProfileStore.profiles[Math.min(index, aiConfigProfileStore.profiles.length - 1)];
  aiConfigProfileStore.activeId = next.id;
  await persistAiConfigProfileStore();
  await materializeAiConfigProfile(next, true);
  await refreshAfterAiProfileSwitch();
}

function wireAiConfigProfileManager() {
  $("aiProfileSelect").addEventListener("change", (event) =>
    switchAiConfigProfile(event.target.value));
  $("newAiProfile").addEventListener("click", createAiConfigProfile);
  $("deleteAiProfile").addEventListener("click", deleteActiveAiConfigProfile);
  $("aiProfileName").addEventListener("change", (event) => {
    const profile = activeAiConfigProfile();
    const name = String(event.target.value || "").trim().slice(0, 60) ||
      aiConfigProfileFallbackName(profile, 0);
    event.target.value = name;
    updateActiveAiConfigProfile({ name });
  });
}
