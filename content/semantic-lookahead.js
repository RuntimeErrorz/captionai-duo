// Commit-lane lookahead: keep verified translations ahead of playback.
"use strict";

// One prefetch "batch" in the settings UI is a scheduling distance of about
// this many lexical coordinates.
const AI_LOOKAHEAD_ITEMS_PER_BATCH = 32;

function aiLookaheadItems() {
  const batches = typeof aiPrefetchBatchCount === "function" ? aiPrefetchBatchCount() : 0;
  return Math.max(0, Math.floor(Number(batches) || 0)) * AI_LOOKAHEAD_ITEMS_PER_BATCH;
}

// How far a region's commit lane should run: the visible target, or the
// playback lookahead when that reaches further.
function aiCommitHorizon(state) {
  if (!state) return -1;
  const lookahead = Number.isInteger(state.lookaheadThrough) ? state.lookaheadThrough : -1;
  return Math.max(Number(state.targetThrough), lookahead);
}

function aiCommitPending(state) {
  return !!state && state.cursor <= state.limitEnd && state.cursor <= aiCommitHorizon(state);
}

function aiActiveNonUrgentRequestCount() {
  let count = 0;
  for (const request of captionSession.semanticRequestMeta.values()) {
    if (request && !request.urgent) count++;
  }
  return count;
}

// Advance commit lanes sequentially from their cursors instead of launching
// speculative windows at fixed batch starts. A cursor is always a committed
// unit boundary (or a hard-pause region start), so lookahead never leaves a
// gap that playback later has to fill urgently, never overlaps a finished
// response, and never starts a model window mid-sentence. Regions after a
// hard pause are included: each one starts its own lane at its true start.
function advanceAiLookahead(groupIndex) {
  const groups = captionSession.sentGroups;
  const regions = captionSession.semanticCommitRegions;
  const groupToRegion = captionSession.semanticGroupToCommitRegion;
  const gIdx = Math.floor(Number(groupIndex));
  const distance = aiLookaheadItems();
  if (!groups || !regions || !groupToRegion || distance <= 0 ||
      !Number.isInteger(gIdx) || gIdx < 0 || gIdx >= groups.length) return 0;
  if (YTDS_SHARED.isSameLanguage(captionSession.cueSourceLang, settings.targetLang) ||
      captionSession.semanticSeekSettling) return 0;
  const lookaheadEnd = Math.min(groups.length - 1, gIdx + distance);
  const maxLanes = Math.max(1, aiMaxSpeculativeRequests());
  let active = aiActiveNonUrgentRequestCount();
  let started = 0;
  for (let regionIndex = groupToRegion[gIdx];
       Number.isInteger(regionIndex) && regionIndex < regions.length; regionIndex++) {
    const region = regions[regionIndex];
    if (!region || region.start > lookaheadEnd) break;
    if (captionSession.semanticExhaustedRegions.has(regionIndex)) continue;
    const state = semanticCommitState(regionIndex);
    if (!state) continue;
    const through = Math.min(state.limitEnd, lookaheadEnd);
    if (!Number.isInteger(state.lookaheadThrough) || state.lookaheadThrough < through) {
      state.lookaheadThrough = through;
    }
    if (!aiCommitPending(state) || captionSession.transInflight.has(`dsb:${regionIndex}`)) continue;
    if (active >= maxLanes) break;
    const before = captionSession.semanticRequestMeta.size;
    pumpAiCommitRegion(regionIndex, false);
    if (captionSession.semanticRequestMeta.size > before) {
      active++;
      started++;
    }
  }
  return started;
}
