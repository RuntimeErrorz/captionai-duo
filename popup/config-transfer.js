// Versioned, allow-listed backup and restore for all user configuration.
"use strict";

const CONFIG_BACKUP_FORMAT = "captionai-duo-settings";
const CONFIG_BACKUP_VERSION = 1;
const CONFIG_BACKUP_MAX_BYTES = 1024 * 1024;
const CONFIG_LOCAL_KEYS = Object.freeze([
  "aiApiKeys", "aiExtraBodyProfiles", AI_CONFIG_PROFILE_STORE_KEY
]);
const CONFIG_SYNC_META_KEYS = Object.freeze([
  "visualDefaultsVersion", "contextDefaultsVersion", "lineDefaultsVersion"
]);

function configPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function configBoundedString(value, maxLength) {
  return String(value == null ? "" : value).slice(0, maxLength);
}

function configFiniteNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeBackupSettings(value) {
  const raw = configPlainObject(value);
  const settings = {};
  for (const [key, fallback] of Object.entries(YTDS_SHARED.DEFAULTS)) {
    if (typeof fallback === "boolean") settings[key] = typeof raw[key] === "boolean" ? raw[key] : fallback;
    else if (typeof fallback === "number") settings[key] = configFiniteNumber(raw[key], fallback, -100000, 100000);
    else settings[key] = typeof raw[key] === "string"
      ? configBoundedString(raw[key], 2048) : fallback;
  }

  settings.targetLang = YTDS_SHARED.normalizeTargetLang(settings.targetLang);
  settings.aiBaseUrl = YTDS_SHARED.normalizeAiBaseUrl(settings.aiBaseUrl) ||
    YTDS_SHARED.AI_DEFAULT_BASE_URL;
  settings.aiModel = configBoundedString(settings.aiModel.trim(), 160) ||
    YTDS_SHARED.AI_DEFAULT_MODEL;
  settings.aiExtraBodyRevision = Math.max(0, Math.round(settings.aiExtraBodyRevision));
  settings.deepseekContextPast = YTDS_SHARED.normalizeAiContextCount(
    settings.deepseekContextPast, YTDS_SHARED.DEFAULTS.deepseekContextPast
  );
  settings.deepseekContextFuture = YTDS_SHARED.normalizeAiContextCount(
    settings.deepseekContextFuture, YTDS_SHARED.DEFAULTS.deepseekContextFuture
  );
  settings.deepseekPrefetchBatches =
    YTDS_SHARED.normalizeDeepseekPrefetchBatches(settings.deepseekPrefetchBatches);

  const enumValues = {
    order: new Set(["trans-top", "orig-top"]),
    position: new Set(["top", "middle", "bottom"]),
    posMode: new Set(["preset", "custom"]),
    origFont: new Set(["system", "roboto", "noto", "arial", "georgia", "times", "mono", "cjk"]),
    transFont: new Set(["system", "roboto", "noto", "arial", "georgia", "times", "mono", "cjk"])
  };
  for (const [key, allowed] of Object.entries(enumValues)) {
    if (!allowed.has(settings[key])) settings[key] = YTDS_SHARED.DEFAULTS[key];
  }
  for (const key of ["origColor", "origBg", "origStroke", "transColor", "transBg", "transStroke"]) {
    if (!/^#[0-9a-f]{6}$/i.test(settings[key])) settings[key] = YTDS_SHARED.DEFAULTS[key];
  }
  const ranges = {
    rowGap: [0, 30], posXpct: [0, 100], posYpct: [0, 100],
    origSize: [12, 48], transSize: [12, 48],
    origFullscreenSize: [12, 72], transFullscreenSize: [12, 72],
    origBgOpacity: [0, 1], transBgOpacity: [0, 1],
    origStrokeOpacity: [0, 1], transStrokeOpacity: [0, 1],
    origStrokeWidth: [0, 8], transStrokeWidth: [0, 8]
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    settings[key] = configFiniteNumber(settings[key], YTDS_SHARED.DEFAULTS[key], min, max);
  }
  return settings;
}

function normalizeBackupStringMap(value, valueLimit, canonicalJson) {
  const result = {};
  const entries = Object.entries(configPlainObject(value)).slice(0, 100);
  for (const [rawKey, rawValue] of entries) {
    const key = configBoundedString(rawKey, 2048).trim();
    if (!key || typeof rawValue !== "string") continue;
    if (canonicalJson) {
      const parsed = YTDS_SHARED.parseAiExtraBody(rawValue);
      if (parsed.ok && parsed.canonical !== "{}") result[key] = parsed.canonical;
    } else {
      const text = configBoundedString(rawValue, valueLimit).trim();
      if (text) result[key] = text;
    }
  }
  return result;
}

function normalizeBackupProfileStore(value, fallbackSettings = state) {
  const raw = configPlainObject(value);
  const profiles = [];
  const usedIds = new Set();
  for (const [index, entry] of (Array.isArray(raw.profiles) ? raw.profiles : []).slice(0, 100).entries()) {
    const source = configPlainObject(entry);
    const profile = normalizeAiConfigProfile({
      id: configBoundedString(source.id, 160),
      name: configBoundedString(source.name, 60),
      targetLang: configBoundedString(source.targetLang || fallbackSettings.targetLang, 32),
      baseUrl: configBoundedString(source.baseUrl, 2048),
      model: configBoundedString(source.model, 160),
      apiKey: configBoundedString(source.apiKey, 8192),
      extraBody: configBoundedString(source.extraBody, 4096),
      contextPast: source.contextPast == null
        ? fallbackSettings.deepseekContextPast : source.contextPast,
      contextFuture: source.contextFuture == null
        ? fallbackSettings.deepseekContextFuture : source.contextFuture,
      prefetchBatches: source.prefetchBatches == null
        ? fallbackSettings.deepseekPrefetchBatches : source.prefetchBatches
    }, index);
    if (usedIds.has(profile.id)) profile.id = newAiConfigProfileId();
    usedIds.add(profile.id);
    profiles.push(profile);
  }
  if (!profiles.length) return null;
  const wanted = configBoundedString(raw.activeId, 160);
  return {
    activeId: profiles.some((profile) => profile.id === wanted) ? wanted : profiles[0].id,
    profiles
  };
}

function normalizeConfigBackup(value) {
  const raw = configPlainObject(value);
  if (raw.format !== CONFIG_BACKUP_FORMAT || raw.version !== CONFIG_BACKUP_VERSION) {
    throw new Error("unsupported-backup");
  }
  const local = configPlainObject(raw.local);
  const settings = normalizeBackupSettings(raw.settings);
  const profileStore = normalizeBackupProfileStore(
    local[AI_CONFIG_PROFILE_STORE_KEY], settings
  );
  if (!profileStore) throw new Error("missing-profiles");
  const apiKeys = normalizeBackupStringMap(local.aiApiKeys, 8192, false);
  const extraBodies = normalizeBackupStringMap(local.aiExtraBodyProfiles, 4096, true);
  const activeProfile = profileStore.profiles.find(
    (profile) => profile.id === profileStore.activeId
  );
  settings.targetLang = activeProfile.targetLang;
  settings.aiBaseUrl = activeProfile.baseUrl;
  settings.aiModel = activeProfile.model;
  settings.deepseekContextPast = activeProfile.contextPast;
  settings.deepseekContextFuture = activeProfile.contextFuture;
  settings.deepseekPrefetchBatches = activeProfile.prefetchBatches;
  const credentialScope = YTDS_SHARED.aiCredentialScope(activeProfile.baseUrl);
  const requestScope = YTDS_SHARED.aiRequestProfileScope(
    activeProfile.baseUrl, activeProfile.model
  );
  if (activeProfile.apiKey) apiKeys[credentialScope] = activeProfile.apiKey;
  else delete apiKeys[credentialScope];
  if (activeProfile.extraBody !== "{}") extraBodies[requestScope] = activeProfile.extraBody;
  else delete extraBodies[requestScope];
  return {
    format: CONFIG_BACKUP_FORMAT,
    version: CONFIG_BACKUP_VERSION,
    exportedAt: configBoundedString(raw.exportedAt, 64),
    settings,
    local: {
      aiApiKeys: apiKeys,
      aiExtraBodyProfiles: extraBodies,
      [AI_CONFIG_PROFILE_STORE_KEY]: profileStore
    }
  };
}

function createConfigBackup(syncValue, localValue, nowValue) {
  const sync = configPlainObject(syncValue);
  const local = configPlainObject(localValue);
  const profileStore = normalizeBackupProfileStore(local[AI_CONFIG_PROFILE_STORE_KEY]) ||
    normalizeBackupProfileStore(aiConfigProfileStore);
  if (!profileStore) throw new Error("missing-profiles");
  const backup = {
    format: CONFIG_BACKUP_FORMAT,
    version: CONFIG_BACKUP_VERSION,
    exportedAt: new Date(nowValue == null ? Date.now() : nowValue).toISOString(),
    settings: normalizeBackupSettings(sync),
    local: {
      aiApiKeys: normalizeBackupStringMap(local.aiApiKeys, 8192, false),
      aiExtraBodyProfiles: normalizeBackupStringMap(local.aiExtraBodyProfiles, 4096, true),
      [AI_CONFIG_PROFILE_STORE_KEY]: profileStore
    }
  };
  return normalizeConfigBackup(backup);
}

function parseConfigBackupText(text) {
  const source = String(text || "");
  if (!source || new TextEncoder().encode(source).byteLength > CONFIG_BACKUP_MAX_BYTES) {
    throw new Error("invalid-size");
  }
  return normalizeConfigBackup(JSON.parse(source));
}

async function readCurrentConfigBackup() {
  await aiConfigProfilePersist.catch(() => {});
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get(CONFIG_LOCAL_KEYS)
  ]);
  return createConfigBackup(sync, local);
}

async function restoreConfigBackup(backupValue) {
  const backup = normalizeConfigBackup(backupValue);
  const current = await chrome.storage.sync.get({ aiExtraBodyRevision: 0 });
  backup.settings.aiExtraBodyRevision = Math.max(
    Number(current.aiExtraBodyRevision) || 0,
    backup.settings.aiExtraBodyRevision
  ) + 1;
  for (const key of CONFIG_SYNC_META_KEYS) backup.settings[key] = 2;

  await Promise.all([
    chrome.storage.sync.set(backup.settings),
    chrome.storage.local.set(backup.local),
    chrome.storage.local.remove(["aiApiKey", "deepseekApiKey"])
  ]);
  return backup;
}
