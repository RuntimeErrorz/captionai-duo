// DeepSeek semantic timeline, commit and request pipeline.
"use strict";

function groupKey(gIdx) { return captionSession.cueVideoId + " g" + gIdx; }

function deepseekPauseAfter(list, index) {
  if (index >= list.length - 1) return Number.POSITIVE_INFINITY;
  return Math.max(0, Number(YTDS_SHARED.cuePauseMs(list[index], list[index + 1])) || 0);
}

function deepseekHardBoundaryAfter(list, index) {
  return index >= list.length - 1 || YTDS_SHARED.semanticPauseKind(
    deepseekPauseAfter(list, index), DEEPSEEK_SOFT_PAUSE_MS, DEEPSEEK_HARD_PAUSE_MS
  ) === "hard";
}

function resetDeepseekCommitTimeline() {
  captionSession.deepseekCommitRegions = [];
  captionSession.deepseekGroupToCommitRegion = [];
  captionSession.deepseekCommitStateByRegion.clear();
}

function buildDeepseekCommitRegions() {
  resetDeepseekCommitTimeline();
  if (!captionSession.sentGroups || !captionSession.sentGroups.length) return;
  let start = 0;
  for (let end = 0; end < captionSession.sentGroups.length; end++) {
    if (!captionSession.sentGroups[end].hardAfter && end < captionSession.sentGroups.length - 1) continue;
    const regionIndex = captionSession.deepseekCommitRegions.length;
    captionSession.deepseekCommitRegions.push({ start, end });
    for (let id = start; id <= end; id++) captionSession.deepseekGroupToCommitRegion[id] = regionIndex;
    start = end + 1;
  }
}

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
  captionSession.deepseekBatchWindows = YTDS_SHARED.referenceBatchWindows(
    list, atoms, 0, 0, true,
    { coreItems: DEEPSEEK_CORE_ITEMS, requestItems: DEEPSEEK_CORE_ITEMS }
  );
  captionSession.deepseekGroupToBatch = new Array(captionSession.sentGroups.length);
  for (let batchIndex = 0; batchIndex < captionSession.deepseekBatchWindows.length; batchIndex++) {
    const batch = captionSession.deepseekBatchWindows[batchIndex];
    for (let i = batch.start; i <= batch.end; i++) {
      captionSession.deepseekGroupToBatch[i] = batchIndex;
      const sourceCueIndex = captionSession.sentGroups[i].startIdx;
      const nextSourceCueIndex = i + 1 < captionSession.sentGroups.length ? captionSession.sentGroups[i + 1].startIdx : -1;
      const crossesCue = sourceCueIndex !== nextSourceCueIndex;
      const pauseAfterMs = crossesCue ? deepseekPauseAfter(list, sourceCueIndex) : 0;
      const pauseKind = YTDS_SHARED.semanticPauseKind(
        pauseAfterMs, DEEPSEEK_SOFT_PAUSE_MS, DEEPSEEK_HARD_PAUSE_MS
      );
      captionSession.sentGroups[i].pauseAfterMs = Number.isFinite(pauseAfterMs)
        ? Math.round(pauseAfterMs) : DEEPSEEK_HARD_PAUSE_MS;
      captionSession.sentGroups[i].softAfter = crossesCue && pauseKind !== "none";
      captionSession.sentGroups[i].hardAfter = i >= captionSession.sentGroups.length - 1 ||
        (crossesCue && deepseekHardBoundaryAfter(list, sourceCueIndex));
    }
  }
  buildDeepseekCommitRegions();
}

function deepseekBatchEntry(gIdx, withTranslation) {
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

function deepseekCueContextEntry(cueIdx, temporal) {
  const cue = captionSession.cueList && captionSession.cueList[cueIdx];
  if (!cue) return null;
  return {
    id: `c${cueIdx}`,
    text: cue.text,
    temporal: temporal === "future" ? "future" : "past"
  };
}

function cueTrackFingerprint(videoId, trackKind, sourceLang, cues) {
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
  add(cues.length);
  for (const cue of cues) {
    add(cue.start);
    add(cue.dur);
    add(cue.text);
  }
  return `${cues.length}:${hash >>> 0}`;
}

function deepseekContextsForRange(requestStart, requestEnd) {
  const startCue = Math.max(0,
    Number(captionSession.sentGroups[requestStart] && captionSession.sentGroups[requestStart].startIdx) || 0);
  const endCue = Math.max(startCue,
    Number(captionSession.sentGroups[requestEnd] && captionSession.sentGroups[requestEnd].endIdx) || startCue);
  const contextBefore = [];
  for (let i = Math.max(0, startCue - DEEPSEEK_CONTEXT_GROUPS); i < startCue; i++) {
    const entry = deepseekCueContextEntry(i, "past");
    if (entry) contextBefore.push(entry);
  }
  const contextAfter = [];
  for (let i = endCue + 1;
       i <= Math.min(captionSession.cueList.length - 1, endCue + DEEPSEEK_CONTEXT_GROUPS); i++) {
    const entry = deepseekCueContextEntry(i, "future");
    if (entry) contextAfter.push(entry);
  }
  return { contextBefore, contextAfter };
}

function deepseekCommitState(regionIndex) {
  const region = captionSession.deepseekCommitRegions[regionIndex];
  if (!region) return null;
  let state = captionSession.deepseekCommitStateByRegion.get(regionIndex);
  if (!state) {
    state = {
      cursor: region.start,
      commitFloor: region.start,
      limitEnd: region.end,
      targetThrough: region.start - 1,
      urgentTarget: region.start - 1,
      windowItems: DEEPSEEK_INITIAL_REQUEST_ITEMS
    };
    captionSession.deepseekCommitStateByRegion.set(regionIndex, state);
  }
  return state;
}

function reseedDeepseekCommitState(regionIndex, targetGroup) {
  const region = captionSession.deepseekCommitRegions[regionIndex];
  const state = deepseekCommitState(regionIndex);
  if (!region || !state) return state;
  captionSession.deepseekExhaustedRegions.delete(regionIndex);
  const inflightKey = `dsb:${regionIndex}`;
  const existing = captionSession.deepseekRequestMeta.get(inflightKey);
  if (existing) {
    sendRuntimeMessage({
      type: "cancelDeepSeekRequest",
      videoId: captionSession.cueVideoId,
      requestId: existing.requestId
    });
    captionSession.deepseekRequestMeta.delete(inflightKey);
    captionSession.transInflight.delete(inflightKey);
  }

  let requestStart = Math.max(region.start, targetGroup - DEEPSEEK_SEEK_BACKTRACK_ITEMS);
  // A previously committed unit immediately to the left is already a proven
  // semantic boundary. Start after it instead of inventing another guard.
  for (let id = targetGroup - 1; id >= requestStart; id--) {
    if (captionSession.transCache.has(groupKey(id))) {
      requestStart = id + 1;
      break;
    }
  }
  let limitEnd = region.end;
  for (let id = targetGroup; id <= region.end; id++) {
    if (captionSession.transCache.has(groupKey(id))) {
      limitEnd = id - 1;
      break;
    }
  }
  const provenLeftBoundary = requestStart === region.start ||
    (requestStart > region.start && captionSession.transCache.has(groupKey(requestStart - 1)));
  state.cursor = requestStart;
  state.commitFloor = provenLeftBoundary
    ? requestStart
    : Math.min(targetGroup, requestStart + DEEPSEEK_SEEK_LEFT_GUARD_ITEMS);
  state.limitEnd = Math.max(targetGroup, limitEnd);
  state.targetThrough = requestStart - 1;
  state.urgentTarget = requestStart - 1;
  state.windowItems = DEEPSEEK_INITIAL_REQUEST_ITEMS;
  emitDebug("semantic-commit-reseeded", {
    regionIndex,
    targetGroup,
    requestStart,
    commitFloor: state.commitFloor,
    limitEnd: state.limitEnd,
    provenLeftBoundary
  });
  return state;
}

function canContinueDeepseekInflight(regionIndex, state, targetGroup) {
  const request = captionSession.deepseekRequestMeta.get(`dsb:${regionIndex}`);
  if (!request || !state || request.reqEpoch !== captionSession.cueEpoch ||
      request.focusGeneration !== captionSession.deepseekFocusGeneration ||
      !isCaptionSessionCurrent(request.sessionToken)) return false;
  // Normal or accelerated playback may overtake the private guard just before
  // a response completes. Preserve that response when the new target is close
  // enough for its committed prefix plus one continuation request to reach.
  // A real random seek changes focus generation after seek settlement and is
  // still free to reseed immediately.
  return targetGroup >= state.cursor &&
    targetGroup <= request.requestEnd + DEEPSEEK_URGENT_TARGET_TAIL_ITEMS;
}

function commitDeepseekResponsePrefix(
  regionIndex, requestStart, requestEnd, commitFloor, limitEnd, translations, guardItems
) {
  const region = captionSession.deepseekCommitRegions[regionIndex];
  const state = deepseekCommitState(regionIndex);
  if (!region || !state || state.cursor !== requestStart) return null;
  const plan = YTDS_SHARED.monotonicSemanticCommitPlan(
    translations, requestStart, requestEnd, limitEnd,
    guardItems, commitFloor
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
        translation: YTDS_SHARED.normalizeTranslatedText(chunk && chunk.translation)
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
      if (captionSession.transCache.has(groupKey(id)) || captionSession.deepseekUnitCache.has(groupKey(id))) {
        emitDebug("semantic-commit-invariant-violation", {
          regionIndex, requestStart, requestEnd, id, unitId: unit.unitId
        });
        return requestStart;
      }
    }
    expected = unit.members[unit.members.length - 1] + 1;
  }
  if (expected - 1 !== plan.commitThrough) return requestStart;

  for (const unit of units) {
    for (const id of unit.members) {
      const key = groupKey(id);
      captionSession.transCache.set(key, unit.translation);
      captionSession.deepseekUnitCache.set(key, unit.unitId);
      captionSession.deepseekSourceCache.set(key, unit.source);
    }
    if (unit.alignedChunks && unit.alignedChunks.length) {
      captionSession.deepseekAlignedChunksCache.set(unit.unitId, unit.alignedChunks);
    }
  }
  cacheDeepseekDisplayNeighborhood(units.flatMap((unit) => unit.members), true);
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

function handleDeepseekTranslationProgress(msg) {
  if (String(msg && msg.requestId || "") === captionSession.fallbackRequestId &&
      isCaptionSessionCurrent(captionSession.fallbackSessionToken) &&
      String(msg && msg.videoId || "") === captionSession.currentVideoId &&
      Number(msg && msg.focusGeneration) === captionSession.deepseekFocusGeneration) {
    const translated = Array.isArray(msg.translations) && msg.translations[0] &&
      String(msg.translations[0].translation || "").trim();
    if (translated && captionSession.lastSource) {
      setTranslation(translated, captionSession.lastSource);
      return true;
    }
  }
  const found = deepseekRequestById(msg && msg.requestId);
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

  const state = deepseekCommitState(request.regionIndex);
  if (!state || state.cursor < request.requestStart || state.cursor > request.requestEnd) return false;
  const pending = request.progressTranslations.filter(
    (item) => Number(item && item.id) >= state.cursor
  );
  const previousCursor = state.cursor;
  const nextCursor = commitDeepseekResponsePrefix(
    request.regionIndex, previousCursor, request.requestEnd, state.commitFloor,
    request.limitEnd, pending, request.effectiveGuardItems
  );
  if (!Number.isInteger(nextCursor) || nextCursor <= previousCursor) return false;

  state.cursor = nextCursor;
  state.commitFloor = nextCursor;
  state.windowItems = DEEPSEEK_REQUEST_ITEMS;
  captionSession.deepseekExhaustedRegions.delete(request.regionIndex);
  request.progressTranslations = request.progressTranslations.filter(
    (item) => Number(item && item.id) >= nextCursor
  );
  captionSession.deepseekRetryCounts.delete(deepseekBatchRetryKey(
    request.requestStart, request.requestEnd, request.reqVid, request.reqEpoch
  ));
  emitDebug("semantic-jsonl-progress-committed", {
    regionIndex: request.regionIndex,
    requestStart: request.requestStart,
    requestEnd: request.requestEnd,
    previousCursor,
    nextCursor
  });
  repaintActiveDeepseekTranslation();
  return true;
}

function pumpDeepseekCommitRegion(regionIndex, urgent, requestOptions) {
  const region = captionSession.deepseekCommitRegions[regionIndex];
  const state = deepseekCommitState(regionIndex);
  if (!region || !state || state.cursor > state.limitEnd || state.cursor > state.targetThrough) return;
  const requestStart = state.cursor;
  const commitFloor = state.commitFloor;
  const limitEnd = state.limitEnd;
  const requestUrgent = !!urgent || state.urgentTarget >= requestStart;
  // Put the requested playback/prefetch target before the private guard when
  // the cap allows it. Urgent work deliberately ignores the farther
  // speculative target: visible text returns first, then preloading resumes.
  const requestPlan = YTDS_SHARED.semanticCommitRequestPlan(
    state, requestStart, DEEPSEEK_COMMIT_GUARD_ITEMS,
    DEEPSEEK_MAX_REQUEST_ITEMS, requestUrgent, DEEPSEEK_URGENT_REQUEST_ITEMS,
    DEEPSEEK_URGENT_TARGET_TAIL_ITEMS
  );
  const targetAwareItems = requestPlan.itemCount;
  let requestEnd = Math.min(limitEnd, requestStart + targetAwareItems - 1);
  // The range is deliberately absent: targetThrough can expand while this
  // request is in flight, but the region must still have only one writer.
  const inflightKey = `dsb:${regionIndex}`;
  const existingRequest = captionSession.deepseekRequestMeta.get(inflightKey);
  if (captionSession.transInflight.has(inflightKey) &&
      (!requestUrgent || !existingRequest || existingRequest.urgent)) return;
  const items = [];
  let currentChars = 0;
  for (let id = requestStart; id <= requestEnd; id++) {
    const entry = deepseekBatchEntry(id, false);
    const nextChars = String(entry.text || "").length;
    if (items.length && currentChars + nextChars > DEEPSEEK_MAX_CURRENT_CHARS) break;
    items.push(entry);
    currentChars += nextChars;
  }
  requestEnd = requestStart + items.length - 1;
  const effectiveGuardItems = Math.min(
    DEEPSEEK_COMMIT_GUARD_ITEMS,
    Math.max(0, Math.floor(items.length / 3))
  );
  const { contextBefore, contextAfter } = deepseekContextsForRange(requestStart, requestEnd);
  const requestId = beginDeepseekRequest(
    inflightKey, "commit", requestStart, requestEnd, requestUrgent
  );
  if (!requestId) return;
  const reqVid = captionSession.cueVideoId;
  const reqEpoch = captionSession.cueEpoch;
  const requestSessionToken = captureCaptionSession();
  const liveRequest = captionSession.deepseekRequestMeta.get(inflightKey);
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
      focusGeneration: captionSession.deepseekFocusGeneration
    });
  }
  sendRuntimeMessage({
    type: "translateBatch",
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
    focusGeneration: captionSession.deepseekFocusGeneration,
    items,
    contextBefore,
    contextAfter
  }, (resp, runtimeError) => {
    const finishedRequest = finishDeepseekRequest(inflightKey, requestId);
    if (!finishedRequest) return;
    if (!isCaptionSessionCurrent(requestSessionToken)) {
      emitCaptionStateTransition("semantic-response", "discarded", {
        requestId,
        reason: "session-invalidated"
      });
      return;
    }
    const effectiveUrgent = requestUrgent || !!finishedRequest.urgent;
    const progressedCursor = state.cursor;
    if (runtimeError) {
      if (progressedCursor > requestStart) {
        repaintActiveDeepseekTranslation();
        if (state.cursor <= state.targetThrough && state.cursor <= state.limitEnd) {
          queueMicrotask(() => pumpDeepseekCommitRegion(regionIndex, false));
        }
      } else {
        scheduleDeepSeekBatchRetry(
          requestStart, requestStart, requestEnd, reqVid, reqEpoch,
          runtimeError.message || "runtime unavailable", { urgent: effectiveUrgent }
        );
      }
      return;
    }
    if (reqEpoch !== captionSession.cueEpoch || reqVid !== captionSession.cueVideoId) {
      emitCaptionStateTransition("semantic-response", "discarded", {
        requestId,
        reason: "track-invalidated"
      });
      return;
    }
    if (!resp || !resp.ok || !Array.isArray(resp.translations)) {
      const error = resp && resp.error || "empty background response";
      emitDebug("batch-rejected", {
        regionIndex, requestStart, requestEnd, error,
        needsKey: !!(resp && resp.needsKey),
        timeout: !!(resp && resp.timeout),
        rateLimited: !!(resp && resp.rateLimited),
        retryAfterMs: Number(resp && resp.retryAfterMs) || 0,
        limitReason: String(resp && resp.limitReason || "")
      });
      emitCaptionStateTransition("semantic-response", "rejected", {
        requestId,
        reason: String(error || "rejected"),
        retryable: !!(!resp || resp.netfail || resp.timeout || resp.rateLimited)
      });
      if (progressedCursor > requestStart) {
        repaintActiveDeepseekTranslation();
        if (state.cursor <= state.targetThrough && state.cursor <= state.limitEnd) {
          queueMicrotask(() => pumpDeepseekCommitRegion(regionIndex, false));
        }
      } else if (!resp || resp.netfail || resp.timeout || resp.rateLimited ||
          error === "invalid translation batch" || error === "untrusted sender") {
        scheduleDeepSeekBatchRetry(requestStart, requestStart, requestEnd, reqVid, reqEpoch, error, {
          rateLimited: !!(resp && resp.rateLimited),
          retryAfterMs: Number(resp && resp.retryAfterMs) || 0,
          urgent: effectiveUrgent
        });
      }
      return;
    }

    emitDebug("deepseek-batch-response", {
      regionIndex,
      requestStart,
      requestEnd,
      itemCount: items.length,
      urgent: effectiveUrgent,
      modelDeferredIds: Array.isArray(resp.deferredIds) ? resp.deferredIds : [],
      httpDiagnostics: resp.httpDiagnostics || { attempts: [] }
    });
    emitCaptionStateTransition("semantic-response", "accepted", {
      requestId,
      translationCount: resp.translations.length,
      partial: !!resp.partial
    });
    const finalStart = state.cursor;
    const finalTranslations = resp.translations.filter(
      (item) => Number(item && item.id) >= finalStart
    );
    let nextCursor = commitDeepseekResponsePrefix(
      regionIndex, finalStart, requestEnd, state.commitFloor, limitEnd,
      finalTranslations, effectiveGuardItems
    );
    if (!Number.isInteger(nextCursor)) return;
    const canExpand = requestEnd < limitEnd && targetAwareItems < DEEPSEEK_MAX_REQUEST_ITEMS;
    if (nextCursor === finalStart && !canExpand) {
      const recoveredTranslations = YTDS_SHARED.semanticUnitsFromAlignedChunks(finalTranslations);
      const recoveredCursor = commitDeepseekResponsePrefix(
        regionIndex, finalStart, requestEnd, state.commitFloor, limitEnd,
        recoveredTranslations, effectiveGuardItems
      );
      if (Number.isInteger(recoveredCursor) && recoveredCursor > finalStart) {
        nextCursor = recoveredCursor;
        emitDebug("semantic-aligned-chunk-recovery", {
          regionIndex, requestStart, requestEnd,
          previousCursor: finalStart, nextCursor
        });
      }
    }
    if (nextCursor > finalStart) {
      state.cursor = nextCursor;
      state.commitFloor = nextCursor;
      state.windowItems = DEEPSEEK_REQUEST_ITEMS;
    }
    const madeProgress = state.cursor > requestStart;
    if (madeProgress) {
      // A malformed/cancelled tail is intentionally retried from the first
      // uncommitted id. Completed JSONL units are already immutable cache.
      captionSession.deepseekRetryCounts.delete(deepseekBatchRetryKey(
        requestStart, requestEnd, reqVid, reqEpoch
      ));
      captionSession.deepseekExhaustedRegions.delete(regionIndex);
    } else if (canExpand) {
      captionSession.deepseekRetryCounts.delete(deepseekBatchRetryKey(
        requestStart, requestEnd, reqVid, reqEpoch
      ));
      captionSession.deepseekExhaustedRegions.delete(regionIndex);
      state.windowItems = Math.min(DEEPSEEK_MAX_REQUEST_ITEMS, targetAwareItems + 32);
      emitDebug("semantic-commit-window-expanded", {
        regionIndex, cursor: state.cursor, windowItems: state.windowItems
      });
    } else {
      scheduleDeepSeekBatchRetry(
        requestStart, requestStart, requestEnd, reqVid, reqEpoch,
        "no immutable semantic prefix", { urgent: effectiveUrgent, bypassCache: true }
      );
      repaintActiveDeepseekTranslation();
      return;
    }
    repaintActiveDeepseekTranslation();
    if (state.cursor <= state.targetThrough && state.cursor <= state.limitEnd) {
      queueMicrotask(() => pumpDeepseekCommitRegion(regionIndex, false));
    }
  });
}

// Extend one hard-boundary-delimited stream's desired prefix. Transport
// batches only define how far to preload; they never own semantic output.
function deepseekRequestBatch(gIdx, _includePredecessor = true, urgent = false, requestOptions) {
  if (captionSession.deepseekSeekSettling) return;
  if (!captionSession.sentGroups || gIdx < 0 || gIdx >= captionSession.sentGroups.length) return;
  const regionIndex = captionSession.deepseekGroupToCommitRegion[gIdx];
  const region = captionSession.deepseekCommitRegions[regionIndex];
  let state = deepseekCommitState(regionIndex);
  if (!region || !state) return;
  const currentMissing = !captionSession.transCache.has(groupKey(gIdx));
  const randomAccessDistance = (urgent
    ? DEEPSEEK_URGENT_REQUEST_ITEMS : DEEPSEEK_MAX_REQUEST_ITEMS) -
    DEEPSEEK_COMMIT_GUARD_ITEMS;
  const shouldReseed = YTDS_SHARED.shouldReseedSemanticCommitState(
    currentMissing, gIdx, state, randomAccessDistance, urgent, captionSession.activeGroupIdx >= 0
  );
  if (shouldReseed && !canContinueDeepseekInflight(regionIndex, state, gIdx)) {
    state = reseedDeepseekCommitState(regionIndex, gIdx);
  } else if (shouldReseed) {
    emitDebug("semantic-reseed-deferred", {
      regionIndex,
      targetGroup: gIdx,
      cursor: state.cursor,
      requestId: (captionSession.deepseekRequestMeta.get(`dsb:${regionIndex}`) || {}).requestId || ""
    });
  }
  if (captionSession.deepseekExhaustedRegions.has(regionIndex)) return;
  const batchIndex = captionSession.deepseekGroupToBatch[gIdx];
  const batch = captionSession.deepseekBatchWindows[batchIndex];
  const targetThrough = Math.min(state.limitEnd, batch ? batch.end : gIdx);
  state.targetThrough = Math.max(state.targetThrough, targetThrough);
  if (urgent) {
    state.urgentTarget = gIdx;
    if (Number.isInteger(batchIndex)) captionSession.deepseekFocusedBatchIndex = batchIndex;
  }
  pumpDeepseekCommitRegion(regionIndex, urgent, requestOptions);
}

function clearPendingTimer() {
  if (captionSession.pendingTimer) { clearTimeout(captionSession.pendingTimer); captionSession.pendingTimer = null; }
  captionSession.pendingIndicatorKey = "";
}

function pendingTranslationScopeKey(gIdx) {
  return YTDS_SHARED.pendingTranslationScopeKey(gIdx, captionSession.deepseekGroupToBatch);
}

// Lexical token groups can advance several times inside 400 ms. The old
// timer captured gIdx and restarted at every token, so a slow DeepSeek batch
// could leave the previous translation visible indefinitely without ever
// reaching the loading indicator. Scope the timer to the semantic API batch
// and inspect the current token only when it fires.
function armPendingTranslationIndicator(gIdx, immediate) {
  const scopeKey = pendingTranslationScopeKey(gIdx);
  if (!scopeKey) return;
  if (captionSession.pendingIndicatorKey !== scopeKey) {
    clearPendingTimer();
    captionSession.pendingIndicatorKey = scopeKey;
  } else if (captionSession.pendingTimer && immediate) {
    clearTimeout(captionSession.pendingTimer);
    captionSession.pendingTimer = null;
  } else if (!immediate) {
    return;
  }
  const pVid = captionSession.cueVideoId;
  const pEpoch = captionSession.cueEpoch;
  const pendingSessionToken = captureCaptionSession();
  const showPending = () => {
    captionSession.pendingTimer = null;
    if (!isCaptionSessionCurrent(pendingSessionToken) ||
        captionSession.pendingIndicatorKey !== scopeKey || pEpoch !== captionSession.cueEpoch || pVid !== captionSession.cueVideoId) {
      if (captionSession.pendingIndicatorKey === scopeKey) captionSession.pendingIndicatorKey = "";
      return;
    }
    if (captionSession.activeGroupIdx < 0 || captionSession.activeCueIdx < 0 || !captionSession.cueList ||
        pendingTranslationScopeKey(captionSession.activeGroupIdx) !== scopeKey) {
      captionSession.pendingIndicatorKey = "";
      return;
    }
    if (captionSession.transCache.has(groupKey(captionSession.activeGroupIdx))) {
      captionSession.pendingIndicatorKey = "";
      return;
    }
    const source = sourceForDisplayedCue(captionSession.activeCueIdx, captionSession.cueList[captionSession.activeCueIdx]);
    setTranslation("…", source);
    // Keep the scope key after firing. Token changes inside this unresolved
    // batch must neither restart the timer nor disturb the indicator.
  };
  if (immediate) showPending();
  else captionSession.pendingTimer = setTimeout(showPending, PENDING_ELLIPSIS_MS);
}

function onCues(data) {
  if (!captionSession.currentVideoId || data.videoId !== captionSession.currentVideoId) return;
  if (!Number.isInteger(data.nonce) || data.nonce !== captionSession.configNonce) return;
  captionSession.nocuesFallback = false;
  stopCueRecovery();
  stopFallback();                 // cue mode wins; stop scraping

  // Sort the original json3 cue timeline before assigning lexical coordinates.
  const nextCueList = sanitizeCueList(data.cues);
  if (!nextCueList) { onNoCues(data); return; }
  nextCueList.sort((a, b) => a.start - b.start);
  computeCueEnds(nextCueList);

  const nextVideoId = data.videoId || captionSession.currentVideoId;
  const nextTrackKind = data.trackKind === "asr" ? "asr"
                      : data.trackKind ? "manual" : "";
  const nextSourceLang = typeof data.sourceLang === "string" &&
    /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(data.sourceLang)
    ? data.sourceLang.slice(0, 24) : "";
  const nextSignature = cueTrackFingerprint(
    nextVideoId, nextTrackKind, nextSourceLang, nextCueList
  );
  if (captionSession.cueTimer && captionSession.cueVideoId === nextVideoId && captionSession.cueTrackSignature === nextSignature) {
    captionSession.duplicateCueEvents++;
    if (captionSession.duplicateCueEvents === 1 || captionSession.duplicateCueEvents % 25 === 0) {
      emitDebug("cues-duplicate-ignored", {
        cueCount: nextCueList.length,
        duplicateCount: captionSession.duplicateCueEvents
      });
    }
    return;
  }

  captionSession.duplicateCueEvents = 0;
  captionSession.cueTrackSignature = nextSignature;
  captionSession.cueList = nextCueList;
  captionSession.cueVideoId = nextVideoId;
  captionSession.cueTrackKind = nextTrackKind;
  captionSession.cueSourceLang = nextSourceLang;
  captionSession.lastDebugCueIdx = -1;

  if (!captionSession.cueList.length) { onNoCues(data); return; }
  buildHybridCueGroups(captionSession.cueList);
  emitDebug("cues-loaded", {
    cueCount: captionSession.cueList.length,
    trackKind: captionSession.cueTrackKind,
    sourceLang: captionSession.cueSourceLang,
    groupCount: captionSession.sentGroups ? captionSession.sentGroups.length : 0,
    batchCount: captionSession.deepseekBatchWindows.length,
    regionCount: captionSession.deepseekCommitRegions.length,
    firstCueStartMs: captionSession.cueList.length ? captionSession.cueList[0].start : 0,
    lastCueEndMs: captionSession.cueList.length ? captionSession.cueList[captionSession.cueList.length - 1].end : 0,
    sourceChars: captionSession.cueList.reduce((sum, cue) => sum + String(cue.text || "").length, 0)
  });
  startCueLoop();
}
