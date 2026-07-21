# CaptionAI Duo agent map

This repository is a Chrome MV3 extension for semantic, bilingual YouTube
captions. Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing runtime load
order or moving code across execution worlds.

## Required loop

1. Inspect the current worktree and preserve unrelated user changes.
2. Turn the request or log into explicit acceptance criteria and a reproducible
   failure before editing. For a bug, identify the violated invariant—not just
   the example phrase or timestamp.
3. Implement the smallest coherent root-cause fix. Do not add phrase-specific,
   video-specific, timestamp-specific, or provider-hostname exceptions when a
   protocol or state invariant can express the behavior.
4. Add a behavioral regression test. Prefer executable state/transport tests
   over source-text assertions; use randomized invariant tests for timelines.
5. Run the nearest test while iterating, then run `npm run check` before handoff.
6. Review the final diff for secret leakage, permission growth, stale compatibility
   paths, duplicated state transitions, and changes unrelated to the request.

## Repository rules

- `shared/` is pure cross-context logic exposed only through frozen
  `YTDS_SHARED`; `content/`, `background/`, and `popup/` are separate Chrome
  execution worlds.
- Keep every runtime file below 900 lines. Update the declared ordered module
  lists and architecture checks whenever a runtime file is added or moved.
- API keys and complete connection profiles stay in `chrome.storage.local` and
  must never enter sync storage, logs, thrown errors, fixtures, or screenshots.
- Treat network/model output as untrusted. Validate structure at boundaries and
  preserve the underlying Chromium/network error in diagnostics.
- Do not add speculative old/new protocol compatibility. Add compatibility only
  for a documented, currently supported provider contract and cover it with a
  fixture.
- A change is not complete solely because unit tests pass. UI, extension
  lifecycle, permission, or first-load changes also require the manual Chrome
  smoke checks in [docs/VERIFIED_DEVELOPMENT.md](docs/VERIFIED_DEVELOPMENT.md).
- Use [docs/VIBE_CODING_WITH_CODEX.md](docs/VIBE_CODING_WITH_CODEX.md) as the
  human-facing operating manual for planning, steering, reviewing, and
  integrating Codex-assisted changes.

More specific instructions live in `content/AGENTS.md`, `background/AGENTS.md`,
`popup/AGENTS.md`, and `tests/AGENTS.md`.
