// MAIN-world loader for an optional user-selected translation caption track.
// It returns raw cues only to inject.js; proof-bearing URLs stay in MAIN.
(() => {
  "use strict";
  if (window.__ytdsCaptionTranslationTrack) return;

  function normalizeSelection(value) {
    const text = String(value || "").trim().slice(0, 160);
    if (!text || text === "ai") return "ai";
    return /^[A-Za-z0-9._:-]+$/.test(text) ? text : "";
  }

  async function fetchTrack(options) {
    const opts = options && typeof options === "object" ? options : {};
    const trackId = normalizeSelection(opts.trackId);
    const sourceUrl = String(opts.sourceUrl || "");
    const isCurrent = typeof opts.isCurrent === "function" ? opts.isCurrent : () => true;
    const noCues = (reason) => {
      if (!isCurrent() || typeof opts.onNocues !== "function") return;
      opts.onNocues(String(reason || "fetch-error").slice(0, 160));
    };
    const transport = window.__ytdsCaptionTrackTransport;
    if (!trackId || trackId === "ai" || !sourceUrl || !transport) {
      noCues("source-unavailable");
      return;
    }
    try {
      const result = await transport.fetchCaptionCues(
        sourceUrl, String(opts.donorUrl || ""), opts.markInternal
      );
      const cues = result.cues;
      if (!isCurrent()) return;
      if (!cues.length) {
        noCues("timedtext empty track");
        return;
      }
      if (typeof opts.onCues === "function") opts.onCues(cues);
    } catch (error) {
      noCues(String(error && error.message || "fetch-error"));
    }
  }

  window.__ytdsCaptionTranslationTrack = Object.freeze({ normalizeSelection, fetchTrack });
})();
