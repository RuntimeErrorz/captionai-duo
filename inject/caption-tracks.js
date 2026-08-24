// MAIN-world YouTube caption-track catalog. Keep proof-bearing URLs inside the
// MAIN world; only the small, user-facing track metadata crosses the bridge.
(() => {
  "use strict";
  if (window.__ytdsCaptionTrackCatalog) return;

  const TIMEDTEXT_MARK = "/api/timedtext";
  const VOLATILE_PARAMS = [
    "fmt", "pot", "potc", "c", "cver", "cplayer", "cbr", "cbrver",
    "cos", "cosver", "cplatform", "tlang", "expire", "sig", "signature", "sparams"
  ];
  let latestPlayerOptions = new Map();

  function asObject(value) {
    return value && typeof value === "object" ? value : null;
  }

  function parseResponse(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string" || !value.trim()) return null;
    try { return JSON.parse(value); } catch (_e) { return null; }
  }

  function playerResponses() {
    const values = [];
    try { values.push(window.ytInitialPlayerResponse); } catch (_e) { /* ignore */ }
    try {
      const config = window.ytplayer && window.ytplayer.config;
      const args = config && config.args;
      values.push(args && (args.player_response || args.playerResponse));
      values.push(config && config.player_response);
    } catch (_e) { /* ignore */ }
    return values.map(parseResponse).filter(Boolean);
  }

  function captionTrackRenderer(response) {
    const captions = asObject(response && response.captions);
    return asObject(captions && captions.playerCaptionsTracklistRenderer);
  }

  function captionTracksFrom(response) {
    const renderer = captionTrackRenderer(response);
    return renderer && Array.isArray(renderer.captionTracks) ? renderer.captionTracks : [];
  }

  function languageCode(value) {
    const text = String(value || "").trim().replace(/_/g, "-");
    return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(text)
      ? text.slice(0, 24) : "";
  }

  function trackLabel(value) {
    const name = asObject(value);
    if (name && typeof name.simpleText === "string") return name.simpleText.trim().slice(0, 120);
    if (name && Array.isArray(name.runs)) {
      return name.runs.map((run) => String(run && run.text || "")).join("")
        .replace(/\s+/g, " ").trim().slice(0, 120);
    }
    return "";
  }

  function trackLabelForSource(source, fallback) {
    const key = sourceKey(source);
    if (key) {
      for (const response of playerResponses()) {
        for (const raw of captionTracksFrom(response)) {
          const rawSource = canonicalSource(raw && raw.baseUrl);
          if (rawSource && sourceKey(rawSource) === key) {
            const label = trackLabel(raw && raw.name);
            if (label) return label;
          }
        }
      }
    }
    return fallback;
  }

  function canonicalSource(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      if (!url.pathname.includes(TIMEDTEXT_MARK)) return "";
      return url.toString();
    } catch (_e) { return ""; }
  }

  function sourceKey(value) {
    try {
      const url = new URL(value, location.href);
      for (const key of VOLATILE_PARAMS) url.searchParams.delete(key);
      return url.toString();
    } catch (_e) { return ""; }
  }

  function observedTrack(value) {
    const source = canonicalSource(value);
    if (!source) return null;
    let url;
    try { url = new URL(source, location.href); } catch (_e) { return null; }
    const language = languageCode(url.searchParams.get("lang"));
    const key = sourceKey(source);
    if (!language || !key) return null;
    const kind = url.searchParams.get("kind") === "asr" ? "asr" : "manual";
    return {
      track: {
        id: `track:${language.toLowerCase()}:${kind}:${hash(key)}`,
        languageCode: language,
        label: trackLabelForSource(source, language),
        kind
      },
      source,
      sourceKey: key
    };
  }

  function mergeObservedTrack(value, videoId, tracks, sources, sourceKeys) {
    const observed = observedTrack(value);
    if (!observed || !Array.isArray(tracks) || !(sources instanceof Map) ||
        !(sourceKeys instanceof Map)) return null;
    try {
      const sourceVideoId = new URL(observed.source, location.href).searchParams.get("v");
      if (videoId && sourceVideoId && sourceVideoId !== videoId) return null;
    } catch (_e) { return null; }

    const nextSources = new Map(sources);
    const nextSourceKeys = new Map(sourceKeys);
    const existingId = nextSourceKeys.get(observed.sourceKey);
    if (existingId) {
      nextSources.set(existingId, observed.source);
      return { tracks, sources: nextSources, sourceKeys: nextSourceKeys, changed: false };
    }

    const sameTrack = tracks.filter((track) =>
      track.languageCode === observed.track.languageCode &&
      track.kind === observed.track.kind
    );
    if (sameTrack.length === 1) {
      nextSources.set(sameTrack[0].id, observed.source);
      nextSourceKeys.set(observed.sourceKey, sameTrack[0].id);
      return { tracks, sources: nextSources, sourceKeys: nextSourceKeys, changed: false };
    }
    if (tracks.length >= 100) return null;

    let track = { ...observed.track };
    let id = track.id;
    let suffix = 1;
    while (tracks.some((item) => item.id === id)) id = `${track.id}:${suffix++}`;
    if (id !== track.id) track = { ...track, id };
    nextSources.set(track.id, observed.source);
    nextSourceKeys.set(observed.sourceKey, track.id);
    return {
      tracks: tracks.concat(track), sources: nextSources,
      sourceKeys: nextSourceKeys, changed: true
    };
  }

  function trackIdForUrl(value, tracks, sourceKeys) {
    const key = sourceKey(value);
    if (key && sourceKeys instanceof Map && sourceKeys.has(key)) return sourceKeys.get(key);
    if (!Array.isArray(tracks)) return "";
    let url;
    try { url = new URL(value, location.href); } catch (_e) { return ""; }
    const language = languageCode(url.searchParams.get("lang"));
    const kind = url.searchParams.get("kind") === "asr" ? "asr" : "manual";
    const matches = tracks.filter((track) =>
      track.languageCode === language && track.kind === kind
    );
    return matches.length === 1 ? matches[0].id : "";
  }

  function hash(value) {
    let result = 2166136261;
    for (let i = 0; i < value.length; i++) {
      result ^= value.charCodeAt(i);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  }

  function safeIdPart(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 60);
  }

  function playerTrackOptions(raw, language, kind) {
    const options = { languageCode: language, kind: kind === "asr" ? "asr" : "" };
    const vssId = safeIdPart(raw && raw.vssId);
    const trackName = String(raw && raw.trackName || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (vssId) options.vssId = vssId;
    if (trackName) options.trackName = trackName;
    return options;
  }

  function sameAudioLanguage(left, right) {
    const a = languageCode(left).toLowerCase().split("-");
    const b = languageCode(right).toLowerCase().split("-");
    return !!a[0] && a[0] === b[0];
  }

  function audioLanguageCandidates(response) {
    const out = [];
    const add = (value) => {
      const language = languageCode(value);
      if (language && !out.includes(language)) out.push(language);
    };
    const details = asObject(response && response.videoDetails);
    const microformat = asObject(response && response.microformat);
    const microPlayer = asObject(microformat && microformat.playerMicroformatRenderer);
    add(details && (details.defaultAudioLanguage || details.audioLanguage));
    add(microPlayer && (microPlayer.defaultAudioLanguage || microPlayer.audioLanguage));
    const renderer = captionTrackRenderer(response);
    for (const audio of Array.isArray(renderer && renderer.audioTracks) ? renderer.audioTracks : []) {
      add(audio && (audio.languageCode || audio.language));
    }
    const streaming = asObject(response && response.streamingData);
    for (const format of Array.isArray(streaming && streaming.adaptiveFormats)
      ? streaming.adaptiveFormats : []) {
      const audio = asObject(format && format.audioTrack);
      add(audio && (audio.languageCode || audio.language));
    }
    return out;
  }

  function preferredRawTrackIndex(response, rawTracks, allTracks) {
    const renderer = captionTrackRenderer(response);
    const indices = [];
    const addIndex = (value) => {
      const index = Number(value);
      if (Number.isInteger(index) && index >= 0 && index < allTracks.length &&
          !indices.includes(index)) indices.push(index);
    };
    addIndex(renderer && renderer.defaultCaptionTrackIndex);
    for (const audio of Array.isArray(renderer && renderer.audioTracks) ? renderer.audioTracks : []) {
      addIndex(audio && audio.defaultCaptionTrackIndex);
      const captionIndices = audio && audio.captionTrackIndices;
      if (!indices.length && Array.isArray(captionIndices)) addIndex(captionIndices[0]);
    }
    for (const index of indices) {
      const filteredIndex = rawTracks.indexOf(allTracks[index]);
      if (filteredIndex >= 0) return filteredIndex;
    }
    const explicit = rawTracks.findIndex((track) => track &&
      (track.isDefault === true || track.isOriginal === true));
    if (explicit >= 0) return explicit;
    for (const language of audioLanguageCandidates(response)) {
      const exact = rawTracks.findIndex((track) =>
        languageCode(track && track.languageCode).toLowerCase() === language.toLowerCase());
      if (exact >= 0) return exact;
      const primary = rawTracks.findIndex((track) => sameAudioLanguage(track && track.languageCode, language));
      if (primary >= 0) return primary;
    }
    return rawTracks.length === 1 ? 0 : -1;
  }

  function createCatalog(videoId) {
    let rawTracks = [];
    let allTracks = [];
    let playerResponse = null;
    for (const response of playerResponses()) {
      const candidateTracks = captionTracksFrom(response);
      const currentTracks = candidateTracks.filter((raw) => {
        const source = canonicalSource(raw && raw.baseUrl);
        if (!source) return false;
        try {
          const sourceVideoId = new URL(source, location.href).searchParams.get("v");
          return !videoId || !sourceVideoId || sourceVideoId === videoId;
        } catch (_e) { return false; }
      });
      if (currentTracks.length) {
        rawTracks = currentTracks;
        allTracks = candidateTracks;
        playerResponse = response;
        break;
      }
    }
    if (!rawTracks.length) return null;

    const tracks = [];
    const sources = Object.create(null);
    const sourceKeys = Object.create(null);
    const playerOptions = Object.create(null);
    const seenSources = new Set();
    const usedIds = new Set();
    const preferredIndex = preferredRawTrackIndex(playerResponse, rawTracks, allTracks);
    let preferredTrackId = "";
    rawTracks.forEach((raw, index) => {
      const source = canonicalSource(raw && raw.baseUrl);
      const key = sourceKey(source);
      const language = languageCode(raw && raw.languageCode);
      if (!source || !key || !language || seenSources.has(key)) return;
      try {
        const sourceVideoId = new URL(source, location.href).searchParams.get("v");
        if (videoId && sourceVideoId && sourceVideoId !== videoId) return;
      } catch (_e) { return; }
      seenSources.add(key);
      const kind = raw && raw.kind === "asr" ? "asr" : "manual";
      const label = trackLabel(raw && raw.name) || language;
      const vssId = safeIdPart(raw && raw.vssId);
      const baseId = `track:${language.toLowerCase()}:${kind}:${vssId || hash(key)}`;
      let id = baseId;
      if (usedIds.has(id)) id = `${baseId}:${index}`;
      usedIds.add(id);
      tracks.push({ id, languageCode: language, label, kind });
      if (index === preferredIndex) preferredTrackId = id;
      sources[id] = source;
      sourceKeys[id] = key;
      playerOptions[id] = playerTrackOptions(raw, language, kind);
    });
    return {
      tracks,
      sources,
      sourceKeys,
      playerOptions,
      preferredTrackId: preferredTrackId || (tracks.length === 1 ? tracks[0].id : ""),
      fingerprint: tracks.map((track) =>
        [track.id, track.languageCode, track.label, track.kind].join("|")
      ).join("\n")
    };
  }

  function scan(videoId) {
    const catalog = createCatalog(videoId);
    latestPlayerOptions = new Map(Object.entries(catalog && catalog.playerOptions || {}));
    return catalog;
  }

  function requestPlayerTrack(track) {
    if (!track) return false;
    const options = latestPlayerOptions.get(track.id) || {
      languageCode: track.languageCode, kind: track.kind === "asr" ? "asr" : ""
    };
    const players = [];
    try {
      const moviePlayer = document.getElementById("movie_player");
      const html5Player = document.querySelector(".html5-video-player");
      if (moviePlayer) players.push(moviePlayer);
      if (html5Player && html5Player !== moviePlayer) players.push(html5Player);
    } catch (_e) { return false; }
    for (const player of players) {
      if (!player || typeof player.setOption !== "function") continue;
      try {
        player.setOption("captions", "track", { ...options });
        return true;
      } catch (_e) { /* try the next player surface */ }
    }
    return false;
  }

  window.__ytdsCaptionTrackCatalog = Object.freeze({
    scan,
    observed: observedTrack,
    mergeObserved: mergeObservedTrack,
    trackIdForUrl,
    requestPlayerTrack
  });
})();
