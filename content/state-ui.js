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

// Video/track/request/display/fallback state is owned by captionSession, which
// is initialized by the next ordered content module.
const ZERO_DUR_FLOOR_MS = 1000; // min visible window for a trailing zero-dur cue
const MAX_CUE_COUNT = 50000;
const MAX_CUE_TEXT_CHARS = 4000;
const MAX_CUE_PARTS = 512;
const MAX_CUE_TOTAL_CHARS = 4000000;
const MAX_TRACK_TIME_MS = 7 * 24 * 60 * 60 * 1000;

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
const DEEPSEEK_MIN_DISPLAY_UNIT_MS = 650; // co-display imperceptibly short units from one raw cue
const DEEPSEEK_COLD_RETRY_DELAYS_MS = Object.freeze([400, 1200, 2500]);
const DEEPSEEK_RATE_RETRY_LIMIT = 6;
const PENDING_ELLIPSIS_MS = 400; // show "…" if the active group is still in flight

const DEBOUNCE_MS = 450;

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
  stopFallback();
  stopCueRecovery();
  clearPendingTimer();
  captionSession.transInflight.clear();
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
  "aiBaseUrl", "aiModel", "aiThinking", "aiExtraBodyRevision",
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
    if (settings.enabled && captionSession.activeGroupIdx >= 0) {
      deepseekRequestBatch(captionSession.activeGroupIdx, true, true);
      prefetchDeepseekBatches(captionSession.activeGroupIdx, false);
    }
  }
  if ((needRecue || needRetranslate) && settings.enabled) {
    resetCaptionSessionState("settings-change");
    if (captionSession.sentGroups && captionSession.sentGroups.length) buildDeepseekCommitRegions();
    if (captionSession.cueTimer) {
      setTranslation("", "");
    }
    // A language change refreshes configuration; model/context changes reuse cues.
    if (needRecue) sendConfig("settings-recue");
    else if (captionSession.cueList) cueTick();
    if (captionSession.nocuesFallback && captionSession.lastSource) scheduleTranslate(captionSession.lastSource);
  }
  if (enabledChanged && settings.enabled && !needRecue) {
    sendConfig("enabled");
    scheduleCueRecovery(INITIAL_CUE_RECOVERY_MS);
  }
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
        videoId: captionSession.cueVideoId || captionSession.currentVideoId || "",
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
  captionSession.nonceFallback = (captionSession.nonceFallback + 1) >>> 0;
  return captionSession.nonceFallback || 1;
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
  if (arguments.length > 1) captionSession.lastTransSource = forSource || "";
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
    captionSession.weEnabledCC = true;
  }
}

function restoreCaptionsIfWeEnabled() {
  if (!captionSession.weEnabledCC) return;
  captionSession.weEnabledCC = false;
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
  if (captionSession.cueRecoveryTimer) { clearTimeout(captionSession.cueRecoveryTimer); captionSession.cueRecoveryTimer = null; }
  captionSession.cueRecoveryAttempt = 0;
}

function forceCaptionReload() {
  const cc = document.querySelector(".ytp-subtitles-button");
  if (!cc) { ensureCaptionsOn(6); return; }
  if (cc.getAttribute("aria-pressed") === "true") {
    const wasEnabledByUs = captionSession.weEnabledCC;
    try { cc.click(); } catch (_e) { /* ignore */ }
    setTimeout(() => {
      const fresh = document.querySelector(".ytp-subtitles-button");
      if (fresh && fresh.getAttribute("aria-pressed") !== "true" &&
          fresh.getAttribute("aria-disabled") !== "true") {
        try { fresh.click(); } catch (_e) { /* ignore */ }
      }
      // A recovery cycle must not claim ownership of CC if the user had
      // already enabled it before the extension intervened.
      captionSession.weEnabledCC = wasEnabledByUs;
    }, 300);
  } else {
    ensureCaptionsOn(8);
  }
}

function scheduleCueRecovery(delayOverride) {
  if (captionSession.cueRecoveryTimer || !settings.enabled || captionSession.cueList) return;
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
    if (!settings.enabled || captionSession.cueList) { stopCueRecovery(); return; }
    captionSession.cueRecoveryAttempt++;
    emitDebug("cue-recovery-attempt", {
      attempt: captionSession.cueRecoveryAttempt,
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
    if (!captionSession.lastSource && captionSession.cueRecoveryAttempt % 2 === 0) forceCaptionReload();
    scheduleCueRecovery();
  }, delay);
}
