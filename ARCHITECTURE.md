# Runtime architecture

This extension uses ordered classic scripts instead of a bundler. Chrome MV3
does not require one large file: every execution world loads the files listed
in `manifest.json` in order, and the service worker loads its modules through
`background.js`.

## Module boundaries

- `shared/` contains pure, cross-context helpers, including the mandatory
  diagnostic redaction boundary. `shared/youtube-url.js` loads first and
  creates the module registry; `shared.js` is the final API assembler and
  exposes the frozen `YTDS_SHARED` object. Registry keys starting with `__`
  pass helpers between shared modules only and never reach `YTDS_SHARED`.
- The MAIN world shares the page's JavaScript realm, so it loads only
  `MAIN_SHARED_FILES` (`shared/youtube-url.js` and `shared.js`). The
  architecture check fails if `inject/*` uses a `YTDS_SHARED` member that set
  does not provide.
- `content/` contains the isolated-world subtitle runtime: UI state, the explicit
  `captionSession` owner for video/track/playback/request/display/fallback state,
  its opaque identity and reset boundary, versioned diagnostics, semantic
  request/retry ownership (`semantic-requests.js`), batch-result commit and
  retry (`semantic-results.js`), semantic translation, export, bridge, and
  lifecycle.
- `background/` contains service-worker state, Chromium network diagnostics,
  HTTP transport, translation, and message routing. `background.js` only
  declares their deterministic order. Network diagnostics observe only
  extension-initiated requests (`tabId: -1`).
- `inject/caption-tracks.js` catalogs the current video's YouTube caption
  tracks in the MAIN world while keeping proof-bearing URLs private.
- `inject/track-transport.js` fetches and parses proof-bearing json3 tracks in
  the MAIN world for both the source and an optional manual translation track.
- `inject/translation-track.js` owns the optional manual translation-track
  loader and its selection validation in the MAIN world.
- `inject/network-hooks.js` installs XHR, fetch, and Resource Timing observation
  hooks in the MAIN world.
- `inject.js` is the MAIN-world timedtext interceptor and caption source loader.
- `popup/` contains local connection-profile/configuration logic and the AI
  connection controls (`ai-controls.js`), including per-origin host-permission
  requests; `popup.js` is the remaining popup controller.

## Permissions

Only `https://api.deepseek.com/*` is a required host permission. Every other
API origin comes from `optional_host_permissions` and is requested for exactly
that origin from the popup. The worker refuses to send a request without the
grant (`AI_HOST_PERMISSION_MISSING`) and bumps `aiExtraBodyRevision` on
`permissions.onAdded`, so open video tabs retry after a grant.

Runtime modules deliberately share classic-script lexical state only inside
their Chrome execution world. Shared cross-world logic must go through the
immutable `YTDS_SHARED` API.

## Verification

Run `npm run check`. It verifies:

1. every runtime module exists and parses;
2. ordered content/background modules compile together without duplicate
   declarations or broken function boundaries;
3. manifest, popup, and worker loading orders match their declared module
   lists;
4. no runtime file exceeds 900 lines;
5. the shared API still assembles and remains frozen;
6. the complete behavioral regression suite passes.
7. repository agent instructions, CI, bug/PR evidence templates, and the verified
   development guide remain present and wired to the same check command.

See `docs/VERIFIED_DEVELOPMENT.md` for the required reproduce/verify/review loop
and the manual Chrome checks for changes that cross the browser boundary.
