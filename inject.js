// inject.js — MAIN world, document_start.
// Hooks XMLHttpRequest + fetch to capture the YouTube player's OWN
// /api/timedtext request URL (which carries a valid "pot"), then reuses that
// exact URL to fetch the original json3 cues.
//
// NEVER throw into the page: every hook body is wrapped in try/catch.
(() => {
  "use strict";

  // ---- guard against double injection -------------------------------------
  if (window.__ytdsInjected) return;
  window.__ytdsInjected = true;

  const TIMEDTEXT_MARK = "/api/timedtext";

  // The player's ORIGINAL-track fetch: a timedtext URL WITHOUT a "tlang" param.
  // This is the only URL whose "pot" we may reuse.
  let sourceUrl = "";
  // The videoId that sourceUrl was captured for. produceCues bails if this no
  // longer matches the current location video, so a stale (previous-video) URL
  // can never be fetched and posted under the new videoId.
  let sourceVid = "";
  // Identity of the captured source track, IGNORING fmt/tlang. Used so our own
  // json3 re-fetches (and pot rotations on the same track) are not mistaken for
  // a brand-new source — which would otherwise re-trigger produceCues in a loop.
  let sourceKey = "";
  // Monotonic identity of the player's selected source track. Two different
  // timedtext tracks can be requested close together. Only the newest capture
  // may publish cues; otherwise completed fetches can replace each other's
  // timeline in content.js.
  let sourceRevision = 0;

  // Keep our own timedtext refetches out of noteTimedtext(). Both the fetch hook
  // and Resource Timing observe these requests. Without provenance, concurrent
  // refetches for different tracks can form a feedback loop and make the
  // original subtitle flash between two timelines.
  const internalTimedtextUrls = new Map();
  const INTERNAL_TIMEDTEXT_TTL_MS = 20000;
  const pageFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;

  let currentVideoId = videoIdFromLocation();

  // pending config from content.js (set once popup config arrives)
  let cfg = null;
  let nocuesTimer = null;    // fires if no timedtext URL shows up
  let producedForUrl = "";   // dedupe: last sourceUrl we produced cues for
  let cueFetchInFlightUrl = "";
  let quarantinedSourceUrl = "";
  let playerResponseTimer = null;
  let awaitingPlayerResponseUrl = "";
  let capturedPlayerCues = null;
  let capturedPlayerCuesUrl = "";
  let lastPublishedUrl = "";
  let lastPublishedNonce = 0;
  let freshSourceRequestedForUrl = "";
  let pendingFreshSourceRequest = false;
  // Correlation token echoed back to content.js so it can drop any
  // 'cues'/'nocues' that does not correspond to its latest sendConfig().
  let reqNonce = 0;

  // ---- helpers -------------------------------------------------------------
  function videoIdFromLocation() {
    return YTDS_SHARED.videoIdFromUrl(location.href);
  }

  function hasTlang(url) {
    try {
      return new URL(url, location.href).searchParams.has("tlang");
    } catch (_e) {
      return /[?&]tlang=/.test(url);
    }
  }

  function isTimedtext(url) {
    return typeof url === "string" && url.indexOf(TIMEDTEXT_MARK) !== -1 &&
      YTDS_SHARED.isAllowedTimedtextUrl(url);
  }

  function rememberInternalTimedtext(url) {
    const now = Date.now();
    internalTimedtextUrls.set(String(url), now + INTERNAL_TIMEDTEXT_TTL_MS);
    if (internalTimedtextUrls.size <= 32) return;
    for (const [knownUrl, expiresAt] of internalTimedtextUrls) {
      if (expiresAt <= now || internalTimedtextUrls.size > 32) {
        internalTimedtextUrls.delete(knownUrl);
      }
    }
  }

  function isInternalTimedtext(url) {
    const key = String(url || "");
    const expiresAt = internalTimedtextUrls.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      internalTimedtextUrls.delete(key);
      return false;
    }
    return true;
  }

  // Track identity ignoring the params that rotate or that WE vary. "pot" (the
  // proof-of-origin token) is rotated by the player periodically for the SAME
  // track — if we kept it in the key, each rotation would look like a brand-new
  // source and re-trigger produceCues, causing the overlay to flicker. So strip
  // pot/fmt/tlang; what remains (v, lang, kind, ...) is the stable track id.
  function normKey(url) {
    try {
      const u = new URL(url, location.href);
      u.searchParams.delete("fmt");
      u.searchParams.delete("tlang");
      u.searchParams.delete("pot");
      return u.toString();
    } catch (_e) {
      return url;
    }
  }

  // Track kind of a captured timedtext URL: auto-generated (ASR) tracks carry
  // kind=asr; human tracks have no kind param.
  function trackKindOf(url) {
    try {
      return new URL(url, location.href).searchParams.get("kind") === "asr"
        ? "asr" : "manual";
    } catch (_e) {
      return "manual";
    }
  }

  // Parse the "v" param off a captured timedtext URL when present; otherwise
  // fall back to the current location video id.
  function vidOfUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.searchParams.get("v") || videoIdFromLocation();
    } catch (_e) {
      return videoIdFromLocation();
    }
  }

  // Build a fetch URL from the captured source URL: preserve every param
  // (including pot + signature), force fmt=json3, drop any stray tlang.
  function buildUrl(base) {
    const u = new URL(base, location.href);
    u.searchParams.delete("tlang");
    u.searchParams.set("fmt", "json3");
    return u.toString();
  }

  // Parse json3 into cue objects. Robust against missing/empty segs.
  function parseJson3(json) {
    const cues = [];
    if (!json || !Array.isArray(json.events)) return cues;
    for (const ev of json.events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      let text = "";
      let off = 0;
      const parts = [];
      for (const s of ev.segs) {
        if (s && typeof s.utf8 === "string") {
          text += s.utf8;
          // Track the last NON-BLANK word's offset. ASR tracks carry per-word
          // tOffsetMs; blank segs ("\n") may carry one too and would inflate it.
          if (s.utf8.trim()) {
            const part = { text: s.utf8 };
            if (typeof s.tOffsetMs === "number" && Number.isFinite(s.tOffsetMs)) {
              off = s.tOffsetMs;
              part.offsetMs = s.tOffsetMs;
            }
            parts.push(part);
          }
        }
      }
      text = text.replace(/\s+/g, " ").trim();
      if (!text) continue;          // skip style/window/blank events
      const start = typeof ev.tStartMs === "number" ? ev.tStartMs : 0;
      const dur = typeof ev.dDurationMs === "number" ? ev.dDurationMs : 0;
      // lastOff = absolute time of the event's last word. Manual tracks have no
      // per-word segs, so lastOff === start — sentence grouping in content.js
      // reads the pause as (next.start - lastOff), which for manual tracks is
      // roughly the cue duration and therefore almost always a sentence break.
      cues.push({ start, dur, text, lastOff: start + off, parts });
    }
    return cues;
  }

  // page-context fetch — same-origin youtube.com so pot/signature stay valid.
  async function fetchJson3(url) {
    if (!pageFetch) throw new Error("fetch unavailable");
    rememberInternalTimedtext(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await pageFetch(url, {
        method: "GET", credentials: "include", signal: controller.signal
      });
      if (!res.ok) throw new Error("timedtext http " + res.status);
      const txt = await res.text();
      if (!txt) throw new Error("timedtext empty body");
      return JSON.parse(txt);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- bridge to content.js ------------------------------------------------
  function post(type, extra) {
    try {
      window.postMessage(Object.assign(
        { source: "ytds-inject", type, videoId: currentVideoId, nonce: reqNonce },
        extra || {}
      ), location.origin);
    } catch (_e) { /* never throw */ }
  }

  function postDiagnostic(event, data) {
    post("diagnostic", {
      event: String(event || "event"),
      data: data && typeof data === "object" ? data : {}
    });
  }

  function clearNocuesTimer() {
    if (nocuesTimer) { clearTimeout(nocuesTimer); nocuesTimer = null; }
  }

  function trackLanguageOf(url) {
    try {
      const lang = new URL(url, location.href).searchParams.get("lang") || "";
      return /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(lang)
        ? lang.slice(0, 24) : "";
    } catch (_e) {
      return "";
    }
  }

  function clearPlayerResponseTimer() {
    if (playerResponseTimer) { clearTimeout(playerResponseTimer); playerResponseTimer = null; }
  }

  function sourceStillCurrent(url, revision) {
    return url === sourceUrl && sourceVid === currentVideoId &&
      revision === sourceRevision;
  }

  function publishCues(cues, url, revision, origin) {
    if (!Array.isArray(cues) || !cues.length || !sourceStillCurrent(url, revision)) return;
    capturedPlayerCues = cues;
    capturedPlayerCuesUrl = url;
    producedForUrl = url;
    quarantinedSourceUrl = "";
    if (!cfg) return;
    const publishNonce = reqNonce;
    if (lastPublishedUrl === url && lastPublishedNonce === publishNonce) return;
    lastPublishedUrl = url;
    lastPublishedNonce = publishNonce;
    postDiagnostic("cue-fetch-success", {
      cueCount: cues.length,
      fetchNonce: publishNonce,
      sourceRevision: revision,
      trackKind: trackKindOf(url),
      sourceLang: trackLanguageOf(url),
      responseOrigin: String(origin || "refetch")
    });
    post("cues", {
      cues,
      trackKind: trackKindOf(url),
      sourceLang: trackLanguageOf(url),
      nonce: publishNonce
    });
  }

  function rejectCurrentSource(url, revision, reason, detail, requestFreshSource) {
    if (!sourceStillCurrent(url, revision)) return;
    quarantinedSourceUrl = url;
    producedForUrl = "";
    capturedPlayerCues = null;
    capturedPlayerCuesUrl = "";
    lastPublishedUrl = "";
    lastPublishedNonce = 0;
    const shouldRequestFreshSource = !!requestFreshSource &&
      freshSourceRequestedForUrl !== url;
    if (shouldRequestFreshSource) {
      freshSourceRequestedForUrl = url;
      pendingFreshSourceRequest = true;
    }
    if (!cfg) return;
    const notifyFreshSource = pendingFreshSourceRequest &&
      freshSourceRequestedForUrl === url;
    if (notifyFreshSource) pendingFreshSourceRequest = false;
    post("nocues", {
      reason: String(reason || "fetch-error"),
      detail: String(detail || "").slice(0, 240),
      requestFreshSource: notifyFreshSource
    });
  }

  function consumePlayerTimedtext(url, text, revision) {
    if (!sourceStillCurrent(url, revision)) return;
    awaitingPlayerResponseUrl = "";
    clearPlayerResponseTimer();
    const body = typeof text === "string" ? text : "";
    if (!body) {
      postDiagnostic("cue-fetch-error", {
        fetchNonce: reqNonce,
        sourceRevision: revision,
        detail: "player timedtext empty body",
        responseOrigin: "player"
      });
      rejectCurrentSource(
        url, revision, "fetch-error", "player timedtext empty body", true
      );
      return;
    }
    try {
      const cues = parseJson3(JSON.parse(body));
      if (cues.length) {
        publishCues(cues, url, revision, "player");
        return;
      }
      // A valid JSON caption response with no text is authoritative. Repeating
      // it with the same proof token cannot create cues.
      postDiagnostic("cue-fetch-empty", {
        fetchNonce: reqNonce,
        sourceRevision: revision,
        responseOrigin: "player"
      });
      rejectCurrentSource(url, revision, "empty-track", "player timedtext contained no cues");
    } catch (_e) {
      // The player may request XML/VTT. Its non-empty response proves the URL
      // is live, so a single json3 conversion fetch is safe and necessary.
      produceCues(true);
    }
  }

  function playerResponseUnavailable(url, revision) {
    if (!sourceStillCurrent(url, revision)) return;
    awaitingPlayerResponseUrl = "";
    clearPlayerResponseTimer();
    produceCues(true);
  }

  function awaitPlayerResponse(url, revision) {
    awaitingPlayerResponseUrl = url;
    clearPlayerResponseTimer();
    playerResponseTimer = setTimeout(() => {
      playerResponseTimer = null;
      if (awaitingPlayerResponseUrl !== url || !sourceStillCurrent(url, revision)) return;
      awaitingPlayerResponseUrl = "";
      produceCues(true);
    }, 750);
  }

  // Produce original cues from the captured source URL.
  async function produceCues(force) {
    if (!cfg || !sourceUrl) return;
    // The captured source URL must belong to the CURRENT video. Without this,
    // a config round-trip on SPA nav could refetch the previous video's URL and
    // post it stamped with the new videoId.
    if (sourceVid !== currentVideoId) return;
    if (!force && producedForUrl === sourceUrl) return;
    if (quarantinedSourceUrl === sourceUrl) return;
    if (awaitingPlayerResponseUrl === sourceUrl) return;
    if (cueFetchInFlightUrl === sourceUrl) return;
    producedForUrl = sourceUrl;
    cueFetchInFlightUrl = sourceUrl;
    clearNocuesTimer();

    const vid = currentVideoId;
    const mySourceUrl = sourceUrl;
    const mySourceKey = sourceKey;
    const mySourceRevision = sourceRevision;
    // Capture the nonce NOW, at produce start. post() must stamp the reply with
    // THIS nonce, not the live global reqNonce at send-time: otherwise two
    // produces running concurrently (e.g. boot + yt-navigate-finish both send
    // config) would both be stamped with the latest nonce and both accepted by
    // content.js -> double cue-loop restart -> startup flicker.
    const myNonce = reqNonce;
    const kind = trackKindOf(mySourceUrl);
    const sourceLang = trackLanguageOf(mySourceUrl);
    postDiagnostic("cue-fetch-start", {
      force: !!force,
      fetchNonce: myNonce,
      sourceRevision: mySourceRevision,
      trackKind: kind,
      sourceLang
    });
    try {
      const origJson = await fetchJson3(buildUrl(mySourceUrl));
      const cues = parseJson3(origJson);

      // ignore if we navigated away mid-fetch (or the source no longer matches)
      if (vid !== currentVideoId || sourceVid !== currentVideoId ||
          mySourceRevision !== sourceRevision || mySourceKey !== sourceKey) return;

      if (!cues.length) {
        postDiagnostic("cue-fetch-empty", { fetchNonce: myNonce, sourceRevision: mySourceRevision });
        rejectCurrentSource(
          mySourceUrl, mySourceRevision, "empty-track", "timedtext contained no cues"
        );
        return;
      }

      publishCues(cues, mySourceUrl, mySourceRevision, "refetch");
    } catch (err) {
      // could not fetch/parse — let content.js fall back to scraping, but only
      // if we are still on the same video the fetch was started for.
      if (vid !== currentVideoId || sourceVid !== currentVideoId ||
          mySourceRevision !== sourceRevision || mySourceKey !== sourceKey) return;
      producedForUrl = "";
      const detail = String(err && err.message || err || "cue fetch failed").slice(0, 240);
      postDiagnostic("cue-fetch-error", {
        fetchNonce: myNonce,
        sourceRevision: mySourceRevision,
        detail
      });
      rejectCurrentSource(mySourceUrl, mySourceRevision, "fetch-error", detail);
    } finally {
      if (cueFetchInFlightUrl === mySourceUrl) cueFetchInFlightUrl = "";
    }
  }

  // Called whenever we capture a fresh source URL.
  function onSourceCaptured(expectPlayerResponse) {
    if (!cfg) return;               // wait for config before fetching
    if (expectPlayerResponse) awaitPlayerResponse(sourceUrl, sourceRevision);
    else produceCues(false);
  }

  // Record a timedtext URL seen on the wire.
  function noteTimedtext(url, expectPlayerResponse) {
    try {
      if (!isTimedtext(url)) return;
      if (isInternalTimedtext(url)) return;
      if (!hasTlang(url)) {
        // The player's original-track fetch — the only pot we may reuse.
        // Always keep the freshest exact URL (pot can rotate), but only treat
        // it as a NEW source (and re-produce) when the track identity changes.
        const key = normKey(url);
        const exactChanged = url !== sourceUrl;
        sourceUrl = url;
        sourceVid = vidOfUrl(url);
        if (exactChanged) {
          producedForUrl = "";
          quarantinedSourceUrl = "";
          capturedPlayerCues = null;
          capturedPlayerCuesUrl = "";
          lastPublishedUrl = "";
          lastPublishedNonce = 0;
          freshSourceRequestedForUrl = "";
          pendingFreshSourceRequest = false;
        }
        if (key !== sourceKey) {
          sourceKey = key;
          sourceRevision++;
          postDiagnostic("timedtext-captured", {
            sourceRevision,
            sourceVideoMatches: sourceVid === currentVideoId,
            trackKind: trackKindOf(url),
            sourceLang: trackLanguageOf(url)
          });
          onSourceCaptured(!!expectPlayerResponse);
        } else if (expectPlayerResponse && cfg) {
          awaitPlayerResponse(sourceUrl, sourceRevision);
        } else if (exactChanged && cfg && producedForUrl === "") {
          // Same track with a freshly rotated pot/signature after a failure.
          // Retry immediately instead of waiting for a video navigation.
          produceCues(true);
        }
      }
    } catch (_e) { /* never throw */ }
  }

  // ---- video-change reset --------------------------------------------------
  // Returns true if a change was detected and state was reset.
  function checkVideoChange() {
    try {
      const v = videoIdFromLocation();
      if (v !== currentVideoId) {
        currentVideoId = v;
        sourceUrl = "";
        sourceVid = "";
        sourceKey = "";
        sourceRevision++;
        producedForUrl = "";
        cueFetchInFlightUrl = "";
        quarantinedSourceUrl = "";
        awaitingPlayerResponseUrl = "";
        capturedPlayerCues = null;
        capturedPlayerCuesUrl = "";
        lastPublishedUrl = "";
        lastPublishedNonce = 0;
        freshSourceRequestedForUrl = "";
        pendingFreshSourceRequest = false;
        clearNocuesTimer();
        clearPlayerResponseTimer();
        return true;
      }
    } catch (_e) { /* never throw */ }
    return false;
  }
  setInterval(checkVideoChange, 500);

  // ---- nocues watchdog -----------------------------------------------------
  function armNocuesTimer() {
    clearNocuesTimer();
    const vid = currentVideoId;
    const nonceAtArm = reqNonce;
    nocuesTimer = setTimeout(() => {
      nocuesTimer = null;
      if (vid !== currentVideoId) return;
      if (nonceAtArm !== reqNonce) return;
      if (!sourceUrl) {
        postDiagnostic("timedtext-watchdog-expired", { waitMs: 6000 });
        post("nocues", { reason: "timedtext-not-seen" });
      }
    }, 6000);
  }

  // ---- receive config from content.js --------------------------------------
  window.addEventListener("message", (evt) => {
    try {
      if (evt.source !== window) return;
      if (evt.origin !== location.origin) return;
      const d = evt.data;
      if (!d || d.source !== "ytds-content") return;

      if (d.type === "config") {
        if (!Number.isInteger(d.nonce) || d.nonce <= 0) return;
        // Treat the config message as the authoritative nav signal: reset any
        // stale capture synchronously if the location video changed, rather
        // than waiting up to 500ms for the poll. This closes the cross-video
        // contamination window — produceCues will only run for a sourceUrl
        // captured for the now-current video.
        checkVideoChange();
        currentVideoId = videoIdFromLocation();
        cfg = true;
        // Adopt the content-supplied nonce so our posts correlate to THIS
        // sendConfig(); content.js drops any reply with an older nonce.
        if (typeof d.nonce === "number") reqNonce = d.nonce;
        postDiagnostic("bridge-config-received", {
          hasCapturedSource: !!sourceUrl,
          sourceVideoMatches: !!sourceUrl && sourceVid === currentVideoId
        });
        if (capturedPlayerCues && capturedPlayerCuesUrl === sourceUrl) {
          publishCues(capturedPlayerCues, sourceUrl, sourceRevision, "player-cache");
        } else if (awaitingPlayerResponseUrl === sourceUrl) {
          // The player's response is still authoritative; do not race it with
          // an extension-side conversion request.
        } else if (quarantinedSourceUrl === sourceUrl) {
          if (pendingFreshSourceRequest) {
            rejectCurrentSource(
              sourceUrl, sourceRevision, "fetch-error",
              "player timedtext source unavailable", false
            );
          }
        } else if (sourceUrl && sourceVid === currentVideoId) {
          produceCues(true);            // already captured for this video
        } else {
          armNocuesTimer();             // wait for player's timedtext fetch
        }
      }
    } catch (_e) { /* never throw */ }
  }, false);

  // ---- hook XMLHttpRequest --------------------------------------------------
  try {
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;

    XHR.open = function (method, url) {
      try { this.__ytdsUrl = url; } catch (_e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };

    XHR.send = function () {
      try {
        const url = this.__ytdsUrl;
        if (isTimedtext(url) && !hasTlang(url) && !isInternalTimedtext(url)) {
          noteTimedtext(url, true);
          const revision = sourceRevision;
          if (typeof this.addEventListener === "function") {
            this.addEventListener("loadend", () => {
              try {
                let text = "";
                if (!this.responseType || this.responseType === "text") text = this.responseText || "";
                else if (this.responseType === "json") text = JSON.stringify(this.response || null);
                consumePlayerTimedtext(String(url), text, revision);
              } catch (_e) { playerResponseUnavailable(String(url), revision); }
            }, { once: true });
          } else {
            playerResponseUnavailable(String(url), revision);
          }
        }
      } catch (_e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  } catch (_e) { /* never throw */ }

  // ---- hook fetch -----------------------------------------------------------
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, init) {
        let url = "";
        let watchesPlayerResponse = false;
        let revision = 0;
        try {
          if (typeof input === "string") url = input;
          else if (input && typeof input.url === "string") url = input.url;
          watchesPlayerResponse = isTimedtext(url) && !hasTlang(url) && !isInternalTimedtext(url);
          noteTimedtext(url, watchesPlayerResponse);
          revision = sourceRevision;
        } catch (_e) { /* ignore */ }
        const result = origFetch.apply(this, arguments);
        if (watchesPlayerResponse) {
          Promise.resolve(result).then((response) => {
            try {
              if (!response || typeof response.clone !== "function") {
                playerResponseUnavailable(String(url), revision);
                return;
              }
              response.clone().text().then(
                (text) => consumePlayerTimedtext(String(url), text, revision),
                () => playerResponseUnavailable(String(url), revision)
              );
            } catch (_e) { playerResponseUnavailable(String(url), revision); }
          }, () => playerResponseUnavailable(String(url), revision));
        }
        return result;
      };
    }
  } catch (_e) { /* never throw */ }

  // ---- robust capture via Resource Timing ----------------------------------
  // Hook-independent fallback: the player's /api/timedtext request shows up in
  // Resource Timing with its FULL url (incl. pot) regardless of whether it used
  // XHR or fetch — and even if another extension (e.g. an older dual-subtitles
  // build) has locked XMLHttpRequest.prototype.open so our XHR hook never
  // installs. This is the mechanism the rewrite was validated against.
  try {
    const scan = (entries) => {
      for (const e of entries) {
        if (e && typeof e.name === "string" && isTimedtext(e.name)) {
          noteTimedtext(e.name);
        }
      }
    };
    try { scan(performance.getEntriesByType("resource")); } catch (_e) { /* ignore */ }
    if (typeof PerformanceObserver === "function") {
      const po = new PerformanceObserver((list) => {
        try { scan(list.getEntries()); } catch (_e) { /* ignore */ }
      });
      po.observe({ type: "resource", buffered: true });
    }
  } catch (_e) { /* never throw */ }
})();
