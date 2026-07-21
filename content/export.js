// SRT export and runtime message handling.
"use strict";

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
  const vid = captionSession.cueVideoId || captionSession.currentVideoId || "";
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
  if (!captionSession.cueList || !captionSession.cueToGroup ||
      captionSession.cueToGroup.length !== captionSession.cueList.length) return null;
  const out = [];
  let current = null;
  for (let i = 0; i < captionSession.cueList.length; i++) {
    const group = captionSession.cueToGroup[i];
    const key = Number.isInteger(group) ? groupKey(group) : "";
    const translation = key ? captionSession.transCache.get(key) : "";
    const unitId = key ? captionSession.deepseekUnitCache.get(key) : "";
    if (!translation || !unitId) return null;
    if (!current || current.unitId !== unitId) {
      current = {
        unitId,
        start: captionSession.cueList[i].start,
        end: captionSession.cueList[i].end,
        dur: Math.max(0, captionSession.cueList[i].end - captionSession.cueList[i].start),
        parts: [captionSession.cueList[i]],
        trans: translation
      };
      out.push(current);
    } else {
      current.parts.push(captionSession.cueList[i]);
      current.end = Math.max(current.end, captionSession.cueList[i].end);
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
    if (!captionSession.cueList || !captionSession.cueList.length) return { ok: false, reason: "nocues" };
    const built = buildSrt(captionSession.cueList, "orig");
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
