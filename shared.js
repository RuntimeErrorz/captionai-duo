// shared.js — immutable constants and pure helpers used by every extension context.
(() => {
  "use strict";

  if (globalThis.YTDS_SHARED) return;

  const TARGET_LANGS = Object.freeze([
    "zh-CN", "en", "ja", "ko", "es", "fr", "de",
    "ru", "pt", "it", "ar", "hi", "id", "th", "vi"
  ]);
  const TARGET_LANG_SET = new Set(TARGET_LANGS);

  const AI_DEFAULT_BASE_URL = "https://api.deepseek.com";
  const AI_DEFAULT_MODEL = "deepseek-v4-flash";

  const DEFAULTS = Object.freeze({
    enabled: true,
    targetLang: "zh-CN",
    aiBaseUrl: AI_DEFAULT_BASE_URL,
    aiModel: AI_DEFAULT_MODEL,
    aiThinking: "disabled",
    deepseekContextPast: 1,
    deepseekContextFuture: 1,
    deepseekPrefetchBatches: 1,
    debugEnabled: false,
    order: "trans-top",
    rowGap: 4,
    position: "bottom",
    posMode: "preset",
    posXpct: 50,
    posYpct: 90,
    showOriginal: true,
    origFont: "system",
    origSize: 24,
    origFullscreenSize: 34,
    origColor: "#ffffff",
    origBg: "#080808",
    origBgOpacity: 0,
    origStroke: "#000000",
    origStrokeOpacity: 1,
    origStrokeWidth: 4,
    showTranslation: true,
    transFont: "system",
    transSize: 24,
    transFullscreenSize: 34,
    transColor: "#ffffff",
    transBg: "#080808",
    transBgOpacity: 0,
    transStroke: "#000000",
    transStrokeOpacity: 1,
    transStrokeWidth: 4
  });

  const FONT_STACKS = Object.freeze({
    system:  'system-ui, -apple-system, "Segoe UI", sans-serif',
    roboto:  'Roboto, "YouTube Noto", sans-serif',
    noto:    '"Noto Sans", "YouTube Noto", sans-serif',
    arial:   'Arial, Helvetica, sans-serif',
    georgia: 'Georgia, "Times New Roman", serif',
    times:   '"Times New Roman", Times, serif',
    mono:    '"Courier New", ui-monospace, monospace',
    cjk:     '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
  });

  function normalizeTargetLang(value) {
    return TARGET_LANG_SET.has(value) ? value : DEFAULTS.targetLang;
  }

  function normalizeAiThinking(value) {
    return value === "max" ? "max" : value === "high" ? "high" : "disabled";
  }

  function isLocalAiHostname(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1";
  }

  // API bases may include a compatibility prefix such as /v1. Remote endpoints
  // must use HTTPS; plain HTTP is accepted only for local model servers.
  function normalizeAiBaseUrl(value) {
    const raw = String(value || "").trim() || AI_DEFAULT_BASE_URL;
    if (!raw) return "";
    try {
      const url = new URL(raw);
      if (url.username || url.password || url.search || url.hash) return "";
      if (url.protocol !== "https:" &&
          !(url.protocol === "http:" && isLocalAiHostname(url.hostname))) return "";
      let pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
      if (pathname === "/") pathname = "";
      return `${url.origin}${pathname}`;
    } catch (_e) {
      return "";
    }
  }

  function aiEndpointKind(value) {
    const base = normalizeAiBaseUrl(value);
    if (!base) return "custom";
    try {
      return new URL(base).hostname.toLowerCase() === "api.deepseek.com"
        ? "deepseek" : "compatible";
    } catch (_e) {
      return "compatible";
    }
  }

  function aiChatCompletionsUrl(value) {
    const base = normalizeAiBaseUrl(value);
    if (!base) return "";
    return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  }

  function aiOriginPattern(value) {
    const base = normalizeAiBaseUrl(value);
    if (!base) return "";
    try {
      const url = new URL(base);
      return `${url.protocol}//${url.hostname}/*`;
    } catch (_e) {
      return "";
    }
  }

  function aiCredentialScope(baseUrlValue) {
    const baseUrl = normalizeAiBaseUrl(baseUrlValue);
    if (aiEndpointKind(baseUrl) === "deepseek") return "deepseek";
    return baseUrl ? `custom:${baseUrl}` : "";
  }

  function aiCompletionText(payload) {
    const choice = payload && Array.isArray(payload.choices) && payload.choices[0];
    const content = choice && ((choice.message && choice.message.content) ||
      (choice.delta && choice.delta.content));
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => typeof part === "string" ? part :
      part && typeof part.text === "string" ? part.text : "").join("");
  }

  function aiChatCompletionBody(configValue, messages, maxTokens, temperature) {
    const config = configValue && typeof configValue === "object" ? configValue : {};
    const endpointKind = aiEndpointKind(config.baseUrl);
    const thinking = normalizeAiThinking(config.thinking);
    const thinkingEnabled = thinking !== "disabled";
    return {
      messages: Array.isArray(messages) ? messages : [],
      ...(endpointKind === "deepseek" ? {
        response_format: { type: "json_object" },
        thinking: { type: thinkingEnabled ? "enabled" : "disabled" }
      } : {}),
      max_tokens: Math.max(1, Math.min(16384, Math.round(Number(maxTokens) || 2048))),
      model: String(config.model || "").trim(),
      ...(thinkingEnabled ? { reasoning_effort: thinking } : {
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2
      }),
      stream: true
    };
  }

  function normalizeDeepseekPrefetchBatches(value) {
    const count = Number(value);
    return Number.isFinite(count)
      ? Math.max(0, Math.min(10, Math.round(count)))
      : DEFAULTS.deepseekPrefetchBatches;
  }

  function normalizeAiContextCount(value, fallbackValue) {
    const count = Number(value);
    const fallback = Number.isFinite(Number(fallbackValue))
      ? Number(fallbackValue) : 0;
    return Number.isFinite(count)
      ? Math.max(0, Math.min(20, Math.round(count)))
      : Math.max(0, Math.min(20, Math.round(fallback)));
  }

  function normalizedContextText(value) {
    let text = String(value || "").replace(/\s+/g, " ").trim();
    try { text = text.normalize("NFKC"); } catch (_e) { /* old JS engine */ }
    return text.toLocaleLowerCase();
  }

  function dedupeRollingContext(entriesValue, currentTextValue) {
    const entries = Array.isArray(entriesValue) ? entriesValue.filter(Boolean) : [];
    const current = normalizedContextText(currentTextValue);
    const out = [];
    for (const raw of entries) {
      const entry = { ...raw, text: String(raw.text || "").replace(/\s+/g, " ").trim() };
      const key = normalizedContextText(entry.text);
      if (!key || (key.length >= 4 && current.includes(key))) continue;
      const previous = out[out.length - 1];
      const previousKey = previous && normalizedContextText(previous.text);
      if (previousKey === key || (previousKey && previousKey.includes(key))) continue;
      // Rolling ASR cues commonly grow by repeating the preceding text and
      // appending new words. Keep the newer, more informative form once.
      if (previousKey && key.length >= 4 && key.includes(previousKey)) {
        out[out.length - 1] = entry;
      } else {
        out.push(entry);
      }
    }
    return out;
  }

  function preparePromptContexts(
    beforeValue, afterValue, pastCountValue, futureCountValue,
    currentItemsValue, maxSourceCharsValue
  ) {
    const pastCount = normalizeAiContextCount(pastCountValue, 0);
    const futureCount = normalizeAiContextCount(futureCountValue, 0);
    const currentItems = Array.isArray(currentItemsValue) ? currentItemsValue.filter(Boolean) : [];
    const currentText = currentItems.map((item) => String(item.text || "")).join(" ");
    const currentChars = currentItems.reduce(
      (sum, item) => sum + String(item.text || "").length + 32, 0
    );
    const maxSourceChars = Math.max(1024, Math.floor(Number(maxSourceCharsValue) || 28000));
    let remaining = Math.max(0, maxSourceChars - currentChars);
    const pastCandidates = dedupeRollingContext(
      (Array.isArray(beforeValue) ? beforeValue : []).slice(-pastCount), currentText
    );
    const futureCandidates = dedupeRollingContext(
      (Array.isArray(afterValue) ? afterValue : []).slice(0, futureCount), currentText
    );
    const past = [];
    const future = [];
    const seen = new Set();
    let pastIndex = pastCandidates.length - 1;
    let futureIndex = 0;
    let takePast = true;
    while (pastIndex >= 0 || futureIndex < futureCandidates.length) {
      let side;
      if ((takePast && pastIndex >= 0) || futureIndex >= futureCandidates.length) side = "past";
      else side = "future";
      const entry = side === "past" ? pastCandidates[pastIndex--] : futureCandidates[futureIndex++];
      takePast = !takePast;
      if (!entry) continue;
      const key = normalizedContextText(entry.text);
      if (!key || seen.has(key)) continue;
      const cost = String(entry.text || "").length + 64;
      if (cost > remaining) continue;
      seen.add(key);
      remaining -= cost;
      if (side === "past") past.unshift(entry);
      else future.push(entry);
    }
    return {
      past,
      future,
      currentChars,
      usedChars: maxSourceChars - remaining,
      maxSourceChars,
      droppedPast: Math.max(0, pastCandidates.length - past.length),
      droppedFuture: Math.max(0, futureCandidates.length - future.length)
    };
  }

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

  // Urgent playback work is sized only through the active batch. Speculative
  // targetThrough may be much farther ahead and is resumed after this response;
  // including it here delays the visible subtitle for work nobody can see yet.
  function semanticCommitRequestPlan(
    state, requestStartValue, guardItemsValue, maxItemsValue, urgent
  ) {
    const requestStart = Math.max(0, Math.floor(Number(requestStartValue) || 0));
    const guardItems = Math.max(0, Math.floor(Number(guardItemsValue) || 0));
    const maxItems = Math.max(1, Math.floor(Number(maxItemsValue) || 1));
    const windowItems = Math.max(1, Math.floor(Number(state && state.windowItems) || 1));
    const target = Math.floor(Number(urgent
      ? state && state.urgentThrough : state && state.targetThrough));
    const targetThrough = Number.isFinite(target) ? Math.max(requestStart - 1, target) : requestStart - 1;
    const targetItems = Math.max(0, targetThrough - requestStart + 1) + guardItems;
    return {
      targetThrough,
      // windowItems is also the adaptive recovery size. Never clamp it back to
      // the cold-start size after a guard-crossing unit requested expansion.
      itemCount: Math.min(maxItems, Math.max(windowItems, targetItems))
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

  function baseLanguageCode(value) {
    return String(value || "").trim().toLowerCase().split(/[-_]/)[0];
  }

  function targetScriptPattern(targetLang) {
    switch (baseLanguageCode(targetLang)) {
      case "zh": return /\p{Script=Han}/u;
      case "ja": return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
      case "ko": return /[\p{Script=Hangul}\p{Script=Han}]/u;
      case "ru": return /\p{Script=Cyrillic}/u;
      case "ar": return /\p{Script=Arabic}/u;
      case "hi": return /\p{Script=Devanagari}/u;
      case "th": return /\p{Script=Thai}/u;
      default: return null;
    }
  }

  function comparableTranslationText(value) {
    let text = String(value || "");
    try { text = text.normalize("NFKC"); } catch (_e) { /* old JS engine */ }
    return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join("");
  }

  function looksLikeProperNameOnly(value) {
    const words = String(value || "").match(/[\p{L}\p{M}][\p{L}\p{M}.'’_-]*/gu) || [];
    if (!words.length || words.length > 4) return false;
    return words.every((word) => /^[\p{Lu}]/u.test(word) || /^[\p{Lu}.]+$/u.test(word));
  }

  function protectedLiteralFacts(value) {
    let text = String(value || "");
    try { text = text.normalize("NFKC"); } catch (_e) { /* old JS engine */ }
    const matches = text.match(
      /(?:https?:\/\/|www\.)[^\s<>()\[\]{}"'“”‘’]+|[\p{L}\p{N}.%_+\-]+@[\p{L}\p{N}.\-]+\.[\p{L}]{2,}/giu
    ) || [];
    return Array.from(new Set(matches.map((part) =>
      part.replace(/[.,;:!?。，；：！？]+$/u, "").toLocaleLowerCase()
    ).filter(Boolean)));
  }

  function protectedNumericFacts(value) {
    let text = String(value || "");
    try { text = text.normalize("NFKC"); } catch (_e) { /* old JS engine */ }
    // Dates and clock times are deliberately excluded: natural translations
    // may reorder their components. Standalone numbers, decimals, grouped
    // thousands and percentages are stable enough for deterministic checks.
    text = text.replace(/\b\d{1,4}(?:[\/:\-]\d{1,4}){1,2}\b/g, " ");
    const matches = text.match(/[+\-]?(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s*[%‰°])?/g) || [];
    return matches.map((part) => part.replace(/\s+/g, "").replace(/,/g, ""));
  }

  function containsFactMultiset(sourceFacts, translationFacts) {
    const counts = new Map();
    for (const fact of sourceFacts) counts.set(fact, (counts.get(fact) || 0) + 1);
    for (const fact of translationFacts) counts.set(fact, (counts.get(fact) || 0) - 1);
    return Array.from(counts.values()).every((count) => count <= 0);
  }

  // This is deliberately a small output contract, not a translation scorer.
  // It catches only a model copying meaningful source text into a translation
  // field. Fluent-but-wrong translations remain a model-quality problem and
  // must not be guessed at with phrase-specific heuristics.
  function translationQualityIssue(sourceValue, translationValue, targetLang, sourceLang) {
    const source = String(sourceValue || "").trim();
    const translation = String(translationValue || "").trim();
    if (!translation) return "empty translation";
    if (!source) return "";
    const sourceLiterals = protectedLiteralFacts(source);
    const translationLiterals = new Set(protectedLiteralFacts(translation));
    const missingLiteral = sourceLiterals.find((fact) => !translationLiterals.has(fact));
    if (missingLiteral) return `translation omits protected token ${missingLiteral}`;
    const sourceNumbers = protectedNumericFacts(source);
    const translationNumbers = protectedNumericFacts(translation);
    if (!containsFactMultiset(sourceNumbers, translationNumbers)) {
      return "translation changes numeric facts";
    }
    const targetBase = baseLanguageCode(targetLang);
    const sourceBase = baseLanguageCode(sourceLang);
    const comparableSource = comparableTranslationText(source);
    const comparableTranslation = comparableTranslationText(translation);
    const properNameOnly = looksLikeProperNameOnly(source);
    if (!properNameOnly && comparableSource.length >= 24 &&
        comparableTranslation.length < Math.max(2, Math.floor(comparableSource.length * 0.08))) {
      return "translation is implausibly short";
    }
    if (targetBase && sourceBase && targetBase === sourceBase) return "";
    const targetScript = targetScriptPattern(targetLang);
    // When track metadata is unavailable, text already written in the target's
    // distinctive script is allowed to remain unchanged.
    if (!sourceBase && targetScript && targetScript.test(source)) return "";
    if (comparableSource.length >= 6 && comparableSource === comparableTranslation && !properNameOnly) {
      return "translation matches source text";
    }
    // For targets with a distinctive script, a non-name translation made only
    // of foreign-script words is a contract violation even when the model
    // paraphrased instead of copying byte-for-byte. Punctuation and numeric-only
    // answers remain valid (for example, "100%").
    if (targetScript && !targetScript.test(translation) && !properNameOnly &&
        /\p{L}/u.test(translation)) {
      return "translation does not use target language script";
    }
    return "";
  }

  function repairedUnitTranslationsFromJsonText(
    value, unitsValue, targetLang, sourceLang, diagnostics
  ) {
    const reject = (reason) => {
      if (diagnostics && typeof diagnostics === "object") diagnostics.reason = reason;
      return null;
    };
    const units = Array.isArray(unitsValue) ? unitsValue.filter(Boolean) : [];
    const parsed = jsonObjectFromText(value);
    const translated = parsed && parsed.translations;
    if (!units.length || !Array.isArray(translated) || translated.length !== units.length) {
      return reject("invalid translation repair count");
    }
    const out = [];
    for (let index = 0; index < units.length; index++) {
      const expected = units[index];
      const actual = translated[index];
      const unitId = String(actual && actual.unitId || "");
      const translation = String(actual && actual.translation || "").trim();
      if (!unitId || unitId !== String(expected.unitId || "")) {
        return reject(`unexpected translation repair unit ${unitId} at offset ${index}`);
      }
      const issue = translationQualityIssue(
        expected.source, translation, targetLang, sourceLang
      );
      if (issue) return reject(`${issue} for ${unitId}`);
      out.push({ unitId, translation });
    }
    if (diagnostics && typeof diagnostics === "object") diagnostics.reason = "";
    return out;
  }

  function segmentedTranslationsFromJsonText(
    value, items, diagnostics, targetLang, sourceLang
  ) {
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
      if (targetLang) {
        const source = mergeTimedCueTexts(items.slice(cursor, cursor + ids.length));
        const issue = translationQualityIssue(source, translation, targetLang, sourceLang);
        if (issue) return reject(`${issue} for semantic-${ids[0]}-${ids[ids.length - 1]}`);
      }
      const unitId = `semantic-${ids[0]}-${ids[ids.length - 1]}`;
      for (const id of ids) translations.push({ id, translation, unitId });
      cursor += ids.length;
    }
    if (cursor !== expected.length) return reject(`missing cue coverage after offset ${cursor}`);
    if (diagnostics && typeof diagnostics === "object") diagnostics.reason = "";
    return translations;
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

  function alignedChunkDisplayPlan(
    chunksValue, maxSourceWidthValue, maxTranslationWidthValue,
    measureSource, measureTranslation, targetLang
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

    const pageChunks = [];
    let current = [];
    for (const chunk of chunks) {
      const candidate = [...current, chunk];
      const candidateText = textFor(candidate);
      const overflows = sourceMeasure(candidateText.source) > sourceLimit ||
        translationMeasure(candidateText.translation) > translationLimit;
      if (current.length && overflows) {
        pageChunks.push(current);
        current = [chunk];
      } else {
        current = candidate;
      }
    }
    if (current.length) pageChunks.push(current);

    const memberPages = {};
    const pages = pageChunks.map((members, page) => {
      const text = textFor(members);
      const ids = members.flatMap((chunk) => chunk.ids);
      for (const id of ids) memberPages[id] = page;
      return { ...text, ids, chunkCount: members.length };
    });
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

  // Legacy safety pagination for responses without aligned model chunks.
  // Locale-aware sentence boundaries win over clause/word boundaries. Lexical
  // protected spans are never split even when doing so would balance widths.
  function splitTextForDisplay(value, pageCount, measureText, locale) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const requested = Math.max(1, Math.floor(Number(pageCount) || 1));
    if (!text || requested === 1) return text ? [{ text, start: 0, end: text.length }] : [];
    const measure = typeof measureText === "function"
      ? (part) => Math.max(0, Number(measureText(part)) || 0)
      : (part) => part.length;
    const candidates = [];
    const terminal = /[.!?…。！？]/;
    const clause = /[,;:，；：、]/;
    const cjk = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
    const protectedRanges = displayProtectedRanges(text);
    const sentenceBoundaries = displaySentenceBoundaries(text, locale);
    for (let i = 1; i < text.length; i++) {
      if (displayBoundaryIsProtected(i, protectedRanges)) continue;
      const prev = text[i - 1];
      let penalty = null;
      if (sentenceBoundaries && sentenceBoundaries.has(i)) penalty = 0;
      else if (terminal.test(prev)) penalty = sentenceBoundaries ? 0.28 : 0;
      else if (clause.test(prev)) penalty = 0.12;
      else if (/\s/.test(prev)) penalty = 0.42;
      else if (cjk.test(prev) && cjk.test(text[i])) penalty = 0.62;
      if (penalty == null) continue;
      const left = text.slice(0, i).trimEnd();
      const lastWord = (left.match(/([A-Za-z']+)$/) || [])[1];
      if (lastWord && /^(?:a|an|the|on|in|at|to|of|for|from|with|by|and|or|but|as)$/i.test(lastWord)) {
        penalty += 1.4;
      }
      candidates.push({ at: i, penalty });
    }
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

  function shouldBridgeSemanticCueGap(previous, next, timeMs, previousUnit, nextUnit, maxGapMs) {
    if (!previous || !next || !previousUnit || previousUnit !== nextUnit) return false;
    const time = Number(timeMs);
    const previousEnd = Number(previous.end);
    const nextStart = Number(next.start);
    const maxGap = Math.max(0, Number(maxGapMs) || 0);
    if (![time, previousEnd, nextStart].every(Number.isFinite)) return false;
    const gap = nextStart - previousEnd;
    return gap >= 0 && gap <= maxGap && time >= previousEnd && time < nextStart;
  }

  function causalCueGroups(cues) {
    return cues.map((cue, index) => ({
      startIdx: index,
      endIdx: index,
      text: cue.text,
      start: cue.start,
      end: cue.end,
      lastOff: cue.lastOff,
      dur: cue.dur
    }));
  }

  function deepSeekSseEvents(value, flush) {
    const input = String(value || "");
    const events = [];
    let cursor = 0;
    while (true) {
      const match = /\r?\n\r?\n/g;
      match.lastIndex = cursor;
      const boundary = match.exec(input);
      if (!boundary) break;
      const block = input.slice(cursor, boundary.index);
      cursor = boundary.index + boundary[0].length;
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) events.push(data);
    }
    let rest = input.slice(cursor);
    if (flush && rest.trim()) {
      const data = rest.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) events.push(data);
      rest = "";
    }
    return { events, rest };
  }

  const api = Object.freeze({
    TARGET_LANGS,
    AI_DEFAULT_BASE_URL,
    AI_DEFAULT_MODEL,
    DEFAULTS,
    FONT_STACKS,
    normalizeTargetLang,
    normalizeAiThinking,
    normalizeAiBaseUrl,
    aiEndpointKind,
    aiChatCompletionsUrl,
    aiOriginPattern,
    aiCredentialScope,
    aiCompletionText,
    aiChatCompletionBody,
    normalizeDeepseekPrefetchBatches,
    normalizeAiContextCount,
    preparePromptContexts,
    videoIdFromUrl,
    isYoutubePageUrl,
    videoIdMatchesPageUrls,
    isAllowedTimedtextUrl,
    cuePauseMs,
    semanticPauseKind,
    mergeTimedCueTexts,
    cueReferenceAtoms,
    referenceBatchWindows,
    ownedSemanticTranslations,
    monotonicSemanticCommitPlan,
    shouldReseedSemanticCommitState,
    semanticCommitRequestPlan,
    canonicalSemanticUnits,
    pendingTranslationScopeKey,
    semanticCoverageGaps,
    groupReferenceItemsByCue,
    semanticBatchWindows,
    semanticPrefetchBatchStarts,
    deepSeekConcurrencyStatus,
    jsonObjectFromText,
    translationFromJsonText,
    translationQualityIssue,
    repairedUnitTranslationsFromJsonText,
    joinTranslatedParts,
    segmentedTranslationsFromJsonText,
    alignedTranslationsFromJsonText,
    joinTranslatedParts,
    alignedChunkDisplayPlan,
    displayProtectedRanges,
    splitTextForDisplay,
    splitAlignedSentencesForDisplay,
    displayPageAssignments,
    sourceRangeForDisplayMember,
    semanticDisplayPlan,
    shouldBridgeSemanticCueGap,
    causalCueGroups,
    deepSeekSseEvents
  });
  Object.defineProperty(globalThis, "YTDS_SHARED", {
    value: api,
    enumerable: false,
    configurable: false,
    writable: false
  });
})();
