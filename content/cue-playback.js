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

// YouTube can leave a hole between two timed cues even when the semantic
// timeline has validated them as one continuous unit. Retain the preceding
// display page across that open semantic boundary until the next member starts.
// The semantic hard-boundary state is authoritative; a separate display-time
// gap threshold would disagree on which units are allowed to cross a pause.
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
  const previousUnit = captionSession.deepseekUnitCache.get(groupKey(previousGroup));
  const nextUnit = captionSession.deepseekUnitCache.get(groupKey(nextGroup));
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
  // Clear any leftover text (e.g. last scraped fallback line, or a previous
  // cue) so a start during a gap does not leave a stale line on screen.
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
    for (const event of ["timeupdate", "seeking", "seeked", "play", "loadedmetadata"]) {
      video.addEventListener(event, cueTick);
    }
  } else {
    captionSession.cueTimer = setInterval(cueTick, 120);
  }
  cueTick();                        // render the active cue NOW (no blank frame)
}

function stopCueLoop() {
  clearDeepseekSeekSettle();
  if (captionSession.cueLoopVideo) {
    if (captionSession.cueFrameId != null && typeof captionSession.cueLoopVideo.cancelVideoFrameCallback === "function") {
      try { captionSession.cueLoopVideo.cancelVideoFrameCallback(captionSession.cueFrameId); } catch (_e) { /* ignore */ }
    }
    for (const event of ["timeupdate", "seeking", "seeked", "play", "loadedmetadata"]) {
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

function clearDeepseekSeekSettle() {
  if (captionSession.deepseekSeekSettleTimer) {
    clearTimeout(captionSession.deepseekSeekSettleTimer);
    captionSession.deepseekSeekSettleTimer = null;
  }
  captionSession.deepseekSeekSettling = false;
  captionSession.deepseekPendingSeekTimeMs = 0;
}

function deepseekBatchIndexAtTime(timeMs) {
  if (!captionSession.cueList || !captionSession.deepseekBatchWindows.length) return -1;
  let cueIndex = activeCueIdxAt(timeMs);
  if (cueIndex < 0) cueIndex = Math.min(captionSession.cueList.length - 1, findCueIdx(timeMs) + 1);
  const group = deepseekGroupForCueAt(cueIndex, timeMs);
  if (!Number.isInteger(group) || group < 0) return -1;
  const batchIndex = captionSession.deepseekGroupToBatch[group];
  return Number.isInteger(batchIndex) ? batchIndex : -1;
}

function focusDeepseekAfterSeek(timeMs) {
  const batchIndex = deepseekBatchIndexAtTime(timeMs);
  if (batchIndex < 0 || batchIndex === captionSession.deepseekFocusedBatchIndex) return;
  const previousBatchIndex = captionSession.deepseekFocusedBatchIndex;
  captionSession.deepseekFocusedBatchIndex = batchIndex;
  captionSession.deepseekFocusGeneration++;
  invalidateCaptionSession("seek-focus");
  for (const key of Array.from(captionSession.transInflight)) {
    if (typeof key === "string" && (key.startsWith("dsb:") || key.startsWith("dsr:"))) {
      captionSession.transInflight.delete(key);
      captionSession.deepseekRequestMeta.delete(key);
    }
  }
  captionSession.deepseekRetryCounts.clear();
  captionSession.deepseekExhaustedRegions.clear();
  emitDebug("deepseek-focus-changed", {
    previousBatchIndex,
    batchIndex,
    focusGeneration: captionSession.deepseekFocusGeneration,
    videoTimeMs: Math.round(Number(timeMs) || 0)
  });
  if (captionSession.cueVideoId) {
    sendRuntimeMessage({
      type: "cancelDeepSeek",
      videoId: captionSession.cueVideoId,
      beforeFocusGeneration: captionSession.deepseekFocusGeneration
    });
  }
}

function scheduleDeepseekSeekSettlement(timeMs, reason) {
  if (captionSession.deepseekSeekSettleTimer) clearTimeout(captionSession.deepseekSeekSettleTimer);
  captionSession.deepseekSeekSettling = true;
  captionSession.deepseekPendingSeekTimeMs = Math.max(0, Number(timeMs) || 0);
  captionSession.deepseekSeekSettleTimer = setTimeout(() => {
    captionSession.deepseekSeekSettleTimer = null;
    if (!captionSession.deepseekSeekSettling) return;
    captionSession.deepseekSeekSettling = false;
    const video = getVideo();
    const settledTimeMs = video
      ? video.currentTime * 1000 : captionSession.deepseekPendingSeekTimeMs;
    captionSession.deepseekPendingSeekTimeMs = 0;
    focusDeepseekAfterSeek(settledTimeMs);
    emitDebug("deepseek-seek-settled", {
      reason: String(reason || "idle"),
      videoTimeMs: Math.round(Number(settledTimeMs) || 0)
    });
    cueTick({ type: "deepseek-seek-settled" });
  }, DEEPSEEK_SEEK_SETTLE_MS);
}

function beginDeepseekSeek(timeMs) {
  scheduleDeepseekSeekSettlement(timeMs, "seeking-idle");
}

function finishDeepseekSeek(timeMs) {
  // YouTube can emit a rapid series of final `seeked` events while the user
  // scrubs. Treat both seeking and seeked as one trailing-edge transaction.
  scheduleDeepseekSeekSettlement(timeMs, "seeked-stable");
}

function cueTick(event) {
  if (!extensionContextAlive()) { stopForInvalidatedExtensionContext(); return; }
  if (!settings.enabled || !captionSession.cueList) return;
  const video = getVideo();
  if (!video) return;
  const t = video.currentTime * 1000;
  const eventType = event && event.type || "";
  if (eventType === "seeking") beginDeepseekSeek(t);
  else if (eventType === "seeked") finishDeepseekSeek(t);
  const seekJustSettled = eventType === "deepseek-seek-settled";

  let idx = activeCueIdxAt(t);
  if (idx < 0) idx = semanticGapCueIdxAt(t);

  if (idx < 0) {
    // The first caption often starts after a short intro. Use that otherwise
    // idle lead time to translate the upcoming DeepSeek batch before it is
    // visible. This also warms the destination when seeking into a cue gap.
    prefetchDeepseekAtTime(t);
    if (captionSession.activeCueIdx !== -1) {
      captionSession.activeCueIdx = -1;
      captionSession.activeGroupIdx = -1;              // no cue ⟹ no group (explicit invariant)
      captionSession.lastDebugCueIdx = -1;
      setOriginal("");
      setTranslation("", "");
    }
    return;
  }

  const timedGroupIdx = deepseekGroupForCueAt(idx, t);
  if (idx === captionSession.activeCueIdx && timedGroupIdx === captionSession.activeGroupIdx) {
    maybeReflowSemanticDisplay();
    if (seekJustSettled && captionSession.activeGroupIdx >= 0 &&
        !captionSession.transCache.has(groupKey(captionSession.activeGroupIdx))) {
      armPendingTranslationIndicator(captionSession.activeGroupIdx, true);
      deepseekRequestBatch(captionSession.activeGroupIdx, true, true);
      prefetchFrom(idx);
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
  renderTranslationForCue(idx, cue, displaySource,
    captionSession.deepseekSeekSettling || eventType === "seeking");
  prefetchFrom(idx);
}

function sourceForDisplayedCue(idx, cue) {
  if (!captionSession.cueToGroup) return cue.text;
  const group = idx === captionSession.activeCueIdx && captionSession.activeGroupIdx >= 0
    ? captionSession.activeGroupIdx : deepseekGroupForCueAt(idx);
  if (!Number.isInteger(group)) return cue.text;
  const display = captionSession.deepseekDisplayCache.get(groupKey(group));
  if (display && display.source) return display.source;
  return captionSession.deepseekSourceCache.get(groupKey(group)) || cue.text;
}

function deepseekGroupForCueAt(cueIdx, timeMs) {
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

  if (captionSession.activeGroupIdx >= 0) {
    const gCached = captionSession.transCache.get(groupKey(captionSession.activeGroupIdx));
    if (gCached !== undefined) {
      clearPendingTimer();
      const display = captionSession.deepseekDisplayCache.get(groupKey(captionSession.activeGroupIdx));
      setTranslation(display && display.translation || gCached, origText);
      return;
    }
    const regionIndex = captionSession.deepseekGroupToCommitRegion[captionSession.activeGroupIdx];
    if (captionSession.deepseekExhaustedRegions.has(regionIndex)) {
      clearPendingTimer();
      setTranslation(t("translationUnavailable", "Translation temporarily unavailable"), origText);
      return;
    }
    armPendingTranslationIndicator(captionSession.activeGroupIdx, immediatePending);
    deepseekRequestBatch(captionSession.activeGroupIdx, true, true);
    return;
  }
  setTranslation("", origText);
}

function prefetchFrom(startIdx) {
  if (!settings.enabled || !captionSession.cueList) return;
  if (captionSession.cueToGroup && captionSession.sentGroups) {
    const at = Math.max(0, Math.min(startIdx, captionSession.cueToGroup.length - 1));
    const g0 = at === captionSession.activeCueIdx && captionSession.activeGroupIdx >= 0
      ? captionSession.activeGroupIdx : deepseekGroupForCueAt(at);
    if (g0 == null || g0 < 0) return;
    prefetchDeepseekBatches(g0, false);
    return;
  }
}

function prefetchDeepseekBatches(gIdx, includeCurrent) {
  if (!captionSession.sentGroups || !captionSession.deepseekBatchWindows.length) return;
  if (!Number.isInteger(gIdx) || gIdx < 0 || gIdx >= captionSession.sentGroups.length) return;
  if (includeCurrent) deepseekRequestBatch(gIdx);
  const starts = YTDS_SHARED.semanticPrefetchBatchStarts(
    gIdx, captionSession.deepseekGroupToBatch, captionSession.deepseekBatchWindows,
    Math.min(DEEPSEEK_MAX_PREFETCH_BATCHES, settings.deepseekPrefetchBatches)
  );
  for (const start of starts) deepseekRequestBatch(start);
}

function prefetchDeepseekAtTime(timeMs) {
  if (!captionSession.cueList || !captionSession.cueList.length) return;
  let idx = activeCueIdxAt(timeMs);
  if (idx < 0) {
    // findCueIdx is the last cue that has started. Its successor is the first
    // future cue both before the track begins and inside a genuine cue gap.
    idx = Math.min(captionSession.cueList.length - 1, findCueIdx(timeMs) + 1);
  }
  const group = deepseekGroupForCueAt(idx, timeMs);
  if (Number.isInteger(group)) prefetchDeepseekBatches(group, true);
}

// Compute an effective end for each (already start-sorted) cue. Handles
// zero/near-zero-duration cues (extend to the next cue's start, or a floor
// for the final cue) so they are not treated as a permanent gap.
