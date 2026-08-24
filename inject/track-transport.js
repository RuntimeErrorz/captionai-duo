// MAIN-world timedtext transport shared by the source and manual-translation
// track loaders. Proof-bearing URLs never leave this execution world.
(() => {
  "use strict";
  if (window.__ytdsCaptionTrackTransport) return;

  const pageFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;

  function hasTlang(value) {
    try {
      return new URL(value, location.href).searchParams.has("tlang");
    } catch (_e) {
      return /[?&]tlang=/.test(String(value || ""));
    }
  }

  function trackKindOf(value) {
    try {
      return new URL(value, location.href).searchParams.get("kind") === "asr"
        ? "asr" : "manual";
    } catch (_e) {
      return "manual";
    }
  }

  function sourceLanguageOf(value) {
    try {
      const lang = new URL(value, location.href).searchParams.get("lang") || "";
      return /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(lang)
        ? lang.slice(0, 24) : "";
    } catch (_e) {
      return "";
    }
  }

  function vidOfUrl(value, fallback) {
    try {
      return new URL(value, location.href).searchParams.get("v") || String(fallback || "");
    } catch (_e) {
      return String(fallback || "");
    }
  }

  function buildUrl(base) {
    const url = new URL(base, location.href);
    url.searchParams.delete("tlang");
    url.searchParams.set("fmt", "json3");
    return url.toString();
  }

  function hasSessionParams(value) {
    try {
      const params = new URL(value, location.href).searchParams;
      return ["pot", "potc", "c", "cver", "cplayer", "cbr", "cbrver", "cos", "cosver", "cplatform"]
        .some((name) => params.has(name));
    } catch (_e) { return false; }
  }

  // The player response's baseUrl is signed but may not contain the current
  // session proof. Reuse only missing session parameters from a URL the
  // player actually requested; never replace the target track's signature or
  // language/track selectors.
  function graftSessionParams(base, donor) {
    const target = new URL(base, location.href);
    const source = new URL(donor, location.href);
    for (const name of ["pot", "potc", "c", "cver", "cplayer", "cbr", "cbrver", "cos", "cosver", "cplatform"]) {
      const value = source.searchParams.get(name);
      if (value !== null && !target.searchParams.has(name)) target.searchParams.set(name, value);
    }
    return target.toString();
  }

  function parseJson3(json) {
    const cues = [];
    if (!json || !Array.isArray(json.events)) return cues;
    for (const event of json.events) {
      if (!event || !Array.isArray(event.segs)) continue;
      let text = "";
      let offset = 0;
      const parts = [];
      for (const segment of event.segs) {
        if (!segment || typeof segment.utf8 !== "string") continue;
        text += segment.utf8;
        if (!segment.utf8.trim()) continue;
        const part = { text: segment.utf8 };
        if (typeof segment.tOffsetMs === "number" && Number.isFinite(segment.tOffsetMs)) {
          offset = segment.tOffsetMs;
          part.offsetMs = segment.tOffsetMs;
        }
        parts.push(part);
      }
      text = text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const start = typeof event.tStartMs === "number" ? event.tStartMs : 0;
      const dur = typeof event.dDurationMs === "number" ? event.dDurationMs : 0;
      cues.push({ start, dur, text, lastOff: start + offset, parts });
    }
    return cues;
  }

  function decodeEntities(value) {
    const text = String(value || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "");
    if (typeof document !== "undefined" && typeof DOMParser === "function") {
      try {
        const node = new DOMParser().parseFromString(`<body>${text}</body>`, "text/html").body;
        if (node) return (node.textContent || "").replace(/\s+/g, " ").trim();
      } catch (_e) { /* use the small entity table below */ }
    }
    return text.replace(/&(amp|lt|gt|quot|apos|#39|#x27);/gi, (_all, entity) => ({
      amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'"
    }[String(entity).toLowerCase()] || _all)).replace(/\s+/g, " ").trim();
  }

  function timestampMs(value) {
    const parts = String(value || "").trim().replace(",", ".").split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part)) || (parts.length !== 2 && parts.length !== 3)) {
      return NaN;
    }
    return Math.round((parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1]) * 1000);
  }

  function attributeValue(attributes, name) {
    const match = new RegExp(`${name}=["']([^"']*)["']`, "i").exec(attributes || "");
    return match ? match[1] : "";
  }

  function parseVtt(text) {
    const cues = [];
    const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const timing = /^(\S+)\s+-->\s+(\S+)/.exec(lines[index].trim());
      if (!timing) continue;
      const start = timestampMs(timing[1]);
      const end = timestampMs(timing[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      const parts = [];
      for (index++; index < lines.length && lines[index].trim(); index++) parts.push(lines[index]);
      const value = decodeEntities(parts.join(" "));
      if (value) cues.push({ start, dur: end - start, text: value, lastOff: start });
    }
    return cues;
  }

  function parseXml(text) {
    const cues = [];
    const source = String(text || "");
    const add = (attributes, value, seconds) => {
      const startValue = attributeValue(attributes, seconds ? "start" : "t");
      const durationValue = attributeValue(attributes, seconds ? "dur" : "d");
      const start = Number(startValue) * (seconds ? 1000 : 1);
      const duration = Number(durationValue || 0) * (seconds ? 1000 : 1);
      const cueText = decodeEntities(value);
      if (cueText && Number.isFinite(start) && start >= 0) {
        cues.push({ start: Math.round(start), dur: Math.max(0, Math.round(duration)),
          text: cueText, lastOff: Math.round(start) });
      }
    };
    let match;
    const textPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    while ((match = textPattern.exec(source))) add(match[1], match[2], true);
    if (cues.length) return cues;
    const paragraphPattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    while ((match = paragraphPattern.exec(source))) add(match[1], match[2], false);
    return cues;
  }

  function parseCaptionResponse(value) {
    if (value && typeof value === "object") return parseJson3(value);
    const text = String(value || "").trim();
    if (!text) return [];
    try {
      const cues = parseJson3(JSON.parse(text));
      if (cues.length) return cues;
    } catch (_e) { /* XML/VTT response */ }
    if (/^WEBVTT(?:\s|$)/i.test(text)) return parseVtt(text);
    if (/^\s*</.test(text)) return parseXml(text);
    return parseVtt(text);
  }

  async function xhrResponseText(xhr) {
    const type = String(xhr && xhr.responseType || "");
    if (!type || type === "text") return xhr.responseText || "";
    if (type === "json") return JSON.stringify(xhr.response || null);
    if (type === "blob" && xhr.response && typeof xhr.response.text === "function") {
      return xhr.response.text();
    }
    if (type === "arraybuffer" && xhr.response && typeof TextDecoder === "function") {
      return new TextDecoder().decode(new Uint8Array(xhr.response));
    }
    if (type === "document" && xhr.responseXML && typeof XMLSerializer === "function") {
      return new XMLSerializer().serializeToString(xhr.responseXML);
    }
    return "";
  }

  async function fetchJson3(url, markInternal) {
    if (!pageFetch) throw new Error("fetch unavailable");
    if (typeof markInternal === "function") markInternal(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await pageFetch(url, {
        method: "GET", credentials: "include", signal: controller.signal
      });
      if (!response.ok) throw new Error("timedtext http " + response.status);
      const text = await response.text();
      if (!text) throw new Error("timedtext empty body");
      try { return JSON.parse(text); } catch (_e) { return text; }
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchCaptionCues(base, donor, markInternal) {
    const url = donor
      ? buildUrl(graftSessionParams(base, donor)) : buildUrl(base);
    const response = await fetchJson3(url, markInternal);
    const cues = parseCaptionResponse(response);
    if (!cues.length) throw new Error("timedtext contained no cues");
    return { cues, usedSession: !!donor };
  }

  window.__ytdsCaptionTrackTransport = Object.freeze({
    buildUrl, graftSessionParams, hasSessionParams, parseJson3, parseCaptionResponse, fetchJson3,
    fetchCaptionCues, xhrResponseText,
    hasTlang, trackKindOf, sourceLanguageOf, vidOfUrl
  });
})();
