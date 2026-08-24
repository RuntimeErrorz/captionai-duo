# Test expectations

- Every runtime, data-flow, lifecycle, or interaction bug fix starts with a
  failing test or a reduced fixture that demonstrates the reported behavior.
  Assert the general invariant, not only one quoted phrase. Purely visual CSS
  changes do not need a test; verify them with a focused popup smoke check.
- Prefer public/pure behavior and transport/state-machine tests. Source regex
  assertions are acceptable for architecture, forbidden-pattern guards, and
  stable popup DOM/i18n contracts. Do not assert exact font sizes, padding,
  colors, radii, arrow offsets, or other presentation details in regression tests.
- Exercise arbitrary SSE/JSONL chunk boundaries, cancellation races, overlapping
  cue timelines, stale epochs, empty/malformed provider output, and usage-only
  events where relevant.
- Use deterministic randomized/property-style loops for timeline invariants and
  include the failing seed if a generated case finds a regression.
- Lifecycle ordering tests must cover timers and callbacks on both sides of
  navigation, seek, track, and configuration invalidation. Prefer a fixed-seed
  event model over source assertions for session ownership.
- `npm run check` is the handoff gate for runtime or behavioral changes. For a
  CSS-only change, run the architecture check and the focused popup smoke check.
  Do not weaken an assertion simply to make a new implementation pass; update
  it only when the documented invariant changes.
