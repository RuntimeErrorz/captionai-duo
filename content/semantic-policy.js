// Semantic request sizing and playback policy, from the profile's settings.
"use strict";


function aiMaxConcurrency() {
  const value = typeof settings === "object" && settings ? settings.aiMaxConcurrency : 4;
  const shared = typeof YTDS_SHARED === "object" && YTDS_SHARED ? YTDS_SHARED : null;
  return shared && typeof shared.normalizeAiMaxConcurrency === "function"
    ? shared.normalizeAiMaxConcurrency(value, 4)
    : Math.max(1, Math.min(16, Math.round(Number(value) || 4)));
}

// The profile's "request items" setting (DEFAULTS when absent).
function aiConfiguredRequestItems() {
  const custom = typeof settings === "object" && settings ? settings.aiRequestItems : undefined;
  return YTDS_SHARED.normalizeAiRequestItems(custom);
}

// One sizing policy for every profile, provider and RPM: every lane uses the
// configured window and may grow to AI_MAX_REQUEST_ITEMS. Simulated across
// RPM 0-60, fast/slow/flaky providers and 1-3x playback, this beat short
// cold-start and visible windows everywhere (fewer requests, less stall);
// the method is in docs/VERIFIED_DEVELOPMENT.md.
function aiInitialRequestItems() {
  return aiConfiguredRequestItems();
}

function aiSteadyRequestItems() {
  return aiConfiguredRequestItems();
}

function aiUrgentRequestItems() {
  return aiConfiguredRequestItems();
}

function aiMaxSpeculativeRequests() {
  // Speculative lanes follow playback speed, round(rate + 1); the profile's
  // concurrency caps them, always leaving one slot for the visible subtitle.
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  const wanted = Math.round((Number.isFinite(rate) && rate > 0 ? rate : 1) + 1);
  return Math.max(1, Math.min(wanted, aiMaxConcurrency() - 1));
}

function aiAcceleratedUrgentRequestItems() {
  return aiConfiguredRequestItems();
}

function aiMaxRequestItems() {
  return AI_MAX_REQUEST_ITEMS;
}
