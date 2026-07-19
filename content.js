// content.js — isolated world.
// Renders YouTube bilingual subtitles as a single non-overlapping layer.
//
// Two paths:
//   (A) CUE MODE  — inject.js (MAIN world) captures the player's pot-bearing
//       timedtext URL, fetches original json3 cues, and posts them here. We drive an overlay off currentTime,
//       switching PER-SENTENCE (no per-word jitter).
//   (B) FALLBACK  — if no cues arrive (nocues), fall back to v1 rendered-scrape:
//       poll .ytp-caption-segment every 200ms, then translate with DeepSeek.
(() => {
  "use strict";

  // ---- guard against double injection (mirror inject.js) -------------------
  // In normal MV3 operation this runs once per document, but an extension
  // reload (or a future move to programmatic injection) could re-run it; the
  // guard prevents accumulating listeners / cue loops / duplicate overlays.
  if (window.__ytdsContentLoaded) return;
  window.__ytdsContentLoaded = true;

  // ---- i18n ----------------------------------------------------------------
  // Safe wrapper around chrome.i18n.getMessage: returns the localized string,
  // or the supplied fallback if i18n is unavailable / the key is missing, so
  // nothing breaks if a message is absent.
  const t = (k, fb) => (chrome.i18n && chrome.i18n.getMessage(k)) || fb;

  // ---- shared settings model (MUST match popup.js DEFAULTS) ----------------
  const DEFAULTS = YTDS_SHARED.DEFAULTS;

  // Font key -> font-family stack (shared with popup preview).
  const FONT_STACKS = YTDS_SHARED.FONT_STACKS;
  function fontStack(key) {
    return FONT_STACKS[key] || FONT_STACKS.system;
  }

  // ---- color helpers (tolerant of #rgb / #rrggbb) --------------------------
  function hexToRgb(hex) {
    let h = String(hex || "").trim().replace(/^#/, "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return { r: 0, g: 0, b: 0 };
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }
  function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    let a = Number(alpha);
    if (!isFinite(a)) a = 1;
    a = Math.max(0, Math.min(1, a));
    return `rgba(${r},${g},${b},${a})`;
  }
  // Native Chromium text stroke gives predictable independent opacity/width.
  // Opacity 0 or width 0 means genuinely OFF (no hidden fallback shadow).
  function outlineStyle(strokeHex, strokeOpacity, strokeWidth) {
    const a = Number(strokeOpacity);
    const w = Number(strokeWidth);
    if (!isFinite(a) || a <= 0 || !isFinite(w) || w <= 0) return "0px transparent";
    return `${Math.max(0, Math.min(8, w))}px ${rgba(strokeHex, a)}`;
  }
  function clampPct(v) {
    let n = Number(v);
    if (!isFinite(n)) n = 50;
    return Math.max(2, Math.min(98, n));
  }

  let settings = { ...DEFAULTS };
  let extensionContextInvalidated = false;

  // overlay
  let overlay = null;
  let origEl = null;
  let transEl = null;
  let handleEl = null;

  // drag bookkeeping (listeners live on the handle, so they die with overlay)
  let dragging = false;
  let dragMoved = false;       // true once the pointer actually moved past threshold
  let dragGrabDy = 0;
  let dragStartY = 0;
  let dragSaveTimer = null;
  const DRAG_THRESHOLD = 3;    // px the pointer must move before it counts as a drag

  // cue mode
  let cueList = null;        // [{start,dur,end,text}]
  let cueVideoId = "";       // videoId the cues belong to
  let cueTimer = null;       // currentTime-driven loop
  let cueFrameId = null;
  let cueLoopVideo = null;
  let activeCueIdx = -1;     // index of currently shown cue
  let cueEpoch = 0;          // bumped each (re)start/teardown; invalidates in-flight requests
  const transCache = new Map(); // semantic group key -> translation
  const deepseekUnitCache = new Map(); // group key -> validated semantic unit id
  const deepseekSourceCache = new Map(); // group key -> full source text for that unit
  const deepseekAlignedChunksCache = new Map(); // semantic unit id -> model-aligned cue chunks
  const deepseekDisplayCache = new Map(); // group key -> current source/translation display page
  const deepseekRequestMeta = new Map(); // request key -> id/priority; permits prefetch promotion
  let deepseekRequestSerial = 0;
  let deepseekCommitRegions = []; // hard-boundary-delimited single-writer regions
  let deepseekGroupToCommitRegion = [];
  const deepseekCommitStateByRegion = new Map(); // region -> monotonic cursor/window/target
  let semanticLayoutWidth = 0;
  let semanticResizeObserver = null;
  let semanticReflowFrame = null;
  let displayMeasureCanvas = null;
  const transInflight = new Set(); // in-flight DeepSeek commit-region locks
  const deepseekRetryCounts = new Map(); // bounded cold-worker retries per batch/epoch
  let deepseekFocusGeneration = 0; // increments when seeking to another semantic batch
  let deepseekFocusedBatchIndex = -1;
  let deepseekSeekSettleTimer = null;
  let deepseekSeekSettling = false;
  const ZERO_DUR_FLOOR_MS = 1000; // min visible window for a trailing zero-dur cue
  const MAX_CUE_COUNT = 50000;
  const MAX_CUE_TEXT_CHARS = 4000;
  const MAX_CUE_PARTS = 512;
  const MAX_CUE_TOTAL_CHARS = 4000000;
  const MAX_TRACK_TIME_MS = 7 * 24 * 60 * 60 * 1000;

  // Addressable lexical groups used by DeepSeek's semantic segmentation.
  let sentGroups = null;        // [{startIdx,endIdx,text,start,end}] | null
  let cueToGroup = null;        // cue idx -> group idx | null (null = per-cue mode)
  let cueToGroups = null;       // DeepSeek: cue idx -> lexical-reference group ids
  let deepseekBatchWindows = []; // disjoint UI/prefetch scopes; not semantic ownership
  let deepseekGroupToBatch = [];
  let activeGroupIdx = -1;      // group of the active cue (-1 when none/per-cue)
  let cueTrackKind = "";        // "asr" | "manual" | "" — from inject's captured URL
  let cueSourceLang = "";       // source track language from timedtext's lang parameter
  let cueTrackSignature = "";   // prevents identical cue payloads restarting the loop
  let duplicateCueEvents = 0;
  let pendingTimer = null;      // delayed "…" placeholder for the active group
  let pendingIndicatorKey = ""; // stable batch/group scope; token changes must not reset it
  const DEEPSEEK_CORE_ITEMS = 32; // UI/prefetch scope only; never a semantic boundary
  const DEEPSEEK_INITIAL_REQUEST_ITEMS = 48; // smaller first response for cold-start latency
  const DEEPSEEK_REQUEST_ITEMS = 80; // normal monotonic request window
  const DEEPSEEK_URGENT_REQUEST_ITEMS = 96; // visible-request baseline; target runway may grow it
  const DEEPSEEK_MAX_REQUEST_ITEMS = 160; // expansion cap for unusually long units
  const DEEPSEEK_MAX_CURRENT_CHARS = 18000; // bound source payload independently of item count
  const DEEPSEEK_COMMIT_GUARD_ITEMS = 16; // always-carried trailing safety area
  const DEEPSEEK_URGENT_TARGET_TAIL_ITEMS = 48; // semantic runway after the visible seek target
  const DEEPSEEK_SEEK_BACKTRACK_ITEMS = 64; // read-only lead-in that fits the urgent cap
  const DEEPSEEK_SEEK_LEFT_GUARD_ITEMS = 16; // never commit units touching a seek edge
  const DEEPSEEK_SEEK_SETTLE_MS = 140; // wait for seeked or a short idle before requesting
  const DEEPSEEK_MAX_PREFETCH_BATCHES = 10;
  const DEEPSEEK_CONTEXT_GROUPS = 20; // surrounding original cues, never lexical tokens
  const DEEPSEEK_SOFT_PAUSE_MS = 900; // timing hint only; the model may cross it
  const DEEPSEEK_HARD_PAUSE_MS = 4000; // true discontinuity; semantic units may not cross
  const DEEPSEEK_DISPLAY_GAP_BRIDGE_MS = 2200; // keep one semantic page across short cue holes
  const DEEPSEEK_MIN_DISPLAY_UNIT_MS = 650; // co-display imperceptibly short units from one raw cue
  const DEEPSEEK_COLD_RETRY_DELAYS_MS = Object.freeze([400, 1200, 2500]);
  const DEEPSEEK_RATE_RETRY_LIMIT = 6;
  const PENDING_ELLIPSIS_MS = 400; // show "…" if the active group is still in flight

  // fallback (rendered-scrape) mode
  let pollTimer = null;
  let debounceTimer = null;
  let lastSource = "";
  let lastTransSource = "";
  let lastReqToken = 0;
  let fallbackRequestId = "";
  const DEBOUNCE_MS = 450;

  // bookkeeping
  let currentVideoId = videoIdFromLocation();
  let nocuesFallback = false;   // true once we've committed to scrape mode
  let configNonce = 0;          // random correlation id echoed by inject.js
  let nonceFallback = 0;
  let cueRecoveryTimer = null;
  let cueRecoveryAttempt = 0;
  let lastDebugCueIdx = -1;
  const INITIAL_CUE_RECOVERY_MS = 7000;

  function extensionContextAlive() {
    if (extensionContextInvalidated) return false;
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_e) {
      return false;
    }
  }

  function stopForInvalidatedExtensionContext() {
    if (extensionContextInvalidated) return;
    extensionContextInvalidated = true;
    settings.enabled = false;
    stopCueLoop();
    stopFallback();
    stopCueRecovery();
    clearPendingTimer();
    transInflight.clear();
    document.documentElement.classList.remove("ytds-active");
    removeOverlay();
  }

  function sendRuntimeMessage(message, callback) {
    if (!extensionContextAlive()) {
      stopForInvalidatedExtensionContext();
      return false;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        let runtimeError = null;
        try { runtimeError = chrome.runtime.lastError || null; }
        catch (_e) { stopForInvalidatedExtensionContext(); return; }
        if (!extensionContextAlive()) {
          stopForInvalidatedExtensionContext();
          return;
        }
        if (callback) callback(response, runtimeError);
      });
      return true;
    } catch (_e) {
      stopForInvalidatedExtensionContext();
      return false;
    }
  }

  // ---- settings ------------------------------------------------------------
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(null, (got) => {
        got = got || {};
        settings = { ...DEFAULTS, ...got };
        if (!Object.prototype.hasOwnProperty.call(got, "aiModel") && got.deepseekModel) {
          settings.aiModel = got.deepseekModel;
        }
        if (!Object.prototype.hasOwnProperty.call(got, "aiThinking") && got.deepseekThinking) {
          settings.aiThinking = got.deepseekThinking;
        }
        settings.aiThinking = YTDS_SHARED.normalizeAiThinking(settings.aiThinking);
        settings.targetLang = YTDS_SHARED.normalizeTargetLang(settings.targetLang);
        settings.deepseekContextPast =
          YTDS_SHARED.normalizeAiContextCount(settings.deepseekContextPast, 1);
        settings.deepseekContextFuture =
          YTDS_SHARED.normalizeAiContextCount(settings.deepseekContextFuture, 1);
        settings.deepseekPrefetchBatches =
          YTDS_SHARED.normalizeDeepseekPrefetchBatches(settings.deepseekPrefetchBatches);
        // migrate legacy global bgOpacity -> per-line bg opacities if present
        // and the per-line keys were never set.
        if (typeof got.bgOpacity === "number") {
          if (typeof got.origBgOpacity !== "number") settings.origBgOpacity = got.bgOpacity;
          if (typeof got.transBgOpacity !== "number") settings.transBgOpacity = got.bgOpacity;
        }
        resolve();
      });
    });
  }

  // A language change alters the requested translation but can reuse the cues.
  const RECUE_KEYS = new Set(["targetLang"]);
  const DEEPSEEK_RETRANSLATE_KEYS = new Set([
    "aiBaseUrl", "aiModel", "aiThinking",
    "deepseekModel", "deepseekThinking", "deepseekContextPast", "deepseekContextFuture"
  ]);
  const LIVE_STYLE_KEYS = new Set([
    "order", "rowGap", "position", "posMode", "posXpct", "posYpct",
    "showOriginal", "origFont", "origSize", "origFullscreenSize", "origColor", "origBg",
    "origBgOpacity", "origStroke", "origStrokeOpacity", "origStrokeWidth",
    "showTranslation", "transFont", "transSize", "transFullscreenSize", "transColor", "transBg",
    "transBgOpacity", "transStroke", "transStrokeOpacity", "transStrokeWidth"
  ]);
  const DEEPSEEK_REFLOW_KEYS = new Set([
    "showOriginal", "showTranslation",
    "origFont", "origSize", "origFullscreenSize",
    "transFont", "transSize", "transFullscreenSize"
  ]);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let needRecue = false;
    let needRetranslate = false;
    let needDisplayReflow = false;
    let prefetchChanged = false;
    for (const k of Object.keys(changes)) {
      if (k in settings) {
        const oldV = settings[k];
        settings[k] = changes[k].newValue;
        if (k === "targetLang") settings.targetLang = YTDS_SHARED.normalizeTargetLang(settings.targetLang);
        if (k === "deepseekPrefetchBatches") {
          settings.deepseekPrefetchBatches =
            YTDS_SHARED.normalizeDeepseekPrefetchBatches(settings.deepseekPrefetchBatches);
          prefetchChanged = oldV !== settings.deepseekPrefetchBatches;
        }
        if (RECUE_KEYS.has(k) && oldV !== settings[k]) {
          needRecue = true;
        }
        if (DEEPSEEK_RETRANSLATE_KEYS.has(k) && oldV !== settings[k]) {
          needRetranslate = true;
        }
        if (DEEPSEEK_REFLOW_KEYS.has(k) && oldV !== settings[k]) {
          needDisplayReflow = true;
        }
      }
    }
    const enabledChanged = Object.prototype.hasOwnProperty.call(changes, "enabled");
    applyStateToDom(false);
    if (overlay) styleOverlay();   // position/fonts/colors/bg/stroke/sizes apply live
    if (needDisplayReflow) scheduleDeepseekDisplayReflow(true);
    if (enabledChanged) syncCaptions();   // master switch flipped from popup
    if (prefetchChanged) {
      cancelDeepseekPrefetchRequests();
      if (settings.enabled && activeGroupIdx >= 0) {
        deepseekRequestBatch(activeGroupIdx, true, true);
        prefetchDeepseekBatches(activeGroupIdx, false);
      }
    }
    if ((needRecue || needRetranslate) && settings.enabled) {
      if (cueVideoId) {
        try { sendRuntimeMessage({ type: "cancelDeepSeek", videoId: cueVideoId }); }
        catch (_e) { /* worker unavailable */ }
      }
      transCache.clear();
      deepseekUnitCache.clear();
      deepseekSourceCache.clear();
      deepseekAlignedChunksCache.clear();
      deepseekDisplayCache.clear();
      deepseekRequestMeta.clear();
      resetDeepseekCommitTimeline();
      if (sentGroups && sentGroups.length) buildDeepseekCommitRegions();
      transInflight.clear();
      deepseekRetryCounts.clear();
      clearPendingTimer();
      // Bump the epoch so stale in-flight callbacks cannot repaint this video.
      cueEpoch++;
      activeGroupIdx = -1;
      if (cueTimer) {
        activeCueIdx = -1;          // force re-render of translation on next tick
        setTranslation("", "");
      }
      // A language change refreshes configuration; model/context changes reuse cues.
      if (needRecue) sendConfig("settings-recue");
      else if (cueList) cueTick();
    }
    if (enabledChanged && settings.enabled && !needRecue) {
      sendConfig("enabled");
      scheduleCueRecovery(INITIAL_CUE_RECOVERY_MS);
    }
  });

  // Repaint the active AI translation immediately after the locally stored
  // credential changes; no page reload or cue refetch is needed.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" ||
        (!changes.aiApiKeys && !changes.aiApiKey && !changes.deepseekApiKey)) return;
    if (cueVideoId) {
      try { sendRuntimeMessage({ type: "cancelDeepSeek", videoId: cueVideoId }); }
      catch (_e) { /* worker unavailable */ }
    }
    transCache.clear();
    deepseekUnitCache.clear();
    deepseekSourceCache.clear();
    deepseekAlignedChunksCache.clear();
    deepseekDisplayCache.clear();
    deepseekRequestMeta.clear();
    resetDeepseekCommitTimeline();
    if (sentGroups && sentGroups.length) buildDeepseekCommitRegions();
    transInflight.clear();
    deepseekRetryCounts.clear();
    clearPendingTimer();
    cueEpoch++;
    activeGroupIdx = -1;
    if (cueTimer) {
      activeCueIdx = -1;
      setTranslation("", "");
    }
    if (cueList) cueTick();
  });

  // ---- generic helpers -----------------------------------------------------
  function emitDebug(event, data) {
    if (!settings.debugEnabled) return;
    try {
      sendRuntimeMessage({
        type: "debugLog",
        scope: "content",
        event,
        data: Object.assign({
          videoId: cueVideoId || currentVideoId || "",
          videoTimeMs: Math.round(((getVideo() && getVideo().currentTime) || 0) * 1000)
        }, data || {})
      });
    } catch (_e) { /* debug logging must never affect playback */ }
  }

  function videoIdFromLocation() {
    return YTDS_SHARED.videoIdFromUrl(location.href);
  }

  function nextConfigNonce() {
    try {
      const value = new Uint32Array(1);
      crypto.getRandomValues(value);
      if (value[0]) return value[0];
    } catch (_e) { /* very old/locked-down runtime */ }
    nonceFallback = (nonceFallback + 1) >>> 0;
    return nonceFallback || 1;
  }

  function getPlayer() {
    return document.querySelector("#movie_player") ||
           document.querySelector(".html5-video-player");
  }

  function getVideo() {
    const p = getPlayer();
    return (p && p.querySelector("video")) ||
           document.querySelector("video.html5-main-video") ||
           document.querySelector("video");
  }

  // Read the currently displayed native caption text (fallback path).
  // Read ONLY .ytp-caption-segment (the combined node would duplicate text).
  function readNativeCaption() {
    const segs = document.querySelectorAll(".ytp-caption-segment");
    if (!segs.length) return "";
    let parts = [];
    segs.forEach((s) => {
      const t = s.textContent.trim();
      if (t) parts.push(t);
    });
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  // ---- overlay -------------------------------------------------------------
  function ensureOverlay() {
    const player = getPlayer();
    if (!player) return null;
    if (overlay && overlay.isConnected) return overlay;

    overlay = document.createElement("div");
    overlay.id = "ytds-overlay";
    transEl = document.createElement("div");
    transEl.className = "ytds-line ytds-trans";
    origEl = document.createElement("div");
    origEl.className = "ytds-line ytds-orig";

    overlay.appendChild(transEl);
    overlay.appendChild(origEl);
    buildHandle();                  // drag grip (its listeners die with overlay)
    player.appendChild(overlay);
    styleOverlay();
    observeSemanticLayout();
    return overlay;
  }

  // A small round grip in the overlay's top-left corner. It is the only
  // pointer-events:auto child; all drag listeners are attached to it (plus
  // pointer capture), so removing the overlay removes every listener with no
  // document-level leaks across SPA navigation.
  function buildHandle() {
    handleEl = document.createElement("div");
    handleEl.className = "ytds-handle";
    handleEl.title = t("handleTitle", "上下拖动字幕 · 双击复位");
    handleEl.setAttribute("aria-label", t("handleAria", "上下拖动字幕，双击复位"));
    handleEl.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3' +
      'M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/></svg>';

    handleEl.addEventListener("pointerdown", onHandlePointerDown);
    handleEl.addEventListener("pointermove", onHandlePointerMove);
    handleEl.addEventListener("pointerup", onHandlePointerUp);
    handleEl.addEventListener("pointercancel", onHandlePointerUp);
    handleEl.addEventListener("dblclick", onHandleDblClick);

    overlay.appendChild(handleEl);
  }

  function onHandlePointerDown(e) {
    const player = getPlayer();
    if (!player) return;
    dragging = true;
    dragMoved = false;              // no real movement yet — a bare click won't persist
    dragStartY = e.clientY;
    // Record only the vertical grab offset. Horizontal position is permanently
    // locked to the player centre.
    if (overlay) {
      const orect = overlay.getBoundingClientRect();
      dragGrabDy = e.clientY - (orect.top + orect.height / 2);
    } else {
      dragGrabDy = 0;
    }
    handleEl.classList.add("ytds-dragging");
    try { handleEl.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    e.preventDefault();
    e.stopPropagation();
  }

  function onHandlePointerMove(e) {
    if (!dragging) return;
    const player = getPlayer();
    if (!player) return;
    // Vertical-axis lock: horizontal pointer movement is ignored completely.
    // Only a real vertical gesture can enter custom-position mode.
    if (!dragMoved) {
      if (Math.abs(e.clientY - dragStartY) < DRAG_THRESHOLD) {
        return;
      }
      dragMoved = true;
    }
    const rect = player.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const cy = e.clientY - dragGrabDy;
    const ypct = clampPct(((cy - rect.top) / rect.height) * 100);
    settings.posMode = "custom";
    settings.posXpct = 50;
    settings.posYpct = ypct;
    applyPosition();                // smooth live feedback; no storage write
    e.preventDefault();
  }

  function onHandlePointerUp(e) {
    if (!dragging) return;
    dragging = false;
    handleEl.classList.remove("ytds-dragging");
    try { handleEl.releasePointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    // Only persist when a REAL drag happened. A bare click (no movement) must
    // not flip posMode to custom or move the box, and must not race the
    // dblclick reset (which clears this timer anyway).
    if (!dragMoved) return;
    // persist ONCE (coalesced) at the end of the gesture
    if (dragSaveTimer) clearTimeout(dragSaveTimer);
    dragSaveTimer = setTimeout(() => {
      dragSaveTimer = null;
      try {
        if (!extensionContextAlive()) { stopForInvalidatedExtensionContext(); return; }
        chrome.storage.sync.set({
          posMode: "custom",
          posXpct: 50,
          posYpct: settings.posYpct
        });
      } catch (_e) { stopForInvalidatedExtensionContext(); }
    }, 60);
  }

  function onHandleDblClick(e) {
    e.preventDefault();
    e.stopPropagation();
    // Cancel any pending drag-save timer; otherwise the still-pending write from
    // the preceding pointerup(s) fires ~60ms later and clobbers this reset back
    // to a custom position. Also drop any in-progress drag state.
    if (dragSaveTimer) { clearTimeout(dragSaveTimer); dragSaveTimer = null; }
    dragging = false;
    dragMoved = false;
    settings.posMode = "preset";
    applyPosition();
    try {
      if (extensionContextAlive()) chrome.storage.sync.set({ posMode: "preset" });
      else stopForInvalidatedExtensionContext();
    } catch (_e) { stopForInvalidatedExtensionContext(); }
  }

  // Apply ONLY positioning (shared by styleOverlay + live drag feedback).
  function applyPosition() {
    if (!overlay) return;
    if (settings.posMode === "custom") {
      overlay.classList.remove("ytds-pos-bottom", "ytds-pos-center", "ytds-pos-top");
      const y = clampPct(settings.posYpct);
      // Custom dragging is vertical-only; normalize legacy horizontal offsets.
      overlay.style.left = "50%";
      overlay.style.top = y + "%";
      overlay.style.bottom = "auto";
      overlay.style.transform = "translate(-50%, -50%)";
    } else {
      // preset: hand control back to the CSS classes
      overlay.style.left = "";
      overlay.style.top = "";
      overlay.style.bottom = "";
      overlay.style.transform = "";
      overlay.classList.remove("ytds-pos-bottom", "ytds-pos-center", "ytds-pos-top");
      overlay.classList.add("ytds-pos-" + settings.position);
    }
  }

  function styleOverlay() {
    if (!overlay) return;

    // spacing + order
    const rowGap = Math.max(0, Number(settings.rowGap) || 0);
    overlay.style.gap = rowGap + "px";
    overlay.style.setProperty("--ytds-row-gap", rowGap + "px");
    if (settings.order === "trans-top") {
      overlay.classList.add("ytds-trans-top");
      overlay.classList.remove("ytds-orig-top");
    } else {
      overlay.classList.add("ytds-orig-top");
      overlay.classList.remove("ytds-trans-top");
    }

    // original line
    origEl.style.fontFamily = fontStack(settings.origFont);
    const fullscreen = !!document.fullscreenElement || !!(getPlayer() && getPlayer().classList.contains("ytp-fullscreen"));
    origEl.style.fontSize = (fullscreen ? settings.origFullscreenSize : settings.origSize) + "px";
    origEl.style.color = settings.origColor;
    const origBg = rgba(settings.origBg, settings.origBgOpacity);
    origEl.style.backgroundColor = origBg;
    origEl.style.setProperty("--ytds-line-bg", origBg);
    origEl.style.textShadow = "none";
    origEl.style.webkitTextStroke = outlineStyle(
      settings.origStroke, settings.origStrokeOpacity, settings.origStrokeWidth
    );
    origEl.style.paintOrder = "stroke";

    // translation line
    transEl.style.fontFamily = fontStack(settings.transFont);
    transEl.style.fontSize = (fullscreen ? settings.transFullscreenSize : settings.transSize) + "px";
    transEl.style.color = settings.transColor;
    const transBg = rgba(settings.transBg, settings.transBgOpacity);
    transEl.style.backgroundColor = transBg;
    transEl.style.setProperty("--ytds-line-bg", transBg);
    transEl.style.textShadow = "none";
    transEl.style.webkitTextStroke = outlineStyle(
      settings.transStroke, settings.transStrokeOpacity, settings.transStrokeWidth
    );
    transEl.style.paintOrder = "stroke";

    // per-line visibility
    origEl.style.display = settings.showOriginal ? "" : "none";
    transEl.style.display = settings.showTranslation ? "" : "none";

    applyPosition();
    updateEmptyState();
  }

  function removeOverlay() {
    if (dragSaveTimer) { clearTimeout(dragSaveTimer); dragSaveTimer = null; }
    if (semanticResizeObserver) {
      semanticResizeObserver.disconnect();
      semanticResizeObserver = null;
    }
    if (semanticReflowFrame != null) {
      cancelAnimationFrame(semanticReflowFrame);
      semanticReflowFrame = null;
    }
    dragging = false;
    if (overlay) { overlay.remove(); overlay = null; } // removes handle + its listeners
    origEl = null;
    transEl = null;
    handleEl = null;
  }

  // Hide the container only when there is no VISIBLE content. A line counts as
  // empty if its layer is turned off (showOriginal/showTranslation) OR it has
  // no text — so a disabled-but-non-empty layer does not keep the box open.
  function updateEmptyState() {
    if (!overlay) return;
    const oEmpty = !settings.showOriginal || !origEl.textContent;
    const tEmpty = !settings.showTranslation || !transEl.textContent;
    overlay.classList.toggle("ytds-empty", oEmpty && tEmpty);
    overlay.classList.toggle("ytds-two-lines", !oEmpty && !tEmpty);
  }

  function sanitizeCueList(value) {
    if (!Array.isArray(value) || value.length > MAX_CUE_COUNT) return null;
    let totalChars = 0;
    const out = [];
    for (const raw of value) {
      const start = Number(raw && raw.start);
      const dur = Number(raw && raw.dur);
      const text = typeof (raw && raw.text) === "string" ? raw.text.trim() : "";
      if (!Number.isFinite(start) || start < 0 || start > MAX_TRACK_TIME_MS ||
          !Number.isFinite(dur) || dur < 0 || dur > 60 * 60 * 1000 ||
          !text || text.length > MAX_CUE_TEXT_CHARS) return null;
      totalChars += text.length;
      if (totalChars > MAX_CUE_TOTAL_CHARS) return null;
      const cue = { start, dur, text };
      if (Array.isArray(raw && raw.parts) && raw.parts.length <= MAX_CUE_PARTS) {
        const parts = [];
        for (const rawPart of raw.parts) {
          const partText = typeof (rawPart && rawPart.text) === "string"
            ? rawPart.text.replace(/\s+/g, " ").trim().slice(0, MAX_CUE_TEXT_CHARS) : "";
          if (!partText) continue;
          const part = { text: partText };
          const offsetMs = Number(rawPart && rawPart.offsetMs);
          if (Number.isFinite(offsetMs) && offsetMs >= 0 && offsetMs <= dur) {
            part.offsetMs = offsetMs;
          }
          parts.push(part);
        }
        if (parts.length) cue.parts = parts;
      }
      const lastOff = Number(raw && raw.lastOff);
      if (Number.isFinite(lastOff)) cue.lastOff = Math.max(start, Math.min(MAX_TRACK_TIME_MS, lastOff));
      if (typeof (raw && raw.trans) === "string") {
        cue.trans = raw.trans.trim().slice(0, MAX_CUE_TEXT_CHARS * 2);
      }
      out.push(cue);
    }
    return out;
  }

  function setOriginal(text) {
    if (!ensureOverlay()) return;
    origEl.textContent = text || "";
    updateEmptyState();
  }

  function setTranslation(text, forSource) {
    if (!ensureOverlay()) return;
    const previous = transEl.textContent;
    transEl.textContent = text || "";
    if (arguments.length > 1) lastTransSource = forSource || "";
    updateEmptyState();
    if (previous !== transEl.textContent) {
      emitDebug("translation-painted", {
        cueIdx: activeCueIdx,
        groupIdx: activeGroupIdx,
        source: forSource || "",
        previousTranslation: previous,
        translation: transEl.textContent
      });
    }
  }

  // ---- auto-enable YouTube's caption track ---------------------------------
  // The overlay needs the player to actually FETCH a timedtext track (that is
  // how inject.js gets the pot-bearing URL). So when the extension is on we turn
  // YouTube's CC on for the user by clicking the native button; turning the
  // extension off restores it — but only if WE were the ones who turned it on.
  let weEnabledCC = false;

  function ensureCaptionsOn(retries) {
    if (!settings.enabled) return;
    const cc = document.querySelector(".ytp-subtitles-button");
    if (!cc || cc.getAttribute("aria-pressed") === null) {
      if (retries > 0) setTimeout(() => ensureCaptionsOn(retries - 1), 600);
      return;                                   // button / state not ready yet
    }
    if (cc.getAttribute("aria-disabled") === "true") {
      // Disabled is often TRANSIENT: on a cold page load YouTube keeps the CC
      // button disabled until the video's track list arrives, several seconds
      // after the button exists. Treating that as "no captions on this video"
      // made auto-enable give up on cold loads (SPA navs were fast enough to
      // never hit it). Keep retrying within the window; a video with genuinely
      // no track just lets the retries lapse — clicking never happens either way.
      if (retries > 0) setTimeout(() => ensureCaptionsOn(retries - 1), 600);
      return;
    }
    if (cc.getAttribute("aria-pressed") !== "true") {
      cc.click();
      weEnabledCC = true;
    }
  }

  function restoreCaptionsIfWeEnabled() {
    if (!weEnabledCC) return;
    weEnabledCC = false;
    const cc = document.querySelector(".ytp-subtitles-button");
    if (cc && cc.getAttribute("aria-pressed") === "true") cc.click();
  }

  function syncCaptions() {
    // 20 × 600ms ≈ 12s window: covers slow cold loads where the CC button
    // stays aria-disabled for several seconds while the track list loads.
    if (settings.enabled) ensureCaptionsOn(20);
    else restoreCaptionsIfWeEnabled();
  }

  function captionButtonDebugState() {
    const cc = document.querySelector(".ytp-subtitles-button");
    if (!cc) return { present: false, pressed: "", disabled: "" };
    return {
      present: true,
      pressed: String(cc.getAttribute("aria-pressed") || ""),
      disabled: String(cc.getAttribute("aria-disabled") || "")
    };
  }

  function stopCueRecovery() {
    if (cueRecoveryTimer) { clearTimeout(cueRecoveryTimer); cueRecoveryTimer = null; }
    cueRecoveryAttempt = 0;
  }

  function forceCaptionReload() {
    const cc = document.querySelector(".ytp-subtitles-button");
    if (!cc) { ensureCaptionsOn(6); return; }
    if (cc.getAttribute("aria-pressed") === "true") {
      const wasEnabledByUs = weEnabledCC;
      try { cc.click(); } catch (_e) { /* ignore */ }
      setTimeout(() => {
        const fresh = document.querySelector(".ytp-subtitles-button");
        if (fresh && fresh.getAttribute("aria-pressed") !== "true" &&
            fresh.getAttribute("aria-disabled") !== "true") {
          try { fresh.click(); } catch (_e) { /* ignore */ }
        }
        // A recovery cycle must not claim ownership of CC if the user had
        // already enabled it before the extension intervened.
        weEnabledCC = wasEnabledByUs;
      }, 300);
    } else {
      ensureCaptionsOn(8);
    }
  }

  function scheduleCueRecovery(delayOverride) {
    if (cueRecoveryTimer || !settings.enabled || cueList) return;
    const requestedDelay = Number(delayOverride);
    const delay = Number.isFinite(requestedDelay) && requestedDelay > 0
      ? Math.round(requestedDelay)
      : Math.min(15000, 2500 + cueRecoveryAttempt * 1500);
    emitDebug("cue-recovery-scheduled", {
      attempt: cueRecoveryAttempt + 1,
      delayMs: delay,
      captionButton: captionButtonDebugState()
    });
    cueRecoveryTimer = setTimeout(() => {
      cueRecoveryTimer = null;
      if (!settings.enabled || cueList) { stopCueRecovery(); return; }
      cueRecoveryAttempt++;
      emitDebug("cue-recovery-attempt", {
        attempt: cueRecoveryAttempt,
        captionButton: captionButtonDebugState(),
        nativeCaptionVisible: !!readNativeCaption()
      });
      ensureCaptionsOn(6);
      // Recovery runs only while no cue list exists, so always ask the MAIN
      // bridge to retry the current video/config.
      // Reuse the current nonce: a lost bridge message is safely replayed, while
      // an already-running slow cue fetch is not invalidated by the watchdog.
      sendConfig("recovery", true);
      // Every second failed attempt, force YouTube to issue a fresh timedtext
      // request with a new pot instead of remaining stuck on a stale URL.
      if (!lastSource && cueRecoveryAttempt % 2 === 0) forceCaptionReload();
      scheduleCueRecovery();
    }, delay);
  }

  // =========================================================================
  // CUE MODE
  // =========================================================================

  // binary search: greatest index whose start <= t. -1 if none.
  function findCueIdx(t) {
    if (!cueList || !cueList.length) return -1;
    let lo = 0, hi = cueList.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cueList[mid].start <= t) { ans = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return ans;
  }

  // Find the cue active at time t, tolerant of overlapping/zero-dur cues.
  // findCueIdx gives the greatest-start candidate; if t is past that cue's
  // effective end we walk back to catch an earlier, longer cue still covering t
  // before declaring a gap. Returns the cue index or -1.
  function activeCueIdxAt(t) {
    let idx = findCueIdx(t);
    if (idx < 0) return -1;
    // Walk back over earlier cues whose (sorted) start <= t in case a longer
    // earlier cue still covers t. Bounded scan keeps this cheap.
    for (let i = idx; i >= 0; i--) {
      const c = cueList[i];
      if (t < c.end) return i;       // c covers t (end is the effective end)
      // If even the latest-starting candidate (i === idx) has ended, an
      // earlier cue might still be open (overlap); keep walking a small window.
      if (idx - i > 8) break;        // safety bound; cues rarely overlap deeply
    }
    return -1;                        // genuine gap
  }

  // YouTube occasionally leaves a short hole between two timed cues even when
  // DeepSeek has validated them as one continuous semantic unit. Clearing the
  // overlay inside that hole makes the same sentence disappear and reappear.
  // Retain the preceding cue's display page until the next member starts.
  function semanticGapCueIdxAt(t) {
    if (!cueList || !cueToGroup) return -1;
    const previousCue = findCueIdx(t);
    const nextCue = previousCue + 1;
    if (previousCue < 0 || nextCue >= cueList.length) return -1;
    const previous = cueList[previousCue];
    const next = cueList[nextCue];
    if (t < previous.end || t >= next.start) return -1;
    const previousGroups = cueToGroups && cueToGroups[previousCue];
    const nextGroups = cueToGroups && cueToGroups[nextCue];
    const previousGroup = previousGroups && previousGroups.length
      ? previousGroups[previousGroups.length - 1] : cueToGroup[previousCue];
    const nextGroup = nextGroups && nextGroups.length ? nextGroups[0] : cueToGroup[nextCue];
    if (!Number.isInteger(previousGroup) || !Number.isInteger(nextGroup)) return -1;
    const previousUnit = deepseekUnitCache.get(groupKey(previousGroup));
    const nextUnit = deepseekUnitCache.get(groupKey(nextGroup));
    return YTDS_SHARED.shouldBridgeSemanticCueGap(
      previous, next, t, previousUnit, nextUnit, DEEPSEEK_DISPLAY_GAP_BRIDGE_MS
    ) ? previousCue : -1;
  }

  function startCueLoop() {
    stopCueLoop();
    activeCueIdx = -1;
    activeGroupIdx = -1;
    clearPendingTimer();
    cueEpoch++;                       // invalidate any in-flight callbacks
    ensureOverlay();
    // Clear any leftover text (e.g. last scraped fallback line, or a previous
    // cue) so a start during a gap does not leave a stale line on screen.
    setOriginal("");
    setTranslation("", "");
    const video = getVideo();
    if (video && typeof video.requestVideoFrameCallback === "function") {
      cueTimer = { kind: "video-frame" };
      cueLoopVideo = video;
      const onFrame = () => {
        if (!cueTimer || cueLoopVideo !== video) return;
        cueTick();
        cueFrameId = video.requestVideoFrameCallback(onFrame);
      };
      cueFrameId = video.requestVideoFrameCallback(onFrame);
      for (const event of ["timeupdate", "seeking", "seeked", "play", "loadedmetadata"]) {
        video.addEventListener(event, cueTick);
      }
    } else {
      cueTimer = setInterval(cueTick, 120);
    }
    cueTick();                        // render the active cue NOW (no blank frame)
  }

  function stopCueLoop() {
    clearDeepseekSeekSettle();
    if (cueLoopVideo) {
      if (cueFrameId != null && typeof cueLoopVideo.cancelVideoFrameCallback === "function") {
        try { cueLoopVideo.cancelVideoFrameCallback(cueFrameId); } catch (_e) { /* ignore */ }
      }
      for (const event of ["timeupdate", "seeking", "seeked", "play", "loadedmetadata"]) {
        cueLoopVideo.removeEventListener(event, cueTick);
      }
    } else if (cueTimer) {
      clearInterval(cueTimer);
    }
    cueTimer = null;
    cueFrameId = null;
    cueLoopVideo = null;
    activeCueIdx = -1;
  }

  function clearDeepseekSeekSettle() {
    if (deepseekSeekSettleTimer) {
      clearTimeout(deepseekSeekSettleTimer);
      deepseekSeekSettleTimer = null;
    }
    deepseekSeekSettling = false;
  }

  function deepseekBatchIndexAtTime(timeMs) {
    if (!cueList || !deepseekBatchWindows.length) return -1;
    let cueIndex = activeCueIdxAt(timeMs);
    if (cueIndex < 0) cueIndex = Math.min(cueList.length - 1, findCueIdx(timeMs) + 1);
    const group = deepseekGroupForCueAt(cueIndex, timeMs);
    if (!Number.isInteger(group) || group < 0) return -1;
    const batchIndex = deepseekGroupToBatch[group];
    return Number.isInteger(batchIndex) ? batchIndex : -1;
  }

  function focusDeepseekAfterSeek(timeMs) {
    const batchIndex = deepseekBatchIndexAtTime(timeMs);
    if (batchIndex < 0 || batchIndex === deepseekFocusedBatchIndex) return;
    const previousBatchIndex = deepseekFocusedBatchIndex;
    deepseekFocusedBatchIndex = batchIndex;
    deepseekFocusGeneration++;
    for (const key of Array.from(transInflight)) {
      if (typeof key === "string" && (key.startsWith("dsb:") || key.startsWith("dsr:"))) {
        transInflight.delete(key);
        deepseekRequestMeta.delete(key);
      }
    }
    deepseekRetryCounts.clear();
    emitDebug("deepseek-focus-changed", {
      previousBatchIndex,
      batchIndex,
      focusGeneration: deepseekFocusGeneration,
      videoTimeMs: Math.round(Number(timeMs) || 0)
    });
    if (cueVideoId) {
      sendRuntimeMessage({
        type: "cancelDeepSeek",
        videoId: cueVideoId,
        beforeFocusGeneration: deepseekFocusGeneration
      });
    }
  }

  function beginDeepseekSeek(timeMs) {
    if (deepseekSeekSettleTimer) clearTimeout(deepseekSeekSettleTimer);
    deepseekSeekSettling = true;
    focusDeepseekAfterSeek(timeMs);
    deepseekSeekSettleTimer = setTimeout(() => {
      deepseekSeekSettleTimer = null;
      if (!deepseekSeekSettling) return;
      deepseekSeekSettling = false;
      const video = getVideo();
      const settledTimeMs = video ? video.currentTime * 1000 : timeMs;
      focusDeepseekAfterSeek(settledTimeMs);
      emitDebug("deepseek-seek-settled", {
        reason: "idle",
        videoTimeMs: Math.round(Number(settledTimeMs) || 0)
      });
      cueTick({ type: "deepseek-seek-settled" });
    }, DEEPSEEK_SEEK_SETTLE_MS);
  }

  function finishDeepseekSeek(timeMs) {
    if (deepseekSeekSettleTimer) {
      clearTimeout(deepseekSeekSettleTimer);
      deepseekSeekSettleTimer = null;
    }
    deepseekSeekSettling = false;
    focusDeepseekAfterSeek(timeMs);
    emitDebug("deepseek-seek-settled", {
      reason: "seeked",
      videoTimeMs: Math.round(Number(timeMs) || 0)
    });
  }

  function cueTick(event) {
    if (!extensionContextAlive()) { stopForInvalidatedExtensionContext(); return; }
    if (!settings.enabled || !cueList) return;
    const video = getVideo();
    if (!video) return;
    const t = video.currentTime * 1000;
    const eventType = event && event.type || "";
    if (eventType === "seeking") beginDeepseekSeek(t);
    else if (eventType === "seeked") finishDeepseekSeek(t);
    const seekJustSettled = eventType === "seeked" || eventType === "deepseek-seek-settled";

    let idx = activeCueIdxAt(t);
    if (idx < 0) idx = semanticGapCueIdxAt(t);

    if (idx < 0) {
      // The first caption often starts after a short intro. Use that otherwise
      // idle lead time to translate the upcoming DeepSeek batch before it is
      // visible. This also warms the destination when seeking into a cue gap.
      prefetchDeepseekAtTime(t);
      if (activeCueIdx !== -1) {
        activeCueIdx = -1;
        activeGroupIdx = -1;              // no cue ⟹ no group (explicit invariant)
        lastDebugCueIdx = -1;
        setOriginal("");
        setTranslation("", "");
      }
      return;
    }

    const timedGroupIdx = deepseekGroupForCueAt(idx, t);
    if (idx === activeCueIdx && timedGroupIdx === activeGroupIdx) {
      maybeReflowSemanticDisplay();
      if (seekJustSettled && activeGroupIdx >= 0 &&
          !transCache.has(groupKey(activeGroupIdx))) {
        armPendingTranslationIndicator(activeGroupIdx, true);
        deepseekRequestBatch(activeGroupIdx, true, true);
        prefetchFrom(idx);
      }
      return;                             // same sentence — no re-render, no jitter
    }
    activeCueIdx = idx;
    activeGroupIdx = timedGroupIdx;

    const cue = cueList[idx];
    const displaySource = sourceForDisplayedCue(idx, cue);
    if (idx !== lastDebugCueIdx || eventType === "seeking" || seekJustSettled) {
      lastDebugCueIdx = idx;
      emitDebug("cue-active", {
        cueIdx: idx,
        groupIdx: activeGroupIdx,
        cueStartMs: cue.start,
        cueEndMs: cue.end,
        source: cue.text,
        displaySource
      });
    }
    setOriginal(displaySource);
    renderTranslationForCue(idx, cue, displaySource,
      deepseekSeekSettling || eventType === "seeking");
    prefetchFrom(idx);
  }

  function sourceForDisplayedCue(idx, cue) {
    if (!cueToGroup) return cue.text;
    const group = idx === activeCueIdx && activeGroupIdx >= 0
      ? activeGroupIdx : deepseekGroupForCueAt(idx);
    if (!Number.isInteger(group)) return cue.text;
    const display = deepseekDisplayCache.get(groupKey(group));
    if (display && display.source) return display.source;
    return deepseekSourceCache.get(groupKey(group)) || cue.text;
  }

  function deepseekGroupForCueAt(cueIdx, timeMs) {
    if (!cueToGroup || !Number.isInteger(cueIdx) || cueIdx < 0 || cueIdx >= cueToGroup.length) {
      return -1;
    }
    const groups = cueToGroups && cueToGroups[cueIdx];
    if (!Array.isArray(groups) || !groups.length || !sentGroups) {
      const group = cueToGroup[cueIdx];
      return Number.isInteger(group) ? group : -1;
    }
    const time = Number(timeMs);
    if (!Number.isFinite(time)) return groups[0];
    let selected = groups[0];
    for (const group of groups) {
      const atom = sentGroups[group];
      if (!atom || Number(atom.start) > time) break;
      selected = group;
    }
    return selected;
  }

  function renderTranslationForCue(idx, cue, displayedSource, immediatePending) {
    const origText = displayedSource || cue.text;

    if (activeGroupIdx >= 0) {
      const gCached = transCache.get(groupKey(activeGroupIdx));
      if (gCached !== undefined) {
        clearPendingTimer();
        const display = deepseekDisplayCache.get(groupKey(activeGroupIdx));
        setTranslation(display && display.translation || gCached, origText);
        return;
      }
      armPendingTranslationIndicator(activeGroupIdx, immediatePending);
      deepseekRequestBatch(activeGroupIdx, true, true);
      return;
    }
    setTranslation("", origText);
  }

  function prefetchFrom(startIdx) {
    if (!settings.enabled || !cueList) return;
    if (cueToGroup && sentGroups) {
      const at = Math.max(0, Math.min(startIdx, cueToGroup.length - 1));
      const g0 = at === activeCueIdx && activeGroupIdx >= 0
        ? activeGroupIdx : deepseekGroupForCueAt(at);
      if (g0 == null || g0 < 0) return;
      prefetchDeepseekBatches(g0, false);
      return;
    }
  }

  function prefetchDeepseekBatches(gIdx, includeCurrent) {
    if (!sentGroups || !deepseekBatchWindows.length) return;
    if (!Number.isInteger(gIdx) || gIdx < 0 || gIdx >= sentGroups.length) return;
    if (includeCurrent) deepseekRequestBatch(gIdx);
    const starts = YTDS_SHARED.semanticPrefetchBatchStarts(
      gIdx, deepseekGroupToBatch, deepseekBatchWindows,
      Math.min(DEEPSEEK_MAX_PREFETCH_BATCHES, settings.deepseekPrefetchBatches)
    );
    for (const start of starts) deepseekRequestBatch(start);
  }

  function prefetchDeepseekAtTime(timeMs) {
    if (!cueList || !cueList.length) return;
    let idx = activeCueIdxAt(timeMs);
    if (idx < 0) {
      // findCueIdx is the last cue that has started. Its successor is the first
      // future cue both before the track begins and inside a genuine cue gap.
      idx = Math.min(cueList.length - 1, findCueIdx(timeMs) + 1);
    }
    const group = deepseekGroupForCueAt(idx, timeMs);
    if (Number.isInteger(group)) prefetchDeepseekBatches(group, true);
  }

  // Compute an effective end for each (already start-sorted) cue. Handles
  // zero/near-zero-duration cues (extend to the next cue's start, or a floor
  // for the final cue) so they are not treated as a permanent gap.
  function computeCueEnds(list) {
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      let end = c.start + (c.dur > 0 ? c.dur : 0);
      if (c.dur <= 0) {
        if (i + 1 < list.length) end = list[i + 1].start;
        else end = c.start + ZERO_DUR_FLOOR_MS;
        // guard against a non-positive window if the next cue shares the start
        if (end <= c.start) end = c.start + ZERO_DUR_FLOOR_MS;
      }
      c.end = end;
    }
  }

  // Merge overlapping timed cue text without duplicating rolling-caption words.
  function mergeCueTexts(cues) {
    return YTDS_SHARED.mergeTimedCueTexts(cues);
  }

  function semanticDisplayWidth() {
    if (overlay && overlay.isConnected && overlay.clientWidth > 0) {
      return Math.max(260, Math.round(overlay.clientWidth) - 20);
    }
    const player = getPlayer();
    const width = player && player.clientWidth || window.innerWidth || 1280;
    return Math.max(260, Math.round(width * 0.98) - 20);
  }

  function measureDisplayText(text, original) {
    if (!displayMeasureCanvas) displayMeasureCanvas = document.createElement("canvas");
    const context = displayMeasureCanvas.getContext("2d");
    if (!context) return String(text || "").length * 12;
    const fullscreen = !!document.fullscreenElement ||
      !!(getPlayer() && getPlayer().classList.contains("ytp-fullscreen"));
    const size = original
      ? (fullscreen ? settings.origFullscreenSize : settings.origSize)
      : (fullscreen ? settings.transFullscreenSize : settings.transSize);
    const family = fontStack(original ? settings.origFont : settings.transFont);
    context.font = `400 ${Math.max(8, Number(size) || 16)}px ${family}`;
    return context.measureText(String(text || "")).width;
  }

  function semanticDisplayPageCount(source, translation, memberCount) {
    if (memberCount < 2) return 1;
    // Leave headroom for proportional-font wrapping and the line padding. Each
    // page targets at most two rendered rows per language.
    const twoLineCapacity = semanticDisplayWidth() * 1.68;
    const sourcePages = settings.showOriginal
      ? Math.ceil(measureDisplayText(source, true) / twoLineCapacity) : 1;
    const translationPages = settings.showTranslation
      ? Math.ceil(measureDisplayText(translation, false) / twoLineCapacity) : 1;
    return Math.max(1, Math.min(memberCount, Math.max(sourcePages, translationPages)));
  }

  function cacheSemanticDisplayCluster(unitsValue, logPages) {
    if (!sentGroups) return;
    const units = (Array.isArray(unitsValue) ? unitsValue : [])
      .map((unit) => ({
        unitId: String(unit && unit.unitId || ""),
        members: Array.isArray(unit && unit.members) ? unit.members.slice() : []
      })).filter((unit) => unit.members.length);
    const members = units.flatMap((unit) => unit.members);
    if (!members.length) return;
    const parts = members.map((id) => sentGroups[id]).filter(Boolean);
    if (!parts.length) return;
    const source = mergeCueTexts(parts);
    const translation = YTDS_SHARED.joinTranslatedParts(
      units.map((unit) => transCache.get(groupKey(unit.members[0])) || ""),
      settings.targetLang
    );
    if (!source || !translation) return;
    const unitIds = units.map((unit) => unit.unitId).filter(Boolean);
    const alignedChunks = unitIds.flatMap((unitId) =>
      deepseekAlignedChunksCache.get(unitId) || []);
    let displayPlan = null;
    let alignedByChunks = false;
    if (Array.isArray(alignedChunks) && alignedChunks.length) {
      const expectedIds = members.map(String);
      const displayChunks = [];
      const coveredIds = [];
      for (const chunk of alignedChunks) {
        const ids = Array.isArray(chunk && chunk.ids) ? chunk.ids.map(String) : [];
        const numericIds = ids.map(Number);
        const cues = numericIds.map((id) => sentGroups[id]).filter(Boolean);
        if (!ids.length || cues.length !== ids.length || !chunk.translation) continue;
        coveredIds.push(...ids);
        displayChunks.push({ ids, cues, translation: String(chunk.translation) });
      }
      const exactCoverage = coveredIds.length === expectedIds.length &&
        coveredIds.every((id, index) => id === expectedIds[index]);
      if (exactCoverage && displayChunks.length) {
        const twoLineCapacity = semanticDisplayWidth() * 1.68;
        const alignedPlan = YTDS_SHARED.alignedChunkDisplayPlan(
          displayChunks,
          settings.showOriginal ? twoLineCapacity : Number.MAX_SAFE_INTEGER,
          settings.showTranslation ? twoLineCapacity : Number.MAX_SAFE_INTEGER,
          (text) => measureDisplayText(text, true),
          (text) => measureDisplayText(text, false),
          settings.targetLang,
          cueSourceLang
        );
        if (alignedPlan.pages.length && !alignedPlan.overflow) {
          displayPlan = {
            alignedBySentence: false,
            sourcePages: alignedPlan.pages.map((page) => ({ text: page.source })),
            translationPages: alignedPlan.pages.map((page) => ({ text: page.translation })),
            assignments: members.map((id) => alignedPlan.memberPages[String(id)] || 0)
          };
          alignedByChunks = true;
        }
      }
    }
    if (!displayPlan) {
      // Whole-unit safety path for responses without usable aligned chunks and
      // the rare oversized chunk that cannot be locally paginated by its ids.
      const requestedPages = semanticDisplayPageCount(source, translation, members.length);
      displayPlan = YTDS_SHARED.semanticDisplayPlan(
        source,
        translation,
        parts.map((part) => part.text),
        requestedPages,
        (text) => measureDisplayText(text, true),
        (text) => measureDisplayText(text, false),
        cueSourceLang,
        settings.targetLang
      );
    }
    const sourcePages = displayPlan.sourcePages;
    const translationPages = displayPlan.translationPages;
    if (!sourcePages.length || !translationPages.length) return;
    const pageAssignments = displayPlan.assignments;

    for (let ordinal = 0; ordinal < members.length; ordinal++) {
      const sourcePageIndex = pageAssignments[ordinal] == null ? 0 : pageAssignments[ordinal];
      const translationPageIndex = sourcePages.length > 1
        ? Math.round(sourcePageIndex * (translationPages.length - 1) / (sourcePages.length - 1))
        : 0;
      deepseekDisplayCache.set(groupKey(members[ordinal]), {
        source: sourcePages[sourcePageIndex].text,
        translation: translationPages[translationPageIndex].text,
        pageIndex: sourcePageIndex,
        pageCount: sourcePages.length
      });
    }
    if (logPages && sourcePages.length > 1) {
      emitDebug("semantic-display-pages", {
        unitIds,
        members,
        widthPx: semanticDisplayWidth(),
        alignedByChunks,
        alignedBySentence: displayPlan.alignedBySentence,
        memberPages: members.map((id, ordinal) => ({ id, page: pageAssignments[ordinal] || 0 })),
        sourcePages: sourcePages.map((page) => page.text),
        translationPages: translationPages.map((page) => page.text)
      });
    }
    if (logPages && units.length > 1) {
      const first = sentGroups[members[0]];
      const last = sentGroups[members[members.length - 1]];
      emitDebug("semantic-display-smoothed", {
        unitIds,
        members,
        sourceCueIndex: first && first.startIdx,
        durationMs: Math.max(0, Number(last && last.end) - Number(first && first.start)),
        minimumMs: DEEPSEEK_MIN_DISPLAY_UNIT_MS
      });
    }
  }

  function deepseekSemanticDisplayUnits() {
    if (!sentGroups) return [];
    const units = new Map();
    for (let id = 0; id < sentGroups.length; id++) {
      const unitId = deepseekUnitCache.get(groupKey(id));
      if (!unitId) continue;
      const unit = units.get(unitId) || { unitId, members: [] };
      unit.members.push(id);
      units.set(unitId, unit);
    }
    return Array.from(units.values());
  }

  function deepseekSemanticDisplayClusters() {
    return YTDS_SHARED.semanticDisplayClusters(
      deepseekSemanticDisplayUnits(), sentGroups, DEEPSEEK_MIN_DISPLAY_UNIT_MS
    );
  }

  function cacheDeepseekDisplayNeighborhood(changedMembers, logPages) {
    const changed = new Set((Array.isArray(changedMembers) ? changedMembers : []).map(Number));
    const cueIndexes = new Set(Array.from(changed).map((id) =>
      Number(sentGroups && sentGroups[id] && sentGroups[id].startIdx)).filter(Number.isInteger));
    const unitById = new Map(deepseekSemanticDisplayUnits().map((unit) => [unit.unitId, unit]));
    for (const cluster of deepseekSemanticDisplayClusters()) {
      const relevant = cluster.members.some((id) => changed.has(id) ||
        cueIndexes.has(Number(sentGroups && sentGroups[id] && sentGroups[id].startIdx)));
      if (!relevant) continue;
      const units = cluster.unitIds.map((unitId) => unitById.get(unitId)).filter(Boolean);
      cacheSemanticDisplayCluster(units, logPages);
    }
  }

  function repaintActiveDeepseekTranslation() {
    const activeTranslation = activeGroupIdx >= 0
      ? transCache.get(groupKey(activeGroupIdx)) : "";
    if (!activeTranslation || activeCueIdx < 0 || !cueList) {
      if (activeGroupIdx >= 0 && activeCueIdx >= 0 && cueList) {
        armPendingTranslationIndicator(activeGroupIdx);
      }
      return;
    }
    clearPendingTimer();
    const activeSource = sourceForDisplayedCue(activeCueIdx, cueList[activeCueIdx]);
    const activeDisplay = deepseekDisplayCache.get(groupKey(activeGroupIdx));
    setOriginal(activeSource);
    setTranslation(activeDisplay && activeDisplay.translation || activeTranslation, activeSource);
  }

  function rebuildDeepseekDisplayCache(repaint) {
    deepseekDisplayCache.clear();
    semanticLayoutWidth = semanticDisplayWidth();
    if (!sentGroups) return;
    const unitById = new Map(deepseekSemanticDisplayUnits().map((unit) => [unit.unitId, unit]));
    for (const cluster of deepseekSemanticDisplayClusters()) {
      const units = cluster.unitIds.map((unitId) => unitById.get(unitId)).filter(Boolean);
      cacheSemanticDisplayCluster(units, false);
    }
    if (repaint && activeCueIdx >= 0 && activeGroupIdx >= 0 && cueList) {
      const cue = cueList[activeCueIdx];
      const source = sourceForDisplayedCue(activeCueIdx, cue);
      const display = deepseekDisplayCache.get(groupKey(activeGroupIdx));
      const translation = display && display.translation || transCache.get(groupKey(activeGroupIdx));
      setOriginal(source);
      if (translation) setTranslation(translation, source);
    }
  }

  // Coalesce live slider/font/layout changes to one rebuild per animation
  // frame. Measuring the connected overlay keeps pagination in lockstep with
  // its real content width instead of a separately estimated percentage.
  function scheduleDeepseekDisplayReflow(repaint) {
    if (semanticReflowFrame != null) return;
    semanticReflowFrame = requestAnimationFrame(() => {
      semanticReflowFrame = null;
      rebuildDeepseekDisplayCache(repaint !== false);
    });
  }

  function observeSemanticLayout() {
    if (semanticResizeObserver) semanticResizeObserver.disconnect();
    semanticResizeObserver = null;
    if (typeof ResizeObserver !== "function" || !overlay) return;
    semanticResizeObserver = new ResizeObserver(() => {
      const width = semanticDisplayWidth();
      if (!semanticLayoutWidth || width !== semanticLayoutWidth) {
        scheduleDeepseekDisplayReflow(true);
      }
    });
    semanticResizeObserver.observe(overlay);
  }

  function maybeReflowSemanticDisplay() {
    if (!deepseekUnitCache.size) return;
    const width = semanticDisplayWidth();
    if (!semanticLayoutWidth || width !== semanticLayoutWidth) {
      scheduleDeepseekDisplayReflow(true);
    }
  }

  function groupKey(gIdx) { return cueVideoId + " g" + gIdx; }

  function deepseekPauseAfter(list, index) {
    if (index >= list.length - 1) return Number.POSITIVE_INFINITY;
    return Math.max(0, Number(YTDS_SHARED.cuePauseMs(list[index], list[index + 1])) || 0);
  }

  function deepseekHardBoundaryAfter(list, index) {
    return index >= list.length - 1 || YTDS_SHARED.semanticPauseKind(
      deepseekPauseAfter(list, index), DEEPSEEK_SOFT_PAUSE_MS, DEEPSEEK_HARD_PAUSE_MS
    ) === "hard";
  }

  function resetDeepseekCommitTimeline() {
    deepseekCommitRegions = [];
    deepseekGroupToCommitRegion = [];
    deepseekCommitStateByRegion.clear();
  }

  function buildDeepseekCommitRegions() {
    resetDeepseekCommitTimeline();
    if (!sentGroups || !sentGroups.length) return;
    let start = 0;
    for (let end = 0; end < sentGroups.length; end++) {
      if (!sentGroups[end].hardAfter && end < sentGroups.length - 1) continue;
      const regionIndex = deepseekCommitRegions.length;
      deepseekCommitRegions.push({ start, end });
      for (let id = start; id <= end; id++) deepseekGroupToCommitRegion[id] = regionIndex;
      start = end + 1;
    }
  }

  // Preserve the player's cue timeline while exposing addressable lexical
  // references. DeepSeek alone chooses semantic groups; local scopes only
  // control preloading distance and pending-indicator stability.
  function buildHybridCueGroups(list) {
    // A new cue timeline invalidates its lexical coordinates and immutable
    // commit cursors, even when YouTube reuses the same video id.
    transCache.clear();
    deepseekUnitCache.clear();
    deepseekSourceCache.clear();
    deepseekAlignedChunksCache.clear();
    deepseekDisplayCache.clear();
    deepseekRequestMeta.clear();
    resetDeepseekCommitTimeline();
    const atoms = YTDS_SHARED.cueReferenceAtoms(list);
    sentGroups = YTDS_SHARED.causalCueGroups(atoms);
    cueToGroups = Array.from({ length: list.length }, () => []);
    for (let group = 0; group < sentGroups.length; group++) {
      const sourceCueIndex = Number(atoms[group] && atoms[group].sourceCueIndex);
      if (!Number.isInteger(sourceCueIndex) || !cueToGroups[sourceCueIndex]) continue;
      sentGroups[group].startIdx = sourceCueIndex;
      sentGroups[group].endIdx = sourceCueIndex;
      cueToGroups[sourceCueIndex].push(group);
    }
    cueToGroup = cueToGroups.map((groups) => groups.length ? groups[0] : -1);
    deepseekBatchWindows = YTDS_SHARED.referenceBatchWindows(
      list, atoms, 0, 0, true,
      { coreItems: DEEPSEEK_CORE_ITEMS, requestItems: DEEPSEEK_CORE_ITEMS }
    );
    deepseekGroupToBatch = new Array(sentGroups.length);
    for (let batchIndex = 0; batchIndex < deepseekBatchWindows.length; batchIndex++) {
      const batch = deepseekBatchWindows[batchIndex];
      for (let i = batch.start; i <= batch.end; i++) {
        deepseekGroupToBatch[i] = batchIndex;
        const sourceCueIndex = sentGroups[i].startIdx;
        const nextSourceCueIndex = i + 1 < sentGroups.length ? sentGroups[i + 1].startIdx : -1;
        const crossesCue = sourceCueIndex !== nextSourceCueIndex;
        const pauseAfterMs = crossesCue ? deepseekPauseAfter(list, sourceCueIndex) : 0;
        const pauseKind = YTDS_SHARED.semanticPauseKind(
          pauseAfterMs, DEEPSEEK_SOFT_PAUSE_MS, DEEPSEEK_HARD_PAUSE_MS
        );
        sentGroups[i].pauseAfterMs = Number.isFinite(pauseAfterMs)
          ? Math.round(pauseAfterMs) : DEEPSEEK_HARD_PAUSE_MS;
        sentGroups[i].softAfter = crossesCue && pauseKind !== "none";
        sentGroups[i].hardAfter = i >= sentGroups.length - 1 ||
          (crossesCue && deepseekHardBoundaryAfter(list, sourceCueIndex));
      }
    }
    buildDeepseekCommitRegions();
  }

  function deepseekBatchEntry(gIdx, withTranslation) {
    const group = sentGroups[gIdx];
    const entry = {
      id: String(gIdx),
      cueId: String(group.startIdx),
      text: group.text,
      startMs: Math.max(0, Math.round(group.start || 0)),
      endMs: Math.max(0, Math.round(group.end || group.start || 0)),
      pauseAfterMs: Math.max(0, Math.round(Number(group.pauseAfterMs) || 0)),
      softAfter: !!group.softAfter,
      hardAfter: !!group.hardAfter
    };
    if (withTranslation) {
      const translated = transCache.get(groupKey(gIdx));
      if (translated) entry.translation = translated;
    }
    return entry;
  }

  function deepseekCueContextEntry(cueIdx, temporal) {
    const cue = cueList && cueList[cueIdx];
    if (!cue) return null;
    return {
      id: `c${cueIdx}`,
      text: cue.text,
      temporal: temporal === "future" ? "future" : "past"
    };
  }

  function cueTrackFingerprint(videoId, trackKind, sourceLang, cues) {
    let hash = 2166136261;
    const add = (value) => {
      const text = String(value == null ? "" : value);
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      hash ^= 31;
      hash = Math.imul(hash, 16777619);
    };
    add(videoId);
    add(settings.targetLang);
    add(trackKind);
    add(sourceLang);
    add(cues.length);
    for (const cue of cues) {
      add(cue.start);
      add(cue.dur);
      add(cue.text);
    }
    return `${cues.length}:${hash >>> 0}`;
  }

  function deepseekBatchRetryKey(start, end, videoId, epoch) {
    return `${videoId}:${epoch}:${start}:${end}`;
  }

  function beginDeepseekRequest(inflightKey, kind, start, end, urgent) {
    const existing = deepseekRequestMeta.get(inflightKey);
    if (existing) {
      if (!urgent || existing.urgent) return "";
      // Playback caught a speculative request. Cancel only that HTTP request;
      // its eventual callback is ignored by request-id comparison below.
      sendRuntimeMessage({
        type: "cancelDeepSeekRequest",
        videoId: cueVideoId,
        requestId: existing.requestId
      });
      emitDebug("deepseek-request-promoted", {
        kind,
        start,
        end,
        cancelledRequestId: existing.requestId
      });
      deepseekRequestMeta.delete(inflightKey);
      transInflight.delete(inflightKey);
    } else if (transInflight.has(inflightKey)) {
      return "";
    }
    const requestId = `${kind}:${deepseekFocusGeneration}:${++deepseekRequestSerial}:${start}-${end}`;
    deepseekRequestMeta.set(inflightKey, {
      requestId,
      urgent: !!urgent,
      progressTranslations: []
    });
    transInflight.add(inflightKey);
    return requestId;
  }

  function finishDeepseekRequest(inflightKey, requestId) {
    const current = deepseekRequestMeta.get(inflightKey);
    if (!current || current.requestId !== requestId) return false;
    deepseekRequestMeta.delete(inflightKey);
    transInflight.delete(inflightKey);
    return true;
  }

  function deepseekRequestById(requestId) {
    const wanted = String(requestId || "");
    if (!wanted) return null;
    for (const [inflightKey, request] of deepseekRequestMeta.entries()) {
      if (request && request.requestId === wanted) return { inflightKey, request };
    }
    return null;
  }

  function cancelDeepseekPrefetchRequests() {
    for (const [inflightKey, request] of Array.from(deepseekRequestMeta.entries())) {
      if (!request || request.urgent) continue;
      sendRuntimeMessage({
        type: "cancelDeepSeekRequest",
        videoId: cueVideoId,
        requestId: request.requestId
      });
      deepseekRequestMeta.delete(inflightKey);
      transInflight.delete(inflightKey);
    }
  }

  function scheduleDeepSeekBatchRetry(
    gIdx, start, end, videoId, epoch, reason, retryOptions
  ) {
    const key = deepseekBatchRetryKey(start, end, videoId, epoch);
    const attempt = deepseekRetryCounts.get(key) || 0;
    const rateLimited = !!(retryOptions && retryOptions.rateLimited);
    const maxAttempts = rateLimited
      ? DEEPSEEK_RATE_RETRY_LIMIT : DEEPSEEK_COLD_RETRY_DELAYS_MS.length;
    if (attempt >= maxAttempts) {
      emitDebug("batch-retry-exhausted", { start, end, reason: String(reason || "") });
      repaintActiveDeepseekTranslation();
      return;
    }
    const requestedDelay = Number(retryOptions && retryOptions.retryAfterMs);
    const delayMs = rateLimited
      ? Math.max(500, Math.min(61000,
          Number.isFinite(requestedDelay) && requestedDelay > 0 ? Math.ceil(requestedDelay) : 1500))
      : DEEPSEEK_COLD_RETRY_DELAYS_MS[attempt];
    const regionIndex = deepseekGroupToCommitRegion[gIdx];
    // One lock per semantic region, not per request range. The target may grow
    // while a request is running; a range-shaped key would then admit another
    // request with the same commit cursor and violate the single-writer model.
    const inflightKey = `dsb:${regionIndex}`;
    const scheduledFocusGeneration = deepseekFocusGeneration;
    deepseekRetryCounts.set(key, attempt + 1);
    // Keep the batch marked as pending during the cooldown. cueTick runs many
    // times per second; without this lock it would repeatedly hit the worker
    // while local concurrency or the remote API is still rate-limited.
    transInflight.add(inflightKey);
    emitDebug("batch-retry", {
      start,
      end,
      attempt: attempt + 1,
      delayMs,
      rateLimited,
      reason: String(reason || "")
    });
    setTimeout(() => {
      transInflight.delete(inflightKey);
      if (epoch !== cueEpoch || videoId !== cueVideoId) {
        deepseekRetryCounts.delete(key);
        return;
      }
      if (scheduledFocusGeneration !== deepseekFocusGeneration) {
        deepseekRetryCounts.delete(key);
        return;
      }
      deepseekRequestBatch(gIdx, true, !!(retryOptions && retryOptions.urgent));
    }, delayMs);
  }

  function deepseekContextsForRange(requestStart, requestEnd) {
    const startCue = Math.max(0,
      Number(sentGroups[requestStart] && sentGroups[requestStart].startIdx) || 0);
    const endCue = Math.max(startCue,
      Number(sentGroups[requestEnd] && sentGroups[requestEnd].endIdx) || startCue);
    const contextBefore = [];
    for (let i = Math.max(0, startCue - DEEPSEEK_CONTEXT_GROUPS); i < startCue; i++) {
      const entry = deepseekCueContextEntry(i, "past");
      if (entry) contextBefore.push(entry);
    }
    const contextAfter = [];
    for (let i = endCue + 1;
         i <= Math.min(cueList.length - 1, endCue + DEEPSEEK_CONTEXT_GROUPS); i++) {
      const entry = deepseekCueContextEntry(i, "future");
      if (entry) contextAfter.push(entry);
    }
    return { contextBefore, contextAfter };
  }

  function deepseekCommitState(regionIndex) {
    const region = deepseekCommitRegions[regionIndex];
    if (!region) return null;
    let state = deepseekCommitStateByRegion.get(regionIndex);
    if (!state) {
      state = {
        cursor: region.start,
        commitFloor: region.start,
        limitEnd: region.end,
        targetThrough: region.start - 1,
        urgentTarget: region.start - 1,
        windowItems: DEEPSEEK_INITIAL_REQUEST_ITEMS
      };
      deepseekCommitStateByRegion.set(regionIndex, state);
    }
    return state;
  }

  function reseedDeepseekCommitState(regionIndex, targetGroup) {
    const region = deepseekCommitRegions[regionIndex];
    const state = deepseekCommitState(regionIndex);
    if (!region || !state) return state;
    const inflightKey = `dsb:${regionIndex}`;
    const existing = deepseekRequestMeta.get(inflightKey);
    if (existing) {
      sendRuntimeMessage({
        type: "cancelDeepSeekRequest",
        videoId: cueVideoId,
        requestId: existing.requestId
      });
      deepseekRequestMeta.delete(inflightKey);
      transInflight.delete(inflightKey);
    }

    let requestStart = Math.max(region.start, targetGroup - DEEPSEEK_SEEK_BACKTRACK_ITEMS);
    // A previously committed unit immediately to the left is already a proven
    // semantic boundary. Start after it instead of inventing another guard.
    for (let id = targetGroup - 1; id >= requestStart; id--) {
      if (transCache.has(groupKey(id))) {
        requestStart = id + 1;
        break;
      }
    }
    let limitEnd = region.end;
    for (let id = targetGroup; id <= region.end; id++) {
      if (transCache.has(groupKey(id))) {
        limitEnd = id - 1;
        break;
      }
    }
    const provenLeftBoundary = requestStart === region.start ||
      (requestStart > region.start && transCache.has(groupKey(requestStart - 1)));
    state.cursor = requestStart;
    state.commitFloor = provenLeftBoundary
      ? requestStart
      : Math.min(targetGroup, requestStart + DEEPSEEK_SEEK_LEFT_GUARD_ITEMS);
    state.limitEnd = Math.max(targetGroup, limitEnd);
    state.targetThrough = requestStart - 1;
    state.urgentTarget = requestStart - 1;
    state.windowItems = DEEPSEEK_INITIAL_REQUEST_ITEMS;
    emitDebug("semantic-commit-reseeded", {
      regionIndex,
      targetGroup,
      requestStart,
      commitFloor: state.commitFloor,
      limitEnd: state.limitEnd,
      provenLeftBoundary
    });
    return state;
  }

  function commitDeepseekResponsePrefix(
    regionIndex, requestStart, requestEnd, commitFloor, limitEnd, translations, guardItems
  ) {
    const region = deepseekCommitRegions[regionIndex];
    const state = deepseekCommitState(regionIndex);
    if (!region || !state || state.cursor !== requestStart) return null;
    const plan = YTDS_SHARED.monotonicSemanticCommitPlan(
      translations, requestStart, requestEnd, limitEnd,
      guardItems, commitFloor
    );
    if (!plan.units.length) return requestStart;

    const byUnit = new Map();
    for (const item of plan.translations) {
      const unitId = String(item.unitId || `semantic-${item.id}-${item.id}`);
      const unit = byUnit.get(unitId) || { unitId, members: [], translation: "", alignedChunks: null };
      unit.members.push(Number(item.id));
      if (!unit.translation) unit.translation = String(item.translation || "");
      if (!unit.alignedChunks && Array.isArray(item.alignedChunks)) {
        unit.alignedChunks = item.alignedChunks.map((chunk) => ({
          ids: Array.isArray(chunk && chunk.ids) ? chunk.ids.map(String) : [],
          translation: String(chunk && chunk.translation || "").trim()
        })).filter((chunk) => chunk.ids.length && chunk.translation);
      }
      byUnit.set(unitId, unit);
    }
    const units = Array.from(byUnit.values()).sort((a, b) => a.members[0] - b.members[0]);
    let expected = plan.commitStart;
    for (const unit of units) {
      unit.members.sort((a, b) => a - b);
      if (!unit.translation || unit.members[0] !== expected) return requestStart;
      const parts = unit.members.map((id) => sentGroups[id]).filter(Boolean);
      if (parts.length !== unit.members.length) return requestStart;
      unit.source = mergeCueTexts(parts);
      for (const id of unit.members) {
        if (transCache.has(groupKey(id)) || deepseekUnitCache.has(groupKey(id))) {
          emitDebug("semantic-commit-invariant-violation", {
            regionIndex, requestStart, requestEnd, id, unitId: unit.unitId
          });
          return requestStart;
        }
      }
      expected = unit.members[unit.members.length - 1] + 1;
    }
    if (expected - 1 !== plan.commitThrough) return requestStart;

    for (const unit of units) {
      for (const id of unit.members) {
        const key = groupKey(id);
        transCache.set(key, unit.translation);
        deepseekUnitCache.set(key, unit.unitId);
        deepseekSourceCache.set(key, unit.source);
      }
      if (unit.alignedChunks && unit.alignedChunks.length) {
        deepseekAlignedChunksCache.set(unit.unitId, unit.alignedChunks);
      }
    }
    cacheDeepseekDisplayNeighborhood(units.flatMap((unit) => unit.members), true);
    semanticLayoutWidth = semanticDisplayWidth();
    emitDebug("semantic-prefix-committed", {
      regionIndex,
      requestStart,
      requestEnd,
      guardStart: plan.guardStart,
      commitThrough: plan.commitThrough,
      carryStart: plan.carryStart,
      units: units.map((unit) => ({ unitId: unit.unitId, members: unit.members }))
    });
    return plan.carryStart;
  }

  function handleDeepseekTranslationProgress(msg) {
    if (String(msg && msg.requestId || "") === fallbackRequestId &&
        String(msg && msg.videoId || "") === currentVideoId &&
        Number(msg && msg.focusGeneration) === deepseekFocusGeneration) {
      const translated = Array.isArray(msg.translations) && msg.translations[0] &&
        String(msg.translations[0].translation || "").trim();
      if (translated && lastSource) {
        setTranslation(translated, lastSource);
        return true;
      }
    }
    const found = deepseekRequestById(msg && msg.requestId);
    if (!found) return false;
    const request = found.request;
    if (String(msg.videoId || "") !== request.reqVid ||
        Number(msg.focusGeneration) !== request.focusGeneration ||
        request.reqEpoch !== cueEpoch || request.reqVid !== cueVideoId) {
      return false;
    }
    const incoming = Array.isArray(msg.translations) ? msg.translations.filter(Boolean) : [];
    if (!incoming.length) return false;

    // Delivery through chrome.tabs.sendMessage is asynchronous. Keep a small
    // id-keyed buffer so a duplicated or slightly reordered progress message
    // can never create a hole or overwrite an already committed unit.
    const byId = new Map();
    for (const item of request.progressTranslations) {
      const id = Number(item && item.id);
      if (Number.isInteger(id)) byId.set(id, item);
    }
    for (const item of incoming) {
      const id = Number(item && item.id);
      if (Number.isInteger(id) && id >= request.requestStart && id <= request.requestEnd) {
        byId.set(id, item);
      }
    }
    request.progressTranslations = Array.from(byId.values())
      .sort((a, b) => Number(a.id) - Number(b.id));

    const state = deepseekCommitState(request.regionIndex);
    if (!state || state.cursor < request.requestStart || state.cursor > request.requestEnd) return false;
    const pending = request.progressTranslations.filter(
      (item) => Number(item && item.id) >= state.cursor
    );
    const previousCursor = state.cursor;
    const nextCursor = commitDeepseekResponsePrefix(
      request.regionIndex, previousCursor, request.requestEnd, state.commitFloor,
      request.limitEnd, pending, request.effectiveGuardItems
    );
    if (!Number.isInteger(nextCursor) || nextCursor <= previousCursor) return false;

    state.cursor = nextCursor;
    state.commitFloor = nextCursor;
    state.windowItems = DEEPSEEK_REQUEST_ITEMS;
    request.progressTranslations = request.progressTranslations.filter(
      (item) => Number(item && item.id) >= nextCursor
    );
    deepseekRetryCounts.delete(deepseekBatchRetryKey(
      request.requestStart, request.requestEnd, request.reqVid, request.reqEpoch
    ));
    emitDebug("semantic-jsonl-progress-committed", {
      regionIndex: request.regionIndex,
      requestStart: request.requestStart,
      requestEnd: request.requestEnd,
      previousCursor,
      nextCursor
    });
    repaintActiveDeepseekTranslation();
    return true;
  }

  function pumpDeepseekCommitRegion(regionIndex, urgent) {
    const region = deepseekCommitRegions[regionIndex];
    const state = deepseekCommitState(regionIndex);
    if (!region || !state || state.cursor > state.limitEnd || state.cursor > state.targetThrough) return;
    const requestStart = state.cursor;
    const commitFloor = state.commitFloor;
    const limitEnd = state.limitEnd;
    const requestUrgent = !!urgent || state.urgentTarget >= requestStart;
    // Put the requested playback/prefetch target before the private guard when
    // the cap allows it. Urgent work deliberately ignores the farther
    // speculative target: visible text returns first, then preloading resumes.
    const requestPlan = YTDS_SHARED.semanticCommitRequestPlan(
      state, requestStart, DEEPSEEK_COMMIT_GUARD_ITEMS,
      DEEPSEEK_MAX_REQUEST_ITEMS, requestUrgent, DEEPSEEK_URGENT_REQUEST_ITEMS,
      DEEPSEEK_URGENT_TARGET_TAIL_ITEMS
    );
    const targetAwareItems = requestPlan.itemCount;
    let requestEnd = Math.min(limitEnd, requestStart + targetAwareItems - 1);
    // The range is deliberately absent: targetThrough can expand while this
    // request is in flight, but the region must still have only one writer.
    const inflightKey = `dsb:${regionIndex}`;
    const existingRequest = deepseekRequestMeta.get(inflightKey);
    if (transInflight.has(inflightKey) &&
        (!requestUrgent || !existingRequest || existingRequest.urgent)) return;
    const items = [];
    let currentChars = 0;
    for (let id = requestStart; id <= requestEnd; id++) {
      const entry = deepseekBatchEntry(id, false);
      const nextChars = String(entry.text || "").length;
      if (items.length && currentChars + nextChars > DEEPSEEK_MAX_CURRENT_CHARS) break;
      items.push(entry);
      currentChars += nextChars;
    }
    requestEnd = requestStart + items.length - 1;
    const effectiveGuardItems = Math.min(
      DEEPSEEK_COMMIT_GUARD_ITEMS,
      Math.max(0, Math.floor(items.length / 3))
    );
    const { contextBefore, contextAfter } = deepseekContextsForRange(requestStart, requestEnd);
    const requestId = beginDeepseekRequest(
      inflightKey, "commit", requestStart, requestEnd, requestUrgent
    );
    if (!requestId) return;
    const reqVid = cueVideoId;
    const reqEpoch = cueEpoch;
    const liveRequest = deepseekRequestMeta.get(inflightKey);
    if (liveRequest && liveRequest.requestId === requestId) {
      Object.assign(liveRequest, {
        regionIndex,
        requestStart,
        requestEnd,
        commitFloor,
        limitEnd,
        effectiveGuardItems,
        reqVid,
        reqEpoch,
        focusGeneration: deepseekFocusGeneration
      });
    }
    sendRuntimeMessage({
      type: "translateBatch",
      debug: !!settings.debugEnabled,
      requestId,
      videoId: cueVideoId,
      videoTimeMs: Math.round(((getVideo() && getVideo().currentTime) || 0) * 1000),
      targetLang: settings.targetLang,
      sourceLang: cueSourceLang,
      coreStart: commitFloor,
      coreEnd: Math.min(requestPlan.targetThrough, requestEnd),
      requestStart,
      requestEnd,
      urgent: requestUrgent,
      focusGeneration: deepseekFocusGeneration,
      items,
      contextBefore,
      contextAfter
    }, (resp, runtimeError) => {
      if (!finishDeepseekRequest(inflightKey, requestId)) return;
      const progressedCursor = state.cursor;
      if (runtimeError) {
        if (progressedCursor > requestStart) {
          repaintActiveDeepseekTranslation();
          if (state.cursor <= state.targetThrough && state.cursor <= state.limitEnd) {
            queueMicrotask(() => pumpDeepseekCommitRegion(regionIndex, false));
          }
        } else {
          scheduleDeepSeekBatchRetry(
            requestStart, requestStart, requestEnd, reqVid, reqEpoch,
            runtimeError.message || "runtime unavailable", { urgent: requestUrgent }
          );
        }
        return;
      }
      if (reqEpoch !== cueEpoch || reqVid !== cueVideoId) return;
      if (!resp || !resp.ok || !Array.isArray(resp.translations)) {
        const error = resp && resp.error || "empty background response";
        emitDebug("batch-rejected", {
          regionIndex, requestStart, requestEnd, error,
          needsKey: !!(resp && resp.needsKey),
          timeout: !!(resp && resp.timeout),
          rateLimited: !!(resp && resp.rateLimited),
          retryAfterMs: Number(resp && resp.retryAfterMs) || 0,
          limitReason: String(resp && resp.limitReason || "")
        });
        if (progressedCursor > requestStart) {
          repaintActiveDeepseekTranslation();
          if (state.cursor <= state.targetThrough && state.cursor <= state.limitEnd) {
            queueMicrotask(() => pumpDeepseekCommitRegion(regionIndex, false));
          }
        } else if (!resp || resp.netfail || resp.timeout || resp.rateLimited ||
            error === "invalid translation batch" || error === "untrusted sender") {
          scheduleDeepSeekBatchRetry(requestStart, requestStart, requestEnd, reqVid, reqEpoch, error, {
            rateLimited: !!(resp && resp.rateLimited),
            retryAfterMs: Number(resp && resp.retryAfterMs) || 0,
            urgent: requestUrgent
          });
        }
        return;
      }

      emitDebug("deepseek-batch-response", {
        regionIndex,
        requestStart,
        requestEnd,
        itemCount: items.length,
        urgent: requestUrgent,
        modelDeferredIds: Array.isArray(resp.deferredIds) ? resp.deferredIds : [],
        httpDiagnostics: resp.httpDiagnostics || { attempts: [] }
      });
      const finalStart = state.cursor;
      const finalTranslations = resp.translations.filter(
        (item) => Number(item && item.id) >= finalStart
      );
      const nextCursor = commitDeepseekResponsePrefix(
        regionIndex, finalStart, requestEnd, state.commitFloor, limitEnd,
        finalTranslations, effectiveGuardItems
      );
      if (!Number.isInteger(nextCursor)) return;
      deepseekRetryCounts.delete(deepseekBatchRetryKey(
        requestStart, requestEnd, reqVid, reqEpoch
      ));
      if (nextCursor > finalStart) {
        state.cursor = nextCursor;
        state.commitFloor = nextCursor;
        state.windowItems = DEEPSEEK_REQUEST_ITEMS;
      }
      const madeProgress = state.cursor > requestStart;
      if (madeProgress) {
        // A malformed/cancelled tail is intentionally retried from the first
        // uncommitted id. Completed JSONL units are already immutable cache.
      } else if (requestEnd < limitEnd && targetAwareItems < DEEPSEEK_MAX_REQUEST_ITEMS) {
        state.windowItems = Math.min(DEEPSEEK_MAX_REQUEST_ITEMS, targetAwareItems + 32);
        emitDebug("semantic-commit-window-expanded", {
          regionIndex, cursor: state.cursor, windowItems: state.windowItems
        });
      } else {
        scheduleDeepSeekBatchRetry(
          requestStart, requestStart, requestEnd, reqVid, reqEpoch,
          "no immutable semantic prefix", { urgent: requestUrgent }
        );
        repaintActiveDeepseekTranslation();
        return;
      }
      repaintActiveDeepseekTranslation();
      if (state.cursor <= state.targetThrough && state.cursor <= state.limitEnd) {
        queueMicrotask(() => pumpDeepseekCommitRegion(regionIndex, false));
      }
    });
  }

  // Extend one hard-boundary-delimited stream's desired prefix. Transport
  // batches only define how far to preload; they never own semantic output.
  function deepseekRequestBatch(gIdx, _includePredecessor = true, urgent = false) {
    if (deepseekSeekSettling) return;
    if (!sentGroups || gIdx < 0 || gIdx >= sentGroups.length) return;
    const regionIndex = deepseekGroupToCommitRegion[gIdx];
    const region = deepseekCommitRegions[regionIndex];
    let state = deepseekCommitState(regionIndex);
    if (!region || !state) return;
    const currentMissing = !transCache.has(groupKey(gIdx));
    const randomAccessDistance = (urgent
      ? DEEPSEEK_URGENT_REQUEST_ITEMS : DEEPSEEK_MAX_REQUEST_ITEMS) -
      DEEPSEEK_COMMIT_GUARD_ITEMS;
    if (YTDS_SHARED.shouldReseedSemanticCommitState(
      currentMissing, gIdx, state, randomAccessDistance, urgent, activeGroupIdx >= 0
    )) {
      state = reseedDeepseekCommitState(regionIndex, gIdx);
    }
    const batchIndex = deepseekGroupToBatch[gIdx];
    const batch = deepseekBatchWindows[batchIndex];
    const targetThrough = Math.min(state.limitEnd, batch ? batch.end : gIdx);
    state.targetThrough = Math.max(state.targetThrough, targetThrough);
    if (urgent) {
      state.urgentTarget = gIdx;
      if (Number.isInteger(batchIndex)) deepseekFocusedBatchIndex = batchIndex;
    }
    pumpDeepseekCommitRegion(regionIndex, urgent);
  }

  function clearPendingTimer() {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    pendingIndicatorKey = "";
  }

  function pendingTranslationScopeKey(gIdx) {
    return YTDS_SHARED.pendingTranslationScopeKey(gIdx, deepseekGroupToBatch);
  }

  // Lexical token groups can advance several times inside 400 ms. The old
  // timer captured gIdx and restarted at every token, so a slow DeepSeek batch
  // could leave the previous translation visible indefinitely without ever
  // reaching the loading indicator. Scope the timer to the semantic API batch
  // and inspect the current token only when it fires.
  function armPendingTranslationIndicator(gIdx, immediate) {
    const scopeKey = pendingTranslationScopeKey(gIdx);
    if (!scopeKey) return;
    if (pendingIndicatorKey !== scopeKey) {
      clearPendingTimer();
      pendingIndicatorKey = scopeKey;
    } else if (pendingTimer && immediate) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    } else if (!immediate) {
      return;
    }
    const pVid = cueVideoId;
    const pEpoch = cueEpoch;
    const showPending = () => {
      pendingTimer = null;
      if (pendingIndicatorKey !== scopeKey || pEpoch !== cueEpoch || pVid !== cueVideoId) {
        if (pendingIndicatorKey === scopeKey) pendingIndicatorKey = "";
        return;
      }
      if (activeGroupIdx < 0 || activeCueIdx < 0 || !cueList ||
          pendingTranslationScopeKey(activeGroupIdx) !== scopeKey) {
        pendingIndicatorKey = "";
        return;
      }
      if (transCache.has(groupKey(activeGroupIdx))) {
        pendingIndicatorKey = "";
        return;
      }
      const source = sourceForDisplayedCue(activeCueIdx, cueList[activeCueIdx]);
      setTranslation("…", source);
      // Keep the scope key after firing. Token changes inside this unresolved
      // batch must neither restart the timer nor disturb the indicator.
    };
    if (immediate) showPending();
    else pendingTimer = setTimeout(showPending, PENDING_ELLIPSIS_MS);
  }

  function onCues(data) {
    if (!currentVideoId || data.videoId !== currentVideoId) return;
    if (!Number.isInteger(data.nonce) || data.nonce !== configNonce) return;
    nocuesFallback = false;
    stopCueRecovery();
    stopFallback();                 // cue mode wins; stop scraping

    // Sort the original json3 cue timeline before assigning lexical coordinates.
    const nextCueList = sanitizeCueList(data.cues);
    if (!nextCueList) { onNoCues(data); return; }
    nextCueList.sort((a, b) => a.start - b.start);
    computeCueEnds(nextCueList);

    const nextVideoId = data.videoId || currentVideoId;
    const nextTrackKind = data.trackKind === "asr" ? "asr"
                        : data.trackKind ? "manual" : "";
    const nextSourceLang = typeof data.sourceLang === "string" &&
      /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(data.sourceLang)
      ? data.sourceLang.slice(0, 24) : "";
    const nextSignature = cueTrackFingerprint(
      nextVideoId, nextTrackKind, nextSourceLang, nextCueList
    );
    if (cueTimer && cueVideoId === nextVideoId && cueTrackSignature === nextSignature) {
      duplicateCueEvents++;
      if (duplicateCueEvents === 1 || duplicateCueEvents % 25 === 0) {
        emitDebug("cues-duplicate-ignored", {
          cueCount: nextCueList.length,
          duplicateCount: duplicateCueEvents
        });
      }
      return;
    }

    duplicateCueEvents = 0;
    cueTrackSignature = nextSignature;
    cueList = nextCueList;
    cueVideoId = nextVideoId;
    cueTrackKind = nextTrackKind;
    cueSourceLang = nextSourceLang;
    lastDebugCueIdx = -1;

    if (!cueList.length) { onNoCues(data); return; }
    buildHybridCueGroups(cueList);
    emitDebug("cues-loaded", {
      cueCount: cueList.length,
      trackKind: cueTrackKind,
      sourceLang: cueSourceLang,
      groupCount: sentGroups ? sentGroups.length : 0,
      batchCount: deepseekBatchWindows.length,
      regionCount: deepseekCommitRegions.length,
      firstCueStartMs: cueList.length ? cueList[0].start : 0,
      lastCueEndMs: cueList.length ? cueList[cueList.length - 1].end : 0,
      sourceChars: cueList.reduce((sum, cue) => sum + String(cue.text || "").length, 0)
    });
    startCueLoop();
  }

  // =========================================================================
  // FALLBACK MODE (v1 rendered-scrape)
  // =========================================================================
  function cancelFallbackRequest() {
    if (!fallbackRequestId) return;
    sendRuntimeMessage({
      type: "cancelDeepSeekRequest",
      videoId: currentVideoId,
      requestId: fallbackRequestId
    });
    fallbackRequestId = "";
  }

  function scheduleTranslate(text) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (text !== lastSource) return;        // caption already moved on
      if (text === lastTransSource) return;   // identical text already shown
      const token = ++lastReqToken;
      cancelFallbackRequest();
      const requestId = `fallback:${token}`;
      fallbackRequestId = requestId;
      sendRuntimeMessage(
        {
          type: "translateBatch",
          requestId,
          videoId: currentVideoId,
          targetLang: settings.targetLang,
          sourceLang: cueSourceLang,
          urgent: true,
          focusGeneration: deepseekFocusGeneration,
          items: [{ id: "0", cueId: "0", text, startMs: 0, endMs: 1000, hardAfter: true }],
          contextBefore: [],
          contextAfter: []
        },
        (resp, runtimeError) => {
          if (fallbackRequestId === requestId) fallbackRequestId = "";
          if (runtimeError) return;
          if (token !== lastReqToken) return;
          if (text !== lastSource) return;
          const translated = resp && resp.ok && Array.isArray(resp.translations) &&
            resp.translations[0] && resp.translations[0].translation;
          if (translated) {
            setTranslation(translated, text);
          }
        }
      );
    }, DEBOUNCE_MS);
  }

  function fallbackTick() {
    if (!extensionContextAlive()) { stopForInvalidatedExtensionContext(); return; }
    if (!settings.enabled) return;
    const text = readNativeCaption();
    if (text === lastSource) return;
    cancelFallbackRequest();
    lastSource = text;

    if (!text) {
      if (debounceTimer) clearTimeout(debounceTimer);
      setOriginal("");
      setTranslation("", "");
      return;
    }

    stopCueRecovery();
    setOriginal(text);
    scheduleTranslate(text);
  }

  function startFallback() {
    if (pollTimer) return;
    ensureOverlay();
    pollTimer = setInterval(fallbackTick, 200);
  }

  function stopFallback() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    cancelFallbackRequest();
    lastReqToken++;
    lastSource = "";
    lastTransSource = "";
  }

  function onNoCues(data) {
    if (!data || !currentVideoId || data.videoId !== currentVideoId) return;
    if (!Number.isInteger(data.nonce) || data.nonce !== configNonce) return;
    nocuesFallback = true;
    stopCueLoop();
    cueList = null;
    sentGroups = null;
    cueToGroup = null;
    cueToGroups = null;
    deepseekBatchWindows = [];
    deepseekGroupToBatch = [];
    deepseekRequestMeta.clear();
    resetDeepseekCommitTimeline();
    activeGroupIdx = -1;
    cueTrackKind = "";
    cueSourceLang = "";
    cueTrackSignature = "";
    duplicateCueEvents = 0;
    clearPendingTimer();
    emitDebug("cues-unavailable", {
      reason: String(data.reason || "unknown"),
      detail: String(data.detail || "").slice(0, 240),
      captionButton: captionButtonDebugState()
    });
    if (settings.enabled) {
      startFallback();
      scheduleCueRecovery();
    }
  }

  // =========================================================================
  // EXPORT (SRT download)
  // =========================================================================
  // Triggered from the popup via chrome.tabs.sendMessage. We build an .srt from
  // the cue data and download it via a Blob + <a download> (no extra permission).

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "translationBatchProgress") {
      sendResponse({ ok: handleDeepseekTranslationProgress(msg) });
      return;
    }
    if (msg.type === "settingsPatch") {
      const patch = msg.patch && typeof msg.patch === "object" ? msg.patch : {};
      let needDisplayReflow = false;
      for (const [key, value] of Object.entries(patch)) {
        if (!LIVE_STYLE_KEYS.has(key)) continue;
        if (DEEPSEEK_REFLOW_KEYS.has(key) && settings[key] !== value) {
          needDisplayReflow = true;
        }
        settings[key] = value;
      }
      if (overlay) styleOverlay();
      if (needDisplayReflow) scheduleDeepseekDisplayReflow(true);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type !== "exportSrt") return;                   // not ours — ignore
    handleExport(msg.variant)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, reason: "nocues" }));
    return true;                                            // async reply
  });

  // ms -> "HH:MM:SS,mmm"
  function srtTime(ms) {
    let n = Math.round(Number(ms));
    if (!isFinite(n) || n < 0) n = 0;
    const h = Math.floor(n / 3600000);
    const m = Math.floor((n % 3600000) / 60000);
    const s = Math.floor((n % 60000) / 1000);
    const ms3 = n % 1000;
    const p = (v, w) => String(v).padStart(w, "0");
    return p(h, 2) + ":" + p(m, 2) + ":" + p(s, 2) + "," + p(ms3, 3);
  }

  // Build SRT text from start-sorted cues (ends computed). Returns {text,count}.
  // "orig" | "trans" | "bi"; bilingual line order follows the user's order pref.
  function buildSrt(cues, variant) {
    const out = [];
    let n = 0;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      let body;
      if (variant === "orig") {
        body = (c.text || "").trim();
      } else if (variant === "trans") {
        body = (c.trans || "").trim();
      } else {
        const o = (c.text || "").trim();
        const tr = (c.trans || "").trim();
        const top = settings.order === "trans-top" ? tr : o;
        const bottom = settings.order === "trans-top" ? o : tr;
        body = [top, bottom].filter(Boolean).join("\n");
      }
      if (!body) continue;
      n++;
      let end = (c.end != null)
        ? c.end
        : c.start + (c.dur > 0 ? c.dur : ZERO_DUR_FLOOR_MS);
      // Trim overlap: auto-generated (ASR) tracks use rolling cues whose windows
      // overlap the next one, so a strict player would show two lines at once.
      // Clamp each end to the next cue's start. Manual tracks don't overlap, so
      // this leaves them untouched. (cues is start-sorted; the next array item is
      // the right boundary even if it was skipped above for an empty body.)
      const next = cues[i + 1];
      if (next && next.start > c.start && end > next.start) end = next.start;
      out.push(String(n), srtTime(c.start) + " --> " + srtTime(end), body, "");
    }
    return { text: out.join("\n"), count: n };
  }

  function videoTitle() {
    const el = document.querySelector(
      "h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string"
    );
    if (el && el.textContent.trim()) return el.textContent.trim();
    return (document.title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim();
  }

  function srtFilename(variant) {
    const vid = cueVideoId || currentVideoId || "";
    let title = videoTitle() || vid || "youtube";
    title = title.replace(/[\\/:*?"<>|\n\r\t]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
    const tag = variant === "orig" ? "orig"
              : variant === "trans" ? settings.targetLang
              : settings.targetLang + "+orig";
    return title + (vid ? " [" + vid + "]" : "") + "." + tag + ".srt";
  }

  function triggerDownload(text, filename) {
    try {
      // Prepend a BOM so editors/players detect UTF-8 (matters for CJK text).
      const blob = new Blob(["\ufeff" + text], { type: "application/x-subrip;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(url); a.remove(); } catch (_e) { /* ignore */ } }, 2000);
      return true;
    } catch (_e) {
      return false;
    }
  }

  function fullyCachedDeepSeekCues() {
    if (!cueList || !cueToGroup ||
        cueToGroup.length !== cueList.length) return null;
    const out = [];
    let current = null;
    for (let i = 0; i < cueList.length; i++) {
      const group = cueToGroup[i];
      const key = Number.isInteger(group) ? groupKey(group) : "";
      const translation = key ? transCache.get(key) : "";
      const unitId = key ? deepseekUnitCache.get(key) : "";
      if (!translation || !unitId) return null;
      if (!current || current.unitId !== unitId) {
        current = {
          unitId,
          start: cueList[i].start,
          end: cueList[i].end,
          dur: Math.max(0, cueList[i].end - cueList[i].start),
          parts: [cueList[i]],
          trans: translation
        };
        out.push(current);
      } else {
        current.parts.push(cueList[i]);
        current.end = Math.max(current.end, cueList[i].end);
        current.dur = Math.max(0, current.end - current.start);
      }
    }
    return out.map((unit) => ({
      start: unit.start,
      end: unit.end,
      dur: unit.dur,
      text: mergeCueTexts(unit.parts),
      trans: unit.trans
    }));
  }

  // Main export entry. Returns a serializable result for the popup:
  //   { ok:true, count, variant } | { ok:false, reason:"nocues"|"notrans" }
  async function handleExport(variant) {
    const v = (variant === "orig" || variant === "trans") ? variant : "bi";

    // ORIGINAL: the live cue list already holds the full original track.
    if (v === "orig") {
      if (!cueList || !cueList.length) return { ok: false, reason: "nocues" };
      const built = buildSrt(cueList, "orig");
      if (!built.count) return { ok: false, reason: "nocues" };
      return triggerDownload(built.text, srtFilename("orig"))
        ? { ok: true, count: built.count, variant: "orig", source: "original" }
        : { ok: false, reason: "nocues" };
    }

    // TRANSLATION / BILINGUAL.
    const cues = fullyCachedDeepSeekCues();

    if (!cues || !cues.length) return { ok: false, reason: "nocues" };
    if (!cues.some((c) => c.trans)) return { ok: false, reason: "notrans" };

    const built = buildSrt(cues, v);
    if (!built.count) return { ok: false, reason: "notrans" };
    return triggerDownload(built.text, srtFilename(v))
      ? { ok: true, count: built.count, variant: v, source: "ai" }
      : { ok: false, reason: "notrans" };
  }

  // =========================================================================
  // BRIDGE <- inject.js
  // =========================================================================
  const INJECT_DIAGNOSTIC_EVENTS = new Set([
    "bridge-config-received",
    "timedtext-captured",
    "cue-fetch-start",
    "cue-fetch-success",
    "cue-fetch-empty",
    "cue-fetch-error",
    "timedtext-watchdog-expired"
  ]);

  function onInjectMessage(evt) {
    if (evt.source !== window) return;
    if (evt.origin !== location.origin) return;
    const d = evt.data;
    if (!d || d.source !== "ytds-inject") return;
    if (d.type === "diagnostic") {
      if (d.videoId !== currentVideoId || !settings.enabled ||
          !INJECT_DIAGNOSTIC_EVENTS.has(d.event)) return;
      emitDebug(`inject-${d.event}`, Object.assign({
        messageNonce: Number(d.nonce) || 0,
        currentNonce: configNonce,
        staleNonce: d.nonce !== configNonce
      }, d.data && typeof d.data === "object" ? d.data : {}));
      return;
    }
    if (!Number.isInteger(d.nonce) || d.nonce !== configNonce) return;
    if (d.videoId !== currentVideoId) return;
    if (!settings.enabled) return;

    if (d.type === "cues") onCues(d);
    else if (d.type === "nocues") onNoCues(d);
  }

  function sendConfig(reason, reuseNonce) {
    try {
      const nonce = reuseNonce && Number.isInteger(configNonce) && configNonce > 0
        ? configNonce : nextConfigNonce();
      configNonce = nonce;
      emitDebug("cue-config-sent", {
        nonce,
        reason: String(reason || "request"),
        captionButton: captionButtonDebugState()
      });
      window.postMessage({
        source: "ytds-content",
        type: "config",
        nonce
      }, location.origin);
    } catch (_e) { /* ignore */ }
  }

  // =========================================================================
  // STATE / TEARDOWN / SPA NAV
  // =========================================================================
  function teardownAll() {
    if (cueVideoId) {
      try { sendRuntimeMessage({ type: "cancelDeepSeek", videoId: cueVideoId }); }
      catch (_e) { /* worker unavailable */ }
    }
    stopCueLoop();
    stopFallback();
    removeOverlay();
    cueList = null;
    cueVideoId = "";
    activeCueIdx = -1;
    sentGroups = null;
    cueToGroup = null;
    cueToGroups = null;
    deepseekBatchWindows = [];
    deepseekGroupToBatch = [];
    deepseekRequestMeta.clear();
    resetDeepseekCommitTimeline();
    activeGroupIdx = -1;
    cueTrackKind = "";
    cueSourceLang = "";
    cueTrackSignature = "";
    duplicateCueEvents = 0;
    lastDebugCueIdx = -1;
    clearPendingTimer();
    stopCueRecovery();
    nocuesFallback = false;
    transInflight.clear();
    deepseekRetryCounts.clear();
    cueEpoch++;                       // invalidate any in-flight callbacks
  }

  function applyStateToDom(sendConfiguration) {
    document.documentElement.classList.toggle("ytds-active", !!settings.enabled);
    if (!settings.enabled) {
      teardownAll();
    } else {
      // ensure overlay exists; cue mode will fill it once cues arrive,
      // fallback fills it if we end up scraping.
      ensureOverlay();
      if (nocuesFallback) startFallback();
      if (sendConfiguration) sendConfig("state");
    }
  }

  function onNav() {
    currentVideoId = videoIdFromLocation();
    transCache.clear();
    deepseekUnitCache.clear();
    deepseekSourceCache.clear();
    deepseekAlignedChunksCache.clear();
    deepseekDisplayCache.clear();
    deepseekRequestMeta.clear();
    resetDeepseekCommitTimeline();
    semanticLayoutWidth = 0;
    weEnabledCC = false;        // fresh video — re-evaluate caption state
    teardownAll();
    if (settings.enabled) {
      ensureOverlay();
      emitDebug("cue-navigation", { videoId: currentVideoId || "" });
      sendConfig("navigation"); // ask inject.js for cues on the new video
      scheduleCueRecovery(INITIAL_CUE_RECOVERY_MS);
      syncCaptions();           // auto-turn on YouTube CC so subs actually show
    }
  }

  // single listener instances (added once; never accumulate)
  window.addEventListener("yt-navigate-finish", onNav, true);
  window.addEventListener("message", onInjectMessage, false);
  document.addEventListener("fullscreenchange", () => {
    if (overlay) styleOverlay();
    scheduleDeepseekDisplayReflow(true);
  }, false);
  window.addEventListener("resize", () => scheduleDeepseekDisplayReflow(true), false);
  if (document.fonts && typeof document.fonts.addEventListener === "function") {
    document.fonts.addEventListener("loadingdone", () => scheduleDeepseekDisplayReflow(true));
  }

  // ---- boot ----------------------------------------------------------------
  loadSettings().then(() => {
    emitDebug("content-boot", {
      enabled: !!settings.enabled,
      currentVideoId: currentVideoId || "",
      readyState: document.readyState
    });
    applyStateToDom(true);
    syncCaptions();            // auto-enable YouTube CC so subtitles show on load
    scheduleCueRecovery(INITIAL_CUE_RECOVERY_MS);
  });
})();
