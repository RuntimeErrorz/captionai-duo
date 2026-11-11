// Semantic request sizing and playback policy, from the profile's settings.
"use strict";

// Speculative lanes wanted at each playback speed; the profile's concurrency
// setting caps them, always leaving one slot for the visible subtitle.
// Speculative output is billed even when playback never reaches it, so the
// accelerated runway is useful but bounded.
const SPECULATIVE_REQUESTS = 2;
const ACCELERATED_SPECULATIVE_REQUESTS = 3;
const HIGH_SPEED_SPECULATIVE_REQUESTS = 4;

function aiMaxConcurrency() {
  const value = typeof settings === "object" && settings ? settings.aiMaxConcurrency : 4;
  const shared = typeof YTDS_SHARED === "object" && YTDS_SHARED ? YTDS_SHARED : null;
  return shared && typeof shared.normalizeAiMaxConcurrency === "function"
    ? shared.normalizeAiMaxConcurrency(value, 4)
    : Math.max(1, Math.min(16, Math.round(Number(value) || 4)));
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
  const wanted = Number.isFinite(rate) && rate >= 2.5 ? HIGH_SPEED_SPECULATIVE_REQUESTS
    : Number.isFinite(rate) && rate >= 1.75 ? ACCELERATED_SPECULATIVE_REQUESTS
      : SPECULATIVE_REQUESTS;
  return Math.max(1, Math.min(wanted, aiMaxConcurrency() - 1));
}

function aiAcceleratedUrgentRequestItems() {
  return aiRequestLimited() ? aiConfiguredRequestItems() : ACCELERATED_URGENT_REQUEST_ITEMS;
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
