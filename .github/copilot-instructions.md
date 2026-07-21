# CaptionAI Duo instructions

- Start with the repository `AGENTS.md`, then read the nearest directory-specific
  `AGENTS.md` and `ARCHITECTURE.md`.
- Treat user logs and timestamps as reproduction evidence. Find the violated
  state/protocol invariant; never add phrase-, video-, or timestamp-specific fixes.
- Preserve the four Chrome execution boundaries: MAIN-world injection, isolated
  content runtime, MV3 background worker, and popup. Cross-context pure logic
  belongs in frozen `YTDS_SHARED`.
- Keep runtime modules below 900 lines and maintain deterministic manifest,
  worker, and popup load order.
- Complete connection profiles and API keys are local-only secrets. Never sync,
  log, fixture, or screenshot them.
- Validate AI/network output at boundaries. SSE and JSONL may split at arbitrary
  bytes; cancellation and timeout causes must remain distinguishable.
- Add a behavioral regression test for every fix. Prefer executable state and
  transport tests; use source regex only for architecture/forbidden-pattern checks.
- Run focused tests while iterating and `npm run check` before handoff.
- UI/lifecycle/permission changes also require the relevant manual Chrome checks
  in `docs/VERIFIED_DEVELOPMENT.md`; report any check that was not run.
- Review the final diff for unrelated changes, compatibility clutter, duplicate
  state owners, permission growth, and secret exposure.
