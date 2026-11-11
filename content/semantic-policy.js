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

// A profile limited to a few requests per minute (its RPM setting) is
// request-bound rather than token-bound: it uses its configured window for
// every lane, one speculative lane, and no short visible handoff windows.
function aiRequestLimited() {
  const rpm = typeof settings === "object" && settings ? settings.aiRateLimitRpm : 0;
  const shared = typeof YTDS_SHARED === "object" && YTDS_SHARED ? YTDS_SHARED : null;
  return !!(shared && typeof shared.aiRequestLimited === "function" && shared.aiRequestLimited(rpm));
}

function aiConfiguredRequestItems(fallbackValue) {
  const custom = typeof settings === "object" && settings && settings.aiRequestItems;
  const fallback = Number.isFinite(Number(fallbackValue)) ? Number(fallbackValue) : 96;
  const shared = typeof YTDS_SHARED === "object" && YTDS_SHARED ? YTDS_SHARED : null;
  return shared && typeof shared.normalizeAiRequestItems === "function"
    ? shared.normalizeAiRequestItems(custom, fallback)
    : Math.max(32, Math.min(320, Math.round(Number(custom) || fallback)));
}

function aiInitialRequestItems() {
  return aiRequestLimited() ? aiConfiguredRequestItems() : AI_INITIAL_REQUEST_ITEMS;
}

// The steady lookahead window is the user's "request items" setting for every
// provider; visible (urgent) windows stay short unless requests are scarce.
function aiSteadyRequestItems() {
  return aiConfiguredRequestItems(AI_REQUEST_ITEMS);
}

function aiUrgentRequestItems() {
  return aiRequestLimited() ? aiConfiguredRequestItems() : AI_URGENT_REQUEST_ITEMS;
}

function aiNormalMaxRequestItems() {
  return aiRequestLimited()
    ? Math.max(aiConfiguredRequestItems(), AI_REQUEST_LIMITED_MAX_REQUEST_ITEMS)
    : Math.max(aiConfiguredRequestItems(), AI_NORMAL_MAX_REQUEST_ITEMS);
}

function aiMaxSpeculativeRequests() {
  if (aiRequestLimited()) return AI_REQUEST_LIMITED_MAX_SPECULATIVE_REQUESTS;
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
  if (aiRequestLimited()) return aiConfiguredRequestItems();
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
  if (aiRequestLimited()) return AI_REQUEST_LIMITED_MAX_REQUEST_ITEMS;
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  if (Number.isFinite(rate) && rate >= 2.5) {
    const configured = typeof AI_HIGH_SPEED_MAX_REQUEST_ITEMS === "number"
      ? AI_HIGH_SPEED_MAX_REQUEST_ITEMS : 160;
    return Math.min(AI_MAX_REQUEST_ITEMS, Math.max(aiConfiguredRequestItems(), configured));
  }
  return Number.isFinite(rate) && rate >= 1.75
    ? AI_MAX_REQUEST_ITEMS : aiNormalMaxRequestItems();
}
