# Runtime architecture

This extension uses ordered classic scripts instead of a bundler. Chrome MV3
does not require one large file: every execution world loads the files listed
in `manifest.json` in order, and the service worker loads its modules through
`background.js`.

## Module boundaries

- `shared/` contains pure, cross-context helpers, including the mandatory
  diagnostic redaction boundary. `shared.js` is the final API assembler and
  exposes the frozen `YTDS_SHARED` object.
- `content/` contains the isolated-world subtitle runtime: UI state, the explicit
  `captionSession` owner for video/track/playback/request/display/fallback state,
  its opaque identity and reset boundary, versioned diagnostics, semantic
  request/retry ownership, semantic translation, export, bridge, and lifecycle.
- `background/` contains service-worker state, Chromium network diagnostics,
  HTTP transport, translation, and message routing. `background.js` only
  declares their deterministic order.
- `inject.js` is the MAIN-world timedtext interceptor.
- `popup/` contains local connection-profile/configuration logic;
  `popup.js` is the remaining popup controller.

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
