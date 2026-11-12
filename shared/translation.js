// Translation response parsing and alignment protocol helpers.
(() => {
  "use strict";
  if (globalThis.YTDS_SHARED) return;
  const internal = globalThis["__captionAiDuoSharedModulesV1__"];
  if (!internal) throw new Error("CaptionAI shared modules loaded out of order");
  const compactJsonlCoordinate = internal.compactJsonlCoordinate;
  const isSameLanguage = internal.isSameLanguage;

  function normalizeTranslatedText(value) {
    return String(value || "").replace(/>>/g, "").replace(/。/g, " ").replace(/\s+/g, " ").trim();
  }

  function endsWithChineseFullStop(value) {
    return /。(?:\s|>>)*$/.test(String(value || ""));
  }

  function isSpeakerSwitchMarker(value) {
    return String(value == null ? "" : value).trim() === ">>";
  }

  function comparableTranslationText(value) {
    return String(value == null ? "" : value)
      .normalize("NFKC")
      .replace(/>>/g, "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, "");
  }

  function sourceTextForRange(itemsValue, offsetValue, countValue) {
    const items = Array.isArray(itemsValue) ? itemsValue : [];
    const offset = Math.max(0, Math.floor(Number(offsetValue) || 0));
    const count = Math.max(0, Math.floor(Number(countValue) || 0));
    return items.slice(offset, offset + count)
      .map((item) => String(item && item.text || "").trim())
      .filter(Boolean)
      .join(" ");
  }

  const TRANSLATION_FUNCTION_WORDS = Object.freeze({
    en: new Set([
      "a", "about", "after", "all", "an", "and", "are", "as", "at", "be", "because",
      "but", "by", "can", "could", "do", "for", "from", "has", "have", "he", "her",
      "here", "how", "i", "if", "in", "is", "it", "me", "my", "no", "not", "of", "on",
      "or", "our", "so", "that", "the", "their", "there", "they", "this", "to", "was",
      "we", "were", "what", "when", "where", "which", "who", "will", "with", "you", "your"
    ]),
    es: new Set(["a", "al", "con", "de", "del", "el", "en", "es", "la", "las", "lo", "los", "no", "o", "para", "por", "que", "se", "su", "un", "una", "y"]),
    fr: new Set(["à", "au", "avec", "ce", "dans", "de", "des", "du", "elle", "en", "est", "et", "il", "la", "le", "les", "mais", "ne", "nos", "nous", "ou", "par", "pas", "pour", "que", "qui", "sont", "un", "une", "vous"]),
    de: new Set(["aber", "alle", "als", "auf", "aus", "bei", "das", "dass", "der", "die", "ein", "eine", "für", "im", "in", "ist", "mit", "nicht", "oder", "sein", "sie", "sind", "und", "von", "war", "was", "zu"])
  });

  // Exact source echoes are usually a provider failure when the source and
  // target languages differ. Keep this deliberately conservative: short
  // names, acronyms, URLs, numbers, and title-like proper names may validly
  // survive translation. A caller without both language tags cannot prove an
  // echo is wrong, so it leaves the response untouched.
  function isLikelyUntranslated(sourceValue, translationValue, sourceLang, targetLang) {
    const source = String(sourceValue == null ? "" : sourceValue).trim();
    const translation = String(translationValue == null ? "" : translationValue).trim();
    if (!source || !translation || !sourceLang || !targetLang ||
        (typeof isSameLanguage === "function" && isSameLanguage(sourceLang, targetLang))) {
      return false;
    }
    if (comparableTranslationText(source) !== comparableTranslationText(translation)) return false;
    if (/^(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.)/i.test(source)) return false;

    const words = source.match(/[A-Za-z]+/g) || [];
    if (!words.length) return false;
    if (!/\s/.test(source) && words.length === 1) {
      return words[0].length >= 6 && !/^[A-Z][a-z]+$/.test(words[0]);
    }
    if (words.filter((word) => word.length >= 2).length < 2) return false;

    const titleLike = words.every((word) =>
      /^[A-Z][a-z]+$/.test(word) || /^[A-Z0-9][A-Z0-9_-]*$/.test(word)
    );
    const hasLowercaseWord = words.some((word) =>
      /[a-z]/.test(word) && !/^[A-Z][a-z]+$/.test(word)
    );
    const hasSentencePunctuation = /[.!?;:]/.test(source);
    const language = String(sourceLang).trim().toLowerCase().split("-")[0];
    const functionWords = TRANSLATION_FUNCTION_WORDS[language];
    const hasFunctionWord = !!(functionWords && words.some((word) =>
      functionWords.has(word.toLowerCase())
    ));
    if (titleLike && words.length <= 4 && !hasFunctionWord && !hasSentencePunctuation) return false;
    return words.length >= 3 || hasLowercaseWord || hasSentencePunctuation;
  }

  function untranslatedRangeReason(itemsValue, offsetValue, countValue,
    translationValue, sourceLang, targetLang) {
    const source = sourceTextForRange(itemsValue, offsetValue, countValue);
    return isLikelyUntranslated(source, translationValue, sourceLang, targetLang)
      ? `untranslated source text at offset ${Math.max(0, Math.floor(Number(offsetValue) || 0))}`
      : "";
  }

  // `>>` is a source-side speaker-turn marker. Return the separators that
  // belong before each aligned translation chunk, without changing the
  // normal compact CJK joining rule for ordinary linguistic chunks.
  function speakerSwitchSeparators(chunksValue, itemsValue) {
    const chunks = Array.isArray(chunksValue) ? chunksValue : [];
    const items = Array.isArray(itemsValue) ? itemsValue : [];
    const separators = [];
    let offset = 0;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index] || {};
      const ids = Array.isArray(chunk.ids) ? chunk.ids : [];
      const boundary = index > 0 && (
        isSpeakerSwitchMarker(items[offset] && items[offset].text) ||
        isSpeakerSwitchMarker(items[offset - 1] && items[offset - 1].text)
      );
      separators.push(boundary);
      offset += ids.length;
    }
    return separators;
  }

  function jsonObjectFromText(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return null;
    const candidates = [text];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced && fenced[1]) candidates.push(fenced[1].trim());
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(text.slice(firstBrace, lastBrace + 1));
    }
    for (const candidate of new Set(candidates)) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch (_e) { /* try the next common response wrapper */ }
    }
    return null;
  }

  function hasOwn(value, key) {
    return !!value && Object.prototype.hasOwnProperty.call(value, key);
  }

  function containsLegacyAlignmentIds(value) {
    if (!value || typeof value !== "object") return false;
    if (hasOwn(value, "ids") || hasOwn(value, "deferred_ids")) return true;
    const children = Array.isArray(value) ? value : Object.values(value);
    return children.some(containsLegacyAlignmentIds);
  }

  function segmentedTranslationsFromJsonText(value, items, diagnostics, targetLang, sourceLang) {
    const reject = (reason) => {
      if (diagnostics && typeof diagnostics === "object") diagnostics.reason = reason;
      return null;
    };
    const parsed = jsonObjectFromText(value);
    const segments = parsed && parsed.segments;
    if (containsLegacyAlignmentIds(parsed)) {
      return reject("legacy ids arrays are not supported; use start/end ranges");
    }
    if (!Array.isArray(segments) || !segments.length || !Array.isArray(items) || !items.length) {
      return reject("missing segments or current cue items");
    }
    const expected = items.map((item) => String(item && item.id));
    const translations = [];
    let cursor = 0;
    for (const segment of segments) {
      const range = aiJsonlRangeIds(
        { expected }, segment && segment.start, segment && segment.end, cursor
      );
      const ids = range.ids;
      const translation = normalizeTranslatedText(segment && segment.translation);
      const untranslated = translation && untranslatedRangeReason(
        items, cursor, ids.length, translation, sourceLang, targetLang
      );
      if (range.error || !ids.length || !translation || untranslated ||
          cursor + ids.length > expected.length) {
        return reject(range.error || untranslated || `invalid segment at cue offset ${cursor}`);
      }
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== expected[cursor + i]) {
          return reject(`unexpected cue id ${ids[i]} at offset ${cursor + i}`);
        }
      }
      // A model-selected segment may not cross a locally established hard
      // timing boundary (the flag belongs to the item before the boundary).
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
      // YouTube rolling captions commonly overlap and can make a natural unit
      // appear longer than its actual spoken content. Keep a generous safety
      // ceiling while still rejecting genuinely oversized model output.
      if (ids.length > 1 &&
          ((!Number.isFinite(durationMs) || durationMs > 45000) || sourceChars > 900)) {
        return reject(`oversized segment ${ids[0]}-${ids[ids.length - 1]}: ${durationMs}ms, ${sourceChars} chars`);
      }
      const unitId = `semantic-${ids[0]}-${ids[ids.length - 1]}`;
      for (const id of ids) translations.push({ id, translation, unitId });
      cursor += ids.length;
    }
    if (cursor !== expected.length) return reject(`missing cue coverage after offset ${cursor}`);
    if (diagnostics && typeof diagnostics === "object") diagnostics.reason = "";
    return translations;
  }

  function createAiJsonlTranslationState(itemsValue, targetLang, sourceLang) {
    const items = Array.isArray(itemsValue) ? itemsValue.filter(Boolean) : [];
    return {
      items,
      expected: items.map((item) => String(item && item.id)),
      targetLang: String(targetLang || ""),
      sourceLang: String(sourceLang || ""),
      cursor: 0,
      translations: [],
      // Hold marker-only units until a spoken unit can carry their coverage.
      pendingMarkerChunks: [],
      pendingTrimmedCount: 0,
      done: false,
      error: "",
      recoverableError: ""
    };
  }

  function aiJsonlRangeIds(stateValue, startValue, endValue, offsetValue) {
    const state = stateValue && typeof stateValue === "object" ? stateValue : null;
    const offset = Math.max(0, Math.floor(Number(offsetValue) || 0));
    if (!state || !Array.isArray(state.expected)) {
      return { ids: [], error: `invalid JSONL range at offset ${offset}` };
    }
    const start = compactJsonlCoordinate(startValue);
    const end = compactJsonlCoordinate(endValue);
    if (start == null || end == null || end < start) {
      return { ids: [], error: `invalid JSONL range at offset ${offset}` };
    }
    const count = end - start + 1;
    if (!Number.isSafeInteger(count) || offset + count > state.expected.length) {
      return {
        ids: [],
        error: `unexpected JSONL position ${end} at offset ${Math.min(
          state.expected.length, offset + Math.max(0, count - 1)
        )}`
      };
    }
    if (start !== offset) {
      return { ids: [], error: `unexpected JSONL position ${start} at offset ${offset}` };
    }
    return { ids: state.expected.slice(offset, offset + count), error: "" };
  }

  function aiJsonlChunkTranslation(chunkValue) {
    return Array.isArray(chunkValue)
      ? normalizeTranslatedText(chunkValue[2])
      : "";
  }

  function aiJsonlChunkMayBeEmpty(stateValue, idsValue, offsetValue) {
    const state = stateValue && typeof stateValue === "object" ? stateValue : null;
    const ids = Array.isArray(idsValue) ? idsValue : [];
    const offset = Math.max(0, Math.floor(Number(offsetValue) || 0));
    if (!state || !Array.isArray(state.items) || !ids.length) return false;
    return ids.every((_id, index) => {
      const source = String(state.items[offset + index] &&
        state.items[offset + index].text || "").trim();
      return isSpeakerSwitchMarker(source) || !source || /^[\p{P}\s]+$/u.test(source);
    });
  }

  // A model may omit a standalone speaker marker while still returning the
  // surrounding spoken chunks. It is safe to advance over only marker/blank
  // source rows; a skipped word, number or punctuation remains a protocol
  // error because its meaning cannot be reconstructed from the response.
  function aiJsonlSafeOmittedMarkerIds(stateValue, startValue, offsetValue) {
    const state = stateValue && typeof stateValue === "object" ? stateValue : null;
    const offset = Math.max(0, Math.floor(Number(offsetValue) || 0));
    const start = compactJsonlCoordinate(startValue);
    if (!state || !Array.isArray(state.expected) || !Array.isArray(state.items) ||
        start == null || start <= offset || start > state.expected.length) return null;
    const ids = state.expected.slice(offset, start);
    if (!ids.length || !ids.every((_id, index) => {
      const source = String(state.items[offset + index] &&
        state.items[offset + index].text || "").trim();
      return isSpeakerSwitchMarker(source) || !source;
    })) return null;
    for (let index = offset; index < start; index++) {
      if (state.items[index] && state.items[index].hardAfter) return null;
    }
    return ids;
  }

  function aiJsonlChunkHasSentenceBoundary(chunkValue) {
    return Array.isArray(chunkValue) && endsWithChineseFullStop(chunkValue[2]);
  }

  function aiJsonlIsSentenceBoundaryOverrun(itemsValue, endValue) {
    const items = Array.isArray(itemsValue) ? itemsValue : [];
    const end = compactJsonlCoordinate(endValue);
    if (end == null || end <= 0 || end >= items.length) return false;
    const prev = items[end - 1];
    const curr = items[end];
    const prevText = String(prev && prev.text || "").trim();
    const currText = String(curr && curr.text || "").trim();
    if (!prevText || !currText || /\.{2,}|…/.test(prevText)) return false;
    if (!/[.!?…。！？]["'”’」』》】)）\]]*$/u.test(prevText)) return false;
    if (/^(?:dr|mr|mrs|ms|prof|sr|jr|vs|etc|e\.g|i\.e)\.?$/i.test(prevText) ||
        /(?:\p{L}\.){2,}/u.test(prevText)) return false;
    if (/\s/u.test(currText) || !/^\p{Lu}/u.test(currText)) return false;
    if (/[.!?…。！？]["'”’」』》】)）\]]*$/u.test(currText)) return false;
    return true;
  }

  function aiJsonlAdjustUnitChunks(stateValue, chunksValue) {
    const state = stateValue && typeof stateValue === "object" ? stateValue : null;
    const chunks = (Array.isArray(chunksValue) ? chunksValue : [])
      .map((chunk) => Array.isArray(chunk) ? chunk.slice() : chunk);
    if (!state || !chunks.length) return { chunks, trimmedCount: 0 };
    const pendingMarkerChunks = Array.isArray(state.pendingMarkerChunks)
      ? state.pendingMarkerChunks : [];
    const pendingMarkerIds = pendingMarkerChunks.flatMap((chunk) =>
      Array.isArray(chunk && chunk.ids) ? chunk.ids : []);
    const chunkBaseOffset = state.cursor + pendingMarkerIds.length;
    // End-only chunks carry no start: each one begins right after the
    // previous chunk, the first one at the stream cursor.
    let impliedStart = chunkBaseOffset;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      if (!Array.isArray(chunk) || chunk.length !== 3) break;
      const end = compactJsonlCoordinate(chunk[1]);
      if (end == null) break;
      // An end-only chunk repeating the previous chunk's end splits that
      // chunk's translation in two; join it back instead of failing.
      const previous = chunks[index - 1];
      if (chunk[0] === null && index > 0 && end === impliedStart - 1 &&
          Array.isArray(previous) && typeof previous[2] === "string" && typeof chunk[2] === "string") {
        previous[2] += chunk[2];
        chunks.splice(index, 1);
        index--;
        continue;
      }
      if (chunk[0] === null) chunk[0] = impliedStart;
      impliedStart = end + 1;
    }
    let trimmedCount = 0;
    if (state.pendingTrimmedCount > 0 &&
        compactJsonlCoordinate(chunks[0][0]) === chunkBaseOffset + state.pendingTrimmedCount) {
      chunks[0][0] = chunkBaseOffset;
    }
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!Array.isArray(chunk) || chunk.length < 2) continue;
      const start = compactJsonlCoordinate(chunk[0]);
      const end = compactJsonlCoordinate(chunk[1]);
      if (start != null && end != null && end > start &&
          aiJsonlIsSentenceBoundaryOverrun(state.items, end)) {
        chunk[1] = end - 1;
        if (i + 1 < chunks.length) {
          if (Array.isArray(chunks[i + 1]) &&
              compactJsonlCoordinate(chunks[i + 1][0]) === end + 1) {
            chunks[i + 1][0] = end;
          }
        } else {
          trimmedCount = 1;
        }
      }
    }
    return { chunks, trimmedCount };
  }

  function mergeEmptyAlignedChunks(chunksValue) {
    const chunks = Array.isArray(chunksValue) ? chunksValue : [];
    const merged = [];
    let leadingIds = [];
    for (const chunkValue of chunks) {
      const chunk = chunkValue && typeof chunkValue === "object" ? chunkValue : {};
      const ids = Array.isArray(chunk.ids) ? chunk.ids.slice() : [];
      if (!chunk.translation) {
        if (merged.length) {
          const previous = merged[merged.length - 1];
          previous.ids.push(...ids);
          if (chunk.sentenceBoundaryAfter) previous.sentenceBoundaryAfter = true;
        } else {
          leadingIds.push(...ids);
        }
        continue;
      }
      merged.push({ ...chunk, ids: leadingIds.concat(ids) });
      leadingIds = [];
    }
    if (leadingIds.length && merged.length) merged[0].ids.unshift(...leadingIds);
    return merged;
  }

  // The model uses zero-based positions within the current request. Expand a
  // validated local range against the caller's expected sequence so a skipped,
  // duplicated or invented position is rejected while internal absolute IDs
  // remain available to playback, caching and rendering.
  function aiJsonlChunkIds(stateValue, chunkValue, offsetValue) {
    const chunk = Array.isArray(chunkValue) ? chunkValue : null;
    const offset = Math.max(0, Math.floor(Number(offsetValue) || 0));
    if (!chunk || chunk.length !== 3) {
      return { ids: [], error: `invalid JSONL chunk at offset ${offset}` };
    }
    return aiJsonlRangeIds(stateValue, chunk[0], chunk[1], offset);
  }

  // Clause punctuation opening a translation belongs to the clause before it.
  const CONTINUATION_START = /^\s*[，,、；;：:]/u;
  function aiJsonlChunkContinuesPrevious(chunkValue) {
    return Array.isArray(chunkValue) && typeof chunkValue[2] === "string" &&
      CONTINUATION_START.test(chunkValue[2]);
  }

  function aiJsonlChunkStartOffset(chunkValue) {
    const chunk = Array.isArray(chunkValue) ? chunkValue : null;
    if (!chunk || chunk.length !== 3) return -1;
    const start = compactJsonlCoordinate(chunk[0]);
    return start == null ? -1 : start;
  }

  function pushAiJsonlTranslationRecord(stateValue, recordValue) {
    const state = stateValue && typeof stateValue === "object" ? stateValue : null;
    const record = recordValue && typeof recordValue === "object" ? recordValue : null;
    const reject = (reason) => {
      if (state && !state.error) state.error = reason;
      return { ok: false, type: "error", error: reason, translations: [] };
    };
    if (!state || !Array.isArray(state.items) || !Array.isArray(state.expected)) {
      return reject("invalid JSONL translation state");
    }
    if (state.error) return reject(state.error);
    if (state.done) return reject("JSONL record appears after done");
    if (!record) return reject("missing JSONL record");
    if (hasOwn(record, "ids") || hasOwn(record, "deferred_ids")) {
      return reject("legacy ids fields are not supported; use start/end ranges");
    }

    if (record.type === "done") {
      state.pendingTrimmedCount = 0;
      const remaining = state.expected.slice(state.cursor);
      state.done = true;
      // The stream cursor is the source of truth; a done record never supplies
      // coverage information of its own.
      return { ok: true, type: "done", deferredIds: remaining, translations: [] };
    }

    if (record.type !== "unit") return reject("unknown JSONL record type");
    const rawChunks = Array.isArray(record.chunks) ? record.chunks : [];
    if (!rawChunks.length) return reject(`missing JSONL unit chunks at offset ${state.cursor}`);
    const pendingMarkerChunks = Array.isArray(state.pendingMarkerChunks)
      ? state.pendingMarkerChunks : [];
    const pendingMarkerIds = pendingMarkerChunks.flatMap((chunk) =>
      Array.isArray(chunk && chunk.ids) ? chunk.ids : []);
    const chunkBaseOffset = state.cursor + pendingMarkerIds.length;
    const { chunks, trimmedCount } = aiJsonlAdjustUnitChunks(state, rawChunks);
    const alignedChunks = [];
    const ids = [];
    let hasVisibleTranslation = false;
    for (const chunk of chunks) {
      let chunkOffset = chunkBaseOffset + ids.length;
      let effectiveChunk = chunk;
      let chunkResult = aiJsonlChunkIds(state, effectiveChunk, chunkOffset);
      if (chunkResult.error) {
        const omittedIds = aiJsonlSafeOmittedMarkerIds(state, chunk && chunk[0], chunkOffset);
        if (omittedIds && omittedIds.length) {
          alignedChunks.push({ ids: omittedIds, translation: "" });
          ids.push(...omittedIds);
          chunkOffset += omittedIds.length;
          chunkResult = aiJsonlChunkIds(state, effectiveChunk, chunkOffset);
        }
      }
      if (!chunkResult.error && chunkOffset > 0 && aiJsonlChunkContinuesPrevious(effectiveChunk)) {
        return reject(`JSONL chunk at offset ${chunkOffset} continues the previous chunk`);
      }
      const chunkIds = chunkResult.ids;
      const translation = aiJsonlChunkTranslation(effectiveChunk);
      const markerOnly = !translation && aiJsonlChunkMayBeEmpty(
        state, chunkIds, chunkOffset
      );
      const untranslated = translation && untranslatedRangeReason(
        state.items, chunkOffset, chunkIds.length, translation,
        state.sourceLang, state.targetLang
      );
      if (chunkResult.error || !chunkIds.length || (!translation && !markerOnly) || untranslated) {
        return reject(chunkResult.error || untranslated ||
          `invalid JSONL chunk at offset ${state.cursor + ids.length}`);
      }
      if (translation) hasVisibleTranslation = true;
      for (const id of chunkIds) {
        const expectedId = state.expected[chunkBaseOffset + ids.length];
        if (id !== expectedId) {
          return reject(`unexpected JSONL id ${id} at offset ${chunkBaseOffset + ids.length}`);
        }
        ids.push(id);
      }
      alignedChunks.push({
        ids: chunkIds,
        translation,
        ...(aiJsonlChunkHasSentenceBoundary(effectiveChunk) ? { sentenceBoundaryAfter: true } : {})
      });
    }
    if (!ids.length) return reject(`empty JSONL unit at offset ${state.cursor}`);
    if (!hasVisibleTranslation) {
      // Keep the cursor before the marker suffix so the next spoken unit can
      // carry it; an unfinished suffix remains deferred without an error.
      state.pendingMarkerChunks.push(...alignedChunks);
      return {
        ok: true,
        type: "marker-only",
        ids,
        translations: []
      };
    }
    const allIds = pendingMarkerIds.concat(ids);
    const allChunks = mergeEmptyAlignedChunks(pendingMarkerChunks.concat(alignedChunks));
    const allStart = state.cursor;
    const allEnd = allStart + allIds.length;
    for (let index = allStart; index < allEnd - 1; index++) {
      if (state.items[index] && state.items[index].hardAfter) {
        return reject(`JSONL unit crosses hard boundary after cue ${state.expected[index]}`);
      }
    }
    const firstItem = state.items[allStart] || {};
    const lastItem = state.items[allEnd - 1] || {};
    const durationMs = Number(lastItem.endMs) - Number(firstItem.startMs);
    const sourceChars = state.items.slice(allStart, allEnd)
      .reduce((sum, item) => sum + String(item && item.text || "").length, 0);
    // Multiple ordered chunks provide recovery boundaries; keep the ceiling
    // for a monolithic over-merged unit.
    const translatedChunkCount = allChunks.filter((chunk) => chunk && chunk.translation).length;
    if (allIds.length > 1 && translatedChunkCount <= 1 &&
        ((!Number.isFinite(durationMs) || durationMs > 45000) || sourceChars > 900)) {
      return reject(`oversized JSONL unit ${allIds[0]}-${allIds[allIds.length - 1]}: ${durationMs}ms, ${sourceChars} chars`);
    }
    // Some models put several complete sentences on one JSONL line. The
    // protocol asks for one sentence per line; restore that granularity so
    // finished sentences commit and display without waiting for the line's
    // possibly unfinished last clause.
    const translations = [];
    let itemOffset = allStart;
    for (const group of sentenceChunkGroups(allChunks, state.items, allStart)) {
      const groupIds = group.flatMap((chunk) => chunk.ids);
      const groupItems = state.items.slice(itemOffset, itemOffset + groupIds.length);
      itemOffset += groupIds.length;
      const translation = joinTranslatedParts(
        group, state.targetLang, speakerSwitchSeparators(group, groupItems)
      );
      const unitId = `semantic-${groupIds[0]}-${groupIds[groupIds.length - 1]}`;
      translations.push(...groupIds.map((id, index) => index === 0
        ? { id, translation, unitId, alignedChunks: group }
        : { id, translation, unitId }));
    }
    state.translations.push(...translations);
    state.cursor = chunkBaseOffset + ids.length;
    state.pendingTrimmedCount = trimmedCount;
    state.pendingMarkerChunks = [];
    return {
      ok: true, type: "unit", unitId: translations[0].unitId, ids: allIds, translations,
      unitCount: new Set(translations.map((item) => item.unitId)).size
    };
  }

  const SOURCE_SENTENCE_END = /[.?!…](?:["'”’)\]]*)$/;
  const TARGET_SENTENCE_END = /[。！？!?…](?:["'”’」』）)\]]*)(?:\s|>>)*$/;

  // A source period alone may be an abbreviation (Mr., U.S.); trust it only
  // when the translation does not continue the clause.
  function chunkClosesSentence(lastItem, translationValue) {
    const translated = String(translationValue || "");
    if (!translated) return false;
    const lastSource = String(lastItem && lastItem.text || "").trim();
    return TARGET_SENTENCE_END.test(translated) ||
      (SOURCE_SENTENCE_END.test(lastSource) && !/[，,、;；:：—–-]\s*$/.test(translated));
  }

  // How many leading chunks of a still-streaming line end with a closed
  // sentence. Those chunks can be accepted now, as if the model had broken
  // the line there, instead of waiting for the line's unfinished tail.
  function aiJsonlClosedSentencePrefixLength(stateValue, chunksValue) {
    const state = stateValue && typeof stateValue === "object" ? stateValue : null;
    const chunks = Array.isArray(chunksValue) ? chunksValue : [];
    if (!state || !Array.isArray(state.items)) return 0;
    let closed = 0;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const end = Array.isArray(chunk) ? compactJsonlCoordinate(chunk[1]) : null;
      if (end == null || end >= state.items.length) break;
      const translation = aiJsonlChunkTranslation(chunk);
      if (endsWithChineseFullStop(chunk[2]) || chunkClosesSentence(state.items[end], translation)) {
        closed = index + 1;
      }
    }
    return closed;
  }

  // Split a line's ordered chunks after every chunk that closes a sentence
  // in the source or the translation. A line holding one sentence stays one
  // group; the last group may be an unfinished clause.
  function sentenceChunkGroups(chunks, items, startIndex) {
    const groups = [];
    let current = [];
    let index = startIndex;
    for (const chunk of chunks) {
      current.push(chunk);
      index += chunk.ids.length;
      const closes = chunk.sentenceBoundaryAfter === true ||
        chunkClosesSentence(items[index - 1], chunk.translation);
      if (closes && chunk.translation) {
        groups.push(current);
        current = [];
      }
    }
    if (current.length) {
      if (groups.length && !current.some((chunk) => chunk.translation)) {
        groups[groups.length - 1].push(...current); // trailing markers stay attached
      } else {
        groups.push(current);
      }
    }
    return groups;
  }

  // When a provider puts several complete alignment chunks inside one outer
  // unit, a later chunk can still contain a missing or invented position.
  // Preserve only the strictly ordered leading chunks so the next rolling
  // request can resume at the first missing position. Only standalone marker
  // rows may be skipped; never split a spoken chunk or skip a real mismatch.
  function aiJsonlLeadingRecordPrefix(stateValue, recordValue) {
    const state = stateValue && typeof stateValue === "object" ? stateValue : null;
    const record = recordValue && typeof recordValue === "object" ? recordValue : null;
    if (!state || !Array.isArray(state.items) || !Array.isArray(state.expected) ||
        !record || record.type !== "unit" || !Array.isArray(record.chunks)) return null;
    const pendingMarkerChunks = Array.isArray(state.pendingMarkerChunks)
      ? state.pendingMarkerChunks : [];
    const pendingMarkerIds = pendingMarkerChunks.flatMap((chunk) =>
      Array.isArray(chunk && chunk.ids) ? chunk.ids : []);
    const { chunks: recordChunks } = aiJsonlAdjustUnitChunks(state, record.chunks);
    const chunks = [];
    let offset = state.cursor + pendingMarkerIds.length;
    let stopped = false;
    for (const chunk of recordChunks) {
      let effectiveChunk = chunk;
      // A chunk that starts inside the previous one, or whose text continues
      // it, shows the model lost count: the previous chunk's translation does
      // not match its range either, so the safe prefix ends before it.
      const start = aiJsonlChunkStartOffset(chunk);
      if ((start >= 0 && start < offset) || (offset > 0 && aiJsonlChunkContinuesPrevious(chunk))) {
        while (chunks.length && !chunks[chunks.length - 1][2]) chunks.pop();
        chunks.pop();
        stopped = true;
        break;
      }
      let chunkResult = aiJsonlChunkIds(state, effectiveChunk, offset);
      if (chunkResult.error) {
        const omittedIds = aiJsonlSafeOmittedMarkerIds(state, chunk && chunk[0], offset);
        if (omittedIds && omittedIds.length) {
          chunks.push([offset, offset + omittedIds.length - 1, ""]);
          offset += omittedIds.length;
          chunkResult = aiJsonlChunkIds(state, effectiveChunk, offset);
        }
      }
      const ids = chunkResult.ids;
      const translation = aiJsonlChunkTranslation(effectiveChunk);
      const markerOnly = !translation && aiJsonlChunkMayBeEmpty(state, ids, offset);
      const untranslated = translation && untranslatedRangeReason(
        state.items, offset, ids.length, translation,
        state.sourceLang, state.targetLang
      );
      if (chunkResult.error || !ids.length || (!translation && !markerOnly) || untranslated) {
        stopped = true;
        break;
      }
      let valid = true;
      for (let index = 0; index < ids.length; index++) {
        if (ids[index] !== state.expected[offset + index]) {
          valid = false;
          break;
        }
      }
      if (!valid) {
        stopped = true;
        break;
      }
      for (let index = offset; index < offset + ids.length - 1; index++) {
        if (state.items[index] && state.items[index].hardAfter) {
          valid = false;
          break;
        }
      }
      if (!valid) {
        stopped = true;
        break;
      }
      const chunkStart = offset;
      chunks.push([chunkStart, chunkStart + ids.length - 1, chunk[2]]);
      offset += ids.length;
    }
    if (!chunks.length || !stopped) return null;
    return { type: "unit", chunks };
  }

  function rewindAiJsonlOverlappingUnit(stateValue, recordValue) {
    const state = stateValue && typeof stateValue === "object" ? stateValue : null;
    const record = recordValue && typeof recordValue === "object" ? recordValue : null;
    if (!state || !record || record.type !== "unit" || !Array.isArray(state.translations) ||
        !Array.isArray(state.expected) || !state.translations.length || state.cursor <= 0) {
      return null;
    }
    const firstChunk = Array.isArray(record.chunks) ? record.chunks[0] : null;
    const firstStart = aiJsonlChunkStartOffset(firstChunk);
    // A record that starts inside the last unit, or continues its text, makes
    // that unit suspect; it is still provisional, so take it back.
    const continues = firstStart === state.cursor && aiJsonlChunkContinuesPrevious(firstChunk);
    const overlapStart = continues ? state.cursor - 1 : firstStart;
    if (overlapStart < 0 || overlapStart >= state.cursor) return null;

    const last = state.translations[state.translations.length - 1];
    const unitId = String(last && last.unitId || "");
    if (!unitId) return null;
    let unitStart = state.translations.length - 1;
    while (unitStart > 0 &&
        String(state.translations[unitStart - 1] && state.translations[unitStart - 1].unitId || "") === unitId) {
      unitStart--;
    }
    if (overlapStart < unitStart) return null;

    const previousCursor = state.cursor;
    state.translations.splice(unitStart);
    state.cursor = unitStart;
    state.pendingTrimmedCount = 0;
    return { unitId, previousCursor, nextCursor: unitStart };
  }

  function aiJsonlTranslationResult(stateValue, allowPartial) {
    const state = stateValue && typeof stateValue === "object" ? stateValue : null;
    if (!state || !Array.isArray(state.translations) || !Array.isArray(state.expected)) return null;
    const coverageComplete = state.cursor === state.expected.length;
    const hasPendingMarkers = Array.isArray(state.pendingMarkerChunks) &&
      state.pendingMarkerChunks.length > 0;
    const partial = (!state.done && !coverageComplete) || hasPendingMarkers || !!state.error;
    if (partial && (!allowPartial || (!state.translations.length && !hasPendingMarkers))) return null;
    const deferredIds = state.expected.slice(state.cursor);
    const out = state.translations.slice();
    Object.defineProperties(out, {
      deferredIds: { value: deferredIds },
      streamPartial: { value: partial },
      streamError: { value: String(state.error || "") },
      recoverableJsonlError: { value: String(state.recoverableError || "") }
    });
    return out;
  }

  function joinTranslatedParts(values, targetLang, speakerSwitchesValue) {
    const speakerSwitches = Array.isArray(speakerSwitchesValue) ? speakerSwitchesValue : [];
    const parts = (Array.isArray(values) ? values : [])
      .map((value, index) => {
        const raw = value && typeof value === "object" && !Array.isArray(value)
          ? value.translation : value;
        return {
          text: normalizeTranslatedText(raw),
          sentenceBoundaryAfter: !!(value && typeof value === "object" &&
            value.sentenceBoundaryAfter === true) || endsWithChineseFullStop(raw),
          speakerSwitchBefore: !!speakerSwitches[index]
        };
      })
      .filter((part) => part.text);
    if (!parts.length) return "";
    const compact = /^(?:zh|ja|ko)(?:-|$)/i.test(String(targetLang || ""));
    let out = parts[0].text;
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i].text;
      const nextIsPunctuation = /^[,.;:!?。，；：！？、)）\]】}」』]/.test(part);
      const asciiBoundary = /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(part);
      const sentenceBoundary = parts[i - 1].sentenceBoundaryAfter;
      const compactSeparator = asciiBoundary || sentenceBoundary ? " " : "";
      const finalSeparator = parts[i].speakerSwitchBefore ? " "
        : nextIsPunctuation ? "" : compact ? compactSeparator : " ";
      out += finalSeparator + part;
    }
    return out.trim();
  }

  // A provider can occasionally wrap many otherwise useful aligned chunks in
  // one giant semantic unit. If that unit reaches the caller's maximum rolling
  // window, the trailing commit guard cannot release any prefix. Preserve the
  // model's own linguistic boundaries by promoting its chunks to units; never
  // invent a boundary from words, punctuation, player cues or timestamps.

  // Protocol helpers shared with shared/alignment.js only; "__" keys are
  // dropped when shared.js assembles the public API.
  internal.__translationProtocol = Object.freeze({
    aiJsonlAdjustUnitChunks,
    aiJsonlChunkHasSentenceBoundary,
    aiJsonlChunkIds,
    aiJsonlChunkMayBeEmpty,
    aiJsonlChunkTranslation,
    containsLegacyAlignmentIds,
    endsWithChineseFullStop,
    hasOwn,
    joinTranslatedParts,
    jsonObjectFromText,
    mergeEmptyAlignedChunks,
    normalizeTranslatedText,
    speakerSwitchSeparators,
    untranslatedRangeReason
  });
Object.assign(internal, { normalizeTranslatedText, speakerSwitchSeparators, segmentedTranslationsFromJsonText, createAiJsonlTranslationState, pushAiJsonlTranslationRecord, aiJsonlClosedSentencePrefixLength, aiJsonlLeadingRecordPrefix, rewindAiJsonlOverlappingUnit, aiJsonlTranslationResult, joinTranslatedParts });
})();
