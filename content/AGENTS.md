# Content runtime invariants

- Subtitle state is video- and epoch-scoped. A stale callback must never repaint
  a newer video, seek, track revision, or configuration generation.
- Every asynchronous repaint/retry captures the opaque caption-session token;
  serialized video, epoch, focus, or request fields are diagnostics and
  transport identity, not a substitute for token ownership. Route full semantic
  teardown through `resetCaptionSessionState` so caches, locks, timers, fallback,
  and remote cancellation cannot drift into separate reset paths.
- Video, track, playback, request, display, fallback, and recovery state belongs
  to `captionSession`. Do not add parallel top-level mutable state for those
  lifecycles; add an explicit property in `createCaptionSessionState` and access
  it through the owner.
- Timeline commits are monotonic and hole-free inside a hard-boundary region.
  Overlapping YouTube cues are input data, not permission to duplicate, skip, or
  prematurely reveal semantic coordinates.
- DeepSeek/Gemini decides semantic sentence boundaries. Never encode a known
  phrase, name, abbreviation, language word list, timestamp, or video ID to fix
  segmentation or pagination.
- Display pagination may change presentation only. It must not mutate semantic
  units, translations, request coverage, or cache identity.
- Loading state must be observable: an active untranslated cue is either backed
  by a live/retryable request or displays a loading/error state.
- Diagnostic events use the versioned `state-transition` protocol and include
  only serialized session identity. Never expose the opaque ownership token.
- Bug fixes derived from playback logs need a reduced behavioral fixture in the
  closest semantic, playback, display, or track-stability test.
