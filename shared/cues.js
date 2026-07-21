// YouTube URL, cue timing and semantic window planning helpers.
(() => {
  "use strict";
  if (globalThis.YTDS_SHARED) return;
  const internal = globalThis["__captionAiDuoSharedModulesV1__"];
  if (!internal) throw new Error("CaptionAI shared modules loaded out of order");

  function videoIdFromUrl(href) {
    try {
      const u = new URL(href);
      const fromQuery = u.searchParams.get("v") || "";
      if (/^[A-Za-z0-9_-]{6,32}$/.test(fromQuery)) return fromQuery;
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,32})(?:\/|$)/);
      return m ? m[1] : "";
    } catch (_e) {
      return "";
    }
  }

  function isYoutubePageUrl(href) {
    try {
      const u = new URL(href);
      return u.protocol === "https:" &&
        (u.hostname === "www.youtube.com" || u.hostname === "youtube.com");
    } catch (_e) {
      return false;
    }
  }

  // Chrome may retain the document's original sender.url across a YouTube SPA
  // navigation while sender.tab.url already points at the current video.  A
  // restored/home document can also have no video id in either URL.  Accept a
  // well-formed id when at least one candidate is a trusted YouTube page.  The
  // first candidate with an id is authoritative (background passes tab.url
  // first); a restored/home URL without an id is safe to fall through.
  function videoIdMatchesPageUrls(videoId, hrefs) {
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(String(videoId || ""))) return false;
    const youtubeUrls = Array.isArray(hrefs) ? hrefs.filter(isYoutubePageUrl) : [];
    if (!youtubeUrls.length) return false;
    const currentUrlId = youtubeUrls.map(videoIdFromUrl).find(Boolean);
    return !currentUrlId || currentUrlId === videoId;
  }

  function isAllowedTimedtextUrl(value) {
    try {
      const u = new URL(value, "https://www.youtube.com/");
      return u.protocol === "https:" &&
        (u.hostname === "www.youtube.com" || u.hostname === "youtube.com") &&
        u.pathname === "/api/timedtext";
    } catch (_e) {
      return false;
    }
  }

  function cuePauseMs(cue, nextCue) {
    const start = Number(cue && cue.start);
    const nextStart = Number(nextCue && nextCue.start);
    if (!Number.isFinite(start) || !Number.isFinite(nextStart)) return 0;
    const candidates = [start];
    const end = Number(cue && cue.end);
    const dur = Number(cue && cue.dur);
    const lastOff = Number(cue && cue.lastOff);
    if (Number.isFinite(end)) candidates.push(end);
    if (Number.isFinite(dur) && dur >= 0) candidates.push(start + dur);
    if (Number.isFinite(lastOff)) candidates.push(lastOff);
    // Using the latest reliable endpoint prevents an ASR cue whose lastOff is
    // missing/early from turning a visibly overlapping next cue into a pause.
    return nextStart - Math.max(...candidates);
  }

  function semanticPauseKind(value, softMsValue, hardMsValue) {
    const pauseMs = Math.max(0, Number(value) || 0);
    const softMs = Math.max(0, Number(softMsValue) || 900);
    const hardMs = Math.max(softMs, Number(hardMsValue) || 4000);
    if (pauseMs >= hardMs) return "hard";
    if (pauseMs >= softMs) return "soft";
    return "none";
  }

  function mergeTimedCueTexts(cues) {
    const list = Array.isArray(cues) ? cues.filter(Boolean) : [];
    if (!list.length) return "";
    let merged = String(list[0].text || "");
    let previous = list[0];
    const norm = (value) => String(value || "").toLocaleLowerCase()
      .replace(/^[\s.,!?;:'"“”‘’]+|[\s.,!?;:'"“”‘’]+$/g, "");
    const startOf = (cue) => Number(cue && (cue.start != null ? cue.start : cue.startMs));
    const endOf = (cue) => {
      const direct = Number(cue && (cue.end != null ? cue.end : cue.endMs));
      if (Number.isFinite(direct)) return direct;
      const start = startOf(cue);
      const duration = Number(cue && cue.dur);
      return Number.isFinite(start) && Number.isFinite(duration) ? start + duration : start;
    };

    for (let i = 1; i < list.length; i++) {
      const cue = list[i];
      const words = String(cue.text || "").split(/\s+/).filter(Boolean);
      const priorWords = merged.split(/\s+/).filter(Boolean);
      let overlap = 0;
      const cueStart = startOf(cue);
      const previousEnd = endOf(previous);
      const timedOverlap = Number.isFinite(cueStart) && Number.isFinite(previousEnd) &&
        cueStart < previousEnd - 80;
      if (timedOverlap && priorWords.length && words.length) {
        const maximum = Math.min(priorWords.length, words.length, 24);
        for (let count = maximum; count >= 1; count--) {
          let same = true;
          for (let offset = 0; offset < count; offset++) {
            if (norm(priorWords[priorWords.length - count + offset]) !== norm(words[offset])) {
              same = false;
              break;
            }
          }
          if (same) {
            overlap = count;
            break;
          }
        }
      }
      const novel = words.slice(overlap).join(" ");
      if (novel) {
        const punctuation = /^[,.;:!?。，；：！？、)）\]】}」』]/.test(novel);
        const cjkJoin = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]$/.test(merged) &&
          /^[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(novel);
        merged = `${merged}${punctuation || cjkJoin ? "" : " "}${novel}`
          .replace(/\s+/g, " ").trim();
      }
      previous = cue;
    }
    return merged.trim();
  }

  // Produce addressable lexical reference atoms without making any semantic
  // boundary decision. YouTube ASR word offsets are used when their token
  // sequence matches the normalized cue; otherwise positions are interpolated
  // inside the original cue. DeepSeek remains free to group any contiguous ids.
  function cueReferenceAtoms(cues) {
    const list = Array.isArray(cues) ? cues : [];
    const atoms = [];
    for (let cueIndex = 0; cueIndex < list.length; cueIndex++) {
      const cue = list[cueIndex] || {};
      const text = String(cue.text || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const lexicalMatches = (value) => {
        if (/\s/u.test(value)) return Array.from(value.matchAll(/\S+/gu));
        if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
          const segments = Array.from(new Intl.Segmenter(undefined, { granularity: "word" }).segment(value));
          const visible = segments.filter((segment) => /\S/u.test(segment.segment));
          if (visible.length) {
            return visible.map((segment) => ({ 0: segment.segment, index: segment.index }));
          }
        }
        const chars = [];
        let index = 0;
        for (const char of Array.from(value)) {
          chars.push({ 0: char, index });
          index += char.length;
        }
        return chars;
      };
      const matches = lexicalMatches(text);
      if (!matches.length) continue;

      const timed = [];
      for (const part of Array.isArray(cue.parts) ? cue.parts : []) {
        const words = lexicalMatches(String(part && part.text || "").replace(/\s+/g, " ").trim());
        for (const word of words) {
          timed.push({ word: word[0], offsetMs: Number(part && part.offsetMs) });
        }
      }
      const exactTimedSequence = timed.length === matches.length && timed.every((part, index) =>
        part.word === matches[index][0] && Number.isFinite(part.offsetMs) && part.offsetMs >= 0
      );

      const start = Number(cue.start);
      const rawEnd = Number(cue.end);
      const duration = Number(cue.dur);
      const naturalEnd = Number.isFinite(rawEnd) ? rawEnd
        : Number.isFinite(start) && Number.isFinite(duration) ? start + Math.max(0, duration)
        : start;
      const nextStart = Number(list[cueIndex + 1] && list[cueIndex + 1].start);
      // YouTube rolling cues usually overlap because each cue remains in the
      // two-line caption window after its text has been spoken. The next cue's
      // start is the actual replacement boundary for this cue's source text.
      const end = Number.isFinite(start) && Number.isFinite(nextStart) && nextStart > start
        ? Math.min(naturalEnd, nextStart) : naturalEnd;
      const span = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
      const useTimedOffsets = exactTimedSequence && timed.every((part) => part.offsetMs <= span);
      const starts = [];
      for (let index = 0; index < matches.length; index++) {
        const fallback = Number.isFinite(start)
          ? start + span * matches[index].index / Math.max(1, text.length) : start;
        let value = useTimedOffsets ? start + timed[index].offsetMs : fallback;
        if (!Number.isFinite(value)) value = fallback;
        value = Math.max(start, Math.min(end, value));
        if (index && value <= starts[index - 1] && starts[index - 1] < end) {
          const remaining = Math.max(1, matches.length - index);
          value = Math.min(end, starts[index - 1] + Math.max(1, (end - starts[index - 1]) / remaining));
        }
        starts.push(value);
      }

      for (let index = 0; index < matches.length; index++) {
        const atomStart = starts[index];
        const atomEnd = index + 1 < starts.length ? Math.max(atomStart, starts[index + 1]) : end;
        atoms.push({
          ...cue,
          parts: undefined,
          text: matches[index][0],
          start: atomStart,
          end: atomEnd,
          dur: Math.max(0, atomEnd - atomStart),
          lastOff: atomEnd,
          sourceCueIndex: cueIndex,
          sourceCuePart: index,
          sourceCueParts: matches.length,
          timed: useTimedOffsets
        });
      }
    }
    return atoms;
  }

  // Plan disjoint transport cores directly on lexical coordinates. Original
  // YouTube cues can contain wildly different token counts, so cue-count caps
  // do not bound API payloads. The core/request limits below are transport
  // limits only; DeepSeek still owns every semantic boundary and may defer an
  // incomplete suffix for the following rolling request.
  function referenceBatchWindows(
    cues, atoms, preferredSize, maxSize, protectAdjacentWindows, limitsValue
  ) {
    const atomList = Array.isArray(atoms) ? atoms : [];
    if (!atomList.length) return [];
    const limits = limitsValue && typeof limitsValue === "object" ? limitsValue : {};
    const coreItems = Math.max(1, Math.min(300,
      Math.floor(Number(limits.coreItems) || atomList.length)));
    const requestItems = Math.max(coreItems, Math.min(300,
      Math.floor(Number(limits.requestItems) ||
        (protectAdjacentWindows ? coreItems * 2 : coreItems))));
    const windows = [];
    for (let start = 0; start < atomList.length; start += coreItems) {
      const end = Math.min(atomList.length - 1, start + coreItems - 1);
      windows.push({
        start,
        end,
        requestStart: start,
        requestEnd: Math.min(atomList.length - 1, start + requestItems - 1)
      });
    }
    return windows;
  }

  // Overlapping request windows translate protection tokens on both sides of
  // a disjoint core. A semantic unit belongs to the core containing its first
  // token; accepting the entire owned unit preserves cross-boundary phrases,
  // while filtering non-owned units prevents duplicate/racing cache writes.
  function ownedSemanticTranslations(translations, coreStart, coreEnd) {
    const list = Array.isArray(translations) ? translations.filter(Boolean) : [];
    const start = Math.floor(Number(coreStart));
    const end = Math.floor(Number(coreEnd));
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return [];
    const units = new Map();
    for (const item of list) {
      const id = Number(item && item.id);
      if (!Number.isInteger(id) || id < 0) continue;
      const unitId = String(item && item.unitId || `causal-${id}`);
      const unit = units.get(unitId) || { first: id, items: [] };
      unit.first = Math.min(unit.first, id);
      unit.items.push(item);
      units.set(unitId, unit);
    }
    const owned = [];
    for (const unit of units.values()) {
      if (unit.first < start || unit.first > end) continue;
      owned.push(...unit.items);
    }
    return owned.sort((a, b) => Number(a.id) - Number(b.id));
  }

  // Select the immutable prefix that a rolling semantic request may commit.
  // The caller deliberately distrusts model-provided deferred_ids: every
  // complete unit touching the trailing guard is carried to the next request
  // as a whole. Only a contiguous prefix beginning at cursor can be returned,
  // so no response can create a hole or overwrite an earlier decision.
  function monotonicSemanticCommitPlan(
    translations, cursorValue, requestEndValue, regionEndValue, guardItemsValue,
    commitFloorValue
  ) {
    const cursor = Math.floor(Number(cursorValue));
    const requestEnd = Math.floor(Number(requestEndValue));
    const regionEnd = Math.floor(Number(regionEndValue));
    const guardItems = Math.max(0, Math.floor(Number(guardItemsValue) || 0));
    const rawCommitFloor = commitFloorValue == null ? cursor : Math.floor(Number(commitFloorValue));
    const commitFloor = Math.max(cursor, Math.min(requestEnd, rawCommitFloor));
    if (!Number.isInteger(cursor) || !Number.isInteger(requestEnd) ||
        !Number.isInteger(regionEnd) || cursor < 0 || requestEnd < cursor ||
        regionEnd < requestEnd) {
      return { translations: [], units: [], commitStart: cursor, commitThrough: cursor - 1,
        carryStart: cursor, guardStart: cursor };
    }
    const guardStart = requestEnd >= regionEnd
      ? regionEnd + 1
      : Math.max(cursor, requestEnd - guardItems + 1);
    const ordered = Array.isArray(translations) ? translations : [];
    const units = [];
    const unitById = new Map();
    for (const item of ordered) {
      const id = Number(item && item.id);
      if (!Number.isInteger(id) || id < cursor || id > requestEnd || !item.translation) continue;
      const unitId = String(item.unitId || `semantic-${id}-${id}`);
      let unit = unitById.get(unitId);
      if (!unit) {
        unit = { unitId, items: [], members: [] };
        unitById.set(unitId, unit);
        units.push(unit);
      }
      unit.items.push(item);
      unit.members.push(id);
    }

    const committedUnits = [];
    const committedTranslations = [];
    let expected = commitFloor;
    let started = false;
    for (const unit of units) {
      unit.members.sort((a, b) => a - b);
      let contiguous = true;
      for (let i = 0; i < unit.members.length; i++) {
        if (unit.members[i] !== unit.members[0] + i ||
            (i > 0 && unit.members[i] === unit.members[i - 1])) {
          contiguous = false;
          break;
        }
      }
      if (!contiguous) break;
      const first = unit.members[0];
      const last = unit.members[unit.members.length - 1];
      if (!started) {
        // Units wholly inside the left read-only guard, plus the one touching
        // its boundary, provide context but can never become committed output.
        if (last < commitFloor || first < commitFloor) continue;
        if (commitFloor === cursor && first !== cursor) break;
        expected = first;
        started = true;
      }
      if (first !== expected) break;
      if (last >= guardStart) break;
      unit.items.sort((a, b) => Number(a.id) - Number(b.id));
      committedUnits.push({ unitId: unit.unitId, members: unit.members.slice() });
      committedTranslations.push(...unit.items);
      expected = last + 1;
    }
    return {
      translations: committedTranslations,
      units: committedUnits,
      commitStart: committedUnits.length ? committedUnits[0].members[0] : commitFloor,
      commitThrough: expected - 1,
      carryStart: committedUnits.length ? expected : cursor,
      guardStart
    };
  }

  // A speculative look-ahead must never move the only commit cursor away from
  // the subtitle currently being watched. It may extend targetThrough and be
  // consumed sequentially by the existing island, but only an urgent playback
  // request (or gap/intro prewarming with no active subtitle) may relocate it.
  function shouldReseedSemanticCommitState(
    currentMissing, targetGroup, state, maxDistance, urgent, playbackActive
  ) {
    if (!currentMissing || !state) return false;
    const target = Number(targetGroup);
    const cursor = Number(state.cursor);
    const commitFloor = Number(state.commitFloor);
    const limitEnd = Number(state.limitEnd);
    const distance = Math.max(1, Math.floor(Number(maxDistance) || 1));
    if (![target, cursor, commitFloor, limitEnd].every(Number.isFinite)) return false;
    const outsideIsland = target < commitFloor || target >= cursor + distance || target > limitEnd;
    return outsideIsland && (!!urgent || !playbackActive);
  }

  // Urgent playback work is sized around the one subtitle currently needed.
  // Speculative targetThrough may be much farther ahead and is resumed after
  // that subtitle is covered. A separate target tail keeps the visible unit
  // away from the trailing commit guard: without it, a seek target placed
  // immediately before the guard forces any ordinary sentence continuing past
  // the target into a second request. Very long units still use adaptive
  // expansion and remain bounded by maxItems.
  function semanticCommitRequestPlan(
    state, requestStartValue, guardItemsValue, maxItemsValue, urgent,
    initialUrgentItemsValue, urgentTargetTailItemsValue
  ) {
    const requestStart = Math.max(0, Math.floor(Number(requestStartValue) || 0));
    const guardItems = Math.max(0, Math.floor(Number(guardItemsValue) || 0));
    const maxItems = Math.max(1, Math.floor(Number(maxItemsValue) || 1));
    const windowItems = Math.max(1, Math.floor(Number(state && state.windowItems) || 1));
    const initialUrgentItems = Math.max(1,
      Math.floor(Number(initialUrgentItemsValue) || maxItems));
    const urgentTargetTailItems = urgent
      ? Math.max(0, Math.floor(Number(urgentTargetTailItemsValue) || 0)) : 0;
    const target = Math.floor(Number(urgent
      ? state && state.urgentTarget : state && state.targetThrough));
    const targetThrough = Number.isFinite(target) ? Math.max(requestStart - 1, target) : requestStart - 1;
    const targetItems = Math.max(0, targetThrough - requestStart + 1) +
      guardItems + urgentTargetTailItems;
    const effectiveMaxItems = urgent
      ? Math.min(maxItems, Math.max(windowItems, initialUrgentItems, targetItems))
      : maxItems;
    return {
      targetThrough,
      // windowItems is also the adaptive recovery size. Never clamp it back to
      // the cold-start size after a guard-crossing unit requested expansion.
      itemCount: Math.min(effectiveMaxItems, Math.max(windowItems, targetItems))
    };
  }

  // Select one canonical, non-overlapping semantic timeline from responses
  // produced by overlapping API windows. Later cores are intentionally held
  // until their immediate predecessor has answered: otherwise a fast response
  // for the later core could briefly paint a boundary fragment, only to be
  // replaced by the complete unit from the predecessor a moment later.
  //
  // Ordering is derived only from source coordinates, never response arrival
  // order. At an overlap, the unit with the earliest source start owns the
  // boundary. A longer unit wins an equal start, which also makes retries that
  // recover a complete phrase dominate a truncated version deterministically.
  function canonicalSemanticUnits(candidates, settledBatches) {
    const settled = settledBatches && typeof settledBatches.has === "function"
      ? settledBatches : new Set(Array.isArray(settledBatches) ? settledBatches : []);
    const normalized = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (!candidate) continue;
      const members = Array.from(new Set((Array.isArray(candidate.members) ? candidate.members : [])
        .map(Number).filter((id) => Number.isInteger(id) && id >= 0))).sort((a, b) => a - b);
      if (!members.length) continue;
      const batchIndex = Math.floor(Number(candidate.batchIndex));
      if (!Number.isInteger(batchIndex) || batchIndex < 0) continue;
      // Only the first unit owned by a core can be a fragment of something
      // that began in the previous core. Holding every unit would needlessly
      // delay safe subtitles in the middle of the current window.
      if (candidate.boundaryCandidate && batchIndex > 0 && !settled.has(batchIndex - 1)) continue;
      normalized.push({
        ...candidate,
        batchIndex,
        members,
        first: members[0],
        last: members[members.length - 1]
      });
    }
    normalized.sort((a, b) =>
      a.first - b.first ||
      b.last - a.last ||
      a.batchIndex - b.batchIndex ||
      String(a.unitId || "").localeCompare(String(b.unitId || ""))
    );
    const selected = [];
    let occupiedThrough = -1;
    for (const candidate of normalized) {
      if (candidate.first <= occupiedThrough) continue;
      selected.push(candidate);
      occupiedThrough = candidate.last;
    }
    return selected;
  }

  function pendingTranslationScopeKey(groupIndex, groupToBatch) {
    const group = Math.floor(Number(groupIndex));
    if (!Number.isInteger(group) || group < 0) return "";
    const batch = Array.isArray(groupToBatch) ? Number(groupToBatch[group]) : NaN;
    return Number.isInteger(batch) && batch >= 0
      ? `deepseek-batch:${batch}` : `deepseek-group:${group}`;
  }

  function semanticCoverageGaps(units, rangeStart, rangeEnd) {
    const start = Math.floor(Number(rangeStart));
    const end = Math.floor(Number(rangeEnd));
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return [];
    const covered = new Set();
    for (const unit of Array.isArray(units) ? units : []) {
      for (const value of Array.isArray(unit && unit.members) ? unit.members : []) {
        const id = Number(value);
        if (Number.isInteger(id) && id >= start && id <= end) covered.add(id);
      }
    }
    const gaps = [];
    for (let id = start; id <= end;) {
      if (covered.has(id)) { id++; continue; }
      const gapStart = id;
      while (id <= end && !covered.has(id)) id++;
      gaps.push({ start: gapStart, end: id - 1 });
    }
    return gaps;
  }

  // Reassemble lexical references by their original player cue. This is used
  // only when semantic batch validation fails, so the safety fallback remains
  // cue-level instead of producing unusable word-by-word translations.
  function groupReferenceItemsByCue(items) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const groups = [];
    for (const item of list) {
      const cueId = String(item.cueId == null ? "" : item.cueId);
      let group = groups[groups.length - 1];
      if (!group || group.cueId !== cueId) {
        group = { cueId, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    return groups.map((group) => ({
      cueId: group.cueId,
      ids: group.items.map((item) => String(item.id)),
      items: group.items,
      text: mergeTimedCueTexts(group.items)
    }));
  }

  const SEMANTIC_SENTENCE_END_RE = /[.!?…。！？]["'“”‘’」』》】)）\]]?\s*$/;

  function semanticBoundaryAfter(cues, index) {
    if (index >= cues.length - 1) return true;
    const cue = cues[index] || {};
    return cuePauseMs(cue, cues[index + 1]) > 900 ||
      SEMANTIC_SENTENCE_END_RE.test(String(cue.text || ""));
  }

  // Keep the usual request compact, but never force a cut at that preferred
  // size when the next few YouTube atoms complete the same sentence. This is
  // important because future context is read-only: DeepSeek may use it to
  // understand an item but cannot merge a future-context id into its output.
  function semanticBatchWindows(cues, preferredSize, maxSize) {
    const list = Array.isArray(cues) ? cues : [];
    if (!list.length) return [];
    const preferred = Math.max(2, Math.floor(Number(preferredSize) || 6));
    const maximum = Math.max(preferred, Math.floor(Number(maxSize) || 10));
    const windows = [];

    for (let start = 0; start < list.length;) {
      const preferredEnd = Math.min(list.length - 1, start + preferred - 1);
      let end = preferredEnd;
      let foundBoundary = preferredEnd >= list.length - 1;

      if (!foundBoundary) {
        // Preserve the prior behavior when a clean sentence/pause boundary is
        // already available in the compact preferred window.
        for (let i = preferredEnd; i >= start + 1; i--) {
          if (semanticBoundaryAfter(list, i)) {
            end = i;
            foundBoundary = true;
            break;
          }
        }
      }

      if (!foundBoundary) {
        // No safe cut exists at or before the preferred edge. Look forward for
        // the first natural ending, with a strict cap to bound latency/cost.
        const extendedEnd = Math.min(list.length - 1, start + maximum - 1);
        end = extendedEnd;
        for (let i = preferredEnd + 1; i <= extendedEnd; i++) {
          if (semanticBoundaryAfter(list, i)) {
            end = i;
            break;
          }
        }
      }

      windows.push({ start, end });
      start = end + 1;
    }
    return windows;
  }

  // Return the starts of the next distinct semantic request windows. Looking
  // ahead by raw cue/group count is not enough: several adjacent groups often
  // belong to the same already in-flight DeepSeek batch and therefore do not
  // warm any future network request.
  function semanticPrefetchBatchStarts(groupIndex, groupToBatch, windows, ahead) {
    const mapping = Array.isArray(groupToBatch) ? groupToBatch : [];
    const batches = Array.isArray(windows) ? windows : [];
    const group = Math.floor(Number(groupIndex));
    const count = Math.max(0, Math.floor(Number(ahead) || 0));
    if (!Number.isInteger(group) || group < 0 || group >= mapping.length || !count) return [];
    const currentBatch = mapping[group];
    if (!Number.isInteger(currentBatch) || currentBatch < 0 || currentBatch >= batches.length) return [];
    const starts = [];
    for (let i = currentBatch + 1; i < batches.length && starts.length < count; i++) {
      const start = batches[i] && batches[i].start;
      if (Number.isInteger(start) && start >= 0) starts.push(start);
    }
    return starts;
  }

  function deepSeekConcurrencyStatus(activeValue, maxActiveValue, urgentValue) {
    const active = Math.max(0, Math.floor(Number(activeValue) || 0));
    const maxActive = Math.max(1, Math.floor(Number(maxActiveValue) || 1));
    // The local cap protects speculative prefetch only. The subtitle currently
    // being watched must never wait behind stale look-ahead work; remote 429s
    // are still handled by the real API retry path.
    if (urgentValue) return { allowed: true, reason: "urgent-bypass", retryAfterMs: 0 };
    return active < maxActive
      ? { allowed: true, reason: "", retryAfterMs: 0 }
      : { allowed: false, reason: "local-concurrency", retryAfterMs: 1500 };
  }

  Object.assign(internal, { videoIdFromUrl, isYoutubePageUrl, videoIdMatchesPageUrls, isAllowedTimedtextUrl, cuePauseMs, semanticPauseKind, mergeTimedCueTexts, cueReferenceAtoms, referenceBatchWindows, ownedSemanticTranslations, monotonicSemanticCommitPlan, shouldReseedSemanticCommitState, semanticCommitRequestPlan, canonicalSemanticUnits, pendingTranslationScopeKey, semanticCoverageGaps, groupReferenceItemsByCue, semanticBatchWindows, semanticPrefetchBatchStarts, deepSeekConcurrencyStatus });
})();
