// inject.js — MAIN world, document_start.
// Hooks XMLHttpRequest + fetch to capture the YouTube player's OWN
// /api/timedtext request URL (which carries a valid "pot"), then reuses that
// proof-bearing URL to fetch the selected json3 cue track.
//
// NEVER throw into the page: every hook body is wrapped in try/catch.
(() => {
  "use strict";

  // ---- guard against double injection -------------------------------------
  if (window.__ytdsInjected) return;
  window.__ytdsInjected = true;

  const TIMEDTEXT_MARK = "/api/timedtext";
  const trackCatalog = window.__ytdsCaptionTrackCatalog;
  const trackTransport = window.__ytdsCaptionTrackTransport;
  const translationTrack = window.__ytdsCaptionTranslationTrack;
  const hasTlang = trackTransport.hasTlang;
  const trackKindOf = trackTransport.trackKindOf;
  const sourceLanguageOf = trackTransport.sourceLanguageOf;
  const vidOfUrl = (url) => trackTransport.vidOfUrl(url, videoIdFromLocation()), hasSessionParams = trackTransport.hasSessionParams;
  let sourceUrl = "";
  // The videoId that sourceUrl was captured for. produceCues bails if this no
  // longer matches the current location video, so a stale (previous-video) URL
  // can never be fetched and posted under the new videoId.
  let sourceVid = "";
  // Identity of the captured source track, ignoring fmt/pot/tlang. Used so our own
  // json3 re-fetches (and pot rotations on the same track) are not mistaken for
  // a brand-new source — which would otherwise re-trigger produceCues in a loop.
  let sourceKey = "", sourceTrackId = "";
  // Monotonic identity of the player's selected source track. Two different
  // timedtext tracks can be requested close together. Only the newest capture
  // may publish cues; otherwise completed fetches can replace each other's
  // timeline in content.js.
  let sourceRevision = 0;
  let selectedCaptionTrackId = "auto";
  let availableCaptionTracks = [];
  let captionTrackSources = new Map();
  let captionTrackSourceKeys = new Map();
  let captionTrackFingerprint = "";
  let catalogPreferredCaptionTrackId = "";
  let preferredCaptionTrackId = "";
  let selectedTranslationTrackId = "ai";
  let translationFetchRevision = 0;
  let pendingTranslationTrackId = "";
  let latestOriginalUrl = "", sessionDonorUrl = "";

  // Keep our own timedtext refetches out of noteTimedtext(). Both the fetch hook
  // and Resource Timing observe these requests. Without provenance, concurrent
  // refetches for different tracks can form a feedback loop and make the
  // original subtitle flash between two timelines.
  const internalTimedtextUrls = new Map();
  const INTERNAL_TIMEDTEXT_TTL_MS = 20000;
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

  // YouTube can keep the previous video's auto-translate selection and request
  // the current track with tlang. The lang track remains the source track; use
  // the same proof-bearing URL with only the translation parameter removed.
  function sourceTrackUrl(url) {
    try {
      const u = new URL(url, location.href);
      u.searchParams.delete("tlang");
      return u.toString();
    } catch (_e) {
      return "";
    }
  }
  // Auto mode deliberately follows the source/original track even when
  // YouTube carries an old auto-translation parameter across navigation.
  function selectedTrackUrl(url) { return sourceTrackUrl(url); }
  function normalizeCaptionTrackSelection(value) {
    const text = String(value || "").trim().slice(0, 160);
    if (!text || text === "auto") return "auto";
    return /^[A-Za-z0-9._:-]+$/.test(text) ? text : "";
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
  // source and re-trigger produceCues, causing the overlay to flicker. The
  // Track identity ignores "tlang" because it is never part of a selected
  // source-track identity.
  function normKey(url) {
    try {
      const u = new URL(url, location.href);
      for (const key of ["fmt", "pot", "potc", "c", "cver", "cplayer", "cbr", "cbrver", "cos", "cosver", "cplatform", "tlang", "expire", "sig", "signature", "sparams"])
        u.searchParams.delete(key);
      return u.toString();
    } catch (_e) {
      return url;
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

  function clearPlayerResponseTimer() {
    if (playerResponseTimer) { clearTimeout(playerResponseTimer); playerResponseTimer = null; }
  }

  function captionTrackIdForUrl(url) {
    return trackCatalog && typeof trackCatalog.trackIdForUrl === "function"
      ? trackCatalog.trackIdForUrl(url, availableCaptionTracks, captionTrackSourceKeys) : "";
  }

  function sourceTrackIdForUrl(url) { return captionTrackIdForUrl(selectedTrackUrl(url)); }
  function sourceIdentityMatches(url) {
    const incomingTrackId = sourceTrackIdForUrl(url);
    if (sourceTrackId && incomingTrackId) return sourceTrackId === incomingTrackId;
    return selectedTrackUrl(url) === sourceUrl || normKey(url) === sourceKey;
  }
  function publishCaptionTracks(reason) {
    post("caption-tracks", {
      tracks: availableCaptionTracks.map((track) => ({ ...track })),
      selectedTrackId: selectedCaptionTrackId,
      preferredTrackId: preferredCaptionTrackId,
      selectedTranslationTrackId,
      catalogReason: String(reason || "changed").slice(0, 40)
    });
  }

  function postCaptionTracks(force, skipSourceSelection) {
    if (!trackCatalog || typeof trackCatalog.scan !== "function") {
      return availableCaptionTracks.length > 0;
    }
    let catalog = null;
    try { catalog = trackCatalog.scan(currentVideoId); } catch (_e) {
      return availableCaptionTracks.length > 0;
    }
    if (!catalog || !Array.isArray(catalog.tracks) || !catalog.tracks.length) {
      return availableCaptionTracks.length > 0;
    }
    const nextTracks = catalog.tracks.slice(0, 100);
    const nextCatalogPreferred = nextTracks.some((track) => track.id === catalog.preferredTrackId)
      ? catalog.preferredTrackId : "";
    const retainedPreferred = preferredCaptionTrackId && nextTracks.some((track) =>
      track.id === preferredCaptionTrackId) ? preferredCaptionTrackId : "";
    const nextPreferred = nextCatalogPreferred || retainedPreferred ||
      (nextTracks.length === 1 ? nextTracks[0].id : "");
    const catalogSources = new Map(Object.entries(catalog.sources || {}));
    const catalogSourceKeys = new Map(
      Object.entries(catalog.sourceKeys || {}).map(([id, key]) => [key, id])
    );
    const changed = force || catalog.fingerprint !== captionTrackFingerprint ||
      nextPreferred !== preferredCaptionTrackId ||
      nextCatalogPreferred !== catalogPreferredCaptionTrackId;
    if (changed) {
      const previousSelected = availableCaptionTracks.find((track) =>
        track.id === selectedCaptionTrackId
      );
      const previousTranslation = availableCaptionTracks.find((track) =>
        track.id === selectedTranslationTrackId
      );
      if (selectedCaptionTrackId !== "auto" && previousSelected &&
          !nextTracks.some((track) => track.id === selectedCaptionTrackId)) {
        const replacement = nextTracks.filter((track) =>
          track.languageCode === previousSelected.languageCode &&
          track.kind === previousSelected.kind
        );
        if (replacement.length === 1) selectedCaptionTrackId = replacement[0].id;
      }
      if (selectedTranslationTrackId !== "ai" && previousTranslation &&
          !nextTracks.some((track) => track.id === selectedTranslationTrackId)) {
        const replacement = nextTracks.filter((track) =>
          track.languageCode === previousTranslation.languageCode &&
          track.kind === previousTranslation.kind
        );
        if (replacement.length === 1) selectedTranslationTrackId = replacement[0].id;
      }
      availableCaptionTracks = nextTracks;
      catalogPreferredCaptionTrackId = nextCatalogPreferred;
      preferredCaptionTrackId = nextPreferred;
      captionTrackSources = catalogSources;
      captionTrackSourceKeys = catalogSourceKeys;
      captionTrackFingerprint = String(catalog.fingerprint || "");
      publishCaptionTracks();
    } else {
      for (const [id, source] of catalogSources) captionTrackSources.set(id, source);
      for (const [key, id] of catalogSourceKeys) captionTrackSourceKeys.set(key, id);
    }
    if (skipSourceSelection || selectedCaptionTrackId === "auto") {
      return availableCaptionTracks.length > 0;
    }
    const selectedSource = captionTrackSources.get(selectedCaptionTrackId) || "";
    if (selectedSource && (sourceTrackId !== selectedCaptionTrackId || sourceVid !== currentVideoId || pendingFreshSourceRequest)) {
      const selectedTrack = availableCaptionTracks.find((track) => track.id === selectedCaptionTrackId);
      const playerRequested = typeof trackCatalog.requestPlayerTrack === "function";
      const freshSourceRetry = pendingFreshSourceRequest;
      if (freshSourceRetry) pendingFreshSourceRequest = false;
      if (!freshSourceRetry) resetSelectedSource();
      selectSourceCandidate(selectedSource, playerRequested, {
        transport: playerRequested ? "player-track" : "track-catalog", method: ""
      }, selectedCaptionTrackId);
      if (playerRequested) requestPlayerTrackOrFallback(selectedTrack);
    }
    return availableCaptionTracks.length > 0;
  }
  function rememberObservedCaptionTrack(url) {
    if (!trackCatalog || typeof trackCatalog.mergeObserved !== "function") return false;
    let merged = null;
    try {
      merged = trackCatalog.mergeObserved(
        url, currentVideoId, availableCaptionTracks,
        captionTrackSources, captionTrackSourceKeys
      );
    } catch (_e) { return false; }
    if (!merged) return false;
    availableCaptionTracks = merged.tracks;
    captionTrackSources = merged.sources;
    captionTrackSourceKeys = merged.sourceKeys;
    if (merged.changed && selectedCaptionTrackId === "auto" &&
        !catalogPreferredCaptionTrackId) {
      preferredCaptionTrackId = availableCaptionTracks[availableCaptionTracks.length - 1].id;
    } else if (!preferredCaptionTrackId && availableCaptionTracks.length === 1) {
      preferredCaptionTrackId = availableCaptionTracks[0].id;
    }
    if (merged.changed) publishCaptionTracks();
    return true;
  }
  function requestPlayerTrackOrFallback(track) {
    if (trackCatalog.requestPlayerTrack && trackCatalog.requestPlayerTrack(track)) return true;
    awaitingPlayerResponseUrl = ""; clearPlayerResponseTimer(); produceCues(true);
    return false;
  }
  function selectedIncomingTrack(url) {
    const originalUrl = sourceTrackUrl(url);
    const matchedId = captionTrackIdForUrl(originalUrl);
    if (selectedCaptionTrackId === "auto") {
      const preferredId = preferredCaptionTrackId &&
        availableCaptionTracks.some((track) => track.id === preferredCaptionTrackId)
        ? preferredCaptionTrackId : availableCaptionTracks.length === 1
          ? availableCaptionTracks[0].id : "";
      if (preferredId && matchedId && matchedId !== preferredId) {
        const preferredSource = captionTrackSources.get(preferredId) || "";
        if (preferredSource) {
          return { originalUrl, matchedId, candidate: preferredSource, watches: false, trackId: preferredId };
        }
      }
      return { originalUrl, matchedId, candidate: originalUrl, watches: !hasTlang(url), trackId: matchedId || preferredId };
    }
    const candidate = matchedId === selectedCaptionTrackId
      ? originalUrl : captionTrackSources.get(selectedCaptionTrackId) || "";
    return { originalUrl, matchedId, candidate,
      watches: !!candidate && matchedId === selectedCaptionTrackId, trackId: matchedId };
  }
  function activeCaptionTrackId(url) {
    return selectedCaptionTrackId === "auto"
      ? captionTrackIdForUrl(url) || preferredCaptionTrackId || "auto" : selectedCaptionTrackId;
  }
  function resetSelectedSource() {
    sourceUrl = "";
    sourceVid = "";
    sourceKey = "";
    sourceTrackId = "";
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
  }
  function sourceStillCurrent(url, revision) {
    return sourceVid === currentVideoId &&
      revision === sourceRevision && sourceIdentityMatches(url);
  }
  function requestFreshTranslationTrack(trackId) {
    const track = availableCaptionTracks.find((item) => item.id === trackId);
    if (!track || trackId === selectedCaptionTrackId || pendingTranslationTrackId === trackId || !trackCatalog || typeof trackCatalog.requestPlayerTrack !== "function") return;
    pendingTranslationTrackId = trackId;
    if (!trackCatalog.requestPlayerTrack(track)) pendingTranslationTrackId = "";
  }
  async function fetchManualTranslationCues(sourceOverride) {
    const trackId = selectedTranslationTrackId;
    const revision = sourceOverride ? translationFetchRevision : ++translationFetchRevision; if (!sourceOverride) pendingTranslationTrackId = "";
    if (trackId === "ai") {
      post("translation-cleared", { captionTrackId: "ai" });
      return;
    }
    const url = String(sourceOverride || captionTrackSources.get(trackId) || "");
    if (!url || !translationTrack) { postDiagnostic("translation-fetch-error", { captionTrackId: trackId, detail: "source-unavailable" }); post("translation-nocues", { captionTrackId: trackId, reason: "source-unavailable" }); requestFreshTranslationTrack(trackId); return; }
    const videoId = currentVideoId;
    postDiagnostic("translation-fetch-start", { captionTrackId: trackId, sourceLang: sourceLanguageOf(url), sourceUrlKind: trackKindOf(url) });
    translationTrack.fetchTrack({
      trackId, sourceUrl: url,
      donorUrl: sessionDonorUrl && vidOfUrl(sessionDonorUrl) === currentVideoId ? sessionDonorUrl : "",
      markInternal: rememberInternalTimedtext,
      isCurrent: () => videoId === currentVideoId && revision === translationFetchRevision && trackId === selectedTranslationTrackId,
      onCues: (cues) => (postDiagnostic("translation-fetch-success", { captionTrackId: trackId, cueCount: Array.isArray(cues) ? cues.length : 0 }), post("translation-cues", { cues, trackKind: trackKindOf(url), sourceLang: sourceLanguageOf(url), captionTrackId: trackId })),
      onNocues: (reason) => (postDiagnostic("translation-fetch-error", { captionTrackId: trackId, detail: reason }), post("translation-nocues", { captionTrackId: trackId, reason }), !sourceOverride && requestFreshTranslationTrack(trackId))
    });
  }
  function publishCues(cues, url, revision, origin) {
    if (!Array.isArray(cues) || !cues.length || !sourceStillCurrent(url, revision)) return;
    const candidateUrl = selectedTrackUrl(url);
    const activeTrackId = activeCaptionTrackId(candidateUrl);
    capturedPlayerCues = cues;
    capturedPlayerCuesUrl = candidateUrl;
    producedForUrl = candidateUrl;
    quarantinedSourceUrl = "";
    if (!cfg) return;
    const publishNonce = reqNonce;
    if (lastPublishedUrl === candidateUrl && lastPublishedNonce === publishNonce) return;
    lastPublishedUrl = candidateUrl;
    lastPublishedNonce = publishNonce;
    postDiagnostic("cue-fetch-success", {
      cueCount: cues.length,
      fetchNonce: publishNonce,
      sourceRevision: revision,
      trackKind: trackKindOf(candidateUrl),
      sourceLang: sourceLanguageOf(candidateUrl),
      captionTrackId: activeTrackId,
      responseOrigin: String(origin || "refetch")
    });
    post("cues", {
      cues,
      trackKind: trackKindOf(candidateUrl),
      sourceLang: sourceLanguageOf(candidateUrl),
      captionTrackId: activeTrackId,
      nonce: publishNonce
    });
  }
  function rejectCurrentSource(url, revision, reason, detail, requestFreshSource) {
    if (!sourceStillCurrent(url, revision)) return;
    const candidateUrl = selectedTrackUrl(url);
    quarantinedSourceUrl = candidateUrl;
    producedForUrl = "";
    capturedPlayerCues = null;
    capturedPlayerCuesUrl = "";
    lastPublishedUrl = "";
    lastPublishedNonce = 0;
    const shouldRequestFreshSource = !!requestFreshSource &&
      freshSourceRequestedForUrl !== candidateUrl;
    if (shouldRequestFreshSource) {
      freshSourceRequestedForUrl = candidateUrl;
      pendingFreshSourceRequest = true;
    }
    if (!cfg) return;
    const notifyFreshSource = pendingFreshSourceRequest &&
      freshSourceRequestedForUrl === candidateUrl;
    if (notifyFreshSource) pendingFreshSourceRequest = selectedCaptionTrackId !== "auto";
    post("nocues", {
      reason: String(reason || "fetch-error"),
      detail: String(detail || "").slice(0, 240),
      sourceLang: sourceLanguageOf(candidateUrl),
      captionTrackId: selectedCaptionTrackId,
      requestFreshSource: notifyFreshSource
    });
  }
  function consumePlayerTimedtext(url, text, revision, responseMeta) {
    if (!sourceStillCurrent(url, revision)) return;
    awaitingPlayerResponseUrl = "";
    clearPlayerResponseTimer();
    const body = typeof text === "string" ? text : "";
    const meta = responseMeta && typeof responseMeta === "object" ? responseMeta : {};
    const status = Number.isFinite(Number(meta.status)) ? Number(meta.status) : 0;
    postDiagnostic("player-timedtext-response", {
      sourceRevision: revision,
      transport: String(meta.transport || "unknown"),
      method: String(meta.method || "GET").slice(0, 12),
      status,
      contentType: String(meta.contentType || "").slice(0, 120),
      responseChars: body.length,
      elapsedMs: Math.max(0, Math.round(Number(meta.elapsedMs) || 0)),
      captionTrackId: selectedCaptionTrackId
    });
    // Status 0 is an aborted/incomplete player request, not an empty track.
    if (status <= 0) {
      postDiagnostic("cue-fetch-error", {
        fetchNonce: reqNonce,
        sourceRevision: revision,
        detail: "player timedtext transport incomplete",
        responseOrigin: "player",
        transient: true
      });
      if (capturedPlayerCuesUrl !== url) awaitPlayerResponse(url, revision);
      return;
    }
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
      const cues = trackTransport.parseCaptionResponse(body);
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
    }, 2500);
  }
  // A player request can start before content.js sends its first config. Keep
  // that request authoritative across the config boundary, but only start the
  // timeout once config exists and we can report a failed source.
  function trackPendingPlayerResponse(url, revision) {
    awaitingPlayerResponseUrl = url;
    clearPlayerResponseTimer();
    if (cfg) awaitPlayerResponse(url, revision);
  }
  // Produce cues from the configured caption track.
  async function produceCues(force) {
    if (!cfg || !sourceUrl) return;
    // The captured source URL must belong to the CURRENT video. Without this,
    // a config round-trip on SPA nav could refetch the previous video's URL and
    // post it stamped with the new videoId.
    if (sourceVid !== currentVideoId) return;
    if (!force && producedForUrl && sourceIdentityMatches(producedForUrl)) return;
    if (quarantinedSourceUrl && sourceIdentityMatches(quarantinedSourceUrl)) return;
    if (awaitingPlayerResponseUrl === sourceUrl) return;
    if (awaitingPlayerResponseUrl && sourceIdentityMatches(awaitingPlayerResponseUrl)) return;
    if (cueFetchInFlightUrl && sourceIdentityMatches(cueFetchInFlightUrl)) return;
    producedForUrl = sourceUrl;
    cueFetchInFlightUrl = sourceUrl;
    clearNocuesTimer();
    const vid = currentVideoId;
    const mySourceUrl = sourceUrl;
    const mySourceRevision = sourceRevision;
    // Capture the nonce NOW, at produce start. post() must stamp the reply with
    // THIS nonce, not the live global reqNonce at send-time: otherwise two
    // produces running concurrently (e.g. boot + yt-navigate-finish both send
    // config) would both be stamped with the latest nonce and both accepted by
    // content.js -> double cue-loop restart -> startup flicker.
    const myNonce = reqNonce;
    const kind = trackKindOf(mySourceUrl);
    const sourceLang = sourceLanguageOf(mySourceUrl);
    postDiagnostic("cue-fetch-start", {
      force: !!force,
      fetchNonce: myNonce,
      sourceRevision: mySourceRevision,
      trackKind: kind,
      sourceLang,
      captionTrackId: selectedCaptionTrackId,
      hasSessionDonor: !!sessionDonorUrl && vidOfUrl(sessionDonorUrl) === currentVideoId
    });
    try {
      const donor = sessionDonorUrl && vidOfUrl(sessionDonorUrl) === currentVideoId
        ? sessionDonorUrl : "";
      const result = await trackTransport.fetchCaptionCues(
        mySourceUrl, donor, rememberInternalTimedtext
      );
      // ignore if we navigated away mid-fetch (or the source no longer matches)
      if (vid !== currentVideoId || !sourceStillCurrent(mySourceUrl, mySourceRevision)) return;
      publishCues(result.cues, mySourceUrl, mySourceRevision,
        result.usedSession ? "refetch-session" : "refetch");
    } catch (err) {
      // Could not fetch/parse. Ask content.js to rotate the player's
      // proof-bearing source immediately, but only for the same video/request.
      if (vid !== currentVideoId || !sourceStillCurrent(mySourceUrl, mySourceRevision)) return;
      producedForUrl = "";
      const detail = String(err && err.message || err || "cue fetch failed").slice(0, 240);
      postDiagnostic("cue-fetch-error", {
        fetchNonce: myNonce,
        sourceRevision: mySourceRevision,
        detail
      });
      rejectCurrentSource(mySourceUrl, mySourceRevision, "fetch-error", detail, true);
    } finally {
      if (cueFetchInFlightUrl === mySourceUrl) cueFetchInFlightUrl = "";
    }
  }
  // Called whenever we capture a fresh source URL.
  function onSourceCaptured(expectPlayerResponse) {
    if (expectPlayerResponse) {
      trackPendingPlayerResponse(sourceUrl, sourceRevision);
      return;
    }
    if (!cfg) return;               // wait for config before fetching
    produceCues(false);
  }
  function selectSourceCandidate(candidate, expectPlayerResponse, captureMeta, trackId) {
    if (!candidate) return;
    const key = normKey(candidate);
    const nextTrackId = normalizeCaptionTrackSelection(trackId || captionTrackIdForUrl(candidate) ||
      (selectedCaptionTrackId !== "auto" ? selectedCaptionTrackId : ""));
    const identityChanged = sourceTrackId && nextTrackId
      ? sourceTrackId !== nextTrackId : key !== sourceKey;
    const exactChanged = candidate !== sourceUrl;
    sourceUrl = candidate; sourceVid = vidOfUrl(candidate);
    sourceKey = key; sourceTrackId = nextTrackId;
    if (exactChanged && identityChanged) {
      producedForUrl = "";
      quarantinedSourceUrl = "";
      capturedPlayerCues = null;
      capturedPlayerCuesUrl = "";
      lastPublishedUrl = "";
      lastPublishedNonce = 0;
      freshSourceRequestedForUrl = "";
      pendingFreshSourceRequest = false;
    }
    if (identityChanged) {
      sourceRevision++;
      postDiagnostic("timedtext-captured", {
        sourceRevision,
        sourceVideoMatches: sourceVid === currentVideoId,
        trackKind: trackKindOf(candidate),
        sourceLang: sourceLanguageOf(candidate),
        captionTrackId: selectedCaptionTrackId,
        sourceTrackId,
        transport: String(captureMeta && captureMeta.transport || "observer"),
        method: String(captureMeta && captureMeta.method || "GET").slice(0, 12)
      });
      onSourceCaptured(!!expectPlayerResponse);
    } else if (expectPlayerResponse) {
      trackPendingPlayerResponse(sourceUrl, sourceRevision);
    } else if (exactChanged && cfg && producedForUrl === "" && !awaitingPlayerResponseUrl) {
      // Same track with a freshly rotated pot/signature after a failure.
      // Retry immediately instead of waiting for a video navigation.
      produceCues(true);
    }
  }
  // Record a timedtext URL and select the automatic source or explicit
  // catalog entry. Return whether this is the selected player's response.
  function noteTimedtext(url, playerTransport, captureMeta) {
    try {
      if (!isTimedtext(url) || isInternalTimedtext(url)) return false;
      const donor = sourceTrackUrl(url);
      if (donor && vidOfUrl(donor) === currentVideoId && hasSessionParams(donor)) sessionDonorUrl = donor;
      postCaptionTracks(false, true);
      rememberObservedCaptionTrack(url);
      const incoming = selectedIncomingTrack(url);
      const translationTrackId = captionTrackIdForUrl(incoming.originalUrl);
      if (pendingTranslationTrackId && translationTrackId === pendingTranslationTrackId &&
          selectedTranslationTrackId === pendingTranslationTrackId) {
        pendingTranslationTrackId = "";
        captionTrackSources.set(translationTrackId, incoming.originalUrl);
        captionTrackSourceKeys.set(normKey(incoming.originalUrl), translationTrackId);
        fetchManualTranslationCues(incoming.originalUrl);
        return false;
      }
      if (!incoming.originalUrl ||
          (selectedCaptionTrackId !== "auto" && incoming.matchedId !== selectedCaptionTrackId)) {
        return false;
      }
      latestOriginalUrl = incoming.candidate || incoming.originalUrl;
      if (incoming.matchedId) {
        captionTrackSources.set(incoming.matchedId, incoming.originalUrl);
        captionTrackSourceKeys.set(normKey(incoming.originalUrl), incoming.matchedId);
      }
      const watches = !!playerTransport && incoming.watches;
      selectSourceCandidate(incoming.candidate, watches, captureMeta, incoming.trackId);
      return watches;
    } catch (_e) { return false; }
  }

  // ---- video-change reset --------------------------------------------------
  // Returns true if a change was detected and state was reset.
  function checkVideoChange() {
    try {
      const v = videoIdFromLocation();
      if (v !== currentVideoId) {
        currentVideoId = v;
        latestOriginalUrl = "";
        sessionDonorUrl = "";
        selectedCaptionTrackId = "auto";
        selectedTranslationTrackId = "ai";
        pendingTranslationTrackId = "";
        preferredCaptionTrackId = "";
        catalogPreferredCaptionTrackId = "";
        translationFetchRevision++;
        availableCaptionTracks = [];
        captionTrackSources = new Map();
        captionTrackSourceKeys = new Map();
        captionTrackFingerprint = "";
        resetSelectedSource();
        postCaptionTracks(true);
        return true;
      }
    } catch (_e) { /* never throw */ }
    return false;
  }
  setInterval(() => {
    checkVideoChange();
    postCaptionTracks(false);
  }, 500);

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
      if (d.type === "caption-tracks-request" &&
          String(d.videoId || "") === currentVideoId &&
          (Number(d.nonce) || 0) === reqNonce) {
        postCaptionTracks(d.force === true, true);
      } else if (d.type === "config") {
        if (!Number.isInteger(d.nonce) || d.nonce <= 0) return;
        // Treat the config message as the authoritative nav signal: reset any
        // stale capture synchronously if the location video changed, rather
        // than waiting up to 500ms for the poll. This closes the cross-video
        // contamination window — produceCues will only run for a sourceUrl
        // captured for the now-current video.
        checkVideoChange();
        currentVideoId = videoIdFromLocation();
        const nextTrackId = normalizeCaptionTrackSelection(d.captionTrackId);
        const nextTranslationTrackId = translationTrack.normalizeSelection(d.translationTrackId);
        if (!nextTrackId || !nextTranslationTrackId) return;
        const selectionChanged = selectedCaptionTrackId !== nextTrackId;
        const translationSelectionChanged = selectedTranslationTrackId !== nextTranslationTrackId;
        selectedCaptionTrackId = nextTrackId;
        selectedTranslationTrackId = nextTranslationTrackId;
        cfg = {
          captionTrackId: selectedCaptionTrackId,
          translationTrackId: selectedTranslationTrackId
        };
        // Adopt the content-supplied nonce so our posts correlate to THIS
        // sendConfig(); content.js drops any reply with an older nonce.
        if (typeof d.nonce === "number") reqNonce = d.nonce;
        postDiagnostic("bridge-config-received", {
          hasCapturedSource: !!sourceUrl,
          sourceVideoMatches: !!sourceUrl && sourceVid === currentVideoId,
          captionTrackId: selectedCaptionTrackId,
          translationTrackId: selectedTranslationTrackId
        });
        postCaptionTracks(true, true);
        const actualSelectionChanged = selectionChanged || selectedCaptionTrackId !== nextTrackId;
        const actualTranslationChanged = translationSelectionChanged ||
          selectedTranslationTrackId !== nextTranslationTrackId;
        if (actualTranslationChanged) fetchManualTranslationCues();
        if (actualSelectionChanged) {
          resetSelectedSource();
          const candidate = selectedCaptionTrackId === "auto"
            ? latestOriginalUrl : captionTrackSources.get(selectedCaptionTrackId) || "";
          if (candidate) {
            const selectedTrack = availableCaptionTracks.find((track) => track.id === selectedCaptionTrackId);
            const playerRequested = selectedCaptionTrackId !== "auto" && typeof trackCatalog.requestPlayerTrack === "function";
            selectSourceCandidate(candidate, playerRequested,
              { transport: playerRequested ? "player-track" : "config", method: "" },
              selectedCaptionTrackId === "auto" ? preferredCaptionTrackId || captionTrackIdForUrl(candidate) : selectedCaptionTrackId);
            if (playerRequested) requestPlayerTrackOrFallback(selectedTrack);
          } else {
            armNocuesTimer();
          }
          return;
        }
        if (capturedPlayerCues && sourceIdentityMatches(capturedPlayerCuesUrl)) {
          publishCues(capturedPlayerCues, sourceUrl, sourceRevision, "player-cache");
        } else if (awaitingPlayerResponseUrl && sourceIdentityMatches(awaitingPlayerResponseUrl)) {
          // The player's response is still authoritative; arm the timeout now
          // if the request was observed before this config message arrived.
          awaitPlayerResponse(sourceUrl, sourceRevision);
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

  // ---- install player network hooks ----------------------------------------
  if (window.__ytdsNetworkHooks && typeof window.__ytdsNetworkHooks.install === "function") {
    window.__ytdsNetworkHooks.install({
      isTimedtext,
      isInternalTimedtext,
      noteTimedtext,
      getSourceRevision: () => sourceRevision,
      consumePlayerTimedtext,
      playerResponseUnavailable
    });
  }
})();
