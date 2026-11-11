// DeepSeek semantic timeline, commit and request pipeline.
"use strict";
function groupKey(gIdx) { return captionSession.cueVideoId + " g" + gIdx; }
function aiPauseAfter(list, index) {
  if (index >= list.length - 1) return Number.POSITIVE_INFINITY;
  return Math.max(0, Number(YTDS_SHARED.cuePauseMs(list[index], list[index + 1])) || 0);
}
function resetSemanticCommitTimeline() {
  const regions = captionSession.semanticCommitRegions;
  if (regions) regions.length = 0;
  else captionSession.semanticCommitRegions = [];
  const groupToRegion = captionSession.semanticGroupToCommitRegion;
  if (groupToRegion) groupToRegion.length = 0;
  else captionSession.semanticGroupToCommitRegion = [];
  const stateByRegion = captionSession.semanticCommitStateByRegion;
  if (stateByRegion) stateByRegion.clear();
  else captionSession.semanticCommitStateByRegion = new Map();
}
const resetAiCommitTimeline = resetSemanticCommitTimeline;

function buildSemanticCommitRegions() {
  resetSemanticCommitTimeline();
  if (!captionSession.sentGroups || !captionSession.sentGroups.length) return;
  const regions = captionSession.semanticCommitRegions || [];
  captionSession.semanticCommitRegions = regions;
  const groupToRegion = captionSession.semanticGroupToCommitRegion || [];
  captionSession.semanticGroupToCommitRegion = groupToRegion;
  let start = 0;
  for (let end = 0; end < captionSession.sentGroups.length; end++) {
    if (!captionSession.sentGroups[end].hardAfter && end < captionSession.sentGroups.length - 1) continue;
    const regionIndex = regions.length;
    regions.push({ start, end });
    for (let id = start; id <= end; id++) groupToRegion[id] = regionIndex;
    start = end + 1;
  }
}
const buildAiCommitRegions = buildSemanticCommitRegions;
// Preserve the player's cue timeline while exposing addressable lexical
// references. DeepSeek alone chooses semantic groups; local scopes only
// control preloading distance and pending-indicator stability.
function buildHybridCueGroups(list) {
  // A new cue timeline invalidates its lexical coordinates and immutable
  // commit cursors, even when YouTube reuses the same video id.
  resetCaptionSessionState("track-rebuild");
  const atoms = YTDS_SHARED.cueReferenceAtoms(list);
  captionSession.sentGroups = YTDS_SHARED.causalCueGroups(atoms);
  captionSession.cueToGroups = Array.from({ length: list.length }, () => []);
  for (let group = 0; group < captionSession.sentGroups.length; group++) {
    const sourceCueIndex = Number(atoms[group] && atoms[group].sourceCueIndex);
    if (!Number.isInteger(sourceCueIndex) || !captionSession.cueToGroups[sourceCueIndex]) continue;
    captionSession.sentGroups[group].startIdx = sourceCueIndex;
    captionSession.sentGroups[group].endIdx = sourceCueIndex;
    captionSession.cueToGroups[sourceCueIndex].push(group);
  }
  captionSession.cueToGroup = captionSession.cueToGroups.map((groups) => groups.length ? groups[0] : -1);
  captionSession.semanticBatchWindows = YTDS_SHARED.referenceBatchWindows(
    list, atoms, 0, 0, true,
    { coreItems: AI_CORE_ITEMS, requestItems: AI_CORE_ITEMS }
  );
  captionSession.semanticGroupToBatch = new Array(captionSession.sentGroups.length);
  for (let batchIndex = 0; batchIndex < captionSession.semanticBatchWindows.length; batchIndex++) {
    const batch = captionSession.semanticBatchWindows[batchIndex];
    for (let i = batch.start; i <= batch.end; i++) {
      captionSession.semanticGroupToBatch[i] = batchIndex;
      const atom = atoms[i] || {};
      const sourceCueIndex = captionSession.sentGroups[i].startIdx;
      const nextSourceCueIndex = i + 1 < captionSession.sentGroups.length ? captionSession.sentGroups[i + 1].startIdx : -1;
      const crossesCue = sourceCueIndex !== nextSourceCueIndex;
      const timingPauseMs = Math.max(0, Number(atom.pauseAfterMs) || 0);
      const rawCuePauseMs = crossesCue ? aiPauseAfter(list, sourceCueIndex) : 0;
      // A timed JSON3 atom has a more precise adjacent-onset signal than the
      // rolling caption window's display duration. A long raw-cue hole is the
      // exception: the final timed atom has no following word onset, but a
      // hard-sized hole is still an unambiguous semantic/display boundary.
      const hardRawCuePauseMs = Number.isFinite(rawCuePauseMs) &&
        rawCuePauseMs >= AI_HARD_PAUSE_MS ? rawCuePauseMs : 0;
      const pauseAfterMs = atom.timed === true
        ? Math.max(timingPauseMs, hardRawCuePauseMs)
        : crossesCue ? rawCuePauseMs : 0;
      const pauseKind = YTDS_SHARED.semanticPauseKind(
        pauseAfterMs, AI_SOFT_PAUSE_MS, AI_HARD_PAUSE_MS
      );
      captionSession.sentGroups[i].pauseAfterMs = Number.isFinite(pauseAfterMs)
        ? Math.round(pauseAfterMs) : AI_HARD_PAUSE_MS;
      captionSession.sentGroups[i].softAfter = pauseKind !== "none";
      captionSession.sentGroups[i].hardAfter = i >= captionSession.sentGroups.length - 1 ||
        pauseKind === "hard";
    }
  }
  buildAiCommitRegions();
}
function aiBatchEntry(gIdx, withTranslation) {
  const group = captionSession.sentGroups[gIdx];
  const entry = {
    id: String(gIdx),
    cueId: String(group.startIdx),
    text: group.text,
    startMs: Math.max(0, Math.round(group.start || 0)),
    endMs: Math.max(0, Math.round(group.end || group.start || 0)),
    pauseAfterMs: Math.max(0, Math.round(Number(group.pauseAfterMs) || 0)),
    softAfter: !!group.softAfter,
    hardAfter: !!group.hardAfter
  };
  if (withTranslation) {
    const translated = captionSession.transCache.get(groupKey(gIdx));
    if (translated) entry.translation = translated;
  }
  return entry;
}
function aiCueContextEntry(cueIdx, temporal) {
  const cue = captionSession.cueList && captionSession.cueList[cueIdx];
  if (!cue) return null;
  return {
    id: `c${cueIdx}`,
    text: cue.text,
    temporal: temporal === "future" ? "future" : "past"
  };
}
function cueTrackFingerprint(videoId, trackKind, sourceLang, trackId, cues) {
  let hash = 2166136261;
  const add = (value) => {
    const text = String(value == null ? "" : value);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 31;
    hash = Math.imul(hash, 16777619);
  };
  add(videoId);
  add(settings.targetLang);
  add(trackKind);
  add(sourceLang);
  add(trackId);
  add(cues.length);
  for (const cue of cues) {
    add(cue.start);
    add(cue.dur);
    add(cue.text);
    for (const part of Array.isArray(cue.parts) ? cue.parts : []) {
      add(part && part.offsetMs);
      add(part && part.durationMs);
      add(part && part.text);
    }
  }
  return `${cues.length}:${hash >>> 0}`;
}
function aiContextsForRange(requestStart, requestEnd) {
  const startCue = Math.max(0,
    Number(captionSession.sentGroups[requestStart] && captionSession.sentGroups[requestStart].startIdx) || 0);
  const endCue = Math.max(startCue,
    Number(captionSession.sentGroups[requestEnd] && captionSession.sentGroups[requestEnd].endIdx) || startCue);
  const contextBefore = [];
  for (let i = Math.max(0, startCue - AI_CONTEXT_GROUPS); i < startCue; i++) {
    const entry = aiCueContextEntry(i, "past");
    if (entry) contextBefore.push(entry);
  }
  const contextAfter = [];
  for (let i = endCue + 1;
       i <= Math.min(captionSession.cueList.length - 1, endCue + AI_CONTEXT_GROUPS); i++) {
    const entry = aiCueContextEntry(i, "future");
    if (entry) contextAfter.push(entry);
  }
  return { contextBefore, contextAfter };
}
function semanticCommitState(regionIndex) {
  const regions = captionSession.semanticCommitRegions;
  const region = regions ? regions[regionIndex] : null;
  if (!region) return null;
  const stateByRegion = captionSession.semanticCommitStateByRegion;
  let state = stateByRegion ? stateByRegion.get(regionIndex) : null;
  if (!state && stateByRegion) {
    state = {
      cursor: region.start,
      commitFloor: region.start,
      limitEnd: region.end,
      targetThrough: region.start - 1,
      urgentTarget: region.start - 1,
      lookaheadThrough: region.start - 1,
      windowItems: aiInitialRequestItems(),
      recoveryWindowItems: false, noProgressRange: "",
      prefetchQueue: [],
      prefetchQueued: new Set(),
      prefetchResponses: new Map()
    };
    stateByRegion.set(regionIndex, state);
  }
  return state;
}
const aiCommitState = semanticCommitState;

function aiPrefetchAtCursor(regionIndex, cursorValue) {
  const cursor = Math.floor(Number(cursorValue));
  if (!Number.isInteger(cursor)) return false;
  const state = aiCommitState(regionIndex);
  if (!state) return false;
  const candidates = Array.from(captionSession.semanticRequestMeta.values())
    .filter((request) => request && request.prefetch && request.regionIndex === regionIndex &&
      Number.isInteger(Math.floor(Number(request.requestStart))) &&
      Number.isInteger(Math.floor(Number(request.requestEnd))) &&
      Math.floor(Number(request.requestStart)) <= state.cursor &&
      Math.floor(Number(request.requestEnd)) >= state.cursor)
    .sort((a, b) => Number(a.requestStart) - Number(b.requestStart));
  for (const request of candidates) {
    let consumed = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const pending = (Array.isArray(request.progressTranslations)
        ? request.progressTranslations : []).filter((item) => {
          const id = Number(item && item.id);
          return Number.isInteger(id) && id >= state.cursor && id <= Number(request.requestEnd);
        });
      if (!pending.length) {
        if (consumed || Number(request.requestStart) >= state.cursor) break;
        if (Number(request.requestEnd) >= state.cursor) {
          if (!request.urgent) {
            request.urgent = true;
            request.promotedAt = Date.now();
            emitDebug("ai-prefetch-promoted", {
              requestId: request.requestId, regionIndex, cursor: state.cursor
            });
          }
          return true;
        }
        const owner = Array.from(captionSession.semanticRequestMeta.entries()).find(([, value]) => value === request);
        if (request.requestId) sendRuntimeMessage({ type: "cancelAiTranslationRequest", videoId: captionSession.cueVideoId, requestId: request.requestId });
        if (owner) { captionSession.semanticRequestMeta.delete(owner[0]); captionSession.transInflight.delete(owner[0]); }
        break;
      }
      if (typeof handleAiTranslationProgress !== "function") break;
      const previousCursor = state.cursor;
      handleAiTranslationProgress({
        type: "translationBatchProgress",
        requestId: request.requestId,
        videoId: request.reqVid,
        focusGeneration: request.focusGeneration,
        translations: pending
      });
      if (state.cursor <= previousCursor) break;
      consumed = true;
    }
    if (consumed) emitDebug("semantic-prefetch-progress-consumed", {
      requestId: request.requestId,
      regionIndex,
      cursor: state.cursor
    });
    const bufferedAfterConsume = (Array.isArray(request.progressTranslations)
      ? request.progressTranslations : []).filter((item) => {
        const id = Number(item && item.id);
        return Number.isInteger(id) && id >= state.cursor && id <= Number(request.requestEnd);
      });
    if (bufferedAfterConsume.length &&
        !bufferedAfterConsume.some((item) => Number(item && item.id) === state.cursor)) {
      let inflightKey = "";
      for (const [key, value] of captionSession.semanticRequestMeta.entries()) {
        if (value === request) { inflightKey = key; break; }
      }
      if (request.requestId) sendRuntimeMessage({
        type: "cancelAiTranslationRequest",
        videoId: captionSession.cueVideoId,
        requestId: request.requestId
      });
      if (inflightKey) {
        captionSession.semanticRequestMeta.delete(inflightKey);
        captionSession.transInflight.delete(inflightKey);
      }
      emitCaptionStateTransition("semantic-request", "cancelled", {
        requestId: request.requestId,
        reason: "buffered-prefix-gap",
        regionIndex,
        cursor: state.cursor,
        firstBufferedId: Number(bufferedAfterConsume[0].id)
      });
      continue;
    }
    // Keep one writer for this range until its remaining body settles.
    // body instead of launching an overlapping duplicate.
    if (state.cursor >= Number(request.requestStart) &&
        state.cursor <= Number(request.requestEnd)) {
      if (!request.urgent) {
        request.urgent = true;
        request.promotedAt = Date.now();
        emitDebug("ai-prefetch-promoted", {
          requestId: request.requestId, regionIndex, cursor: state.cursor
        });
      }
      return true;
    }
  }
  return false;
}

// Preserve safe aligned chunks when a future response settles or is cancelled after a
// valid prefix), otherwise the content side would throw away work that already
// crossed the stream boundary and start the same range again.
function aiResponseWithBufferedProgress(request, response, state) {
  const buffered = Array.isArray(request && request.progressTranslations)
    ? request.progressTranslations : [];
  const responseTranslations = response && response.ok &&
    Array.isArray(response.translations) ? response.translations : [];
  if (!buffered.length && !responseTranslations.length) return response;
  const cursor = Number(state && state.cursor);
  const requestEnd = Number(request && request.requestEnd);
  const byId = new Map();
  for (const item of responseTranslations) {
    const id = Number(item && item.id);
    if (Number.isInteger(id)) byId.set(id, item);
  }
  for (const item of buffered) {
    const id = Number(item && item.id);
    if (Number.isInteger(id) && (!Number.isInteger(cursor) || id >= cursor) &&
        (!Number.isInteger(requestEnd) || id <= requestEnd) && !byId.has(id)) {
      byId.set(id, item);
    }
  }
  if (!byId.size) return response;
  return {
    ...(response && typeof response === "object" ? response : {}), ...(response && response.error !== undefined ? { error: response.error } : {}), ...(response && response.errorCode !== undefined ? { errorCode: response.errorCode } : {}), ...(response && response.providerCode !== undefined ? { providerCode: response.providerCode } : {}), ...(response && response.streamError !== undefined ? { streamError: response.streamError } : {}),
    ok: true,
    translations: Array.from(byId.values()).sort((a, b) => Number(a.id) - Number(b.id)),
    partial: !!(response && response.partial) || buffered.length > 0
  };
}

function reseedSemanticCommitState(regionIndex, targetGroup) {
  const regions = captionSession.semanticCommitRegions;
  const region = regions ? regions[regionIndex] : null;
  const state = semanticCommitState(regionIndex);
  if (!region || !state) return state;
  const exhausted = captionSession.semanticExhaustedRegions;
  if (exhausted) exhausted.delete(regionIndex);
  const visibleErrors = captionSession.semanticVisibleErrors;
  if (visibleErrors) visibleErrors.delete(regionIndex);
  let effectiveTarget = targetGroup;
  while (effectiveTarget <= region.end && captionSession.transCache.has(groupKey(effectiveTarget))) {
    effectiveTarget++;
  }
  if (effectiveTarget > region.end) {
    state.cursor = region.end + 1;
    state.commitFloor = region.end + 1;
    state.limitEnd = region.end;
    state.targetThrough = region.end;
    state.urgentTarget = region.end;
    return state;
  }
  let requestStart = Math.max(region.start, effectiveTarget - aiSeekBacktrackItems());
  // A previously committed unit immediately to the left is already a proven
  // semantic boundary. Start after it instead of inventing another guard.
  for (let id = effectiveTarget - 1; id >= requestStart; id--) {
    if (captionSession.transCache.has(groupKey(id))) {
      requestStart = id + 1;
      break;
    }
  }
  let limitEnd = region.end;
  for (let id = effectiveTarget; id <= region.end; id++) {
    if (captionSession.transCache.has(groupKey(id))) {
      limitEnd = id - 1;
      break;
    }
  }
  // Replace only the stalled writer; preserve future ranges that still reach the new cursor.
  cancelAiRegionRequests(regionIndex, requestStart);
  const provenLeftBoundary = requestStart === region.start ||
    (requestStart > region.start && captionSession.transCache.has(groupKey(requestStart - 1)));
  state.cursor = requestStart;
  state.commitFloor = provenLeftBoundary
    ? requestStart
    : Math.min(effectiveTarget, requestStart + AI_SEEK_LEFT_GUARD_ITEMS);
  state.limitEnd = Math.max(effectiveTarget, limitEnd);
  state.targetThrough = requestStart - 1;
  state.urgentTarget = requestStart - 1;
  state.lookaheadThrough = requestStart - 1;
  state.windowItems = aiInitialRequestItems();
  state.recoveryWindowItems = false; state.noProgressRange = "";
  emitDebug("semantic-commit-reseeded", {
    regionIndex,
    targetGroup: effectiveTarget,
    requestStart,
    commitFloor: state.commitFloor,
    limitEnd: state.limitEnd,
    provenLeftBoundary
  });
  return state;
}
const reseedAiCommitState = reseedSemanticCommitState;
function canContinueAiInflight(regionIndex, state, targetGroup) {
  const request = captionSession.semanticRequestMeta.get(`dsb:${regionIndex}`);
  if (!request || !state || request.reqEpoch !== captionSession.cueEpoch ||
      request.focusGeneration !== captionSession.semanticFocusGeneration ||
      !isCaptionSessionCurrent(request.sessionToken)) return false;
  // Normal or accelerated playback may overtake the private guard just before
  // a response completes. Preserve that response when the new target is close
  // enough for its committed prefix plus one continuation request to reach.
  // A real random seek changes focus generation after seek settlement and is
  // still free to reseed immediately.
  if (aiRequestIsStaleForTarget(request, targetGroup)) return false;
  if (aiRequestIsPlaybackLagging(request, state, targetGroup)) return false;
  return targetGroup >= state.cursor &&
    targetGroup <= request.requestEnd + aiUrgentTargetTailItems();
}

function commitSemanticResponsePrefix(
  regionIndex, requestStart, requestEnd, commitFloor, limitEnd, translations, guardItems,
  minimumRunwayItems
) {
  const regions = captionSession.semanticCommitRegions;
  const region = regions ? regions[regionIndex] : null;
  const state = semanticCommitState(regionIndex);
  const runwayRequirement = minimumRunwayItems == null ? 0 : minimumRunwayItems;
  if (requestEnd < limitEnd && requestEnd - requestStart + 1 <= runwayRequirement) {
    emitDebug("semantic-commit-subrunway-request", {
      regionIndex, requestStart, requestEnd, limitEnd, minimumRunwayItems: runwayRequirement
    });
  }
  const plan = YTDS_SHARED.monotonicSemanticCommitPlan(
    translations, requestStart, requestEnd, limitEnd,
    guardItems, commitFloor,
    runwayRequirement
  );
  if (!plan.units.length) return requestStart;

  const byUnit = new Map();
  for (const item of plan.translations) {
    const unitId = String(item.unitId || `semantic-${item.id}-${item.id}`);
    const unit = byUnit.get(unitId) || { unitId, members: [], translation: "", alignedChunks: null };
    unit.members.push(Number(item.id));
    if (!unit.translation) unit.translation = YTDS_SHARED.normalizeTranslatedText(item.translation);
    if (!unit.alignedChunks && Array.isArray(item.alignedChunks)) {
      unit.alignedChunks = item.alignedChunks.map((chunk) => ({
        ids: Array.isArray(chunk && chunk.ids) ? chunk.ids.map(String) : [],
        translation: YTDS_SHARED.normalizeTranslatedText(chunk && chunk.translation), sentenceBoundaryAfter: chunk && chunk.sentenceBoundaryAfter === true
      })).filter((chunk) => chunk.ids.length && chunk.translation);
    }
    byUnit.set(unitId, unit);
  }
  const units = Array.from(byUnit.values()).sort((a, b) => a.members[0] - b.members[0]);
  let expected = plan.commitStart;
  for (const unit of units) {
    unit.members.sort((a, b) => a - b);
    if (!unit.translation || unit.members[0] !== expected) return requestStart;
    const parts = unit.members.map((id) => captionSession.sentGroups[id]).filter(Boolean);
    if (parts.length !== unit.members.length) return requestStart;
    unit.source = mergeCueTexts(parts);
    for (const id of unit.members) {
      const unitCache = captionSession.semanticUnitCache;
      if (captionSession.transCache.has(groupKey(id)) || (unitCache && unitCache.has(groupKey(id)))) {
        emitDebug("semantic-commit-invariant-violation", {
          regionIndex, requestStart, requestEnd, id, unitId: unit.unitId
        });
        return requestStart;
      }
    }
    expected = unit.members[unit.members.length - 1] + 1;
  }
  if (expected - 1 !== plan.commitThrough) return requestStart;

  const unitCache = captionSession.semanticUnitCache;
  const sourceCache = captionSession.semanticSourceCache;
  const chunkCache = captionSession.semanticAlignedChunksCache;
  for (const unit of units) {
    for (const id of unit.members) {
      const key = groupKey(id);
      captionSession.transCache.set(key, unit.translation);
      if (unitCache) unitCache.set(key, unit.unitId);
      if (sourceCache) sourceCache.set(key, unit.source);
      if (captionSession.semanticUnitCache && captionSession.semanticUnitCache !== unitCache) {
        captionSession.semanticUnitCache.set(key, unit.unitId);
      }
      if (captionSession.semanticSourceCache && captionSession.semanticSourceCache !== sourceCache) {
        captionSession.semanticSourceCache.set(key, unit.source);
      }
    }
    if (unit.alignedChunks && unit.alignedChunks.length) {
      if (chunkCache) chunkCache.set(unit.unitId, unit.alignedChunks);
      if (captionSession.semanticAlignedChunksCache && captionSession.semanticAlignedChunksCache !== chunkCache) {
        captionSession.semanticAlignedChunksCache.set(unit.unitId, unit.alignedChunks);
      }
    }
  }
  cacheAiDisplayNeighborhood(units.flatMap((unit) => unit.members), true);
  captionSession.semanticLayoutWidth = semanticDisplayWidth();
  emitDebug("semantic-prefix-committed", {
    regionIndex,
    requestStart,
    requestEnd,
    guardStart: plan.guardStart,
    commitThrough: plan.commitThrough,
    carryStart: plan.carryStart,
    units: units.map((unit) => ({ unitId: unit.unitId, members: unit.members }))
  });
  return plan.carryStart;
}
const commitAiResponsePrefix = commitSemanticResponsePrefix;
function handleAiTranslationProgress(msg) {
  const found = aiRequestById(msg && msg.requestId);
  if (!found) {
    emitCaptionStateTransition("semantic-progress", "discarded", {
      requestId: String(msg && msg.requestId || ""),
      reason: "request-owner-missing"
    });
    return false;
  }
  const request = found.request;
  if (String(msg.videoId || "") !== request.reqVid ||
      Number(msg.focusGeneration) !== request.focusGeneration ||
      request.reqEpoch !== captionSession.cueEpoch || request.reqVid !== captionSession.cueVideoId ||
      !isCaptionSessionCurrent(request.sessionToken)) {
    emitCaptionStateTransition("semantic-progress", "discarded", {
      requestId: String(msg && msg.requestId || ""),
      reason: "session-track-or-focus-invalidated"
    });
    return false;
  }
  const incoming = Array.isArray(msg.translations) ? msg.translations.filter(Boolean) : [];
  if (!incoming.length) return false;
  // Delivery through chrome.tabs.sendMessage is asynchronous. Keep a small
  // id-keyed buffer so a duplicated or slightly reordered progress message
  // can never create a hole or overwrite an already committed unit.
  const byId = new Map();
  for (const item of request.progressTranslations) {
    const id = Number(item && item.id);
    if (Number.isInteger(id)) byId.set(id, item);
  }
  for (const item of incoming) {
    const id = Number(item && item.id);
    if (Number.isInteger(id) && id >= request.requestStart && id <= request.requestEnd) {
      byId.set(id, item);
    }
  }
  request.progressTranslations = Array.from(byId.values())
    .sort((a, b) => Number(a.id) - Number(b.id));
  // Unlike the commit buffer, this request-scoped copy is never trimmed until
  // the request settles. It preserves the complete outer semantic unit when
  // a later progress message starts after the current cursor; aligned-chunk
  // recovery needs that anchor to prove the model-owned boundaries are whole.
  const recoveryById = new Map();
  for (const item of (Array.isArray(request.progressRecoveryTranslations)
    ? request.progressRecoveryTranslations : [])) {
    const id = Number(item && item.id);
    if (Number.isInteger(id)) recoveryById.set(id, item);
  }
  for (const item of incoming) {
    const id = Number(item && item.id);
    if (Number.isInteger(id) && id >= request.requestStart && id <= request.requestEnd) {
      recoveryById.set(id, item);
    }
  }
  request.progressRecoveryTranslations = Array.from(recoveryById.values())
    .sort((a, b) => Number(a.id) - Number(b.id));

  const state = aiCommitState(request.regionIndex);
  if (!state || state.cursor < request.requestStart || state.cursor > request.requestEnd) return false;
  const pending = request.progressTranslations.filter(
    (item) => Number(item && item.id) >= state.cursor
  );
  const previousCursor = state.cursor;
  let nextCursor = commitAiResponsePrefix(
    request.regionIndex, previousCursor, request.requestEnd, state.commitFloor,
    request.limitEnd, pending, request.effectiveGuardItems,
    AI_MIN_COMMIT_RUNWAY_ITEMS
  );
  if ((!Number.isInteger(nextCursor) || nextCursor <= previousCursor) && request.urgent) {
    const recoveredTranslations = YTDS_SHARED.semanticUnitsFromAlignedChunks(
      aiAlignedRecoveryInput(request.progressRecoveryTranslations, previousCursor)
    );
    const recoveredCursor = commitAiResponsePrefix(
      request.regionIndex, previousCursor, request.requestEnd, state.commitFloor,
      request.limitEnd, recoveredTranslations, request.effectiveGuardItems,
      AI_MIN_COMMIT_RUNWAY_ITEMS
    );
    if (Number.isInteger(recoveredCursor) && recoveredCursor > previousCursor) {
      nextCursor = recoveredCursor;
      emitDebug("semantic-aligned-chunk-progress-recovery", {
        regionIndex: request.regionIndex,
        requestStart: request.requestStart,
        requestEnd: request.requestEnd,
        previousCursor,
        nextCursor
      });
    }
  }
  if (!Number.isInteger(nextCursor) || nextCursor <= previousCursor) return false;
  if (captionSession.semanticVisibleErrors) captionSession.semanticVisibleErrors.delete(request.regionIndex);
  // Refresh lag grace only after the immutable commit cursor advanced. A
  // provisional/left-guard fragment must not make a stalled playback request
  // look healthy indefinitely.
  request.lastProgressAt = Date.now();
  request.progressCursor = nextCursor;
  state.cursor = nextCursor;
  state.commitFloor = nextCursor;
  reconcileAiPrefetchCandidates(state, nextCursor);
  state.windowItems = aiSteadyRequestItems();
  state.recoveryWindowItems = false; state.noProgressRange = "";
  captionSession.semanticExhaustedRegions.delete(request.regionIndex);
  request.progressTranslations = request.progressTranslations.filter(
    (item) => Number(item && item.id) >= nextCursor
  );
  captionSession.semanticRetryCounts.delete(aiBatchRetryKey(
    request.requestStart, request.requestEnd, request.reqVid, request.reqEpoch
  ));
  emitDebug("semantic-jsonl-progress-committed", {
    regionIndex: request.regionIndex,
    requestStart: request.requestStart,
    requestEnd: request.requestEnd,
    previousCursor,
    nextCursor
  });
  if (aiStreamHandoffReady(
    request, state, aiMaxRequestItems(), aiNormalMaxRequestItems()
  )) handoffAiStream(request.regionIndex, request, state);
  repaintActiveAiTranslation();
  return true;
}

function aiUrgentTargetTailItems() {
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  if (Number.isFinite(rate) && rate >= 2.5) {
    return Math.min(aiMaxRequestItems(), Math.max(
      AI_URGENT_TARGET_TAIL_ITEMS, AI_HIGH_SPEED_TARGET_TAIL_ITEMS
    ));
  }
  if (Number.isFinite(rate) && rate >= 1.75) {
    return Math.min(AI_MAX_REQUEST_ITEMS, Math.max(
      AI_URGENT_TARGET_TAIL_ITEMS, AI_FAST_TARGET_TAIL_ITEMS
    ));
  }
  return AI_URGENT_TARGET_TAIL_ITEMS;
}

function aiKeepAcceleratedUrgentLane(requestWasUrgent, state) {
  const video = typeof getVideo === "function" ? getVideo() : null;
  const rate = Number(video && video.playbackRate);
  return !!requestWasUrgent && Number.isFinite(rate) && rate >= 1.75 && !!state &&
    state.cursor <= state.targetThrough && state.cursor <= state.limitEnd;
}

function aiAcceleratedPrefetchItems(targetTailItems) {
  const tailItems = Math.max(0, Math.floor(Number(targetTailItems) || 0));
  if (tailItems <= AI_URGENT_TARGET_TAIL_ITEMS) return 0;
  return Math.min(
    aiMaxRequestItems(),
    tailItems + AI_COMMIT_GUARD_ITEMS + 64
  );
}
function pumpAiCommitRegion(regionIndex, urgent, requestOptions) {
  const regions = captionSession.semanticCommitRegions;
  const region = regions ? regions[regionIndex] : null;
  const state = semanticCommitState(regionIndex);
  if (!region || !state || !aiCommitPending(state)) return;
  const prefetched = takeAiPrefetchedResponse(state);
  if (prefetched) {
    handleAiBatchResult(prefetched.request, prefetched.response, null);
    return;
  }
  const requestStart = state.cursor;
  // A live future response beginning at the cursor is already an acceptable
  // writer. Waiting for it avoids an urgent duplicate and preserves the
  // provider work that was started ahead of playback.
  if (aiPrefetchAtCursor(regionIndex, requestStart)) return;
  const commitFloor = state.commitFloor;
  const limitEnd = state.limitEnd;
  const requestUrgent = !!urgent || state.urgentTarget >= requestStart;
  const targetTailItems = aiUrgentTargetTailItems();
  const maxRequestItems = aiMaxRequestItems();
  const video = typeof getVideo === "function" ? getVideo() : null;
  const playbackRate = Number(video && video.playbackRate);
  const acceleratedPlayback = Number.isFinite(playbackRate) && playbackRate >= 1.75;
  const acceleratedUrgentItems = aiAcceleratedUrgentRequestItems();
  const recoveryWindow = state.recoveryWindowItems;
  const inflightKey = `dsb:${regionIndex}`;
  const existingRequest = captionSession.semanticRequestMeta.get(inflightKey);
  if (captionSession.transInflight.has(inflightKey) &&
      (!requestUrgent || !existingRequest || existingRequest.urgent)) return;
  const urgentRequestTailItems = acceleratedPlayback && requestUrgent && !recoveryWindow
    ? 0 : targetTailItems;
  const acceleratedPrefetchItems = !requestUrgent
    ? aiAcceleratedPrefetchItems(targetTailItems) : 0;
  const acceleratedUrgentWindowItems = acceleratedPlayback && requestUrgent && !recoveryWindow
    ? Math.max(state.windowItems, acceleratedUrgentItems) : state.windowItems;
  const planningWindowItems = Math.max(acceleratedUrgentWindowItems, acceleratedPrefetchItems);
  const planningState = planningWindowItems > state.windowItems
    ? { ...state, windowItems: planningWindowItems } : state;
  const initialUrgentItems = acceleratedPlayback && requestUrgent && !recoveryWindow
    ? acceleratedUrgentItems : aiUrgentRequestItems();
  const guardItems = typeof SEMANTIC_COMMIT_GUARD_ITEMS !== "undefined"
    ? SEMANTIC_COMMIT_GUARD_ITEMS : AI_COMMIT_GUARD_ITEMS;
  const requestPlan = YTDS_SHARED.semanticCommitRequestPlan(
    planningState, requestStart, guardItems,
    maxRequestItems, requestUrgent, initialUrgentItems,
    urgentRequestTailItems
  );
  const targetAwareItems = requestPlan.itemCount;
  let requestEnd = Math.min(limitEnd, requestStart + targetAwareItems - 1);
  const futureStart = aiNextFuturePrefetchStart(regionIndex, state, requestStart);
  if (!recoveryWindow && futureStart > requestStart && futureStart <= requestEnd) {
    const bridgeItems = semanticBridgeRequestItems(
      requestStart, futureStart, maxRequestItems, limitEnd
    );
    if (bridgeItems > 0) {
      requestEnd = Math.min(limitEnd, requestStart + bridgeItems - 1);
      emitDebug("semantic-prefetch-bridge", {
        regionIndex, requestStart, futureStart, requestEnd, bridgeItems
      });
    }
  }
  // The trailing runway is never committed, so a shorter window can only buy
  // a no-progress round trip. Streaming shows the first unit just as early in
  // a wider window; only the region's own end may cut a request shorter.
  const minUsefulItems = Math.min(
    maxRequestItems, 2 * Math.max(guardItems, AI_MIN_COMMIT_RUNWAY_ITEMS)
  );
  if (requestEnd - requestStart + 1 < minUsefulItems) {
    requestEnd = Math.min(limitEnd, requestStart + minUsefulItems - 1);
  }
  const items = [];
  let currentChars = 0;
  for (let id = requestStart; id <= requestEnd; id++) {
    const entry = aiBatchEntry(id, false);
    const nextChars = String(entry.text || "").length;
    if (items.length && currentChars + nextChars > AI_MAX_CURRENT_CHARS) break;
    items.push(entry);
    currentChars += nextChars;
  }
  requestEnd = requestStart + items.length - 1;
  const effectiveGuardItems = YTDS_SHARED.semanticEffectiveGuardItems(
    items.length, AI_COMMIT_GUARD_ITEMS
  );
  const { contextBefore, contextAfter } = aiContextsForRange(requestStart, requestEnd);
  const requestId = beginAiRequest(
    inflightKey, "commit", requestStart, requestEnd, requestUrgent
  );
  if (!requestId) return;
  const reqVid = captionSession.cueVideoId;
  const reqEpoch = captionSession.cueEpoch;
  const requestSessionToken = captureCaptionSession();
  const liveRequest = captionSession.semanticRequestMeta.get(inflightKey);
  if (liveRequest && liveRequest.requestId === requestId) {
    Object.assign(liveRequest, {
      regionIndex,
      requestStart,
      requestEnd,
      commitFloor,
      limitEnd,
      effectiveGuardItems,
      reqVid,
      reqEpoch,
      sessionToken: requestSessionToken,
      focusGeneration: captionSession.semanticFocusGeneration,
      itemCount: items.length,
      targetAwareItems,
      maxRequestItems
    });
  }
  sendRuntimeMessage({
    type: "translateBatch",
    endpointKind: aiEndpointKind(),
    debug: !!settings.debugEnabled,
    requestId,
    videoId: captionSession.cueVideoId,
    videoTimeMs: Math.round(((getVideo() && getVideo().currentTime) || 0) * 1000),
    targetLang: settings.targetLang,
    sourceLang: captionSession.cueSourceLang,
    coreStart: commitFloor,
    coreEnd: Math.min(requestPlan.targetThrough, requestEnd),
    requestStart,
    requestEnd,
    bypassCache: !!(requestOptions && requestOptions.bypassCache),
    urgent: requestUrgent,
    focusGeneration: captionSession.semanticFocusGeneration,
    items,
    contextBefore,
    contextAfter
  }, (resp, runtimeError) => {
    const finishedRequest = finishAiRequest(inflightKey, requestId);
    if (!finishedRequest) return;
    if (!isCaptionSessionCurrent(requestSessionToken)) {
      emitCaptionStateTransition("semantic-response", "discarded", {
        requestId,
        reason: "session-invalidated"
      });
      return;
    }
    handleAiBatchResult(finishedRequest, resp, runtimeError);
  });
}

function aiRequestBatch(gIdx, _includePredecessor = true, urgent = false, requestOptions) {
  if (YTDS_SHARED.isSameLanguage(captionSession.cueSourceLang, settings.targetLang) || captionSession.semanticSeekSettling) return;
  if (!captionSession.sentGroups || gIdx < 0 || gIdx >= captionSession.sentGroups.length) return;
  const groupToRegion = captionSession.semanticGroupToCommitRegion;
  const regionIndex = groupToRegion ? groupToRegion[gIdx] : undefined;
  const regions = captionSession.semanticCommitRegions;
  const region = regions && regionIndex != null ? regions[regionIndex] : null;
  let state = semanticCommitState(regionIndex);
  if (!region || !state) return;
  if (urgent) {
    cancelAiRequestsBeforeRegion(regionIndex);
    cancelAiStaleSpeculativeRequests(regionIndex, gIdx);
  }
  const currentMissing = !captionSession.transCache.has(groupKey(gIdx));
  const targetTailItems = aiUrgentTargetTailItems();
  const urgentRequestItems = Math.max(
    aiUrgentRequestItems(),
    targetTailItems + AI_COMMIT_GUARD_ITEMS
  );
  const maxRequestItems = aiMaxRequestItems();
  const randomAccessDistance = (urgent
    ? Math.min(maxRequestItems, urgentRequestItems) : maxRequestItems) -
    AI_COMMIT_GUARD_ITEMS;
  const shouldReseed = YTDS_SHARED.shouldReseedSemanticCommitState(
    currentMissing, gIdx, state, randomAccessDistance, urgent, captionSession.activeGroupIdx >= 0
  );
  const liveRequest = captionSession.semanticRequestMeta.get(`dsb:${regionIndex}`);
  const stalePrefetch = urgent && aiRequestIsStaleForTarget(liveRequest, gIdx);
  const playbackLagging = urgent && aiRequestIsPlaybackLagging(liveRequest, state, gIdx);
  if ((shouldReseed || stalePrefetch || playbackLagging) &&
      !canContinueAiInflight(regionIndex, state, gIdx)) {
    state = reseedAiCommitState(regionIndex, gIdx);
    if (stalePrefetch) emitDebug("semantic-stale-prefetch-reseed", {
      regionIndex, targetGroup: gIdx, requestEnd: liveRequest.requestEnd,
      ageMs: Math.max(0, Date.now() - Number(liveRequest.startedAt))
    });
    if (playbackLagging) emitDebug("semantic-playback-lag-reseed", {
      regionIndex, targetGroup: gIdx, requestEnd: liveRequest.requestEnd,
      cursor: state.cursor
    });
  } else if (shouldReseed) {
    emitDebug("semantic-reseed-deferred", {
      regionIndex,
      targetGroup: gIdx,
      cursor: state.cursor,
      requestId: (captionSession.semanticRequestMeta.get(`dsb:${regionIndex}`) || {}).requestId || ""
    });
  }
  if (captionSession.semanticExhaustedRegions.has(regionIndex)) return;
  const batchIndex = captionSession.semanticGroupToBatch[gIdx];
  const batch = captionSession.semanticBatchWindows[batchIndex];
  const targetThrough = Math.min(state.limitEnd, batch ? batch.end : gIdx);
  state.targetThrough = Math.max(state.targetThrough, targetThrough);
  if (urgent) {
    state.urgentTarget = gIdx;
    if (Number.isInteger(batchIndex)) captionSession.semanticFocusedBatchIndex = batchIndex;
  }
  if (!urgent && gIdx > state.cursor) {
    queueAiSpeculativeRequest(regionIndex, gIdx);
    return;
  }
  if (!urgent && (captionSession.activeGroupIdx >= 0
      ? groupToRegion && groupToRegion[captionSession.activeGroupIdx] !== regionIndex
      : regionIndex !== 0)) {
    return;
  }
  pumpAiCommitRegion(regionIndex, urgent, requestOptions);
}

