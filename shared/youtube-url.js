// YouTube page and timedtext URL helpers. First shared module in every world:
// it creates the module registry, and it is the only shared code the MAIN
// world (inject/*) loads, so it must stay small and dependency-free.
(() => {
  "use strict";
  if (globalThis.YTDS_SHARED) return;
  const internal = Object.create(null);
  Object.defineProperty(globalThis, "__captionAiDuoSharedModulesV1__", {
    value: internal, configurable: true, enumerable: false, writable: false
  });

  function videoIdFromUrl(href) {
    try {
      const u = new URL(href);
      const fromQuery = u.searchParams.get("v") || "";
      if (/^[A-Za-z0-9_-]{6,32}$/.test(fromQuery)) return fromQuery;
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,32})(?:\/|$)/);
      return m ? m[1] : "";
    } catch (_e) {
      return "";
    }
  }

  function isYoutubePageUrl(href) {
    try {
      const u = new URL(href);
      return u.protocol === "https:" &&
        (u.hostname === "www.youtube.com" || u.hostname === "youtube.com");
    } catch (_e) {
      return false;
    }
  }

  // Chrome may retain the document's original sender.url across a YouTube SPA
  // navigation while sender.tab.url already points at the current video.  A
  // restored/home document can also have no video id in either URL.  Accept a
  // well-formed id when at least one candidate is a trusted YouTube page.  The
  // first candidate with an id is authoritative (background passes tab.url
  // first); a restored/home URL without an id is safe to fall through.
  function videoIdMatchesPageUrls(videoId, hrefs) {
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(String(videoId || ""))) return false;
    const youtubeUrls = Array.isArray(hrefs) ? hrefs.filter(isYoutubePageUrl) : [];
    if (!youtubeUrls.length) return false;
    const currentUrlId = youtubeUrls.map(videoIdFromUrl).find(Boolean);
    return !currentUrlId || currentUrlId === videoId;
  }

  function isAllowedTimedtextUrl(value) {
    try {
      const u = new URL(value, "https://www.youtube.com/");
      return u.protocol === "https:" &&
        (u.hostname === "www.youtube.com" || u.hostname === "youtube.com") &&
        u.pathname === "/api/timedtext";
    } catch (_e) {
      return false;
    }
  }

  Object.assign(internal, {
    videoIdFromUrl, isYoutubePageUrl, videoIdMatchesPageUrls, isAllowedTimedtextUrl
  });
})();
