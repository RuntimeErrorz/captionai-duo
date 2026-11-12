// Aligned-chunk translation responses: parse, validate and recover units.
(() => {
  "use strict";
  if (globalThis.YTDS_SHARED) return;
  const internal = globalThis["__captionAiDuoSharedModulesV1__"];
  if (!internal || !internal.__translationProtocol) {
    throw new Error("CaptionAI shared modules loaded out of order");
  }
  const compactJsonlCoordinate = internal.compactJsonlCoordinate;
  const {
    aiJsonlAdjustUnitChunks,
    aiJsonlChunkHasSentenceBoundary,
    aiJsonlChunkIds,
    aiJsonlChunkMayBeEmpty,
    aiJsonlChunkTranslation,
    containsLegacyAlignmentIds,
    endsWithSentenceStop,
    aiUnitOversized,
    hasOwn,
    joinTranslatedParts,
    jsonObjectFromText,
    mergeEmptyAlignedChunks,
    normalizeTranslatedText,
    speakerSwitchSeparators,
    untranslatedRangeReason
  } = internal.__translationProtocol;

  function semanticUnitsFromAlignedChunks(translationsValue) {
    const list = Array.isArray(translationsValue) ? translationsValue.filter(Boolean) : [];
    if (!list.length) return [];
    const recovered = [];
    let promoted = false;
    for (let index = 0; index < list.length;) {
      const unitId = String(list[index] && list[index].unitId || "");
      let end = index + 1;
      while (end < list.length && String(list[end] && list[end].unitId || "") === unitId) end++;
      const members = list.slice(index, end);
      const anchor = members.find((item) => Array.isArray(item && item.alignedChunks));
      const chunks = anchor && anchor.alignedChunks;
      const memberIds = members.map((item) => String(item && item.id));
      const chunkIds = Array.isArray(chunks)
        ? chunks.flatMap((chunk) => Array.isArray(chunk && chunk.ids) ? chunk.ids.map(String) : [])
        : [];
      const usable = Array.isArray(chunks) && chunks.length > 1 &&
        chunkIds.length === memberIds.length &&
        chunkIds.every((id, ordinal) => id === memberIds[ordinal]) &&
        chunks.every((chunk) => normalizeTranslatedText(chunk && chunk.translation));
      if (!usable) {
        recovered.push(...members);
        index = end;
        continue;
      }
      let memberOffset = 0;
      for (const chunk of chunks) {
        const ids = chunk.ids.map(String);
        const translation = normalizeTranslatedText(chunk.translation);
        const sentenceBoundaryAfter = chunk.sentenceBoundaryAfter === true ||
          endsWithSentenceStop(chunk.translation);
        const chunkUnitId = `semantic-${ids[0]}-${ids[ids.length - 1]}`;
        // A chunk is not a sentence: remember where its sentence starts so the
        // commit plan never opens a committed block in the middle of it.
        const sentenceStart = Number(memberIds[0]);
        for (let ordinal = 0; ordinal < ids.length; ordinal++) {
          const item = { ...members[memberOffset + ordinal], translation, unitId: chunkUnitId, sentenceStart };
          delete item.sentenceBoundaryAfter;
          if (sentenceBoundaryAfter) item.sentenceBoundaryAfter = true;
          delete item.alignedChunks;
          if (ordinal === 0) item.alignedChunks = [{
            ids: ids.slice(),
            translation,
            ...(sentenceBoundaryAfter ? { sentenceBoundaryAfter: true } : {})
          }];
          recovered.push(item);
        }
        memberOffset += ids.length;
      }
      promoted = true;
      index = end;
    }
    return promoted ? recovered : list.slice();
  }

  function alignedTranslationsFromJsonText(value, items, targetLang, diagnostics, sourceLang) {
    const reject = (reason) => {
      if (diagnostics && typeof diagnostics === "object") diagnostics.reason = reason;
      return null;
    };
    const parsed = jsonObjectFromText(value);
    if (!parsed || !Array.isArray(items) || !items.length) {
      return reject("missing aligned segments or current cue items");
    }
    const expected = items.map((item) => String(item && item.id));
    if (containsLegacyAlignmentIds(parsed)) {
      return reject("legacy ids arrays are not supported; use start/end ranges");
    }
    const deferredIds = [];
    let completedCount = expected.length;
    if (hasOwn(parsed, "deferred_start")) {
      const deferredStart = compactJsonlCoordinate(parsed.deferred_start);
      const deferredIndex = deferredStart == null || deferredStart > expected.length
        ? -1 : deferredStart;
      if (deferredIndex < 0) return reject("invalid deferred suffix start position");
      completedCount = deferredIndex;
      deferredIds.push(...expected.slice(deferredIndex));
    }
    let segments = [];
    const isChunkTuple = (value) => Array.isArray(value) && value.length === 3;
    if (Array.isArray(parsed.chunks) && parsed.chunks.length) {
      // A complete response may contain one unit directly. The streaming
      // protocol carries the same tuple leaves inside a `type: unit` record.
      segments = [{ chunks: parsed.chunks }];
    } else if (Array.isArray(parsed.segments) && parsed.segments.length) {
      // Complete aligned responses may group tuple leaves under `segments`.
      // Keep the outer grouping for semantic-unit boundaries while rejecting
      // keyed chunk objects at the leaf parser below.
      const liftContainers = (container) => {
        const children = Array.isArray(container) ? container :
          Array.isArray(container && container.chunks) ? container.chunks : [];
        const out = [];
        let leaves = [];
        const flush = () => {
          if (!leaves.length) return;
          out.push({ chunks: leaves });
          leaves = [];
        };
        for (const child of children) {
          if (child && !Array.isArray(child) &&
              !hasOwn(child, "start") && !hasOwn(child, "end") &&
              !hasOwn(child, "translation") && Array.isArray(child.chunks)) {
            flush();
            out.push(...liftContainers(child));
          } else {
            leaves.push(child);
          }
        }
        flush();
        return out;
      };
      if (parsed.segments.every(isChunkTuple)) {
        segments = [{ chunks: parsed.segments }];
      } else {
        segments = parsed.segments.flatMap((segment) =>
          Array.isArray(segment) ? [{ chunks: segment }] : liftContainers(segment)
        );
      }
    }
    if (!segments.length && !deferredIds.length) {
      return reject("missing aligned segments or current cue items");
    }
    const translations = [];
    let cursor = 0;
    let pendingTrimmedCount = 0;

    for (const segment of segments) {
      const rawChunks = segment && Array.isArray(segment.chunks) ? segment.chunks : [];
      if (!rawChunks.length) return reject(`invalid aligned segment at cue offset ${cursor}`);
      const { chunks, trimmedCount } = aiJsonlAdjustUnitChunks(
        { items, cursor, pendingTrimmedCount }, rawChunks
      );
      pendingTrimmedCount = trimmedCount;
      const ids = [];
      let alignedChunks = [];
      let hasVisibleTranslation = false;
      for (const chunk of chunks) {
        const chunkOffset = cursor + ids.length;
        const range = aiJsonlChunkIds({ expected }, chunk, chunkOffset);
        const chunkIds = range.ids;
        const translation = aiJsonlChunkTranslation(chunk);
        const markerOnly = !translation && aiJsonlChunkMayBeEmpty(
          { items }, chunkIds, chunkOffset
        );
        const untranslated = translation && untranslatedRangeReason(
          items, chunkOffset, chunkIds.length, translation, sourceLang, targetLang
        );
        if (range.error || !chunkIds.length || (!translation && !markerOnly) || untranslated) {
          return reject(range.error
            ? range.error.replace(/JSONL/g, "aligned")
            : untranslated || `invalid aligned chunk at segment offset ${ids.length}`);
        }
        if (translation) hasVisibleTranslation = true;
        if (cursor + ids.length + chunkIds.length > completedCount) {
          return reject(`aligned chunk crosses deferred suffix at segment offset ${ids.length}`);
        }
        alignedChunks.push({
          ids: chunkIds,
          translation,
          ...(aiJsonlChunkHasSentenceBoundary(chunk) ? { sentenceBoundaryAfter: true } : {})
        });
        ids.push(...chunkIds);
      }
      if (!ids.length || cursor + ids.length > completedCount) {
        return reject(`invalid aligned segment at cue offset ${cursor}`);
      }
      if (!hasVisibleTranslation) {
        return reject(`empty aligned segment at cue offset ${cursor}`);
      }
      alignedChunks = mergeEmptyAlignedChunks(alignedChunks);
      for (let i = cursor; i < cursor + ids.length - 1; i++) {
        if (items[i] && items[i].hardAfter) {
          return reject(`segment crosses hard boundary after cue ${expected[i]}`);
        }
      }

      const firstItem = items[cursor] || {};
      const lastItem = items[cursor + ids.length - 1] || {};
      const durationMs = Number(lastItem.endMs) - Number(firstItem.startMs);
      const sourceChars = items.slice(cursor, cursor + ids.length)
        .reduce((sum, item) => sum + String(item && item.text || "").length, 0);
      if (ids.length > 1 && aiUnitOversized(durationMs, sourceChars)) {
        return reject(`oversized segment ${ids[0]}-${ids[ids.length - 1]}: ${durationMs}ms, ${sourceChars} chars`);
      }

      const speakerSwitches = speakerSwitchSeparators(
        alignedChunks, items.slice(cursor, cursor + ids.length)
      );
      const translation = joinTranslatedParts(alignedChunks, targetLang, speakerSwitches);
      const unitId = `semantic-${ids[0]}-${ids[ids.length - 1]}`;
      for (let i = 0; i < ids.length; i++) {
        translations.push(i === 0
          ? { id: ids[i], translation, unitId, alignedChunks }
          : { id: ids[i], translation, unitId });
      }
      cursor += ids.length;
    }
    if (cursor !== completedCount) return reject(`missing completed cue coverage after offset ${cursor}`);
    Object.defineProperty(translations, "deferredIds", { value: deferredIds });
    if (diagnostics && typeof diagnostics === "object") {
      diagnostics.reason = "";
      diagnostics.deferredIds = deferredIds;
      diagnostics.deferredStart = deferredIds.length ? deferredIds[0] : "";
    }
    return translations;
  }

  Object.assign(internal, { semanticUnitsFromAlignedChunks, alignedTranslationsFromJsonText });
})();
