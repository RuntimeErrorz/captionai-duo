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
  request/retry ownership (`semantic-requests.js`: the only writer of
  request owners and retry holds), batch-result commit and
  retry (`semantic-results.js`), commit-lane lookahead and request-limited
  region spans (`semantic-lookahead.js`), semantic translation, the per-video
  translation ledger (`translation-ledger.js`), export, bridge, and lifecycle.

## Translation pipeline invariants

- **Request ownership.** `semanticRequestMeta` holds live request owners;
  `transInflight` is every owner key plus retry holds. Only the ownership
  functions at the top of `content/semantic-requests.js` change them, and a
  retry hold is a token only its own timer can release.
- **Seeks keep wanted work.** A seek keeps the commit writer covering the new
  target and every lookahead lane that runs from its region's cursor within
  reach, and drops all demand left by the previous focus.
- **One scheduling policy.** No provider, RPM threshold or playback-speed
  tier selects behavior. Every lane uses the request-items setting (cap
  320); lookahead depth and speculative lanes are round(rate + 1); the
  semantic runway is 224 items at every speed; seek backtrack is 64 / rate;
  a visible writer is rebuilt 48 items behind after 14 s (4 s after
  progress); connect deadlines start at 20 s and follow measured first
  bytes. Each value won a simulated matrix against the tiers it replaced
  (docs/VERIFIED_DEVELOPMENT.md).
- **Commit lanes change through transitions.** Each region's lane (cursor,
  commit floor, limit, demand, lookahead, window) changes only through the
  `YTDS_SHARED.commitState*` transitions in `shared/cues.js`; a test forbids
  direct assignment in `content/`, and the simulator checks
  `commitStateViolations` for every lane at every step.
- **RPM is a window budget.** At most RPM requests start in any 63 s window
  (60 s plus 5%), with 250 ms between starts. Visible requests go first in
  the queue; a separate reserve for them was measured (8-60 RPM) and changed
  nothing, so there is none.
- **Prefetch runs only from lane cursors.** Lookahead advances each region's
  commit lane from its cursor; there are no mid-sentence speculative windows
  and no bridge windows sized to reach them (simulated: removing both cut
  requests 1-2% and stall 0.4-2.4%).
- **Blocks start at sentences.** A recovered alignment chunk carries its
  sentence start, so a committed block never opens mid-sentence.

- **Output protocol.** Every provider gets the same prompt: one JSONL line
  per sentence, each chunk `[start,end,"translation"]`. The parser also
  tolerates end-only `[end,"translation"]` chunks (start implied by the
  previous chunk) and accepts closed sentences while their line is still
  streaming. End-only prompting was benchmarked and showed no significant
  difference, so the prompt stays provider-independent.
- **Stuck is measured, not timed.** `YTDS_SHARED.schedule*` (shared/schedule.js)
  decides when a writer is stuck from the provider's measured latency per
  endpoint and model: first streamed progress and committed items per
  second, sampled only from streamed progress (a cache hit or adopted
  prefetch arrives at once). A writer is replaced only when stuck; distance
  behind playback alone never restarts it, since a restart pays a fresh
  first byte. The background's whole-request deadline follows the same rule
  over complete responses.
- **Pauses are relative to the video.** `semanticPauseThresholds` raises the
  900 ms / 4000 ms soft and hard floors for a video whose routine pauses are
  long, so a slow speaker's ordinary pauses never become hard boundaries.
- **A one-word sentence overrun is trimmed by shape.** Models often end a
  chunk on the next sentence's opening word (15-17% of chunks in real Gemini
  replays; uncorrected, the judged segmentation fell from 4.98 to 4.18). The
  parser moves that word to the next unit when the item before it closes a
  sentence and it opens a capitalized word, unless the closing token is
  abbreviation-shaped (a capital plus at most two letters, or initials). No
  word list is used.
- **Chunks tile exactly; a lost count is never healed.** A chunk that starts
  inside the previous one, or whose translation opens with clause
  punctuation (`，`, `、`, `;`, ...), shows the model's positions drifted from
  its text. Neither it nor the chunk before it is committed: the safe prefix
  ends before both, a still-provisional unit is taken back, and the next
  request resumes there. Measured on a real Gemini replay: 2 such drifts in
  11 requests, each of which had committed text into the wrong sentence.
- **Window decision.** `YTDS_SHARED.semanticCommitWindowPlan` decides each
  commit-lane request window from plain numbers. The content scheduler, the
  deterministic simulator (`tests/sim/`) and the tests all run it, so a
  scheduling change is measured exactly as it ships.
- **Ledger.** Committed units are stored per video in `chrome.storage.local`
  under a key covering the caption track, target language, provider, model,
  extra parameters, context sizes and `AI_PROMPT_CACHE_VERSION`. A unit is
  reused only if its source text still matches. Requests wait for the ledger
  to load (at most 1.5 s), and a commit lane skips committed blocks instead of
  stopping at them. At most 60 videos / ~4 MB are kept, least recently
  written first out.
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

`https://*/*` is declared in `host_permissions` so any HTTPS API domain can be
accessed without extra permission prompts. Local API origins (`localhost` and
`127.0.0.1`) come from `optional_host_permissions` and can be requested for exactly
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
6. the complete behavioral regression suite passes, including the
   deterministic simulation of the real runtime (`tests/sim/`, see
   `docs/VERIFIED_DEVELOPMENT.md`).
7. repository agent instructions, CI, bug/PR evidence templates, and the verified
   development guide remain present and wired to the same check command.

See `docs/VERIFIED_DEVELOPMENT.md` for the required reproduce/verify/review loop
and the manual Chrome checks for changes that cross the browser boundary.
