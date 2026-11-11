// Cue lookup, playback, seeking and prefetch coordination.
"use strict";

// =========================================================================
// CUE MODE
// =========================================================================

// binary search: greatest index whose start <= t. -1 if none.
function findCueIdx(t) {
  if (!captionSession.cueList || !captionSession.cueList.length) return -1;
  let lo = 0, hi = captionSession.cueList.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (captionSession.cueList[mid].start <= t) { ans = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return ans;
}

// Find the cue active at time t, tolerant of overlapping/zero-dur cues.
// findCueIdx gives the greatest-start candidate; if t is past that cue's
// effective end we walk back to catch an earlier, longer cue still covering t
// before declaring a gap. Returns the cue index or -1.
function activeCueIdxAt(t) {
  let idx = findCueIdx(t);
  if (idx < 0) return -1;
  // Walk back over earlier cues whose (sorted) start <= t in case a longer
  // earlier cue still covers t. Bounded scan keeps this cheap.
  for (let i = idx; i >= 0; i--) {
    const c = captionSession.cueList[i];
    if (t < c.end) return i;       // c covers t (end is the effective end)
    // If even the latest-starting candidate (i === idx) has ended, an
    // earlier cue might still be open (overlap); keep walking a small window.
    if (idx - i > 8) break;        // safety bound; cues rarely overlap deeply
  }
  return -1;                        // genuine gap
}

// YouTube can leave a short hole between two timed cues even when the semantic
// timeline has validated them as one continuous unit. Retain the preceding
// display page across that bounded open semantic boundary until the next
// member starts. A hard-sized raw-cue gap is a real display boundary even if
// the model temporarily assigns both sides to one semantic unit.
function semanticGapCueIdxAt(t) {
  if (!captionSession.cueList || !captionSession.cueToGroup) return -1;
  const previousCue = findCueIdx(t);
  const nextCue = previousCue + 1;
  if (previousCue < 0 || nextCue >= captionSession.cueList.length) return -1;
  const previous = captionSession.cueList[previousCue];
  const next = captionSession.cueList[nextCue];
  if (t < previous.end || t >= next.start) return -1;
  const previousGroups = captionSession.cueToGroups && captionSession.cueToGroups[previousCue];
  const nextGroups = captionSession.cueToGroups && captionSession.cueToGroups[nextCue];
  const previousGroup = previousGroups && previousGroups.length
    ? previousGroups[previousGroups.length - 1] : captionSession.cueToGroup[previousCue];
  const nextGroup = nextGroups && nextGroups.length ? nextGroups[0] : captionSession.cueToGroup[nextCue];
  if (!Number.isInteger(previousGroup) || !Number.isInteger(nextGroup)) return -1;
  const previousUnit = captionSession.semanticUnitCache.get(groupKey(previousGroup));
  const nextUnit = captionSession.semanticUnitCache.get(groupKey(nextGroup));
  const previousAtom = captionSession.sentGroups && captionSession.sentGroups[previousGroup];
  const semanticBoundaryOpen = nextGroup === previousGroup + 1 &&
    !!previousAtom && previousAtom.hardAfter === false;
  return YTDS_SHARED.shouldBridgeSemanticCueGap(
    previous, next, t, previousUnit, nextUnit, semanticBoundaryOpen
  ) ? previousCue : -1;
}

function startCueLoop() {
  stopCueLoop();
  captionSession.activeCueIdx = -1;
  captionSession.activeGroupIdx = -1;
  clearPendingTimer();
  invalidateCaptionSession("cue-loop-start");
  ensureOverlay();
  // Clear any leftover cue text so a start during a gap does not leave a stale
  // line on screen.
  setOriginal("");
  setTranslation("", "");
  const video = getVideo();
  if (video && typeof video.requestVideoFrameCallback === "function") {
    captionSession.cueTimer = { kind: "video-frame" };
    captionSession.cueLoopVideo = video;
    const onFrame = () => {
      if (!captionSession.cueTimer || captionSession.cueLoopVideo !== video) return;
      cueTick();
      captionSession.cueFrameId = video.requestVideoFrameCallback(onFrame);
    };
    captionSession.cueFrameId = video.requestVideoFrameCallback(onFrame);
    for (const event of ["timeupdate", "seeking", "seeked", "play", "ratechange", "loadedmetadata"]) {
      video.addEventListener(event, cueTick);
    }
  } else {
    captionSession.cueTimer = setInterval(cueTick, 120);
  }
  cueTick();                        // render the active cue NOW (no blank frame)
}

function stopCueLoop() {
  clearAiSeekSettle();
  if (captionSession.cueLoopVideo) {
    if (captionSession.cueFrameId != null && typeof captionSession.cueLoopVideo.cancelVideoFrameCallback === "function") {
      try { captionSession.cueLoopVideo.cancelVideoFrameCallback(captionSession.cueFrameId); } catch (_e) { /* ignore */ }
    }
    for (const event of ["timeupdate", "seeking", "seeked", "play", "ratechange", "loadedmetadata"]) {
      captionSession.cueLoopVideo.removeEventListener(event, cueTick);
    }
  } else if (captionSession.cueTimer) {
    clearInterval(captionSession.cueTimer);
  }
  captionSession.cueTimer = null;
  captionSession.cueFrameId = null;
  captionSession.cueLoopVideo = null;
  captionSession.activeCueIdx = -1;
}

function clearAiSeekSettle() {
  if (captionSession.semanticSeekSettleTimer) {
    clearTimeout(captionSession.semanticSeekSettleTimer);
    captionSession.semanticSeekSettleTimer = null;
  }
  captionSession.semanticSeekSettling = false;
  captionSession.semanticPendingSeekTimeMs = 0;
}

function aiBatchIndexAtTime(timeMs) {
  if (!captionSession.cueList || !captionSession.semanticBatchWindows.length) return -1;
  let cueIndex = activeCueIdxAt(timeMs);
  if (cueIndex < 0) cueIndex = Math.min(captionSession.cueList.length - 1, findCueIdx(timeMs) + 1);
  const group = aiGroupForCueAt(cueIndex, timeMs);
  if (!Number.isInteger(group) || group < 0) return -1;
  const batchIndex = captionSession.semanticGroupToBatch[group];
  return Number.isInteger(batchIndex) ? batchIndex : -1;
}

function focusAiAfterSeek(timeMs) {
  const batchIndex = aiBatchIndexAtTime(timeMs);
  if (batchIndex < 0 || batchIndex === captionSession.semanticFocusedBatchIndex) return;
  const previousBatchIndex = captionSession.semanticFocusedBatchIndex;
  captionSession.semanticFocusedBatchIndex = batchIndex;
  captionSession.semanticFocusGeneration++;
  invalidateCaptionSession("seek-focus");
  for (const key of Array.from(captionSession.transInflight)) {
    if (typeof key === "string" && (key.startsWith("dsb:") ||
        key.startsWith("dsp:") || key.startsWith("dsr:"))) {
      captionSession.transInflight.delete(key);
      captionSession.semanticRequestMeta.delete(key);
    }
  }
  for (const state of captionSession.semanticCommitStateByRegion.values()) {
    if (Array.isArray(state.prefetchQueue)) state.prefetchQueue.length = 0;
    if (state.prefetchQueued && typeof state.prefetchQueued.clear === "function") {
      state.prefetchQueued.clear();
    }
    if (state.prefetchResponses && typeof state.prefetchResponses.clear === "function") {
      state.prefetchResponses.clear();
    }
  }
  captionSession.semanticRetryCounts.clear();
  captionSession.semanticExhaustedRegions.clear();
  if (captionSession.semanticVisibleErrors) captionSession.semanticVisibleErrors.clear();
  emitDebug("ai-focus-changed", {
    previousBatchIndex,
    batchIndex,
    focusGeneration: captionSession.semanticFocusGeneration,
    videoTimeMs: Math.round(Number(timeMs) || 0)
  });
  if (captionSession.cueVideoId) {
    sendRuntimeMessage({
      type: "cancelAiTranslation",
      videoId: captionSession.cueVideoId,
      beforeFocusGeneration: captionSession.semanticFocusGeneration
    });
  }
}

function scheduleAiSeekSettlement(timeMs, reason) {
  if (captionSession.semanticSeekSettleTimer) clearTimeout(captionSession.semanticSeekSettleTimer);
  captionSession.semanticSeekSettling = true;
  captionSession.semanticPendingSeekTimeMs = Math.max(0, Number(timeMs) || 0);
  captionSession.semanticSeekSettleTimer = setTimeout(() => {
    captionSession.semanticSeekSettleTimer = null;
    if (!captionSession.semanticSeekSettling) return;
    captionSession.semanticSeekSettling = false;
    const video = getVideo();
    const settledTimeMs = video
      ? video.currentTime * 1000 : captionSession.semanticPendingSeekTimeMs;
    captionSession.semanticPendingSeekTimeMs = 0;
    focusAiAfterSeek(settledTimeMs);
    emitDebug("ai-seek-settled", {
      reason: String(reason || "idle"),
      videoTimeMs: Math.round(Number(settledTimeMs) || 0)
    });
    cueTick({ type: "ai-seek-settled" });
  }, AI_SEEK_SETTLE_MS);
}

function beginAiSeek(timeMs) {
  scheduleAiSeekSettlement(timeMs, "seeking-idle");
}

function finishAiSeek(timeMs) {
  // YouTube can emit a rapid series of final `seeked` events while the user
  // scrubs. Treat both seeking and seeked as one trailing-edge transaction.
  scheduleAiSeekSettlement(timeMs, "seeked-stable");
}

function cueTick(event) {
  if (!extensionContextAlive()) { stopForInvalidatedExtensionContext(); return; }
  if (!settings.enabled || !captionSession.cueList) return;
  const video = getVideo();
  if (!video) return;
  const t = video.currentTime * 1000;
  const manualTranslation = manualTranslationSelected();
  const eventType = event && event.type || "";
  if (!manualTranslation && eventType === "seeking") beginAiSeek(t);
  else if (!manualTranslation && eventType === "seeked") finishAiSeek(t);
  const seekJustSettled = eventType === "ai-seek-settled";
  const playbackRateChanged = eventType === "ratechange";

  let idx = activeCueIdxAt(t);
  if (idx < 0) idx = semanticGapCueIdxAt(t);

  if (idx < 0) {
    // The first caption often starts after a short intro. Use that otherwise
    // idle lead time to translate the upcoming DeepSeek batch before it is
    // visible. This also warms the destination when seeking into a cue gap.
    if (!manualTranslation) prefetchAiAtTime(t);
    if (captionSession.activeCueIdx !== -1) {
      captionSession.activeCueIdx = -1;
      captionSession.activeGroupIdx = -1;              // no cue ⟹ no group (explicit invariant)
      captionSession.lastDebugCueIdx = -1;
      setOriginal("");
      setTranslation("", "");
    }
    return;
  }

  if (manualTranslation) {
    if (idx === captionSession.activeCueIdx && captionSession.activeGroupIdx === -1) {
      setTranslation(manualTranslationTextAt(t), sourceForDisplayedCue(idx, captionSession.cueList[idx]));
      return;
    }
    captionSession.activeCueIdx = idx;
    captionSession.activeGroupIdx = -1;
    const cue = captionSession.cueList[idx];
    const displaySource = cue.text;
    if (idx !== captionSession.lastDebugCueIdx || eventType === "seeking") {
      captionSession.lastDebugCueIdx = idx;
      emitDebug("cue-active", {
        cueIdx: idx, groupIdx: -1, cueStartMs: cue.start, cueEndMs: cue.end,
        source: cue.text, displaySource
      });
    }
    setOriginal(displaySource);
    setTranslation(manualTranslationTextAt(t), displaySource);
    return;
  }

  const timedGroupIdx = aiGroupForCueAt(idx, t);
  if (idx === captionSession.activeCueIdx && timedGroupIdx === captionSession.activeGroupIdx) {
    maybeReflowSemanticDisplay();
    const activeGroup = captionSession.activeGroupIdx;
    if (activeGroup >= 0 &&
        !YTDS_SHARED.isSameLanguage(captionSession.cueSourceLang, settings.targetLang) &&
        !captionSession.transCache.has(groupKey(activeGroup))) {
      // The 120ms cue loop is also the playback watchdog. A long semantic
      // group can remain active while its request stalls; without re-entering
      // the request state machine here, playback-lag detection only runs at a
      // group boundary and cannot rebuild the stalled urgent writer in time.
      const acceleratedPlayback = isAcceleratedAiPlayback();
      if (seekJustSettled || playbackRateChanged) {
        armPendingTranslationIndicator(activeGroup, true);
      }
      if (acceleratedPlayback) {
        // This path includes the current urgent request and replenishes the
        // future runway. Existing request ownership prevents duplicates.
        prefetchFrom(idx);
      } else {
        aiRequestBatch(activeGroup, true, true);
        if (seekJustSettled || playbackRateChanged) prefetchFrom(idx);
      }
    }
    return;                             // same sentence — no re-render, no jitter
  }
  captionSession.activeCueIdx = idx;
  captionSession.activeGroupIdx = timedGroupIdx;

  const cue = captionSession.cueList[idx];
  const displaySource = sourceForDisplayedCue(idx, cue);
  if (idx !== captionSession.lastDebugCueIdx || eventType === "seeking" || seekJustSettled) {
    captionSession.lastDebugCueIdx = idx;
    emitDebug("cue-active", {
      cueIdx: idx,
      groupIdx: captionSession.activeGroupIdx,
      cueStartMs: cue.start,
      cueEndMs: cue.end,
      source: cue.text,
      displaySource
    });
  }
  setOriginal(displaySource);
  // At accelerated playback, warm the current semantic region before the
  // renderer promotes it to visible work. The old order started the urgent
  // request first, so the already-live cold prefetch could never be widened.
  const acceleratedPlayback = isAcceleratedAiPlayback();
  if (acceleratedPlayback) prefetchFrom(idx);
  renderTranslationForCue(idx, cue, displaySource,
    captionSession.semanticSeekSettling || eventType === "seeking");
  if (!acceleratedPlayback) prefetchFrom(idx);
}

function sourceForDisplayedCue(idx, cue) {
  if (!captionSession.cueToGroup) return cue.text;
  const group = idx === captionSession.activeCueIdx && captionSession.activeGroupIdx >= 0
    ? captionSession.activeGroupIdx : aiGroupForCueAt(idx);
  if (!Number.isInteger(group)) return cue.text;
  const display = captionSession.semanticDisplayCache.get(groupKey(group));
  if (display && display.source) return display.source;
  return captionSession.semanticSourceCache.get(groupKey(group)) || cue.text;
}

function aiGroupForCueAt(cueIdx, timeMs) {
  if (!captionSession.cueToGroup || !Number.isInteger(cueIdx) || cueIdx < 0 || cueIdx >= captionSession.cueToGroup.length) {
    return -1;
  }
  const groups = captionSession.cueToGroups && captionSession.cueToGroups[cueIdx];
  if (!Array.isArray(groups) || !groups.length || !captionSession.sentGroups) {
    const group = captionSession.cueToGroup[cueIdx];
    return Number.isInteger(group) ? group : -1;
  }
  const time = Number(timeMs);
  if (!Number.isFinite(time)) return groups[0];
  let selected = groups[0];
  for (const group of groups) {
    const atom = captionSession.sentGroups[group];
    if (!atom || Number(atom.start) > time) break;
    selected = group;
  }
  return selected;
}

function renderTranslationForCue(idx, cue, displayedSource, immediatePending) {
  const origText = displayedSource || cue.text;

  if (manualTranslationSelected()) {
    const video = getVideo();
    setTranslation(manualTranslationTextAt(video ? video.currentTime * 1000 : cue.start), origText);
    return;
  }

  if (YTDS_SHARED.isSameLanguage(captionSession.cueSourceLang, settings.targetLang)) {
    clearPendingTimer();
    setTranslation("", origText);
    return;
  }

  if (captionSession.activeGroupIdx >= 0) {
    const gCached = captionSession.transCache.get(groupKey(captionSession.activeGroupIdx));
    if (gCached !== undefined) {
      clearPendingTimer();
      const display = captionSession.semanticDisplayCache.get(groupKey(captionSession.activeGroupIdx));
      setTranslation(display && display.translation || gCached, origText);
      return;
    }
    const regionIndex = captionSession.semanticGroupToCommitRegion[captionSession.activeGroupIdx];
    const displayError = captionSession.semanticExhaustedRegions.get(regionIndex) ||
      captionSession.semanticVisibleErrors && captionSession.semanticVisibleErrors.get(regionIndex);
    if (displayError) {
      clearPendingTimer();
      setTranslation(aiTranslationErrorText(displayError), origText, "error");
      return;
    }
    armPendingTranslationIndicator(captionSession.activeGroupIdx, immediatePending);
    aiRequestBatch(captionSession.activeGroupIdx, true, true);
    return;
  }
  setTranslation("", origText);
}

function prefetchFrom(startIdx) {
  if (!settings.enabled || !captionSession.cueList) return;
  if (YTDS_SHARED.isSameLanguage(captionSession.cueSourceLang, settings.targetLang)) return;
  if (captionSession.cueToGroup && captionSession.sentGroups) {
    const at = Math.max(0, Math.min(startIdx, captionSession.cueToGroup.length - 1));
    const g0 = at === captionSession.activeCueIdx && captionSession.activeGroupIdx >= 0
      ? captionSession.activeGroupIdx : aiGroupForCueAt(at);
    if (g0 == null || g0 < 0) return;
    const acceleratedPlayback = isAcceleratedAiPlayback();
    prefetchAiBatches(g0, acceleratedPlayback, acceleratedPlayback);
    return;
  }
}

function isAcceleratedAiPlayback() {
  const video = getVideo();
  const rate = Number(video && video.playbackRate);
  return Number.isFinite(rate) && rate >= 1.75;
}

function aiPrefetchBatchCount() {
  const configured = Math.min(
    AI_MAX_PREFETCH_BATCHES,
    Math.max(0, Math.floor(Number(settings.aiPrefetchBatches) || 0))
  );
  if (!isAcceleratedAiPlayback()) return configured;
  const video = getVideo();
  const rate = Number(video && video.playbackRate);
  const accelerated = Number.isFinite(rate) && rate >= 2.5
    ? AI_HIGH_SPEED_PREFETCH_BATCHES : AI_FAST_PREFETCH_BATCHES;
  return Math.min(AI_MAX_PREFETCH_BATCHES, Math.max(configured, accelerated));
}

function prefetchAiBatches(gIdx, includeCurrent, currentUrgent = false) {
  if (YTDS_SHARED.isSameLanguage(captionSession.cueSourceLang, settings.targetLang)) return;
  if (!captionSession.sentGroups || !captionSession.semanticBatchWindows.length) return;
  if (!Number.isInteger(gIdx) || gIdx < 0 || gIdx >= captionSession.sentGroups.length) return;
  if (includeCurrent) aiRequestBatch(gIdx, true, !!currentUrgent);
  const groupToRegion = captionSession.semanticGroupToCommitRegion;
  const currentRegion = groupToRegion ? groupToRegion[gIdx] : undefined;
  const starts = YTDS_SHARED.semanticPrefetchBatchStarts(
    gIdx, captionSession.semanticGroupToBatch, captionSession.semanticBatchWindows,
    aiPrefetchBatchCount()
  );
  for (const start of starts) {
    if (groupToRegion && currentRegion !== undefined && groupToRegion[start] !== currentRegion) continue;
    aiRequestBatch(start);
  }
}

function prefetchAiAtTime(timeMs) {
  if (!captionSession.cueList || !captionSession.cueList.length) return;
  let idx = activeCueIdxAt(timeMs);
  if (idx < 0) {
    // findCueIdx is the last cue that has started. Its successor is the first
    // future cue both before the track begins and inside a genuine cue gap.
    idx = Math.min(captionSession.cueList.length - 1, findCueIdx(timeMs) + 1);
  }
  const group = aiGroupForCueAt(idx, timeMs);
  if (Number.isInteger(group)) prefetchAiBatches(group, true);
}

// Compute an effective end for each (already start-sorted) cue. Handles
// zero/near-zero-duration cues (extend to the next cue's start, or a floor
// for the final cue) so they are not treated as a permanent gap.
