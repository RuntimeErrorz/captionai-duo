// Translation response parsing and alignment protocol helpers.
(() => {
  "use strict";
  if (globalThis.YTDS_SHARED) return;
  const internal = globalThis["__captionAiDuoSharedModulesV1__"];
  if (!internal) throw new Error("CaptionAI shared modules loaded out of order");

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

  function translationFromJsonText(value) {
    const parsed = jsonObjectFromText(value);
    const translation = String(parsed && parsed.translation || "").trim();
    if (translation) return translation;
    return "";
  }

  function segmentedTranslationsFromJsonText(value, items, diagnostics) {
    const reject = (reason) => {
      if (diagnostics && typeof diagnostics === "object") diagnostics.reason = reason;
      return null;
    };
    const parsed = jsonObjectFromText(value);
    const segments = parsed && parsed.segments;
    if (!Array.isArray(segments) || !segments.length || !Array.isArray(items) || !items.length) {
      return reject("missing segments or current cue items");
    }
    const expected = items.map((item) => String(item && item.id));
    const translations = [];
    let cursor = 0;
    for (const segment of segments) {
      const ids = segment && Array.isArray(segment.ids)
        ? segment.ids.map(String) : [];
      const translation = String(segment && segment.translation || "").trim();
      if (!ids.length || !translation || cursor + ids.length > expected.length) {
        return reject(`invalid segment at cue offset ${cursor}`);
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

  function aiJsonlLines(value, flush) {
    const input = String(value || "");
    const lines = [];
    let cursor = 0;
    while (true) {
      const newline = input.indexOf("\n", cursor);
      if (newline < 0) break;
      lines.push(input.slice(cursor, newline).replace(/\r$/, ""));
      cursor = newline + 1;
    }
    let rest = input.slice(cursor);
    if (flush && rest) {
      lines.push(rest.replace(/\r$/, ""));
      rest = "";
    }
    return { lines, rest };
  }

  function aiJsonlRecordFromLine(value) {
    const line = String(value || "").trim();
    if (!line || /^```(?:jsonl?|ndjson)?$/i.test(line) || line === "```") {
      return { ignored: true, record: null, error: "" };
    }
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        return { ignored: false, record: null, error: "JSONL line is not an object" };
      }
      return { ignored: false, record, error: "" };
    } catch (_e) {
      return { ignored: false, record: null, error: "invalid JSONL line" };
    }
  }

  function aiJsonlLegacyDonePrefix(value) {
    return /^\s*\{\s*"type"\s*:\s*"done"\s*,\s*"deferred_ids"\s*:/
      .test(String(value || ""));
  }

  function createAiJsonlTranslationState(itemsValue, targetLang) {
    const items = Array.isArray(itemsValue) ? itemsValue.filter(Boolean) : [];
    return {
      items,
      expected: items.map((item) => String(item && item.id)),
      targetLang: String(targetLang || ""),
      cursor: 0,
      translations: [],
      done: false,
      error: ""
    };
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

    if (record.type === "done") {
      const remaining = state.expected.slice(state.cursor);
      state.done = true;
      // The stream cursor is the source of truth. Older models may still attach
      // a deferred_ids array, but reading or trusting an enumerated suffix only
      // invites numeric continuation and cannot add any coverage information.
      return { ok: true, type: "done", deferredIds: remaining, translations: [] };
    }

    if (record.type !== "unit") return reject("unknown JSONL record type");
    const chunks = Array.isArray(record.chunks) ? record.chunks : [];
    if (!chunks.length) return reject(`missing JSONL unit chunks at offset ${state.cursor}`);
    const alignedChunks = [];
    const ids = [];
    for (const chunk of chunks) {
      const chunkIds = chunk && Array.isArray(chunk.ids) ? chunk.ids.map(String) : [];
      const translation = String(chunk && chunk.translation || "").trim();
      if (!chunkIds.length || !translation) {
        return reject(`invalid JSONL chunk at offset ${state.cursor + ids.length}`);
      }
      for (const id of chunkIds) {
        const expectedId = state.expected[state.cursor + ids.length];
        if (id !== expectedId) {
          return reject(`unexpected JSONL id ${id} at offset ${state.cursor + ids.length}`);
        }
        ids.push(id);
      }
      alignedChunks.push({ ids: chunkIds, translation });
    }
    if (!ids.length) return reject(`empty JSONL unit at offset ${state.cursor}`);
    for (let index = state.cursor; index < state.cursor + ids.length - 1; index++) {
      if (state.items[index] && state.items[index].hardAfter) {
        return reject(`JSONL unit crosses hard boundary after cue ${state.expected[index]}`);
      }
    }
    const firstItem = state.items[state.cursor] || {};
    const lastItem = state.items[state.cursor + ids.length - 1] || {};
    const durationMs = Number(lastItem.endMs) - Number(firstItem.startMs);
    const sourceChars = state.items.slice(state.cursor, state.cursor + ids.length)
      .reduce((sum, item) => sum + String(item && item.text || "").length, 0);
    if (ids.length > 1 &&
        ((!Number.isFinite(durationMs) || durationMs > 45000) || sourceChars > 900)) {
      return reject(`oversized JSONL unit ${ids[0]}-${ids[ids.length - 1]}: ${durationMs}ms, ${sourceChars} chars`);
    }
    const translation = joinTranslatedParts(
      alignedChunks.map((chunk) => chunk.translation), state.targetLang
    );
    const unitId = `semantic-${ids[0]}-${ids[ids.length - 1]}`;
    const translations = ids.map((id, index) => index === 0
      ? { id, translation, unitId, alignedChunks }
      : { id, translation, unitId });
    state.translations.push(...translations);
    state.cursor += ids.length;
    return { ok: true, type: "unit", unitId, ids, translations };
  }

  function aiJsonlTranslationResult(stateValue, allowPartial) {
    const state = stateValue && typeof stateValue === "object" ? stateValue : null;
    if (!state || !Array.isArray(state.translations) || !Array.isArray(state.expected)) return null;
    const coverageComplete = state.cursor === state.expected.length;
    const partial = (!state.done && !coverageComplete) || !!state.error;
    if (partial && (!allowPartial || !state.translations.length)) return null;
    const deferredIds = state.expected.slice(state.cursor);
    const out = state.translations.slice();
    Object.defineProperties(out, {
      deferredIds: { value: deferredIds },
      streamPartial: { value: partial },
      streamError: { value: String(state.error || "") }
    });
    return out;
  }

  function joinTranslatedParts(values, targetLang) {
    const parts = (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (!parts.length) return "";
    const compact = /^(?:zh|ja|ko)(?:-|$)/i.test(String(targetLang || ""));
    let out = parts[0];
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const nextIsPunctuation = /^[,.;:!?。，；：！？、)）\]】}」』]/.test(part);
      const asciiBoundary = /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(part);
      const separator = nextIsPunctuation ? "" : compact ? (asciiBoundary ? " " : "") : " ";
      out += separator + part;
    }
    return out.trim();
  }

  // A provider can occasionally wrap many otherwise useful aligned chunks in
  // one giant outer unit. If that unit reaches the caller's maximum rolling
  // window, the trailing commit guard cannot release any prefix. Preserve the
  // model's own linguistic boundaries by promoting its chunks to units; never
  // invent a boundary from words, punctuation, player cues or timestamps.
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
        chunks.every((chunk) => String(chunk && chunk.translation || "").trim());
      if (!usable) {
        recovered.push(...members);
        index = end;
        continue;
      }
      let memberOffset = 0;
      for (const chunk of chunks) {
        const ids = chunk.ids.map(String);
        const translation = String(chunk.translation).trim();
        const chunkUnitId = `semantic-${ids[0]}-${ids[ids.length - 1]}`;
        for (let ordinal = 0; ordinal < ids.length; ordinal++) {
          const item = { ...members[memberOffset + ordinal], translation, unitId: chunkUnitId };
          delete item.alignedChunks;
          if (ordinal === 0) item.alignedChunks = [{ ids: ids.slice(), translation }];
          recovered.push(item);
        }
        memberOffset += ids.length;
      }
      promoted = true;
      index = end;
    }
    return promoted ? recovered : list.slice();
  }

  function alignedTranslationsFromJsonText(value, items, targetLang, diagnostics) {
    const reject = (reason) => {
      if (diagnostics && typeof diagnostics === "object") diagnostics.reason = reason;
      return null;
    };
    const parsed = jsonObjectFromText(value);
    if (!parsed || !Array.isArray(items) || !items.length) {
      return reject("missing aligned segments or current cue items");
    }
    const expected = items.map((item) => String(item && item.id));
    const deferredIds = Array.isArray(parsed.deferred_ids)
      ? parsed.deferred_ids.map(String) : [];
    if (deferredIds.length > expected.length) return reject("deferred suffix exceeds current cues");
    const completedCount = expected.length - deferredIds.length;
    for (let index = 0; index < deferredIds.length; index++) {
      if (deferredIds[index] !== expected[completedCount + index]) {
        return reject(`invalid deferred suffix id ${deferredIds[index]} at offset ${completedCount + index}`);
      }
    }
    let segments = [];
    if (Array.isArray(parsed.chunks) && parsed.chunks.length) {
      // Current schema: one flat array plus a small monotonic segment number.
      // This removes the only recursive shape from model output.
      let marker = 0;
      let current = null;
      for (const chunk of parsed.chunks) {
        const nextMarker = Number(chunk && chunk.segment);
        if (!Number.isInteger(nextMarker) || nextMarker < 1 ||
            (marker && nextMarker !== marker && nextMarker !== marker + 1)) {
          return reject(`invalid flat segment marker ${String(chunk && chunk.segment)}`);
        }
        if (!current || nextMarker !== marker) {
          current = { chunks: [] };
          segments.push(current);
          marker = nextMarker;
        }
        current.chunks.push(chunk);
      }
    } else if (Array.isArray(parsed.segments) && parsed.segments.length) {
      // Backward compatibility and structural recovery: some model responses
      // accidentally put the next {chunks:[...]} container inside the current
      // chunks array. Lift container-only entries into following segments while
      // leaving every actual id/translation leaf untouched for strict validation.
      const liftContainers = (container) => {
        const children = Array.isArray(container && container.chunks) ? container.chunks : [];
        const hasNestedContainer = children.some((child) =>
          child && !Array.isArray(child.ids) && Array.isArray(child.chunks)
        );
        const out = [];
        let leaves = [];
        const flush = () => {
          if (!leaves.length) return;
          out.push({
            ...(!hasNestedContainer && container && Array.isArray(container.ids)
              ? { ids: container.ids } : {}),
            chunks: leaves
          });
          leaves = [];
        };
        for (const child of children) {
          if (child && !Array.isArray(child.ids) && Array.isArray(child.chunks)) {
            flush();
            out.push(...liftContainers(child));
          } else {
            leaves.push(child);
          }
        }
        flush();
        return out;
      };
      segments = parsed.segments.flatMap(liftContainers);
    }
    if (!segments.length && !deferredIds.length) {
      return reject("missing aligned segments or current cue items");
    }
    const translations = [];
    let cursor = 0;

    for (const segment of segments) {
      const chunks = segment && Array.isArray(segment.chunks) ? segment.chunks : [];
      const declaredIds = segment && Array.isArray(segment.ids) ? segment.ids.map(String) : [];
      // The compact v3.24.3 schema omits segment.ids because the ordered chunk
      // ids already describe the same coverage. Continue accepting the older
      // duplicated form so cached/debug responses remain replayable.
      const ids = declaredIds.length ? declaredIds : chunks.flatMap((chunk) =>
        chunk && Array.isArray(chunk.ids) ? chunk.ids.map(String) : []
      );
      if (!ids.length || !chunks.length || cursor + ids.length > completedCount) {
        return reject(`invalid aligned segment at cue offset ${cursor}`);
      }
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== expected[cursor + i]) {
          return reject(`unexpected cue id ${ids[i]} at offset ${cursor + i}`);
        }
      }
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
      if (ids.length > 1 &&
          ((!Number.isFinite(durationMs) || durationMs > 45000) || sourceChars > 900)) {
        return reject(`oversized segment ${ids[0]}-${ids[ids.length - 1]}: ${durationMs}ms, ${sourceChars} chars`);
      }

      const alignedChunks = [];
      let chunkCursor = 0;
      for (const chunk of chunks) {
        const chunkIds = chunk && Array.isArray(chunk.ids) ? chunk.ids.map(String) : [];
        const translation = String(chunk && chunk.translation || "").trim();
        if (!chunkIds.length || !translation || chunkCursor + chunkIds.length > ids.length) {
          return reject(`invalid aligned chunk at segment offset ${chunkCursor}`);
        }
        for (let i = 0; i < chunkIds.length; i++) {
          if (chunkIds[i] !== ids[chunkCursor + i]) {
            return reject(`unexpected aligned chunk id ${chunkIds[i]} at segment offset ${chunkCursor + i}`);
          }
        }
        // Chunk size is a presentation concern, not a semantic-validity rule.
        // Keep structurally correct model alignment even when one chunk is too
        // wide; the renderer measures the real fonts and viewport and switches
        // that unit to its pixel-aware pagination path when necessary.
        alignedChunks.push({ ids: chunkIds, translation });
        chunkCursor += chunkIds.length;
      }
      if (chunkCursor !== ids.length) {
        return reject(`missing aligned chunk coverage after segment offset ${chunkCursor}`);
      }

      const translation = joinTranslatedParts(
        alignedChunks.map((chunk) => chunk.translation), targetLang
      );
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

  Object.assign(internal, { jsonObjectFromText, translationFromJsonText, segmentedTranslationsFromJsonText, aiJsonlLines, aiJsonlRecordFromLine, aiJsonlLegacyDonePrefix, createAiJsonlTranslationState, pushAiJsonlTranslationRecord, aiJsonlTranslationResult, joinTranslatedParts, semanticUnitsFromAlignedChunks, alignedTranslationsFromJsonText });
})();
