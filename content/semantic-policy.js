// Provider-aware semantic request sizing and playback policy.
"use strict";

const DEEPSEEK_MAX_SPECULATIVE_REQUESTS = 2;
// Speculative output is billed even when playback never reaches it. Keep the
// accelerated runway useful but bounded; the scheduler will refill it as the
// committed cursor advances instead of paying for a whole distant transcript.
const DEEPSEEK_ACCELERATED_MAX_SPECULATIVE_REQUESTS = 3;
const DEEPSEEK_HIGH_SPEED_MAX_SPECULATIVE_REQUESTS = 4;
const COMPATIBLE_ACCELERATED_MAX_SPECULATIVE_REQUESTS = 2;
const COMPATIBLE_HIGH_SPEED_MAX_SPECULATIVE_REQUESTS = 3;

function aiEndpointKind() {
  const baseUrl = typeof settings === "object" && settings ? settings.aiBaseUrl : "";
  const model = typeof settings === "object" && settings ? settings.aiModel : "";
  const shared = typeof YTDS_SHARED === "object" && YTDS_SHARED ? YTDS_SHARED : null;
  if (shared && typeof shared.aiProviderKind === "function") {
    return shared.aiProviderKind(baseUrl, model);
  }
  return shared && typeof shared.aiEndpointKind === "function"
    ? shared.aiEndpointKind(baseUrl) : "deepseek";
}

function isGeminiProvider() {
  return aiEndpointKind() === "gemini";
}

const aiIsGemini = isGeminiProvider;

function aiConfiguredRequestItems(fallbackValue) {
  const custom = typeof settings === "object" && settings && settings.aiRequestItems;
  const fallback = Number.isFinite(Number(fallbackValue))
    ? Number(fallbackValue)
    : (typeof GEMINI_REQUEST_ITEMS === "number" ? GEMINI_REQUEST_ITEMS : 96);
  const shared = typeof YTDS_SHARED === "object" && YTDS_SHARED ? YTDS_SHARED : null;
  return shared && typeof shared.normalizeAiRequestItems === "function"
    ? shared.normalizeAiRequestItems(custom, fallback)
    : Math.max(32, Math.min(320, Math.round(Number(custom) || fallback)));
}

function aiInitialRequestItems() {
  return isGeminiProvider() ? aiConfiguredRequestItems(96) : AI_INITIAL_REQUEST_ITEMS;
}

function aiSteadyRequestItems() {
  return isGeminiProvider() ? aiConfiguredRequestItems(96) : AI_REQUEST_ITEMS;
}

function aiUrgentRequestItems() {
  return isGeminiProvider() ? aiConfiguredRequestItems(96) : AI_URGENT_REQUEST_ITEMS;
}

function aiNormalMaxRequestItems() {
  return isGeminiProvider()
    ? Math.max(aiConfiguredRequestItems(96), GEMINI_MAX_REQUEST_ITEMS)
    : AI_NORMAL_MAX_REQUEST_ITEMS;
}

function aiMaxSpeculativeRequests() {
  if (isGeminiProvider()) return GEMINI_MAX_SPECULATIVE_REQUESTS;
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  const deepseek = aiEndpointKind() === "deepseek";
  if (Number.isFinite(rate) && rate >= 2.5) {
    return deepseek
      ? DEEPSEEK_HIGH_SPEED_MAX_SPECULATIVE_REQUESTS
      : COMPATIBLE_HIGH_SPEED_MAX_SPECULATIVE_REQUESTS;
  }
  if (Number.isFinite(rate) && rate >= 1.75) {
    return deepseek
      ? DEEPSEEK_ACCELERATED_MAX_SPECULATIVE_REQUESTS
      : COMPATIBLE_ACCELERATED_MAX_SPECULATIVE_REQUESTS;
  }
  return deepseek ? DEEPSEEK_MAX_SPECULATIVE_REQUESTS : 1;
}

function aiAcceleratedUrgentRequestItems() {
  if (isGeminiProvider()) return aiConfiguredRequestItems(96);
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  const deepseek = aiEndpointKind() === "deepseek";
  if (Number.isFinite(rate) && rate >= 2.5) {
    return deepseek
      ? DEEPSEEK_HIGH_SPEED_URGENT_REQUEST_ITEMS
      : COMPATIBLE_HIGH_SPEED_URGENT_REQUEST_ITEMS;
  }
  return deepseek
    ? DEEPSEEK_ACCELERATED_URGENT_REQUEST_ITEMS
    : COMPATIBLE_ACCELERATED_URGENT_REQUEST_ITEMS;
}

function aiMaxRequestItems() {
  if (isGeminiProvider()) return GEMINI_MAX_REQUEST_ITEMS;
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  if (Number.isFinite(rate) && rate >= 2.5) {
    const configured = typeof AI_HIGH_SPEED_MAX_REQUEST_ITEMS === "number"
      ? AI_HIGH_SPEED_MAX_REQUEST_ITEMS : 160;
    return Math.min(AI_MAX_REQUEST_ITEMS, Math.max(1, configured));
  }
  return Number.isFinite(rate) && rate >= 1.75
    ? AI_MAX_REQUEST_ITEMS : AI_NORMAL_MAX_REQUEST_ITEMS;
}
