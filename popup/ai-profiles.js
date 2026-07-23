// Local AI configuration profiles and endpoint-specific secrets/options.
"use strict";

const AI_CONFIG_PROFILE_STORE_KEY = "aiConfigProfileStoreV1";
let aiConfigProfileStore = { activeId: "", profiles: [] };
let aiConfigProfileReady = false;
let aiConfigProfilePersist = Promise.resolve();
let aiExtraBodySavePending = Promise.resolve(false);
let aiExtraBodySaveTimer = null;
let aiExtraBodyQueuedValue = null;
let aiProfileRenameActive = false;
let aiProfileMenuOpen = false;
let aiProfileDrag = null;
let aiProfileSuppressClick = false;

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
    targetLang: YTDS_SHARED.normalizeTargetLang(raw.targetLang || state.targetLang),
    baseUrl: YTDS_SHARED.normalizeAiBaseUrl(raw.baseUrl) ||
      YTDS_SHARED.AI_DEFAULT_BASE_URL,
    model: String(raw.model || YTDS_SHARED.AI_DEFAULT_MODEL).trim().slice(0, 160),
    apiKey: String(raw.apiKey || "").trim(),
    extraBody: parsedExtra.ok ? parsedExtra.canonical : "{}",
    contextPast: YTDS_SHARED.normalizeAiContextCount(
      raw.contextPast, state.deepseekContextPast
    ),
    contextFuture: YTDS_SHARED.normalizeAiContextCount(
      raw.contextFuture, state.deepseekContextFuture
    ),
    prefetchBatches: YTDS_SHARED.normalizeDeepseekPrefetchBatches(
      raw.prefetchBatches == null ? state.deepseekPrefetchBatches : raw.prefetchBatches
    )
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
  el.textContent = text || "";
  el.classList.toggle("warn", kind === "warn");
  el.classList.toggle("ok", kind === "ok");
  el.hidden = !text;
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

async function persistCurrentAiExtraBody(value) {
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
    }
    setAiExtraBodyMessage("", "");
    return true;
  } catch (_e) {
    setAiExtraBodyMessage(t("aiExtraBodySaveFailed", "参数保存失败，请重试。"), "warn");
    return false;
  }
}

function saveCurrentAiExtraBody(value) {
  aiExtraBodySavePending = aiExtraBodySavePending
    .catch(() => false)
    .then(() => persistCurrentAiExtraBody(value));
  return aiExtraBodySavePending;
}

function scheduleAiExtraBodySave(value, delay = 360) {
  aiExtraBodyQueuedValue = String(value == null ? "" : value);
  if (aiExtraBodySaveTimer) clearTimeout(aiExtraBodySaveTimer);
  aiExtraBodySaveTimer = setTimeout(flushAiExtraBodySave, delay);
}

function flushAiExtraBodySave() {
  if (aiExtraBodySaveTimer) clearTimeout(aiExtraBodySaveTimer);
  aiExtraBodySaveTimer = null;
  if (aiExtraBodyQueuedValue == null) return aiExtraBodySavePending;
  const value = aiExtraBodyQueuedValue;
  aiExtraBodyQueuedValue = null;
  return saveCurrentAiExtraBody(value);
}

function paintAiProfileRenameMode() {
  const select = $("aiProfileSelect");
  const editor = $("aiProfileNameEditor");
  const create = $("newAiProfile");
  const rename = $("renameAiProfile");
  const cancel = $("cancelRenameAiProfile");
  const remove = $("deleteAiProfile");
  if (!select || !editor) return;
  select.hidden = aiProfileRenameActive;
  editor.hidden = !aiProfileRenameActive;
  create.hidden = aiProfileRenameActive;
  cancel.hidden = !aiProfileRenameActive;
  remove.hidden = aiProfileRenameActive;
  rename.textContent = aiProfileRenameActive
    ? t("aiProfileSaveName", "保存")
    : t("aiProfileRename", "重命名");
}

function createAiProfileOption(profile) {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "ai-profile-option";
  option.dataset.profileId = profile.id;
  option.setAttribute("role", "option");
  option.setAttribute("aria-selected", String(profile.id === aiConfigProfileStore.activeId));
  option.tabIndex = -1;
  option.textContent = profile.name;
  return option;
}

function setAiProfileMenuOpen(open, focusSelected = false) {
  const trigger = $("aiProfileSelectButton");
  const menu = $("aiProfileMenu");
  aiProfileMenuOpen = Boolean(open);
  trigger.setAttribute("aria-expanded", String(aiProfileMenuOpen));
  menu.hidden = !aiProfileMenuOpen;
  if (aiProfileMenuOpen && focusSelected) {
    const selected = Array.from(menu.children).find(
      (option) => option.dataset.profileId === aiConfigProfileStore.activeId
    );
    if (selected) selected.focus();
  }
}

function paintAiConfigProfileManager() {
  const select = $("aiProfileSelect");
  if (!select || !aiConfigProfileReady) return;
  const active = activeAiConfigProfile();
  $("aiProfileSelectValue").textContent = active ? active.name : "";
  $("aiProfileMenu").replaceChildren(
    ...aiConfigProfileStore.profiles.map(createAiProfileOption)
  );
  $("deleteAiProfile").disabled = aiConfigProfileStore.profiles.length <= 1;
  paintAiProfileRenameMode();
}

function reorderAiConfigProfiles(profileId, targetId) {
  const from = aiConfigProfileStore.profiles.findIndex((profile) => profile.id === profileId);
  const to = aiConfigProfileStore.profiles.findIndex((profile) => profile.id === targetId);
  if (from < 0 || to < 0 || from === to) return false;
  const [profile] = aiConfigProfileStore.profiles.splice(from, 1);
  aiConfigProfileStore.profiles.splice(to, 0, profile);
  return true;
}

function cancelAiProfileDragTimer() {
  if (aiProfileDrag && aiProfileDrag.timer) clearTimeout(aiProfileDrag.timer);
  if (aiProfileDrag) aiProfileDrag.timer = null;
}

function finishAiProfileDrag(event) {
  if (!aiProfileDrag || event.pointerId !== aiProfileDrag.pointerId) return;
  cancelAiProfileDragTimer();
  const wasActive = aiProfileDrag.active;
  const item = aiProfileDrag.item;
  item.classList.remove("dragging");
  aiProfileDrag = null;
  if (wasActive) {
    persistAiConfigProfileStore();
    setTimeout(() => { aiProfileSuppressClick = false; }, 0);
  }
}

function wireAiProfileDrag(menu) {
  menu.addEventListener("pointerdown", (event) => {
    const item = event.target.closest(".ai-profile-option");
    if (!item || event.button !== 0) return;
    cancelAiProfileDragTimer();
    aiProfileDrag = {
      active: false,
      item,
      pointerId: event.pointerId,
      profileId: item.dataset.profileId,
      startX: event.clientX,
      startY: event.clientY,
      timer: null
    };
    aiProfileDrag.timer = setTimeout(() => {
      if (!aiProfileDrag || aiProfileDrag.item !== item) return;
      aiProfileDrag.active = true;
      aiProfileSuppressClick = true;
      item.classList.add("dragging");
      if (item.setPointerCapture) item.setPointerCapture(event.pointerId);
    }, 350);
  });
  menu.addEventListener("pointermove", (event) => {
    if (!aiProfileDrag || event.pointerId !== aiProfileDrag.pointerId) return;
    if (!aiProfileDrag.active) {
      if (Math.hypot(
        event.clientX - aiProfileDrag.startX,
        event.clientY - aiProfileDrag.startY
      ) > 7) {
        cancelAiProfileDragTimer();
      }
      return;
    }
    event.preventDefault();
    const hovered = document.elementFromPoint(event.clientX, event.clientY);
    const target = hovered && hovered.closest(".ai-profile-option");
    if (!target || target === aiProfileDrag.item || !menu.contains(target)) return;
    if (!reorderAiConfigProfiles(aiProfileDrag.profileId, target.dataset.profileId)) return;
    for (const profile of aiConfigProfileStore.profiles) {
      const option = Array.from(menu.children).find(
        (entry) => entry.dataset.profileId === profile.id
      );
      if (option) menu.appendChild(option);
    }
  });
  menu.addEventListener("pointerup", finishAiProfileDrag);
  menu.addEventListener("pointercancel", finishAiProfileDrag);
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

  const changed = state.targetLang !== profile.targetLang ||
    state.aiBaseUrl !== profile.baseUrl ||
    state.aiModel !== profile.model ||
    state.deepseekContextPast !== profile.contextPast ||
    state.deepseekContextFuture !== profile.contextFuture ||
    state.deepseekPrefetchBatches !== profile.prefetchBatches;
  const materialChanged = previousKey !== profile.apiKey || !previousExtra.ok ||
    previousExtra.canonical !== profile.extraBody;
  state.targetLang = profile.targetLang;
  state.aiBaseUrl = profile.baseUrl;
  state.aiModel = profile.model;
  state.deepseekContextPast = profile.contextPast;
  state.deepseekContextFuture = profile.contextFuture;
  state.deepseekPrefetchBatches = profile.prefetchBatches;
  if (changed || materialChanged || forceRevision) {
    state.aiExtraBodyRevision = Math.max(0, Number(state.aiExtraBodyRevision) || 0) + 1;
    await chrome.storage.sync.set({
      targetLang: state.targetLang,
      aiBaseUrl: state.aiBaseUrl,
      aiModel: state.aiModel,
      deepseekContextPast: state.deepseekContextPast,
      deepseekContextFuture: state.deepseekContextFuture,
      deepseekPrefetchBatches: state.deepseekPrefetchBatches,
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
      targetLang: state.targetLang,
      baseUrl: state.aiBaseUrl,
      model: state.aiModel,
      apiKey: keys[credentialScope] || "",
      extraBody: extras[requestScope] || "{}",
      contextPast: state.deepseekContextPast,
      contextFuture: state.deepseekContextFuture,
      prefetchBatches: state.deepseekPrefetchBatches
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
  await flushAiExtraBodySave();
  aiConfigProfileStore.activeId = profile.id;
  await persistAiConfigProfileStore();
  await materializeAiConfigProfile(profile, true);
  await refreshAfterAiProfileSwitch();
}

async function createAiConfigProfile() {
  await flushAiExtraBodySave();
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
  startAiConfigProfileRename();
}

function startAiConfigProfileRename() {
  const profile = activeAiConfigProfile();
  if (!profile) return;
  aiProfileRenameActive = true;
  const editor = $("aiProfileNameEditor");
  editor.value = profile.name;
  paintAiProfileRenameMode();
  editor.focus();
  editor.select();
}

async function finishAiConfigProfileRename(save) {
  const profile = activeAiConfigProfile();
  if (!aiProfileRenameActive || !profile) return;
  const editor = $("aiProfileNameEditor");
  const name = String(editor.value).trim().slice(0, 60) ||
    aiConfigProfileFallbackName(profile, 0);
  aiProfileRenameActive = false;
  if (save) await updateActiveAiConfigProfile({ name });
  else paintAiConfigProfileManager();
}

async function deleteActiveAiConfigProfile() {
  if (aiConfigProfileStore.profiles.length <= 1) return;
  if (!confirm(t("aiProfileDeleteConfirm", "确定删除当前配置吗？"))) return;
  await flushAiExtraBodySave();
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
  const select = $("aiProfileSelect");
  const trigger = $("aiProfileSelectButton");
  const menu = $("aiProfileMenu");
  trigger.addEventListener("click", () => setAiProfileMenuOpen(!aiProfileMenuOpen, true));
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setAiProfileMenuOpen(true, true);
  });
  menu.addEventListener("click", (event) => {
    const option = event.target.closest(".ai-profile-option");
    if (!option || aiProfileSuppressClick) return;
    setAiProfileMenuOpen(false);
    switchAiConfigProfile(option.dataset.profileId);
  });
  menu.addEventListener("keydown", (event) => {
    const options = Array.from(menu.querySelectorAll(".ai-profile-option"));
    const index = options.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      options[(index + step + options.length) % options.length].focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      document.activeElement.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setAiProfileMenuOpen(false);
      trigger.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (aiProfileMenuOpen && !select.contains(event.target)) setAiProfileMenuOpen(false);
  });
  wireAiProfileDrag(menu);
  $("newAiProfile").addEventListener("click", createAiConfigProfile);
  $("renameAiProfile").addEventListener("click", () => {
    if (aiProfileRenameActive) finishAiConfigProfileRename(true);
    else startAiConfigProfileRename();
  });
  $("cancelRenameAiProfile").addEventListener("click", () =>
    finishAiConfigProfileRename(false));
  $("aiProfileNameEditor").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finishAiConfigProfileRename(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishAiConfigProfileRename(false);
    }
  });
  $("deleteAiProfile").addEventListener("click", deleteActiveAiConfigProfile);
}
