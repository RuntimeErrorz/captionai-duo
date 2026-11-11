// Cue timing and semantic window planning helpers.
(() => {
  "use strict";
  if (globalThis.YTDS_SHARED) return;
  const internal = globalThis["__captionAiDuoSharedModulesV1__"];
  if (!internal) throw new Error("CaptionAI shared modules loaded out of order");

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
          timed.push({
            word: word[0],
            offsetMs: Number(part && part.offsetMs),
            durationMs: Number(part && part.durationMs)
          });
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

      const positiveIntervals = [];
      for (let index = 0; index + 1 < starts.length; index++) {
        const interval = starts[index + 1] - starts[index];
        if (Number.isFinite(interval) && interval > 0) positiveIntervals.push(interval);
      }
      const orderedIntervals = positiveIntervals.slice().sort((a, b) => a - b);
      const middle = Math.floor(orderedIntervals.length / 2);
      const typicalInterval = orderedIntervals.length
        ? orderedIntervals.length % 2 ? orderedIntervals[middle]
          : (orderedIntervals[middle - 1] + orderedIntervals[middle]) / 2 : 0;
      const pauseAfter = (index, atomStart, nextStart) => {
        if (!useTimedOffsets || index >= starts.length - 1) return 0;
        const interval = Math.max(0, nextStart - atomStart);
        const durationMs = Number(timed[index] && timed[index].durationMs);
        if (Number.isFinite(durationMs) && durationMs > 0) {
          return Math.max(0, nextStart - Math.min(end, atomStart + durationMs));
        }
        // JSON3 normally exposes word onsets but not word durations. Treat a
        // large outlier in those onsets as timing evidence. The robust local
        // baseline prevents uniformly slow speech from becoming a fabricated
        // boundary, while preserving a real one-second onset gap such as the
        // common ASR shape where the first segment has an implicit zero offset.
        if (positiveIntervals.length < 3 || !typicalInterval ||
            interval < Math.max(900, typicalInterval * 2.5)) return 0;
        // Without word durations the exact silence is unknowable. Keep the
        // observed onset gap as the conservative signal sent to the model;
        // it must not be erased merely because the preceding word's duration
        // was omitted by JSON3.
        return interval;
      };

      for (let index = 0; index < matches.length; index++) {
        const atomStart = starts[index];
        const nextStart = index + 1 < starts.length ? Math.max(atomStart, starts[index + 1]) : end;
        const durationMs = Number(timed[index] && timed[index].durationMs);
        const timedEnd = Number.isFinite(durationMs) && durationMs > 0
          ? Math.min(end, atomStart + durationMs) : nextStart;
        const atomEnd = index + 1 < starts.length
          ? Math.max(atomStart, Math.min(nextStart, timedEnd)) : end;
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
          timed: useTimedOffsets,
          pauseAfterMs: Math.round(pauseAfter(index, atomStart, nextStart))
        });
      }
    }
    // JSON3 events are often split at caption-window edges even when the
    // spoken stream is continuous. When both adjacent events carry reliable
    // word onsets, preserve an isolated onset outlier across that edge too;
    // the raw display-cue duration is allowed to overlap and is not enough.
    for (let index = 0; index + 1 < atoms.length; index++) {
      const current = atoms[index];
      const next = atoms[index + 1];
      if (!current || !next || current.sourceCueIndex === next.sourceCueIndex ||
          current.timed !== true || next.timed !== true) continue;
      const interval = Number(next.start) - Number(current.start);
      if (!Number.isFinite(interval) || interval <= 0) continue;
      const nearbyIntervals = [];
      const from = Math.max(0, index - 8);
      const through = Math.min(atoms.length - 2, index + 8);
      for (let neighbor = from; neighbor <= through; neighbor++) {
        if (neighbor === index) continue;
        const left = atoms[neighbor];
        const right = atoms[neighbor + 1];
        if (!left || !right || left.sourceCueIndex !== right.sourceCueIndex) continue;
        const value = Number(right.start) - Number(left.start);
        if (Number.isFinite(value) && value > 0) nearbyIntervals.push(value);
      }
      if (nearbyIntervals.length < 3) continue;
      nearbyIntervals.sort((a, b) => a - b);
      const middle = Math.floor(nearbyIntervals.length / 2);
      const typicalInterval = nearbyIntervals.length % 2
        ? nearbyIntervals[middle]
        : (nearbyIntervals[middle - 1] + nearbyIntervals[middle]) / 2;
      if (!typicalInterval || interval < Math.max(900, typicalInterval * 2.5)) continue;
      current.pauseAfterMs = Math.max(Number(current.pauseAfterMs) || 0,
        Math.round(interval));
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

  function semanticEffectiveGuardItems(itemCountValue, guardLimitValue) {
    const count = Math.max(0, Math.floor(Number(itemCountValue) || 0));
    const limit = Math.max(0, Math.floor(Number(guardLimitValue) || 0));
    return Math.min(limit, Math.floor(count / 3));
  }

  function semanticCommitRunwayItems(itemCountValue, guardLimitValue, minimumRunwayValue) {
    const effectiveGuard = semanticEffectiveGuardItems(itemCountValue, guardLimitValue);
    const minimumRunway = Math.max(0, Math.floor(Number(minimumRunwayValue) || 0));
    return Math.max(effectiveGuard, minimumRunway);
  }

  function semanticCommitGuardStart(
    cursorValue, requestEndValue, regionEndValue, guardItemsValue, minimumRunwayValue
  ) {
    const cursor = Math.floor(Number(cursorValue));
    const requestEnd = Math.floor(Number(requestEndValue));
    const regionEnd = Math.floor(Number(regionEndValue));
    const guardItems = Math.max(0, Math.floor(Number(guardItemsValue) || 0));
    const minimumRunway = Math.max(0, Math.floor(Number(minimumRunwayValue) || 0));
    if (!Number.isInteger(cursor) || !Number.isInteger(requestEnd) ||
        !Number.isInteger(regionEnd) || cursor < 0 || requestEnd < cursor ||
        regionEnd < requestEnd) {
      return cursor;
    }
    if (requestEnd >= regionEnd) return regionEnd + 1;
    const runway = Math.max(guardItems, minimumRunway);
    return Math.max(cursor, requestEnd - runway + 1);
  }

  // Select the immutable prefix that a rolling semantic request may commit.
  // The caller deliberately derives any deferred suffix from validated
  // coverage: every complete unit touching the trailing guard is carried to
  // the next request as a whole. Only a contiguous prefix beginning at cursor
  // can be returned, so no response can create a hole or overwrite an earlier
  // decision.
  function monotonicSemanticCommitPlan(
    translations, cursorValue, requestEndValue, regionEndValue, guardItemsValue,
    commitFloorValue, minimumRunwayItemsValue
  ) {
    const cursor = Math.floor(Number(cursorValue));
    const requestEnd = Math.floor(Number(requestEndValue));
    const regionEnd = Math.floor(Number(regionEndValue));
    const guardItems = Math.max(0, Math.floor(Number(guardItemsValue) || 0));
    const minimumRunwayItems = Math.max(0,
      Math.floor(Number(minimumRunwayItemsValue) || 0));
    const rawCommitFloor = commitFloorValue == null ? cursor : Math.floor(Number(commitFloorValue));
    const commitFloor = Math.max(cursor, Math.min(requestEnd, rawCommitFloor));
    if (!Number.isInteger(cursor) || !Number.isInteger(requestEnd) ||
        !Number.isInteger(regionEnd) || cursor < 0 || requestEnd < cursor ||
        regionEnd < requestEnd) {
      return { translations: [], units: [], commitStart: cursor, commitThrough: cursor - 1,
        carryStart: cursor, guardStart: cursor };
    }
    const guardStart = semanticCommitGuardStart(
      cursor, requestEnd, regionEnd, guardItems, minimumRunwayItems
    );
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
        // A recovered alignment chunk touches the guard when its sentence does.
        const sentenceStart = unit.items.reduce((lowest, item) => {
          const value = Number(item && item.sentenceStart);
          return Number.isInteger(value) ? Math.min(lowest, value) : lowest;
        }, first);
        if (last < commitFloor || sentenceStart < commitFloor) continue;
        if (commitFloor === cursor && first !== cursor) break;
        expected = first;
        started = true;
      }
      if (first !== expected) break;
      if (last >= guardStart) break;
      unit.items.sort((a, b) => Number(a.id) - Number(b.id));
      committedUnits.push({ unitId: unit.unitId, members: unit.members.slice() });
      for (const item of unit.items) {
        const committed = { ...item };
        delete committed.sentenceStart;
        committedTranslations.push(committed);
      }
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
  // request (or gap/intro prewarming with an idle safety island) may relocate it.
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
    const targetThrough = Number(state.targetThrough);
    const isIdle = !Number.isFinite(targetThrough) || targetThrough < cursor;
    return outsideIsland && (!!urgent || (!playbackActive && isIdle));
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
    // A speculative continuation may have enlarged windowItems while the
    // player was elsewhere. Keep urgent work bounded around its visible
    // target; an explicit guard-recovery expansion is marked by the content
    // owner and is allowed to use that larger window.
    const urgentWindowItems = urgent
      ? (state && state.recoveryWindowItems
        ? windowItems : Math.min(windowItems, initialUrgentItems))
      : windowItems;
    const effectiveMaxItems = urgent
      ? Math.min(maxItems, Math.max(urgentWindowItems, targetItems))
      : maxItems;
    return {
      targetThrough,
      itemCount: Math.min(effectiveMaxItems, Math.max(urgentWindowItems, targetItems))
    };
  }

  // Size a bridge window that reaches an already running future request:
  // after its private runway the committed prefix must touch futureStart.
  function semanticBridgeRequestItems(
    requestStartValue, futureStartValue, maxValue, limitEndValue, guardItemsValue, minRunwayValue
  ) {
    const requestStart = Math.floor(Number(requestStartValue));
    const futureStart = Math.floor(Number(futureStartValue));
    const maxItems = Math.max(1, Math.floor(Number(maxValue) || 1));
    const limitEnd = Math.floor(Number(limitEndValue));
    const guardItems = Math.max(0, Math.floor(Number(guardItemsValue) || 0));
    const minRunwayItems = Math.max(0, Math.floor(Number(minRunwayValue) || 0));
    if (![requestStart, futureStart, limitEnd].every(Number.isInteger) ||
        futureStart <= requestStart || requestStart > limitEnd) return 0;
    const gap = futureStart - requestStart;
    let count = Math.min(maxItems, limitEnd - requestStart + 1, gap + 1);
    while (count < maxItems && count < limitEnd - requestStart + 1 &&
        count - semanticCommitRunwayItems(count, guardItems, minRunwayItems) < gap) {
      count++;
    }
    const reachesEnd = requestStart + count - 1 >= limitEnd;
    const runway = reachesEnd ? 0 : semanticCommitRunwayItems(count, guardItems, minRunwayItems);
    if (!reachesEnd && count - runway < gap) return 0;
    return count;
  }

  // The whole window decision of one commit-lane request, from plain
  // numbers. The content scheduler, the simulator and the tests all run this
  // one function, so a tuning change is measured exactly as it ships.
  //   state: { windowItems, recoveryWindowItems, urgentTarget, targetThrough }
  //   urgent, requestStart, limitEnd,
  //   futureStart (start of a live future request, or -1), guardItems,
  //   minRunwayItems, maxRequestItems, targetTailItems,
  //   urgentWindowItems, urgentRequestItems (recovery), acceleratedPrefetchItems
  function semanticCommitWindowPlan(input) {
    const value = input && typeof input === "object" ? input : {};
    const state = value.state && typeof value.state === "object" ? value.state : {};
    const count = (raw, fallback) => {
      const parsed = Math.floor(Number(raw));
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const requestStart = count(value.requestStart, 0);
    const limitEnd = count(value.limitEnd, requestStart);
    const guardItems = Math.max(0, count(value.guardItems, 0));
    const minRunwayItems = Math.max(0, count(value.minRunwayItems, 0));
    const maxRequestItems = Math.max(1, count(value.maxRequestItems, 1));
    const targetTailItems = Math.max(0, count(value.targetTailItems, 0));
    const windowItems = Math.max(1, count(state.windowItems, 1));
    const recoveryWindow = !!state.recoveryWindowItems;
    const requestUrgent = !!value.urgent || count(state.urgentTarget, -1) >= requestStart;
    // Visible work uses its own window and keeps no target tail: the window
    // already reaches well past the subtitle. Only a recovery window, sized
    // by the failure it recovers from, plans its tail around the target.
    const windowedUrgent = requestUrgent && !recoveryWindow;
    const urgentWindowItems = Math.max(0, count(value.urgentWindowItems, 0));
    const urgentTailItems = windowedUrgent ? 0 : targetTailItems;
    const acceleratedPrefetchItems = requestUrgent
      ? 0 : Math.max(0, count(value.acceleratedPrefetchItems, 0));
    const planningWindowItems = Math.max(
      windowedUrgent ? Math.max(windowItems, urgentWindowItems) : windowItems,
      acceleratedPrefetchItems
    );
    const planningState = planningWindowItems > windowItems
      ? { ...state, windowItems: planningWindowItems } : state;
    const initialUrgentItems = windowedUrgent
      ? urgentWindowItems : count(value.urgentRequestItems, maxRequestItems);
    const requestPlan = semanticCommitRequestPlan(
      planningState, requestStart, guardItems, maxRequestItems, requestUrgent,
      initialUrgentItems, urgentTailItems
    );
    let requestEnd = Math.min(limitEnd, requestStart + requestPlan.itemCount - 1);
    const futureStart = count(value.futureStart, -1);
    let bridgeItems = 0;
    if (!recoveryWindow && futureStart > requestStart && futureStart <= requestEnd) {
      bridgeItems = semanticBridgeRequestItems(
        requestStart, futureStart, maxRequestItems, limitEnd, guardItems, minRunwayItems
      );
      if (bridgeItems > 0) requestEnd = Math.min(limitEnd, requestStart + bridgeItems - 1);
    }
    // The trailing runway is never committed, so a shorter window can only
    // buy a no-progress round trip; only the region's own end may cut it.
    const minUsefulItems = Math.min(maxRequestItems, 2 * Math.max(guardItems, minRunwayItems));
    if (requestEnd - requestStart + 1 < minUsefulItems) {
      requestEnd = Math.min(limitEnd, requestStart + minUsefulItems - 1);
    }
    return {
      requestUrgent,
      requestEnd,
      targetAwareItems: requestPlan.itemCount,
      targetThrough: requestPlan.targetThrough,
      bridgeItems,
      futureStart
    };
  }

  function pendingTranslationScopeKey(groupIndex, groupToBatch) {
    const group = Math.floor(Number(groupIndex));
    if (!Number.isInteger(group) || group < 0) return "";
    const batch = Array.isArray(groupToBatch) ? Number(groupToBatch[group]) : NaN;
    return Number.isInteger(batch) && batch >= 0
      ? `ai-batch:${batch}` : `ai-group:${group}`;
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

  function aiConcurrencyStatus(activeValue, maxActiveValue, urgentValue) {
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

  Object.assign(internal, { cuePauseMs, semanticPauseKind, mergeTimedCueTexts, cueReferenceAtoms, referenceBatchWindows, semanticEffectiveGuardItems, semanticCommitRunwayItems, semanticCommitGuardStart, monotonicSemanticCommitPlan, shouldReseedSemanticCommitState, semanticCommitRequestPlan, semanticBridgeRequestItems, semanticCommitWindowPlan, pendingTranslationScopeKey, semanticPrefetchBatchStarts, aiConcurrencyStatus });
})();
