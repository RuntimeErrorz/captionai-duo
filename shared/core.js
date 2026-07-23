// Shared constants, settings, API configuration and prompt context.
(() => {
  "use strict";
  if (globalThis.YTDS_SHARED) return;
  const internal = Object.create(null);
  Object.defineProperty(globalThis, "__captionAiDuoSharedModulesV1__", {
    value: internal, configurable: true, enumerable: false, writable: false
  });

  const TARGET_LANGS = Object.freeze([
    "zh-CN", "en", "ja", "ko", "es", "fr", "de",
    "ru", "pt", "it", "ar", "hi", "id", "th", "vi"
  ]);
  const TARGET_LANG_SET = new Set(TARGET_LANGS);

  const AI_DEFAULT_BASE_URL = "https://api.deepseek.com";
  const AI_DEFAULT_MODEL = "deepseek-v4-flash";
  const AI_EXTRA_BODY_MAX_CHARS = 4096;
  const AI_EXTRA_BODY_MAX_DEPTH = 8;
  const AI_EXTRA_BODY_MAX_KEYS = 128;
  const AI_EXTRA_BODY_FORBIDDEN_KEYS = new Set([
    "__proto__", "prototype", "constructor"
  ]);
  // These fields define the transport and the JSONL subtitle contract. Letting
  // arbitrary endpoint options replace them would make validation impossible.
  const AI_EXTRA_BODY_RESERVED_KEYS = new Set([
    "messages", "model", "stream", "max_tokens", "max_completion_tokens",
    "response_format", "tools", "tool_choice", "parallel_tool_calls", "n",
    "modalities", "audio"
  ]);

  const DEFAULTS = Object.freeze({
    enabled: true,
    targetLang: "zh-CN",
    aiBaseUrl: AI_DEFAULT_BASE_URL,
    aiModel: AI_DEFAULT_MODEL,
    aiExtraBodyRevision: 0,
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

  function aiRequestProfileScope(baseUrlValue, modelValue) {
    const baseUrl = normalizeAiBaseUrl(baseUrlValue);
    const model = String(modelValue || "").trim().slice(0, 160);
    return baseUrl && model ? JSON.stringify([baseUrl, model]) : "";
  }

  function aiExtraBodyError(code, key) {
    return { ok: false, value: {}, canonical: "{}", error: code, key: key || "" };
  }

  // Parse untrusted user JSON into a null-prototype, deterministically ordered
  // tree. This both prevents prototype pollution and gives response-cache keys
  // a stable representation when the user only changes whitespace/key order.
  function parseAiExtraBody(value) {
    let parsed = value;
    if (typeof value === "string") {
      const source = value.trim();
      if (!source) return { ok: true, value: {}, canonical: "{}", error: "", key: "" };
      if (source.length > AI_EXTRA_BODY_MAX_CHARS) return aiExtraBodyError("tooLarge");
      try { parsed = JSON.parse(source); }
      catch (_e) { return aiExtraBodyError("invalidJson"); }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return aiExtraBodyError("rootObject");
    }

    let keyCount = 0;
    function copy(node, depth, topLevel) {
      if (node === null || typeof node === "string" || typeof node === "boolean") return node;
      if (typeof node === "number") {
        if (!Number.isFinite(node)) throw { code: "invalidValue" };
        return node;
      }
      if (!node || typeof node !== "object") throw { code: "invalidValue" };
      if (depth > AI_EXTRA_BODY_MAX_DEPTH) throw { code: "tooDeep" };
      if (Array.isArray(node)) return node.map((entry) => copy(entry, depth + 1, false));
      const out = Object.create(null);
      for (const key of Object.keys(node).sort()) {
        keyCount++;
        if (keyCount > AI_EXTRA_BODY_MAX_KEYS) throw { code: "tooManyKeys" };
        if (AI_EXTRA_BODY_FORBIDDEN_KEYS.has(key)) throw { code: "forbiddenKey", key };
        if (topLevel && AI_EXTRA_BODY_RESERVED_KEYS.has(key)) {
          throw { code: "reservedKey", key };
        }
        out[key] = copy(node[key], depth + 1, false);
      }
      return out;
    }

    try {
      const clean = copy(parsed, 0, true);
      const canonical = JSON.stringify(clean);
      if (canonical.length > AI_EXTRA_BODY_MAX_CHARS) return aiExtraBodyError("tooLarge");
      return { ok: true, value: clean, canonical, error: "", key: "" };
    } catch (err) {
      return aiExtraBodyError(err && err.code || "invalidValue", err && err.key);
    }
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

  function nonNegativeTokenCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  }

  // Normalize OpenAI/DeepSeek/Gemini usage shapes without estimating missing
  // values. A null result means that the endpoint did not report token usage.
  function normalizeAiTokenUsage(value) {
    const root = value && typeof value === "object" ? value : null;
    const usage = root && (root.usage || root.usageMetadata || root.usage_metadata || root);
    if (!usage) return null;
    const hasReportedCount = [
      "prompt_tokens", "completion_tokens", "total_tokens",
      "input_tokens", "output_tokens", "total_input_tokens", "total_output_tokens",
      "promptTokenCount", "candidatesTokenCount", "totalTokenCount"
    ].some((key) => Number.isFinite(Number(usage[key])));
    if (!hasReportedCount) return null;
    const promptTokens = nonNegativeTokenCount(
      usage.prompt_tokens != null ? usage.prompt_tokens
        : usage.input_tokens != null ? usage.input_tokens
        : usage.total_input_tokens != null ? usage.total_input_tokens
        : usage.promptTokenCount
    );
    const completionTokens = nonNegativeTokenCount(
      usage.completion_tokens != null ? usage.completion_tokens
        : usage.output_tokens != null ? usage.output_tokens
        : usage.total_output_tokens != null ? usage.total_output_tokens
        : usage.candidatesTokenCount
    );
    const totalTokens = nonNegativeTokenCount(
      usage.total_tokens != null ? usage.total_tokens
        : usage.totalTokenCount != null ? usage.totalTokenCount
        : promptTokens + completionTokens
    );
    const promptDetails = usage.prompt_tokens_details &&
      typeof usage.prompt_tokens_details === "object" ? usage.prompt_tokens_details : {};
    const completionDetails = usage.completion_tokens_details &&
      typeof usage.completion_tokens_details === "object" ? usage.completion_tokens_details : {};
    const cacheHitTokens = nonNegativeTokenCount(
      usage.prompt_cache_hit_tokens != null
        ? usage.prompt_cache_hit_tokens
        : promptDetails.cached_tokens != null ? promptDetails.cached_tokens
        : usage.cachedContentTokenCount != null ? usage.cachedContentTokenCount
        : usage.total_cached_tokens
    );
    const explicitMiss = usage.prompt_cache_miss_tokens;
    const cacheMissTokens = explicitMiss != null
      ? nonNegativeTokenCount(explicitMiss)
      : Math.max(0, promptTokens - cacheHitTokens);
    const reasoningTokens = nonNegativeTokenCount(
      completionDetails.reasoning_tokens != null
        ? completionDetails.reasoning_tokens
        : usage.reasoning_tokens != null ? usage.reasoning_tokens
        : usage.thoughtsTokenCount != null ? usage.thoughtsTokenCount
        : usage.total_thought_tokens
    );
    return {
      promptTokens,
      completionTokens,
      totalTokens: totalTokens || promptTokens + completionTokens,
      cacheHitTokens,
      cacheMissTokens,
      reasoningTokens
    };
  }

  // Prompt-only compact rows. Full timing metadata remains local for
  // validation, rendering and SRT export; the model only needs lexical ids,
  // text, the following pause and whether that edge is soft or hard.
  function compactAiPromptCueRows(itemsValue) {
    return (Array.isArray(itemsValue) ? itemsValue : []).filter(Boolean).map((item) => [
      String(item.id),
      String(item.text || ""),
      Math.max(0, Math.round(Number(item.pauseAfterMs) || 0)),
      item.hardAfter ? "h" : item.softAfter ? "s" : ""
    ]);
  }

  function compactAiPromptContextRows(entriesValue) {
    return (Array.isArray(entriesValue) ? entriesValue : []).filter(Boolean).map((entry) => [
      String(entry.id || ""),
      String(entry.text || "")
    ]);
  }

  function aiChatCompletionBody(configValue, messages, maxTokens, temperature, optionsValue) {
    const config = configValue && typeof configValue === "object" ? configValue : {};
    const options = optionsValue && typeof optionsValue === "object" ? optionsValue : {};
    const endpointKind = aiEndpointKind(config.baseUrl);
    const parsedExtra = parseAiExtraBody(config.extraBody || {});
    const usesThinking = parsedExtra.ok && aiExtraBodyUsesThinking(parsedExtra.value);
    const body = {
      messages: Array.isArray(messages) ? messages : [],
      ...(endpointKind === "deepseek" ? {
        ...(!options.jsonLines ? { response_format: { type: "json_object" } } : {})
      } : {}),
      stream_options: { include_usage: true },
      max_tokens: Math.max(1, Math.min(16384, Math.round(Number(maxTokens) || 2048))),
      model: String(config.model || "").trim(),
      ...(!usesThinking ? {
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2
      } : {}),
      stream: true
    };
    if (parsedExtra.ok) {
      for (const [key, value] of Object.entries(parsedExtra.value)) body[key] = value;
    }
    // Reassert the protected transport/contract values after the merge even
    // though the parser rejects them. This keeps direct programmatic callers
    // safe if validation rules evolve independently.
    body.messages = Array.isArray(messages) ? messages : [];
    body.max_tokens = Math.max(1, Math.min(16384, Math.round(Number(maxTokens) || 2048)));
    body.model = String(config.model || "").trim();
    body.stream = true;
    return body;
  }

  function aiExtraBodyUsesThinking(value) {
    const parsed = parseAiExtraBody(value);
    if (!parsed.ok) return false;
    const extra = parsed.value;
    if (extra.enable_thinking === true || extra.thinking === true) return true;
    if (extra.thinking && typeof extra.thinking === "object") {
      const type = String(extra.thinking.type || "").trim().toLowerCase();
      if (type && !["disabled", "off", "none", "false"].includes(type)) return true;
    }
    if (Object.prototype.hasOwnProperty.call(extra, "reasoning_effort")) {
      const effort = String(extra.reasoning_effort || "").trim().toLowerCase();
      return !!effort && !["disabled", "off", "none", "false"].includes(effort);
    }
    return false;
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

  Object.assign(internal, {
    TARGET_LANGS, AI_DEFAULT_BASE_URL, AI_DEFAULT_MODEL, DEFAULTS, FONT_STACKS,
    normalizeTargetLang, normalizeAiBaseUrl, aiEndpointKind,
    aiChatCompletionsUrl, aiOriginPattern, aiCredentialScope, aiRequestProfileScope,
    parseAiExtraBody, aiCompletionText,
    normalizeAiTokenUsage, compactAiPromptCueRows, compactAiPromptContextRows,
    aiExtraBodyUsesThinking,
    aiChatCompletionBody, normalizeDeepseekPrefetchBatches, normalizeAiContextCount,
    preparePromptContexts
  });
})();
