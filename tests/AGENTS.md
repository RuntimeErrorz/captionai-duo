# Test expectations

- Every bug fix starts with a failing test or a reduced fixture that demonstrates
  the reported behavior. Assert the general invariant, not only one quoted phrase.
- Prefer public/pure behavior and transport/state-machine tests. Source regex
  assertions are acceptable only for architecture or forbidden-pattern guards.
- Exercise arbitrary SSE/JSONL chunk boundaries, cancellation races, overlapping
  cue timelines, stale epochs, empty/malformed provider output, and usage-only
  events where relevant.
- Use deterministic randomized/property-style loops for timeline invariants and
  include the failing seed if a generated case finds a regression.
- Lifecycle ordering tests must cover timers and callbacks on both sides of
  navigation, seek, track, and configuration invalidation. Prefer a fixed-seed
  event model over source assertions for session ownership.
- `npm run check` is the handoff gate. Do not weaken an assertion simply to make
  a new implementation pass; update it only when the documented invariant changes.
