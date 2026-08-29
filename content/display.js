// Cue timing normalization and semantic display cache.
"use strict";

function computeCueEnds(list) {
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    let end = c.start + (c.dur > 0 ? c.dur : 0);
    if (c.dur <= 0) {
      if (i + 1 < list.length) end = list[i + 1].start;
      else end = c.start + ZERO_DUR_FLOOR_MS;
      // guard against a non-positive window if the next cue shares the start
      if (end <= c.start) end = c.start + ZERO_DUR_FLOOR_MS;
    }
    c.end = end;
  }
}

// Merge overlapping timed cue text without duplicating rolling-caption words.
function mergeCueTexts(cues) {
  return YTDS_SHARED.mergeTimedCueTexts(cues);
}

function semanticDisplayWidth() {
  if (overlay && overlay.isConnected && overlay.clientWidth > 0) {
    return Math.max(260, Math.round(overlay.clientWidth) - 20);
  }
  const player = getPlayer();
  const width = player && player.clientWidth || window.innerWidth || 1280;
  return Math.max(260, Math.round(width * 0.98) - 20);
}

function measureDisplayText(text, original) {
  if (!captionSession.displayMeasureCanvas) captionSession.displayMeasureCanvas = document.createElement("canvas");
  const context = captionSession.displayMeasureCanvas.getContext("2d");
  if (!context) return String(text || "").length * 12;
  const fullscreen = isPlayerFullscreen();
  const size = original
    ? (fullscreen ? settings.origFullscreenSize : settings.origSize)
    : (fullscreen ? settings.transFullscreenSize : settings.transSize);
  const family = fontStack(original ? settings.origFont : settings.transFont);
  context.font = `400 ${Math.max(8, Number(size) || 16)}px ${family}`;
  return context.measureText(String(text || "")).width;
}

function semanticDisplayPageCount(source, translation, memberCount) {
  if (memberCount < 2) return 1;
  // Leave headroom for proportional-font wrapping and the line padding. Each
  // page targets at most two rendered rows per language.
  const twoLineCapacity = semanticDisplayWidth() * 1.68;
  const sourcePages = settings.showOriginal
    ? Math.ceil(measureDisplayText(source, true) / twoLineCapacity) : 1;
  const translationPages = settings.showTranslation
    ? Math.ceil(measureDisplayText(translation, false) / twoLineCapacity) : 1;
  return Math.max(1, Math.min(memberCount, Math.max(sourcePages, translationPages)));
}

function cacheSemanticDisplayCluster(unitsValue, logPages) {
  if (!captionSession.sentGroups) return;
  const units = (Array.isArray(unitsValue) ? unitsValue : [])
    .map((unit) => ({
      unitId: String(unit && unit.unitId || ""),
      members: Array.isArray(unit && unit.members) ? unit.members.slice() : []
    })).filter((unit) => unit.members.length);
  const members = units.flatMap((unit) => unit.members);
  if (!members.length) return;
  const parts = members.map((id) => captionSession.sentGroups[id]).filter(Boolean);
  if (!parts.length) return;
  const source = mergeCueTexts(parts);
  const unitTranslations = units.map((unit) =>
    captionSession.transCache.get(groupKey(unit.members[0])) || ""
  );
  const unitSpeakerSwitches = YTDS_SHARED.speakerSwitchSeparators(
    units.map((unit) => ({ ids: unit.members })), parts
  );
  const translation = YTDS_SHARED.joinTranslatedParts(
    unitTranslations, settings.targetLang, unitSpeakerSwitches
  );
  if (!source || !translation) return;
  const unitIds = units.map((unit) => unit.unitId).filter(Boolean);
  const alignedChunks = unitIds.flatMap((unitId) =>
    captionSession.deepseekAlignedChunksCache.get(unitId) || []);
  let displayPlan = null;
  let alignedByChunks = false;
  if (Array.isArray(alignedChunks) && alignedChunks.length) {
    const expectedIds = members.map(String);
    const displayChunks = [];
    const coveredIds = [];
    for (const chunk of alignedChunks) {
      const ids = Array.isArray(chunk && chunk.ids) ? chunk.ids.map(String) : [];
      const numericIds = ids.map(Number);
      const cues = numericIds.map((id) => captionSession.sentGroups[id]).filter(Boolean);
      if (!ids.length || cues.length !== ids.length || !chunk.translation) continue;
      coveredIds.push(...ids);
      displayChunks.push({
        ids,
        cues,
        translation: String(chunk.translation),
        sentenceBoundaryAfter: chunk.sentenceBoundaryAfter === true
      });
    }
    const exactCoverage = coveredIds.length === expectedIds.length &&
      coveredIds.every((id, index) => id === expectedIds[index]);
    if (exactCoverage && displayChunks.length) {
      const twoLineCapacity = semanticDisplayWidth() * 1.68;
      const alignedPlan = YTDS_SHARED.alignedChunkDisplayPlan(
        displayChunks,
        settings.showOriginal ? twoLineCapacity : Number.MAX_SAFE_INTEGER,
        settings.showTranslation ? twoLineCapacity : Number.MAX_SAFE_INTEGER,
        (text) => measureDisplayText(text, true),
        (text) => measureDisplayText(text, false),
        settings.targetLang,
        captionSession.cueSourceLang
      );
      if (alignedPlan.pages.length && !alignedPlan.overflow) {
        displayPlan = {
          alignedBySentence: false,
          sourcePages: alignedPlan.pages.map((page) => ({ text: page.source })),
          translationPages: alignedPlan.pages.map((page) => ({ text: page.translation })),
          assignments: members.map((id) => alignedPlan.memberPages[String(id)] || 0)
        };
        alignedByChunks = true;
      }
    }
  }
  if (!displayPlan) {
    // Whole-unit safety path for responses without usable aligned chunks and
    // the rare oversized chunk that cannot be locally paginated by its ids.
    const requestedPages = semanticDisplayPageCount(source, translation, members.length);
    displayPlan = YTDS_SHARED.semanticDisplayPlan(
      source,
      translation,
      parts.map((part) => part.text),
      requestedPages,
      (text) => measureDisplayText(text, true),
      (text) => measureDisplayText(text, false),
      captionSession.cueSourceLang,
      settings.targetLang
    );
  }
  const sourcePages = displayPlan.sourcePages;
  const translationPages = displayPlan.translationPages;
  if (!sourcePages.length || !translationPages.length) return;
  const pageAssignments = displayPlan.assignments;

  for (let ordinal = 0; ordinal < members.length; ordinal++) {
    const sourcePageIndex = pageAssignments[ordinal] == null ? 0 : pageAssignments[ordinal];
    const translationPageIndex = sourcePages.length > 1
      ? Math.round(sourcePageIndex * (translationPages.length - 1) / (sourcePages.length - 1))
      : 0;
    captionSession.deepseekDisplayCache.set(groupKey(members[ordinal]), {
      source: sourcePages[sourcePageIndex].text,
      translation: translationPages[translationPageIndex].text,
      pageIndex: sourcePageIndex,
      pageCount: sourcePages.length
    });
  }
  if (logPages && sourcePages.length > 1) {
    emitDebug("semantic-display-pages", {
      unitIds,
      members,
      widthPx: semanticDisplayWidth(),
      alignedByChunks,
      alignedBySentence: displayPlan.alignedBySentence,
      memberPages: members.map((id, ordinal) => ({ id, page: pageAssignments[ordinal] || 0 })),
      sourcePages: sourcePages.map((page) => page.text),
      translationPages: translationPages.map((page) => page.text)
    });
  }
  if (logPages && units.length > 1) {
    const first = captionSession.sentGroups[members[0]];
    const last = captionSession.sentGroups[members[members.length - 1]];
    emitDebug("semantic-display-smoothed", {
      unitIds,
      members,
      sourceCueIndex: first && first.startIdx,
      durationMs: Math.max(0, Number(last && last.end) - Number(first && first.start)),
      minimumMs: DEEPSEEK_MIN_DISPLAY_UNIT_MS
    });
  }
}

function deepseekSemanticDisplayUnits() {
  if (!captionSession.sentGroups) return [];
  const units = new Map();
  for (let id = 0; id < captionSession.sentGroups.length; id++) {
    const unitId = captionSession.deepseekUnitCache.get(groupKey(id));
    if (!unitId) continue;
    const unit = units.get(unitId) || { unitId, members: [] };
    unit.members.push(id);
    units.set(unitId, unit);
  }
  return Array.from(units.values());
}

function deepseekSemanticDisplayClusters() {
  return YTDS_SHARED.semanticDisplayClusters(
    deepseekSemanticDisplayUnits(), captionSession.sentGroups, DEEPSEEK_MIN_DISPLAY_UNIT_MS
  );
}

function deepseekTranslationErrorText(value) {
  const details = YTDS_SHARED.aiErrorDescriptor(value);
  const code = [details.code, details.providerCode].filter(Boolean).join(" / ");
  const base = String(t("translationError", "Translation failed [$1]")).replace(/\$1/g, code);
  const message = YTDS_SHARED.aiErrorMessage(value, "");
  return message && message !== code ? `${base} — ${message}` : base;
}

function deepseekUpdateDisplayError(regionIndex, request, runtimeError, response) {
  const runtimeInfo = runtimeError && YTDS_SHARED.aiErrorDescriptor(runtimeError);
  const responseHasError = response && (response.ok === false || response.errorCode ||
    response.error || response.streamError);
  const responseInfo = responseHasError && YTDS_SHARED.aiErrorDescriptor(response);
  const cancelled = !!(runtimeInfo && runtimeInfo.code === "AI_CANCELLED") ||
    !!(responseInfo && responseInfo.code === "AI_CANCELLED");
  if (request && request.prefetch) return;
  const errors = captionSession.deepseekVisibleErrors;
  if (!errors || !Number.isInteger(regionIndex)) return;
  const value = runtimeError || (responseHasError ? response : null);
  if (!value || cancelled) {
    errors.delete(regionIndex);
    return;
  }
  const details = YTDS_SHARED.aiErrorDescriptor(value);
  errors.set(regionIndex, {
    errorCode: details.code,
    providerCode: details.providerCode,
    errorMessage: YTDS_SHARED.aiErrorMessage(value, "")
  });
}

function cacheDeepseekDisplayNeighborhood(changedMembers, logPages) {
  const changed = new Set((Array.isArray(changedMembers) ? changedMembers : []).map(Number));
  const cueIndexes = new Set(Array.from(changed).map((id) =>
    Number(captionSession.sentGroups && captionSession.sentGroups[id] && captionSession.sentGroups[id].startIdx)).filter(Number.isInteger));
  const unitById = new Map(deepseekSemanticDisplayUnits().map((unit) => [unit.unitId, unit]));
  for (const cluster of deepseekSemanticDisplayClusters()) {
    const relevant = cluster.members.some((id) => changed.has(id) ||
      cueIndexes.has(Number(captionSession.sentGroups && captionSession.sentGroups[id] && captionSession.sentGroups[id].startIdx)));
    if (!relevant) continue;
    const units = cluster.unitIds.map((unitId) => unitById.get(unitId)).filter(Boolean);
    cacheSemanticDisplayCluster(units, logPages);
  }
}

function repaintActiveDeepseekTranslation() {
  if (manualTranslationSelected()) {
    if (captionSession.cueList) cueTick();
    return;
  }
  const activeTranslation = captionSession.activeGroupIdx >= 0
    ? captionSession.transCache.get(groupKey(captionSession.activeGroupIdx)) : "";
  if (!activeTranslation || captionSession.activeCueIdx < 0 || !captionSession.cueList) {
    if (captionSession.activeGroupIdx >= 0 && captionSession.activeCueIdx >= 0 && captionSession.cueList) {
      const regionIndex = captionSession.deepseekGroupToCommitRegion[captionSession.activeGroupIdx];
      const displayError = captionSession.deepseekExhaustedRegions.get(regionIndex) ||
        captionSession.deepseekVisibleErrors && captionSession.deepseekVisibleErrors.get(regionIndex);
      if (displayError) {
        clearPendingTimer();
        const source = sourceForDisplayedCue(captionSession.activeCueIdx, captionSession.cueList[captionSession.activeCueIdx]);
        setTranslation(deepseekTranslationErrorText(displayError), source, "error");
        return;
      }
      armPendingTranslationIndicator(captionSession.activeGroupIdx);
    }
    return;
  }
  clearPendingTimer();
  const activeSource = sourceForDisplayedCue(captionSession.activeCueIdx, captionSession.cueList[captionSession.activeCueIdx]);
  const activeDisplay = captionSession.deepseekDisplayCache.get(groupKey(captionSession.activeGroupIdx));
  setOriginal(activeSource);
  setTranslation(activeDisplay && activeDisplay.translation || activeTranslation, activeSource);
}

function rebuildDeepseekDisplayCache(repaint) {
  captionSession.deepseekDisplayCache.clear();
  captionSession.semanticLayoutWidth = semanticDisplayWidth();
  if (!captionSession.sentGroups) return;
  const unitById = new Map(deepseekSemanticDisplayUnits().map((unit) => [unit.unitId, unit]));
  for (const cluster of deepseekSemanticDisplayClusters()) {
    const units = cluster.unitIds.map((unitId) => unitById.get(unitId)).filter(Boolean);
    cacheSemanticDisplayCluster(units, false);
  }
  if (repaint && captionSession.activeCueIdx >= 0 && captionSession.activeGroupIdx >= 0 && captionSession.cueList) {
    const cue = captionSession.cueList[captionSession.activeCueIdx];
    const source = sourceForDisplayedCue(captionSession.activeCueIdx, cue);
    const display = captionSession.deepseekDisplayCache.get(groupKey(captionSession.activeGroupIdx));
    const translation = display && display.translation || captionSession.transCache.get(groupKey(captionSession.activeGroupIdx));
    setOriginal(source);
    if (translation) setTranslation(translation, source);
  }
}

// Coalesce live slider/font/layout changes to one rebuild per animation
// frame. Measuring the connected overlay keeps pagination in lockstep with
// its real content width instead of a separately estimated percentage.
function scheduleDeepseekDisplayReflow(repaint) {
  if (captionSession.semanticReflowFrame != null) return;
  captionSession.semanticReflowFrame = requestAnimationFrame(() => {
    captionSession.semanticReflowFrame = null;
    rebuildDeepseekDisplayCache(repaint !== false);
  });
}

function observeSemanticLayout() {
  if (captionSession.semanticResizeObserver) captionSession.semanticResizeObserver.disconnect();
  captionSession.semanticResizeObserver = null;
  if (typeof ResizeObserver !== "function" || !overlay) return;
  captionSession.semanticResizeObserver = new ResizeObserver(() => {
    const width = semanticDisplayWidth();
    if (!captionSession.semanticLayoutWidth || width !== captionSession.semanticLayoutWidth) {
      scheduleDeepseekDisplayReflow(true);
    }
  });
  captionSession.semanticResizeObserver.observe(overlay);
}

function maybeReflowSemanticDisplay() {
  if (!captionSession.deepseekUnitCache.size) return;
  const width = semanticDisplayWidth();
  if (!captionSession.semanticLayoutWidth || width !== captionSession.semanticLayoutWidth) {
    scheduleDeepseekDisplayReflow(true);
  }
}
