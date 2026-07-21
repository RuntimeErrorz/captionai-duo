// Pixel-aware subtitle display and pagination helpers.
(() => {
  "use strict";
  if (globalThis.YTDS_SHARED) return;
  const internal = globalThis["__captionAiDuoSharedModulesV1__"];
  if (!internal) throw new Error("CaptionAI shared modules loaded out of order");
  const { mergeTimedCueTexts, joinTranslatedParts } = internal;

  function alignedChunkDisplayPlan(
    chunksValue, maxSourceWidthValue, maxTranslationWidthValue,
    measureSource, measureTranslation, targetLang, sourceLocale
  ) {
    const chunks = (Array.isArray(chunksValue) ? chunksValue : []).map((chunk) => ({
      ids: Array.isArray(chunk && chunk.ids) ? chunk.ids.map(String) : [],
      cues: Array.isArray(chunk && chunk.cues) ? chunk.cues.filter(Boolean) : [],
      source: String(chunk && chunk.source || "").trim(),
      translation: String(chunk && chunk.translation || "").trim()
    })).filter((chunk) => chunk.ids.length && chunk.translation);
    if (!chunks.length) return { pages: [], memberPages: {}, overflow: false };
    const sourceLimit = Math.max(1, Number(maxSourceWidthValue) || 1);
    const translationLimit = Math.max(1, Number(maxTranslationWidthValue) || 1);
    const sourceMeasure = typeof measureSource === "function"
      ? (text) => Math.max(0, Number(measureSource(text)) || 0)
      : (text) => String(text).length;
    const translationMeasure = typeof measureTranslation === "function"
      ? (text) => Math.max(0, Number(measureTranslation(text)) || 0)
      : (text) => String(text).length;
    const textFor = (pageChunks) => {
      const cues = pageChunks.flatMap((chunk) => chunk.cues);
      const source = cues.length
        ? mergeTimedCueTexts(cues)
        : pageChunks.map((chunk) => chunk.source).filter(Boolean).join(" ").trim();
      const translation = joinTranslatedParts(
        pageChunks.map((chunk) => chunk.translation), targetLang
      );
      return { source, translation };
    };

    const memberPages = {};
    const pages = [];
    let current = [];
    const flushCurrent = () => {
      if (!current.length) return;
      const page = pages.length;
      const text = textFor(current);
      const ids = current.flatMap((chunk) => chunk.ids);
      for (const id of ids) memberPages[id] = page;
      pages.push({ ...text, ids, chunkCount: current.length });
      current = [];
    };

    const splitOversizedChunk = (chunk) => {
      if (chunk.ids.length < 2) return null;
      const text = textFor([chunk]);
      const sourceWidth = sourceMeasure(text.source);
      const translationWidth = translationMeasure(text.translation);
      const minimumPages = Math.max(2,
        Math.ceil(sourceWidth / sourceLimit),
        Math.ceil(translationWidth / translationLimit));
      const maximumPages = chunk.ids.length;
      for (let requested = Math.min(maximumPages, minimumPages);
           requested <= maximumPages; requested++) {
        const localPlan = semanticDisplayPlan(
          text.source,
          text.translation,
          chunk.cues.map((cue) => String(cue && cue.text || "")),
          requested,
          sourceMeasure,
          translationMeasure,
          sourceLocale,
          targetLang
        );
        const sourcePages = localPlan.sourcePages;
        const translationPages = localPlan.translationPages;
        const pageCount = Math.max(sourcePages.length, translationPages.length);
        if (pageCount < 2) continue;
        const localPages = Array.from({ length: pageCount }, (_value, page) => {
          const sourcePage = sourcePages.length <= 1 ? 0
            : Math.round(page * (sourcePages.length - 1) / (pageCount - 1));
          const translationPage = translationPages.length <= 1 ? 0
            : Math.round(page * (translationPages.length - 1) / (pageCount - 1));
          return {
            source: sourcePages[sourcePage] && sourcePages[sourcePage].text || text.source,
            translation: translationPages[translationPage] &&
              translationPages[translationPage].text || text.translation,
            ids: [],
            chunkCount: 1,
            splitChunk: true
          };
        });
        for (let ordinal = 0; ordinal < chunk.ids.length; ordinal++) {
          const sourcePage = Number(localPlan.assignments[ordinal]);
          const page = sourcePages.length > 1 && Number.isInteger(sourcePage)
            ? Math.round(sourcePage * (pageCount - 1) / (sourcePages.length - 1))
            : Math.min(pageCount - 1,
              Math.floor(ordinal * pageCount / chunk.ids.length));
          localPages[page].ids.push(chunk.ids[ordinal]);
        }
        if (localPages.some((page) => !page.ids.length)) continue;
        const stillOverflows = localPages.some((page) =>
          sourceMeasure(page.source) > sourceLimit ||
          translationMeasure(page.translation) > translationLimit
        );
        if (!stillOverflows) return localPages;
      }
      return null;
    };

    for (const chunk of chunks) {
      const chunkText = textFor([chunk]);
      const chunkOverflows = sourceMeasure(chunkText.source) > sourceLimit ||
        translationMeasure(chunkText.translation) > translationLimit;
      if (chunkOverflows) {
        flushCurrent();
        const splitPages = splitOversizedChunk(chunk);
        if (splitPages) {
          for (const splitPage of splitPages) {
            const page = pages.length;
            for (const id of splitPage.ids) memberPages[id] = page;
            pages.push(splitPage);
          }
        } else {
          const page = pages.length;
          for (const id of chunk.ids) memberPages[id] = page;
          pages.push({ ...chunkText, ids: chunk.ids.slice(), chunkCount: 1 });
        }
        continue;
      }
      const candidate = [...current, chunk];
      const candidateText = textFor(candidate);
      const candidateOverflows = sourceMeasure(candidateText.source) > sourceLimit ||
        translationMeasure(candidateText.translation) > translationLimit;
      if (current.length && candidateOverflows) flushCurrent();
      current.push(chunk);
    }
    flushCurrent();

    const overflow = pages.some((page) =>
      sourceMeasure(page.source) > sourceLimit ||
      translationMeasure(page.translation) > translationLimit
    );
    return { pages, memberPages, overflow };
  }

  function mergeDisplayProtectedRanges(rangesValue) {
    const ranges = (Array.isArray(rangesValue) ? rangesValue : [])
      .filter((range) => Number.isInteger(range && range.start) &&
        Number.isInteger(range && range.end) && range.end > range.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const range of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
        continue;
      }
      merged.push({ start: range.start, end: range.end });
    }
    return merged;
  }

  // Mark lexical spans whose internal punctuation or whitespace is not a safe
  // display-page boundary. These are shapes, not phrase/name exceptions.
  function displayProtectedRanges(value) {
    const text = String(value || "");
    const patterns = [
      // URLs and email addresses.
      /\b(?:https?:\/\/|www\.)[^\s]+|\b[\p{L}\p{N}.%_+\-]+@[\p{L}\p{N}.\-]+\.[\p{L}]{2,}\b/giu,
      // Initial/acronym chains plus an optional proper-name word:
      // J.D. Vance, J. D. Vance, U.S. Government, Ph.D.
      /(?:\p{L}{1,4}\.\s*){2,}(?:\p{Lu}[\p{L}\p{M}'’\-]+)?/gu,
      // Undotted initialisms followed by a capitalized name/title.
      /\b\p{Lu}{2,}\s+\p{Lu}[\p{L}\p{M}'’\-]+/gu,
      // Decimal numbers, times, dates and versions.
      /\bv?[+\-]?\p{N}+(?:[.,:/\-]\p{N}+)+(?:[%°]|\p{L}+)?/giu,
      // An ellipsis is one punctuation token, not several sentence endings.
      /\.{2,}|…+/g
    ];
    const ranges = [];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
      }
    }
    return mergeDisplayProtectedRanges(ranges);
  }

  function displayBoundaryIsProtected(position, ranges) {
    return ranges.some((range) => position > range.start && position < range.end);
  }

  function displaySentenceBoundaries(text, locale) {
    if (typeof Intl !== "object" || typeof Intl.Segmenter !== "function") return null;
    try {
      const boundaries = new Set();
      const segments = new Intl.Segmenter(locale || undefined, {
        granularity: "sentence"
      }).segment(text);
      for (const segment of segments) {
        let end = segment.index + segment.segment.length;
        while (end > segment.index && /\s/.test(text[end - 1])) end--;
        if (end > 0 && end < text.length) boundaries.add(end);
      }
      return boundaries;
    } catch (_e) {
      return null;
    }
  }

  function displayWordBoundaries(text, locale) {
    if (typeof Intl !== "object" || typeof Intl.Segmenter !== "function") return null;
    try {
      const boundaries = new Set();
      const segments = new Intl.Segmenter(locale || undefined, {
        granularity: "word"
      }).segment(text);
      for (const segment of segments) {
        if (segment.isWordLike === false) continue;
        const end = segment.index + segment.segment.length;
        if (end > 0 && end < text.length) boundaries.add(end);
      }
      return boundaries;
    } catch (_e) {
      return null;
    }
  }

  function displayGraphemeBoundaries(text, locale) {
    if (typeof Intl !== "object" || typeof Intl.Segmenter !== "function") return null;
    try {
      const boundaries = new Set();
      const segments = new Intl.Segmenter(locale || undefined, {
        granularity: "grapheme"
      }).segment(text);
      for (const segment of segments) {
        const end = segment.index + segment.segment.length;
        if (end > 0 && end < text.length) boundaries.add(end);
      }
      return boundaries;
    } catch (_e) {
      return null;
    }
  }

  // Pixel-aware safety pagination for responses without aligned model chunks
  // and for the interior of a single oversized chunk. Locale-aware sentence,
  // clause and word boundaries are the safe choices. Grapheme boundaries are
  // admitted only when there are too few safe points to make the requested
  // pages. Lexical protected spans are never split to balance widths.
  function splitTextForDisplay(value, pageCount, measureText, locale) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const requested = Math.max(1, Math.floor(Number(pageCount) || 1));
    if (!text || requested === 1) return text ? [{ text, start: 0, end: text.length }] : [];
    const measure = typeof measureText === "function"
      ? (part) => Math.max(0, Number(measureText(part)) || 0)
      : (part) => part.length;
    const safeCandidates = [];
    const emergencyCandidates = [];
    const terminal = /[.!?…。！？]/;
    const clause = /[,;:，；：、]/;
    const cjk = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
    const lexical = /[\p{L}\p{M}\p{N}]/u;
    const protectedRanges = displayProtectedRanges(text);
    const sentenceBoundaries = displaySentenceBoundaries(text, locale);
    const wordBoundaries = displayWordBoundaries(text, locale);
    const graphemeBoundaries = displayGraphemeBoundaries(text, locale);
    for (let i = 1; i < text.length; i++) {
      if (displayBoundaryIsProtected(i, protectedRanges)) continue;
      const prev = text[i - 1];
      const next = text[i];
      let penalty = null;
      if (sentenceBoundaries && sentenceBoundaries.has(i)) penalty = 0;
      else if (terminal.test(prev)) penalty = sentenceBoundaries ? 0.28 : 0;
      else if (clause.test(prev)) penalty = 0.12;
      else if (/\s/.test(prev)) penalty = 0.42;
      else if (wordBoundaries && wordBoundaries.has(i) &&
          lexical.test(prev) && lexical.test(next)) penalty = 0.62;
      else if (!wordBoundaries && cjk.test(prev) && cjk.test(next)) penalty = 0.62;
      if (penalty == null) {
        if (graphemeBoundaries && graphemeBoundaries.has(i)) {
          emergencyCandidates.push({ at: i, penalty: 2.2 });
        }
        continue;
      }
      const left = text.slice(0, i).trimEnd();
      const lastWord = (left.match(/([A-Za-z']+)$/) || [])[1];
      if (lastWord && /^(?:a|an|the|on|in|at|to|of|for|from|with|by|and|or|but|as)$/i.test(lastWord)) {
        penalty += 1.4;
      }
      safeCandidates.push({ at: i, penalty });
    }
    const candidates = safeCandidates.length >= requested - 1
      ? safeCandidates
      : [...safeCandidates, ...emergencyCandidates].sort((a, b) => a.at - b.at);
    if (candidates.length < requested - 1) {
      return [{ text, start: 0, end: text.length }];
    }

    const pages = [];
    let start = 0;
    for (let page = 0; page < requested - 1; page++) {
      const pagesLeft = requested - page;
      const available = candidates.filter((candidate) => candidate.at > start);
      if (available.length < pagesLeft - 1) break;
      const target = Math.max(1, measure(text.slice(start)) / pagesLeft);
      let best = null;
      for (let i = 0; i < available.length; i++) {
        const candidate = available[i];
        const afterCount = available.length - i - 1;
        if (afterCount < pagesLeft - 2) continue;
        const width = measure(text.slice(start, candidate.at).trim());
        const ratio = width / target;
        if (ratio < 0.32 || ratio > 1.75) continue;
        const score = Math.abs(1 - ratio) + candidate.penalty;
        if (!best || score < best.score) best = { ...candidate, score };
      }
      if (!best) {
        const index = Math.max(0, available.length - (pagesLeft - 1));
        best = available[index];
      }
      let end = best.at;
      while (end > start && /\s/.test(text[end - 1])) end--;
      if (end <= start) break;
      pages.push({ text: text.slice(start, end).trim(), start, end });
      start = best.at;
      while (start < text.length && /\s/.test(text[start])) start++;
    }
    if (start < text.length) pages.push({ text: text.slice(start).trim(), start, end: text.length });
    return pages.filter((page) => page.text);
  }

  function sentenceSlicesForDisplay(value, locale) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return { text, slices: [] };
    const protectedRanges = displayProtectedRanges(text);
    if (typeof Intl === "object" && typeof Intl.Segmenter === "function") {
      try {
        const slices = [];
        const segments = new Intl.Segmenter(locale || undefined, {
          granularity: "sentence"
        }).segment(text);
        let start = 0;
        for (const segment of segments) {
          const rawEnd = segment.index + segment.segment.length;
          let end = rawEnd;
          while (end > start && /\s/.test(text[end - 1])) end--;
          // ICU can still expose an abbreviation boundary for an unfamiliar
          // name. Join adjacent sentence segments when that boundary lies
          // inside a protected lexical span.
          if (rawEnd < text.length && displayBoundaryIsProtected(end, protectedRanges)) {
            continue;
          }
          let trimmedStart = start;
          while (trimmedStart < end && /\s/.test(text[trimmedStart])) trimmedStart++;
          if (end > trimmedStart) {
            slices.push({ text: text.slice(trimmedStart, end), start: trimmedStart, end });
          }
          start = rawEnd;
        }
        if (slices.length) return { text, slices };
      } catch (_e) { /* fall through to punctuation scanner */ }
    }
    const slices = [];
    let start = 0;
    const closing = /["'”’」』》】)）\]]/;
    for (let i = 0; i < text.length; i++) {
      if (!/[.!?…。！？]/.test(text[i])) continue;
      let end = i + 1;
      if (displayBoundaryIsProtected(end, protectedRanges)) continue;
      while (end < text.length && closing.test(text[end])) end++;
      const part = text.slice(start, end).trim();
      if (part) {
        const trimmedStart = start + (text.slice(start, end).match(/^\s*/) || [""])[0].length;
        slices.push({ text: part, start: trimmedStart, end });
      }
      start = end;
      while (start < text.length && /\s/.test(text[start])) start++;
      i = start - 1;
    }
    if (start < text.length) {
      const part = text.slice(start).trim();
      if (part) slices.push({ text: part, start, end: text.length });
    }
    return { text, slices };
  }

  function pagesFromSentenceSlices(text, slices, pageCount) {
    const pages = [];
    let from = 0;
    for (let page = 0; page < pageCount; page++) {
      const remainingSlices = slices.length - from;
      const remainingPages = pageCount - page;
      const take = page === pageCount - 1
        ? remainingSlices
        // Keep early, already-completed sentences aligned one-for-one and put
        // surplus source fragments into later pages. Models often join a final
        // incomplete source tail to the preceding translated sentence; round()
        // incorrectly pulled that preceding source sentence onto the old page.
        : Math.max(1, Math.floor(remainingSlices / remainingPages));
      const to = Math.min(slices.length, from + take);
      const start = slices[from].start;
      const end = slices[to - 1].end;
      pages.push({ text: text.slice(start, end).trim(), start, end });
      from = to;
    }
    return pages;
  }

  // Paginate both languages by sentence order, not by their unrelated glyph
  // widths. This keeps a source sentence and its translation on the same page
  // even when fullscreen font metrics make Chinese wrap very differently.
  function splitAlignedSentencesForDisplay(
    sourceValue, translationValue, pageCount, sourceLocale, targetLocale
  ) {
    const count = Math.max(1, Math.floor(Number(pageCount) || 1));
    const source = sentenceSlicesForDisplay(sourceValue, sourceLocale);
    const translation = sentenceSlicesForDisplay(translationValue, targetLocale);
    if (count <= 1 || source.slices.length < count || translation.slices.length < count) {
      return null;
    }
    return {
      sourcePages: pagesFromSentenceSlices(source.text, source.slices, count),
      translationPages: pagesFromSentenceSlices(translation.text, translation.slices, count)
    };
  }

  // Assign each timed cue/member to a display page. A member can straddle a
  // sentence boundary and therefore overlap two pages. Once the earlier page
  // has been shown by the preceding member, advance the straddling member to
  // the later page. The minimum-page rule also guarantees that no generated
  // page is left with zero members when pages <= members.
  function displayPageAssignments(pages, ranges) {
    if (!Array.isArray(pages) || !pages.length || !Array.isArray(ranges)) return [];
    const assignments = [];
    let previousPage = 0;
    for (let ordinal = 0; ordinal < ranges.length; ordinal++) {
      const range = ranges[ordinal] || {};
      const start = Number(range.start);
      const end = Number(range.end);
      const safeStart = Number.isFinite(start) ? start : 0;
      const safeEnd = Number.isFinite(end) && end > safeStart ? end : safeStart + 1;
      const anchor = safeStart + (safeEnd - safeStart) * 0.24;
      const overlaps = [];
      for (let page = 0; page < pages.length; page++) {
        if (safeEnd > Number(pages[page].start) && safeStart < Number(pages[page].end)) {
          overlaps.push(page);
        }
      }
      let selected = pages.findIndex((page) => anchor >= Number(page.start) && anchor < Number(page.end));
      if (selected < 0) selected = Math.min(pages.length - 1,
        Math.floor(ordinal * pages.length / Math.max(1, ranges.length)));
      if (overlaps.length > 1 && ordinal > 0) {
        const later = overlaps.find((page) => page > previousPage);
        if (later != null && overlaps.includes(previousPage)) selected = later;
      }
      const minimumPage = Math.max(0, pages.length - (ranges.length - ordinal));
      selected = Math.max(previousPage, minimumPage, selected);
      selected = Math.min(pages.length - 1, selected);
      assignments.push(selected);
      previousPage = selected;
    }
    return assignments;
  }

  function sourceRangeForDisplayMember(sourceValue, memberText, ordinal, memberCount) {
    const source = String(sourceValue || "").replace(/\s+/g, " ").trim();
    const needle = String(memberText || "").replace(/\s+/g, " ").trim();
    if (needle) {
      const at = source.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
      if (at >= 0) return { start: at, end: at + needle.length };
    }
    const count = Math.max(1, Number(memberCount) || 1);
    const start = Math.round(source.length * (Number(ordinal) || 0) / count);
    const end = Math.max(start + 1,
      Math.round(source.length * ((Number(ordinal) || 0) + 1) / count));
    return { start, end };
  }

  // Production display pipeline in one pure function. Keeping sentence
  // alignment, fallback pagination, source-range discovery and cue-to-page
  // assignment together lets tests exercise the exact behavior used by the
  // content script rather than reimplementing pieces of it in test code.
  function semanticDisplayPlan(
    sourceValue, translationValue, memberTexts, pageCount, measureSource, measureTranslation,
    sourceLocale, targetLocale
  ) {
    const source = String(sourceValue || "").replace(/\s+/g, " ").trim();
    const translation = String(translationValue || "").replace(/\s+/g, " ").trim();
    const members = Array.isArray(memberTexts) ? memberTexts.map(String) : [];
    const requested = Math.max(1, Math.min(members.length || 1, Math.floor(Number(pageCount) || 1)));
    const aligned = splitAlignedSentencesForDisplay(
      source, translation, requested, sourceLocale, targetLocale
    );
    const sourcePages = aligned ? aligned.sourcePages
      : splitTextForDisplay(source, requested, measureSource, sourceLocale);
    const translationPages = aligned ? aligned.translationPages
      : splitTextForDisplay(translation, requested, measureTranslation, targetLocale);
    const ranges = members.map((text, ordinal) =>
      sourceRangeForDisplayMember(source, text, ordinal, members.length));
    const assignments = displayPageAssignments(sourcePages, ranges);
    return {
      alignedBySentence: !!aligned,
      sourcePages,
      translationPages,
      ranges,
      assignments
    };
  }

  function shouldBridgeSemanticCueGap(
    previous, next, timeMs, previousUnit, nextUnit, semanticBoundaryOpen
  ) {
    if (!previous || !next || !previousUnit || previousUnit !== nextUnit ||
        semanticBoundaryOpen !== true) return false;
    const time = Number(timeMs);
    const previousEnd = Number(previous.end);
    const nextStart = Number(next.start);
    if (![time, previousEnd, nextStart].every(Number.isFinite)) return false;
    const gap = nextStart - previousEnd;
    return gap >= 0 && time >= previousEnd && time < nextStart;
  }

  // AI semantic boundaries describe meaning, not how long a player will keep a
  // subtitle on screen. A trailing semantic unit can therefore receive only a
  // few frames when it occupies the end of an overlapping YouTube cue. Group
  // such units with an adjacent unit from the SAME raw cue for presentation.
  // Translation/cache ownership stays unchanged; this is only a display plan.
  function semanticDisplayClusters(unitsValue, groupsValue, minVisibleMsValue) {
    const groups = Array.isArray(groupsValue) ? groupsValue : [];
    const minimum = Math.max(0, Number(minVisibleMsValue) || 0);
    const units = (Array.isArray(unitsValue) ? unitsValue : [])
      .map((unit) => {
        const members = Array.from(new Set((Array.isArray(unit && unit.members)
          ? unit.members : []).map(Number).filter(Number.isInteger))).sort((a, b) => a - b);
        return { unitId: String(unit && unit.unitId || ""), members };
      })
      .filter((unit) => unit.members.length)
      .sort((a, b) => a.members[0] - b.members[0]);

    const cueIndexFor = (members) => {
      let cueIndex = null;
      for (const id of members) {
        const group = groups[id];
        const value = Number(group && group.startIdx);
        if (!Number.isInteger(value)) return null;
        if (cueIndex == null) cueIndex = value;
        else if (cueIndex !== value) return null;
      }
      return cueIndex;
    };
    const durationFor = (members) => {
      if (!members.length) return Number.POSITIVE_INFINITY;
      const first = groups[members[0]];
      const last = groups[members[members.length - 1]];
      const start = Number(first && first.start);
      const end = Number(last && last.end);
      return Number.isFinite(start) && Number.isFinite(end)
        ? Math.max(0, end - start) : Number.POSITIVE_INFINITY;
    };
    const canJoin = (left, right) => {
      const leftLast = left.members[left.members.length - 1];
      const rightFirst = right.members[0];
      return leftLast + 1 === rightFirst && left.cueIndex != null &&
        left.cueIndex === right.cueIndex;
    };

    const clusters = [];
    for (const unit of units) {
      const next = {
        unitIds: [unit.unitId],
        members: unit.members.slice(),
        cueIndex: cueIndexFor(unit.members)
      };
      const previous = clusters[clusters.length - 1];
      if (previous && canJoin(previous, next) &&
          (durationFor(previous.members) < minimum || durationFor(next.members) < minimum)) {
        previous.unitIds.push(...next.unitIds);
        previous.members.push(...next.members);
      } else {
        clusters.push(next);
      }
    }
    return clusters.map((cluster) => ({
      unitIds: cluster.unitIds,
      members: cluster.members,
      cueIndex: cluster.cueIndex,
      durationMs: durationFor(cluster.members),
      smoothed: cluster.unitIds.length > 1
    }));
  }

  Object.assign(internal, { alignedChunkDisplayPlan, displayProtectedRanges, splitTextForDisplay, splitAlignedSentencesForDisplay, displayPageAssignments, sourceRangeForDisplayMember, semanticDisplayPlan, shouldBridgeSemanticCueGap, semanticDisplayClusters });
})();
