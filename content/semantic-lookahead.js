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
  if (typeof aiLedgerBlocksRequests === "function" && aiLedgerBlocksRequests()) return 0;
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

// Local position (within a request) where the caller's uncommitted runway
// begins, or -1 when the request reaches its region end and every unit can
// commit. The background stops streaming once a unit reaches it.
function aiCommitGuardLocal(requestStart, requestEnd, limitEnd, effectiveGuardItems) {
  const guardStart = YTDS_SHARED.semanticCommitGuardStart(
    requestStart, requestEnd, limitEnd, effectiveGuardItems, AI_MIN_COMMIT_RUNWAY_ITEMS
  );
  return Number.isInteger(guardStart) && guardStart > requestStart && guardStart <= requestEnd
    ? guardStart - requestStart : -1;
}

// ---- span across hard-pause regions ---------------------------------------
// Videos are often cut into short regions by 4 s pauses, and a request that
// stops at every region end pays a cold first byte per region. A window that
// reaches its region end is carried into the following regions nobody has
// started yet. Units never cross the hard boundary, so each region still
// commits only its own units, and every boundary is a free commit point.
function aiPlanRegionSpan(regionIndex, requestStart, budgetValue) {
  const regions = captionSession.semanticCommitRegions;
  const budget = Math.max(1, Math.floor(Number(budgetValue) || 1));
  const spans = [];
  if (!regions) return spans;
  let requestEnd = regions[regionIndex] ? regions[regionIndex].end : requestStart - 1;
  for (let next = regionIndex + 1; next < regions.length; next++) {
    if (requestEnd - requestStart + 1 >= budget) break;
    const region = regions[next];
    const state = semanticCommitState(next);
    if (!region || !state || state.cursor !== region.start || state.limitEnd !== region.end ||
        captionSession.semanticExhaustedRegions.has(next) ||
        captionSession.transInflight.has(`dsb:${next}`) ||
        aiCoveredRequestRanges(next).length || aiSpanningRequestFor(next, region.start)) break;
    const end = Math.min(region.end, requestStart + budget - 1);
    spans.push({ regionIndex: next, start: region.start, end, regionEnd: region.end });
    requestEnd = end;
    if (end < region.end) break;
  }
  return spans;
}

// Early-stop position for a spanning request: only its last region can be
// cut short by the window, so only that region has an uncommitted runway.
function aiSpanCommitGuardLocal(requestStart, spans, effectiveGuardItems) {
  const last = spans[spans.length - 1];
  if (!last || last.end >= last.regionEnd) return -1;
  const guardStart = YTDS_SHARED.semanticCommitGuardStart(
    last.start, last.end, last.regionEnd, effectiveGuardItems, AI_MIN_COMMIT_RUNWAY_ITEMS
  );
  return Number.isInteger(guardStart) && guardStart > last.start && guardStart <= last.end
    ? guardStart - requestStart : -1;
}

// A live spanning request already writes this region from its start.
function aiSpanningRequestFor(regionIndex, cursor) {
  for (const request of captionSession.semanticRequestMeta.values()) {
    if (request && Array.isArray(request.spanRegions) && request.spanRegions.some((span) =>
      span.regionIndex === regionIndex && span.start === cursor)) return request;
  }
  return null;
}

// Hand each spanned region its own slice of an accepted response, as a
// finished speculative response waiting at that region's cursor.
function distributeAiSpanResponse(request, resp) {
  if (!request || !Array.isArray(request.spanRegions) || !request.spanRegions.length ||
      !resp || !resp.ok || !Array.isArray(resp.translations)) return;
  for (const span of request.spanRegions) {
    const state = semanticCommitState(span.regionIndex);
    if (!state || state.cursor !== span.start) continue;
    const translations = resp.translations.filter((item) => {
      const id = Number(item && item.id);
      return id >= span.start && id <= span.end;
    });
    if (!translations.length) continue;
    storeAiPrefetchCandidate(state, {
      ...request,
      prefetch: true, urgent: false, spanRegions: [],
      regionIndex: span.regionIndex,
      requestStart: span.start, requestEnd: span.end,
      commitFloor: span.start, limitEnd: span.regionEnd,
      progressTranslations: [], progressRecoveryTranslations: []
    }, { ...resp, translations });
    queueMicrotask(() => pumpAiCommitRegion(span.regionIndex, false));
  }
}
