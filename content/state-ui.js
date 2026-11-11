// Content runtime state, settings, overlay and caption recovery.
"use strict";

if (window.__ytdsContentLoaded) {
  throw new Error("CaptionAI content runtime was injected twice");
}
window.__ytdsContentLoaded = true;

// ---- i18n ----------------------------------------------------------------
// Safe wrapper around chrome.i18n.getMessage: returns the localized string,
// or the supplied fallback if i18n is unavailable / the key is missing, so
// nothing breaks if a message is absent.
function t(k, fb) {
  try {
    const message = chrome.i18n && chrome.i18n.getMessage(k);
    if (message) return message;
  } catch (_e) { /* extension context may be invalidated after a reload */ }
  return fb;
}

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
let panelEl = null;
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

// Video/track/request/display/recovery state is owned by captionSession, which
// is initialized by the next ordered content module.
const ZERO_DUR_FLOOR_MS = 1000; // min visible window for a trailing zero-dur cue
const MAX_CUE_COUNT = 50000;
const MAX_CUE_TEXT_CHARS = 4000;
const MAX_CUE_PARTS = 512;
const MAX_CUE_TOTAL_CHARS = 4000000;
const MAX_TRACK_TIME_MS = 7 * 24 * 60 * 60 * 1000;

const SEMANTIC_CORE_ITEMS = 32; // UI/prefetch scope only; never a semantic boundary
const AI_CORE_ITEMS = SEMANTIC_CORE_ITEMS;
const AI_MAX_REQUEST_ITEMS = 320; // every lane's cap; the window grows toward it
const AI_MAX_CURRENT_CHARS = 18000; // bound source payload independently of item count
const SEMANTIC_COMMIT_GUARD_ITEMS = 16; // always-carried trailing safety area
const AI_COMMIT_GUARD_ITEMS = SEMANTIC_COMMIT_GUARD_ITEMS;
const SEMANTIC_MIN_COMMIT_RUNWAY_ITEMS = 32; // minimum unresolved context after a committed prefix
const AI_MIN_COMMIT_RUNWAY_ITEMS = SEMANTIC_MIN_COMMIT_RUNWAY_ITEMS;
const AI_URGENT_TARGET_TAIL_ITEMS = 224; // semantic runway after the visible target, at every speed
const AI_SEEK_BACKTRACK_ITEMS = 64; // read-only lead-in that fits the urgent cap
const AI_SEEK_LEFT_GUARD_ITEMS = 16; // never commit units touching a seek edge
const AI_SEEK_SETTLE_MS = 140; // wait for seeked or a short idle before requesting
const AI_MAX_PREFETCH_BATCHES = 12;
const AI_CONTEXT_GROUPS = 20; // surrounding original cues, never lexical tokens
const SEMANTIC_SOFT_PAUSE_MS = 900; // timing hint only; the model may cross it
const AI_SOFT_PAUSE_MS = SEMANTIC_SOFT_PAUSE_MS;
const SEMANTIC_HARD_PAUSE_MS = 4000; // true discontinuity; semantic units may not cross
const AI_HARD_PAUSE_MS = SEMANTIC_HARD_PAUSE_MS;
const SEMANTIC_MIN_DISPLAY_UNIT_MS = 650; // co-display imperceptibly short units from one raw cue
const AI_MIN_DISPLAY_UNIT_MS = SEMANTIC_MIN_DISPLAY_UNIT_MS;
const AI_COLD_RETRY_DELAYS_MS = Object.freeze([400, 1200, 2500]);
const AI_RATE_RETRY_LIMIT = 6;
const PENDING_ELLIPSIS_MS = 400; // show "…" if the active group is still in flight

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
  invalidateCaptionSession("extension-context-invalid");
  stopCueLoop();
  stopCueRecovery();
  clearPendingTimer();
  captionSession.semanticRequestMeta.clear();
  captionSession.transInflight.clear();
  if (captionSession.semanticRequestHolds) captionSession.semanticRequestHolds.clear();
  document.documentElement.classList.remove("ytds-active");
  stopPlayerToggle();
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
      settings.targetLang = YTDS_SHARED.normalizeTargetLang(settings.targetLang);
      settings.aiContextPast =
        YTDS_SHARED.normalizeAiContextCount(settings.aiContextPast, 1);
      settings.aiContextFuture =
        YTDS_SHARED.normalizeAiContextCount(settings.aiContextFuture, 1);
      settings.aiPrefetchBatches =
        YTDS_SHARED.normalizeAiPrefetchBatches(settings.aiPrefetchBatches);
      settings.aiRequestItems =
        YTDS_SHARED.normalizeAiRequestItems(settings.aiRequestItems, 96);
      settings.aiRateLimitRpm =
        YTDS_SHARED.normalizeAiRateLimitRpm(settings.aiRateLimitRpm, 0);
      settings.aiMaxConcurrency =
        YTDS_SHARED.normalizeAiMaxConcurrency(settings.aiMaxConcurrency, 4);
      resolve();
    });
  });
}

// A language change alters the requested translation but can reuse the cues.
const RECUE_KEYS = new Set(["targetLang"]);
const AI_RETRANSLATE_KEYS = new Set([
  "aiBaseUrl", "aiModel", "aiExtraBodyRevision",
  "aiContextPast", "aiContextFuture"
]);
const LIVE_STYLE_KEYS = new Set([
  "order", "rowGap", "position", "posMode", "posXpct", "posYpct",
  "showOriginal", "origFont", "origSize", "origFullscreenSize", "origColor", "origBg",
  "origBgOpacity", "origStroke", "origStrokeOpacity", "origStrokeWidth",
  "showTranslation", "transFont", "transSize", "transFullscreenSize", "transColor", "transBg",
  "transBgOpacity", "transStroke", "transStrokeOpacity", "transStrokeWidth"
]);
const AI_REFLOW_KEYS = new Set([
  "showOriginal", "showTranslation",
  "origFont", "origSize", "origFullscreenSize",
  "transFont", "transSize", "transFullscreenSize"
]);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  let needRecue = false;
  let needRetranslate = false;
  let needDisplayReflow = false;
  // Scheduling settings never invalidate in-flight work: its translations stay
  // correct. Only a shorter lookahead reach makes speculative requests surplus.
  let prefetchChanged = false;
  let lookaheadShrank = false;
  for (const k of Object.keys(changes)) {
    if (k in settings) {
      const oldV = settings[k];
      settings[k] = changes[k].newValue;
      if (k === "targetLang") settings.targetLang = YTDS_SHARED.normalizeTargetLang(settings.targetLang);
      if (k === "aiPrefetchBatches") {
        settings.aiPrefetchBatches =
          YTDS_SHARED.normalizeAiPrefetchBatches(settings.aiPrefetchBatches);
        prefetchChanged = oldV !== settings.aiPrefetchBatches;
        lookaheadShrank = settings.aiPrefetchBatches < Number(oldV);
      }
      if (k === "aiRequestItems") {
        settings.aiRequestItems =
          YTDS_SHARED.normalizeAiRequestItems(settings.aiRequestItems, 96);
        prefetchChanged = prefetchChanged || oldV !== settings.aiRequestItems;
      }
      if (k === "aiRateLimitRpm") {
        settings.aiRateLimitRpm =
          YTDS_SHARED.normalizeAiRateLimitRpm(settings.aiRateLimitRpm, 0);
        prefetchChanged = prefetchChanged || oldV !== settings.aiRateLimitRpm;
      }
      if (k === "aiMaxConcurrency") {
        settings.aiMaxConcurrency =
          YTDS_SHARED.normalizeAiMaxConcurrency(settings.aiMaxConcurrency, 4);
        prefetchChanged = prefetchChanged || oldV !== settings.aiMaxConcurrency;
      }
      if (RECUE_KEYS.has(k) && oldV !== settings[k]) {
        needRecue = true;
      }
      if (AI_RETRANSLATE_KEYS.has(k) && oldV !== settings[k]) {
        needRetranslate = true;
      }
      if (AI_REFLOW_KEYS.has(k) && oldV !== settings[k]) {
        needDisplayReflow = true;
      }
    }
  }
  const enabledChanged = Object.prototype.hasOwnProperty.call(changes, "enabled");
  applyStateToDom(false);
  syncPlayerToggle();
  if (overlay) styleOverlay();   // position/fonts/colors/bg/stroke/sizes apply live
  if (needDisplayReflow) scheduleAiDisplayReflow(true);
  if (enabledChanged) syncCaptions();   // master switch flipped from popup
  if (prefetchChanged) {
    if (lookaheadShrank) cancelAiPrefetchRequests();
    if (settings.enabled && captionSession.activeGroupIdx >= 0) {
      aiRequestBatch(captionSession.activeGroupIdx, true, true);
      prefetchAiBatches(captionSession.activeGroupIdx, false);
    }
  }
  if ((needRecue || needRetranslate) && settings.enabled) {
    resetCaptionSessionState("settings-change");
    if (captionSession.sentGroups && captionSession.sentGroups.length) {
      buildAiCommitRegions();
      if (!needRecue && typeof loadAiTranslationLedger === "function") loadAiTranslationLedger();
    }
    if (captionSession.cueTimer) {
      setTranslation("", "");
    }
    // A language change refreshes configuration; model/context changes reuse cues.
    if (needRecue) sendConfig("settings-recue");
    else if (captionSession.cueList) cueTick();
  }
  if (enabledChanged && settings.enabled && !needRecue) {
    sendConfig("enabled");
    scheduleCueRecovery(INITIAL_CUE_RECOVERY_MS);
  }
});

// ---- generic helpers -----------------------------------------------------
function videoIdFromLocation() {
  return YTDS_SHARED.videoIdFromUrl(location.href);
}

function nextConfigNonce() {
  try {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    if (value[0]) return value[0];
  } catch (_e) { /* very old/locked-down runtime */ }
  captionSession.nonceFallback = (captionSession.nonceFallback + 1) >>> 0;
  return captionSession.nonceFallback || 1;
}

function getPlayer() {
  return document.querySelector("#movie_player") ||
         document.querySelector(".html5-video-player");
}

function isPlayerFullscreen() {
  const player = getPlayer();
  return YTDS_SHARED.resolveFullscreenState(
    "fullscreenElement" in document,
    document.fullscreenElement,
    !!(player && player.classList.contains("ytp-fullscreen"))
  );
}

function getVideo() {
  const p = getPlayer();
  return (p && p.querySelector("video")) ||
         document.querySelector("video.html5-main-video") ||
         document.querySelector("video");
}

// ---- overlay -------------------------------------------------------------
function ensureOverlay() {
  const player = getPlayer();
  if (!player) return null;
  if (overlay && overlay.isConnected) return overlay;

  overlay = document.createElement("div");
  overlay.id = "ytds-overlay";
  panelEl = document.createElement("div");
  panelEl.className = "ytds-panel";
  transEl = document.createElement("div");
  transEl.className = "ytds-line ytds-trans";
  origEl = document.createElement("div");
  origEl.className = "ytds-line ytds-orig";

  panelEl.appendChild(transEl);
  panelEl.appendChild(origEl);
  overlay.appendChild(panelEl);
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
  panelEl.style.gap = rowGap + "px";
  if (settings.order === "trans-top") {
    overlay.classList.add("ytds-trans-top");
    overlay.classList.remove("ytds-orig-top");
  } else {
    overlay.classList.add("ytds-orig-top");
    overlay.classList.remove("ytds-trans-top");
  }

  // original line
  origEl.style.fontFamily = fontStack(settings.origFont);
  const fullscreen = isPlayerFullscreen();
  origEl.style.fontSize = (fullscreen ? settings.origFullscreenSize : settings.origSize) + "px";
  origEl.style.color = settings.origColor;
  const origBg = rgba(settings.origBg, settings.origBgOpacity);
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
  transEl.style.setProperty("--ytds-line-bg", transBg);
  transEl.style.textShadow = "none";
  transEl.style.webkitTextStroke = outlineStyle(
    settings.transStroke, settings.transStrokeOpacity, settings.transStrokeWidth
  );
  transEl.style.paintOrder = "stroke";

  const sharedBg = origBg === transBg;
  origEl.style.backgroundColor = sharedBg ? "" : origBg;
  transEl.style.backgroundColor = sharedBg ? "" : transBg;

  // per-line visibility
  origEl.style.display = settings.showOriginal ? "" : "none";
  transEl.style.display = settings.showTranslation ? "" : "none";
  panelEl.style.backgroundColor = "";
  panelEl.style.setProperty("--ytds-shared-bg", sharedBg ? origBg : "");
  overlay.classList.toggle("ytds-shared-bg", sharedBg);

  applyPosition();
  updateEmptyState();
}

function removeOverlay() {
  if (dragSaveTimer) { clearTimeout(dragSaveTimer); dragSaveTimer = null; }
  if (captionSession.semanticResizeObserver) {
    captionSession.semanticResizeObserver.disconnect();
    captionSession.semanticResizeObserver = null;
  }
  if (captionSession.semanticReflowFrame != null) {
    cancelAnimationFrame(captionSession.semanticReflowFrame);
    captionSession.semanticReflowFrame = null;
  }
  dragging = false;
  if (overlay) { overlay.remove(); overlay = null; } // removes handle + its listeners
  panelEl = null;
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
        const durationMs = Number(rawPart && rawPart.durationMs);
        if (Number.isFinite(durationMs) && durationMs >= 0 &&
            durationMs <= Math.max(dur, 60 * 60 * 1000)) {
          part.durationMs = durationMs;
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

function setTranslation(text, forSource, displayState) {
  if (!ensureOverlay()) return;
  const previous = transEl.textContent;
  transEl.textContent = text || "";
  transEl.classList.toggle("ytds-translation-error", displayState === "error");
  updateEmptyState();
  if (previous !== transEl.textContent) {
    emitDebug("translation-painted", {
      cueIdx: captionSession.activeCueIdx,
      groupIdx: captionSession.activeGroupIdx,
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
function captionReadinessDebugState(reason) {
  const video = getVideo();
  return {
    reason: String(reason || "unspecified"),
    documentReadyState: String(document.readyState || ""),
    playerPresent: !!getPlayer(),
    videoPresent: !!video,
    videoReadyState: video ? Number(video.readyState) : -1,
    videoNetworkState: video ? Number(video.networkState) : -1,
    videoPaused: video ? !!video.paused : true,
    videoTimeMs: video ? Math.round((Number(video.currentTime) || 0) * 1000) : 0,
    captionButton: captionButtonDebugState()
  };
}

function ensureCaptionsOn(retries, reason) {
  if (!settings.enabled) return;
  const cc = document.querySelector(".ytp-subtitles-button");
  if (!cc || cc.getAttribute("aria-pressed") === null) {
    if (retries > 0) setTimeout(() => ensureCaptionsOn(retries - 1, reason), 600);
    return;                                   // button / state not ready yet
  }
  if (cc.getAttribute("aria-disabled") === "true") {
    // Disabled is often TRANSIENT: on a cold page load YouTube keeps the CC
    // button disabled until the video's track list arrives, several seconds
    // after the button exists. Treating that as "no captions on this video"
    // made auto-enable give up on cold loads (SPA navs were fast enough to
    // never hit it). Keep retrying within the window; a video with genuinely
    // no track just lets the retries lapse — clicking never happens either way.
    if (retries > 0) setTimeout(() => ensureCaptionsOn(retries - 1, reason), 600);
    return;
  }
  if (cc.getAttribute("aria-pressed") !== "true") {
    emitDebug("caption-enable-requested", captionReadinessDebugState(reason));
    cc.click();
    captionSession.weEnabledCC = true;
  }
}

function restoreCaptionsIfWeEnabled() {
  if (!captionSession.weEnabledCC) return;
  captionSession.weEnabledCC = false;
  const cc = document.querySelector(".ytp-subtitles-button");
  if (cc && cc.getAttribute("aria-pressed") === "true") cc.click();
}

function syncCaptions(reason) {
  // 20 × 600ms ≈ 12s window: covers slow cold loads where the CC button
  // stays aria-disabled for several seconds while the track list loads.
  if (settings.enabled && captionSession.currentVideoId) ensureCaptionsOn(20, reason || "sync");
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
  if (captionSession.cueRecoveryTimer) { clearTimeout(captionSession.cueRecoveryTimer); captionSession.cueRecoveryTimer = null; }
  captionSession.cueRecoveryAttempt = 0;
}

function forceCaptionReload(reason) {
  const cc = document.querySelector(".ytp-subtitles-button");
  emitDebug("caption-reload-requested", captionReadinessDebugState(reason || "recovery"));
  if (!cc) { ensureCaptionsOn(6, reason || "recovery"); return; }
  const sessionToken = captureCaptionSession();
  const videoId = captionSession.currentVideoId;
  const initiallyEnabled = cc.getAttribute("aria-pressed") === "true";
  const ownershipAfterReload = captionSession.weEnabledCC || !initiallyEnabled;
  const cycleEnabledTrack = () => {
    if (!isCaptionSessionCurrent(sessionToken) ||
        captionSession.currentVideoId !== videoId || captionSession.cueList) return;
    const active = document.querySelector(".ytp-subtitles-button");
    if (!active || active.getAttribute("aria-pressed") !== "true") return;
    try { active.click(); } catch (_e) { return; }
    setTimeout(() => {
      if (!isCaptionSessionCurrent(sessionToken) ||
          captionSession.currentVideoId !== videoId || captionSession.cueList) return;
      const fresh = document.querySelector(".ytp-subtitles-button");
      if (fresh && fresh.getAttribute("aria-pressed") !== "true" &&
          fresh.getAttribute("aria-disabled") !== "true") {
        try { fresh.click(); } catch (_e) { /* ignore */ }
      }
      // A recovery cycle must not claim ownership of CC if the user had
      // already enabled it before the extension intervened.
      captionSession.weEnabledCC = ownershipAfterReload;
      emitDebug("caption-reload-completed",
        captionReadinessDebugState(reason || "recovery"));
    }, 300);
  };

  if (initiallyEnabled) {
    cycleEnabledTrack();
  } else {
    if (cc.getAttribute("aria-disabled") === "true") {
      ensureCaptionsOn(8, reason || "recovery");
      return;
    }
    try { cc.click(); } catch (_e) { return; }
    captionSession.weEnabledCC = true;
    // Turning CC on is not itself a reload when the failed request left the
    // button off: YouTube can reuse the same stale URL. Once the state settles,
    // perform the actual off/on cycle that rotates the track credentials.
    setTimeout(cycleEnabledTrack, 180);
  }
}

function scheduleCueRecovery(delayOverride) {
  if (captionSession.cueRecoveryTimer || !settings.enabled || captionSession.cueList || !captionSession.currentVideoId) return;
  const requestedDelay = Number(delayOverride);
  const delay = Number.isFinite(requestedDelay) && requestedDelay > 0
    ? Math.round(requestedDelay)
    : Math.min(15000, 2500 + captionSession.cueRecoveryAttempt * 1500);
  emitDebug("cue-recovery-scheduled", {
    attempt: captionSession.cueRecoveryAttempt + 1,
    delayMs: delay,
    captionButton: captionButtonDebugState()
  });
  captionSession.cueRecoveryTimer = setTimeout(() => {
    captionSession.cueRecoveryTimer = null;
    if (!settings.enabled || captionSession.cueList || !captionSession.currentVideoId) { stopCueRecovery(); return; }
    captionSession.cueRecoveryAttempt++;
    emitDebug("cue-recovery-attempt", {
      attempt: captionSession.cueRecoveryAttempt,
      captionButton: captionButtonDebugState()
    });
    ensureCaptionsOn(6, "scheduled-recovery");
    // Recovery runs only while no cue list exists, so always ask the MAIN
    // bridge to retry the current video/config.
    // Reuse the current nonce: a lost bridge message is safely replayed, while
    // an already-running slow cue fetch is not invalidated by the watchdog.
    sendConfig("recovery", true);
    // Every second failed attempt, force YouTube to issue a fresh timedtext
    // request with a new pot instead of remaining stuck on a stale URL.
    if (captionSession.cueRecoveryAttempt % 2 === 0) {
      forceCaptionReload("scheduled-recovery");
    }
    scheduleCueRecovery();
  }, delay);
}
