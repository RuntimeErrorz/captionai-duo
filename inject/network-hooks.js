// inject/network-hooks.js — MAIN world.
// Hooks XMLHttpRequest, fetch, and Resource Timing to observe the YouTube player's
// /api/timedtext requests without disturbing the page.
(() => {
  "use strict";
  if (window.__ytdsNetworkHooks) return;

  function install(handlers) {
    const isTimedtext = handlers && handlers.isTimedtext;
    const isInternalTimedtext = handlers && handlers.isInternalTimedtext;
    const noteTimedtext = handlers && handlers.noteTimedtext;
    const getSourceRevision = handlers && handlers.getSourceRevision;
    const consumePlayerTimedtext = handlers && handlers.consumePlayerTimedtext;
    const playerResponseUnavailable = handlers && handlers.playerResponseUnavailable;
    const trackTransport = window.__ytdsCaptionTrackTransport;

    // ---- hook XMLHttpRequest --------------------------------------------------
    try {
      const XHR = XMLHttpRequest.prototype;
      const origOpen = XHR.open;
      const origSend = XHR.send;

      XHR.open = function (method, url) {
        try {
          this.__ytdsUrl = url;
          this.__ytdsMethod = String(method || "GET").toUpperCase();
        } catch (_e) { /* ignore */ }
        return origOpen.apply(this, arguments);
      };

      XHR.send = function () {
        try {
          const url = this.__ytdsUrl;
          if (isTimedtext && isTimedtext(url) && (!isInternalTimedtext || !isInternalTimedtext(url))) {
            const method = this.__ytdsMethod || "GET";
            const startedAt = Date.now();
            const watchesPlayerResponse = noteTimedtext ? noteTimedtext(url, true, { transport: "xhr", method }) : false;
            const revision = getSourceRevision ? getSourceRevision() : 0;
            if (watchesPlayerResponse && typeof this.addEventListener === "function") {
              this.addEventListener("loadend", () => {
                try {
                  const responseMeta = {
                    transport: "xhr",
                    method,
                    status: Number(this.status) || 0,
                    contentType: typeof this.getResponseHeader === "function"
                      ? this.getResponseHeader("content-type") || "" : "",
                    elapsedMs: Date.now() - startedAt
                  };
                  const responsePromise = trackTransport && typeof trackTransport.xhrResponseText === "function"
                    ? Promise.resolve(trackTransport.xhrResponseText(this))
                    : Promise.resolve(this.responseText);
                  responsePromise.then(
                    (text) => consumePlayerTimedtext && consumePlayerTimedtext(String(url), text, revision, responseMeta),
                    () => playerResponseUnavailable && playerResponseUnavailable(String(url), revision)
                  );
                } catch (_e) {
                  if (playerResponseUnavailable) playerResponseUnavailable(String(url), revision);
                }
              }, { once: true });
            } else if (watchesPlayerResponse) {
              if (playerResponseUnavailable) playerResponseUnavailable(String(url), revision);
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
          let method = "GET";
          const startedAt = Date.now();
          try {
            if (typeof input === "string") url = input;
            else if (input && typeof input.url === "string") {
              url = input.url;
              if (input.method) method = String(input.method).toUpperCase();
            }
            if (init && init.method) method = String(init.method).toUpperCase();
            watchesPlayerResponse = noteTimedtext ? noteTimedtext(url, true, { transport: "fetch", method }) : false;
            revision = getSourceRevision ? getSourceRevision() : 0;
          } catch (_e) { /* ignore */ }
          const result = origFetch.apply(this, arguments);
          if (watchesPlayerResponse) {
            Promise.resolve(result).then((response) => {
              try {
                if (!response || typeof response.clone !== "function") {
                  if (playerResponseUnavailable) playerResponseUnavailable(String(url), revision);
                  return;
                }
                response.clone().text().then(
                  (text) => consumePlayerTimedtext && consumePlayerTimedtext(String(url), text, revision, {
                    transport: "fetch",
                    method,
                    status: Number(response.status) || 0,
                    contentType: response.headers && typeof response.headers.get === "function"
                      ? response.headers.get("content-type") || "" : "",
                    elapsedMs: Date.now() - startedAt
                  }),
                  () => playerResponseUnavailable && playerResponseUnavailable(String(url), revision)
                );
              } catch (_e) {
                if (playerResponseUnavailable) playerResponseUnavailable(String(url), revision);
              }
            }, () => {
              if (playerResponseUnavailable) playerResponseUnavailable(String(url), revision);
            });
          }
          return result;
        };
      }
    } catch (_e) { /* never throw */ }

    // ---- robust capture via Resource Timing ----------------------------------
    try {
      const scan = (entries) => {
        for (const e of entries) {
          if (e && typeof e.name === "string" && isTimedtext && isTimedtext(e.name)) {
            if (noteTimedtext) noteTimedtext(e.name, false, { transport: "resource", method: "GET" });
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
  }

  window.__ytdsNetworkHooks = Object.freeze({ install });
})();
