# Verified agentic development

The project uses a **specify → reproduce → implement → verify → review** loop.
The model can write most of the code, but the repository—not conversational
memory—is the source of truth for constraints and evidence.

For the detailed Chinese handbook, including Codex desktop/CLI shortcuts,
Plan/Goal/Review usage, context engineering, and copyable task templates, see
[VIBE_CODING_WITH_CODEX.md](VIBE_CODING_WITH_CODEX.md).

## Before editing

Write down:

- the observable current behavior;
- the expected behavior and one concrete acceptance example;
- non-goals and state that must remain unchanged;
- the execution world(s) involved: injected page, content, background, popup;
- the likely invariant, plus evidence that would disprove it.

For a runtime bug, reduce the supplied log to the smallest timeline/request
fixture that still fails. A timestamp or English phrase is evidence, never the
implementation condition.

## Implementation loop

1. Read the nearest `AGENTS.md` and trace the complete state/data path.
2. Reproduce with a focused test or documented Chrome scenario. For a pure
   popup CSS change, a documented visual scenario is sufficient; do not create
   a regression fixture for a font, spacing, color, border, or arrow-position
   adjustment.
3. Fix the invariant at its owner boundary; avoid parallel state machines and
   downstream repair heuristics.
4. Run the focused test after each meaningful behavioral edit. For CSS-only
   changes, run the architecture check and the relevant popup smoke check.
5. Run `npm run check` for runtime or behavioral changes: syntax, load order,
   module size, and all regressions.
6. Inspect `git diff --check` and the final diff. Explain the root cause, why the
   fix is general, verification evidence, and remaining risk.

## Deterministic simulation

`tests/sim/` runs the real background worker modules and the real content
runtime in separate vm contexts on one virtual clock, joined by an
asynchronous, JSON-serialized Chrome transport. A fake provider reads the real
prompt's `CURRENT_CUES`, streams the documented JSONL protocol over SSE in
arbitrary byte chunks, and injects 429/503, connect hangs, mid-stream stalls,
truncated, malformed and duplicated lines. A seeded user plays at 1-3x, seeks,
scrubs, pauses, reloads and changes settings. After every 50 ms step the
checker enforces:

- committed translations are immutable and are exactly the chunks of the true
  sentence; every committed block starts at a true sentence start;
- a painted translation is one contiguous span of the active group's region
  that reaches its sentence (no stale translation at a new position);
- busy keys are exactly live request owners plus retry holds;
- no range is re-sent within 30 ms of being cancelled, no request hot loop;
- the visible group is never left untranslated with nothing working on it;
- after a 180 s drain nothing is in flight, and the API key never appears
  outside `aiApiKeys` (transport, storage, diagnostics).

`npm run check` runs 30 seeds plus determinism and settings scenarios. For
broader search and for metrics (stall time, requests, 429s, items sent):

```sh
npm run sim:fuzz -- --seeds 300 --from 20000
npm run sim:fuzz -- --seeds 60 --from 9000 --profile limited
npm run sim:fuzz -- --seed 20035
```

Experiment flags fix one dimension: `--rpm N` (provider and setting),
`--rate R` (every play action), `--ttfb A-B` (first-byte range), and
`--profile fast|limited|slow|flaky`. A scheduling change is accepted only if
it is no worse across a matrix of RPM 0-60, fast/medium/slow/flaky providers
and 1-3x playback, on two disjoint fixed seed sets, for stall seconds,
requests and items sent. This is how the provider and speed tiers were
replaced by one policy (see ARCHITECTURE.md); a threshold that survives must
show a measured loss when removed.

A single `--seed` replays the identical event sequence with its trace. To compare
with an older release, export it and run the same seeds against it:

```sh
git archive <old-commit> | tar -x -C /tmp/old
npm run sim:fuzz -- --seeds 60 --from 9000 --profile limited --root /tmp/old
``` When a
scheduling change is proposed, compare the per-profile totals on fixed seeds
before and after; a failing seed is a reproducible fixture, but add a reduced
unit test for the invariant it exposed.

Every fuzz run also attributes stall time (`stallBreakdown`): each stalled
50 ms step is booked by playback phase (after start, seek, reload or rate
change, or steady) and by what the visible group waited for (no request,
retry wait, queued in the worker, first byte, generating). Decide what to
optimize from this table, not from a total.

## Translation quality

`scripts/quality-eval.js` scores what the extension actually committed. The
committed text depends only on the captions, the runtime's scheduling and the
model, not on YouTube's player, so the run comes from `scripts/sim-replay.js`:
the real background and content code in the simulator, the exported captions
played start to finish, and the real provider, with the virtual clock paced to
wall time. Automated Chrome is not used here: YouTube's player stops with an
error after about a minute in it. Both steps read `CAPTIONAI_E2E_API_KEY` from
your own shell:

```sh
node --use-env-proxy scripts/sim-replay.js --provider gemini --cues-file "captions [VIDEO].orig.srt" --rate 1
node --use-env-proxy scripts/quality-eval.js --result e2e-results/replay-....json
```

`sim-replay.js` without `--provider` uses the local stand-in.
`e2e-chrome.js --scenario quality` still writes the same result shape; it
reports a failure when the video played less than half the intended time.

For every committed unit it asks for a reference translation with the same
segmentation and generous context, then has a judge model score accuracy,
fluency and segmentation (1-5) and name the main issue. Scores are grouped by
the request class that committed the unit and by how close the unit ended to
that request's uncommitted runway, so a speed change can be checked for a
quality cost. `--dry-run` checks the pipeline without any API.

## End-to-end in Chrome

`scripts/e2e-chrome.js` loads a temporary copy of the extension into a fresh
Chrome profile over the DevTools pipe, opens a real YouTube video, and plays it
with rate changes, seeks, scrubs, a settings change and a reload. It then
exports the extension's own debug log and checks it: paints match the
subtitle on screen, no cancelled range is re-sent, no request hot loop, no API
key in the log. It also reports each request's size, first byte and total
time, and the run's token usage. Results go to `e2e-results/` (ignored).

```sh
node scripts/e2e-chrome.js --headful --cues synthetic
node scripts/e2e-chrome.js --headful --cues-file "captions [VIDEO].orig.srt" --video VIDEO
```

The default provider is a local fake that streams the real JSONL protocol and
"translates" by reversing each word's letters, so every paint is checkable.
Run `--provider gemini` yourself, with `CAPTIONAI_E2E_API_KEY` set in your
own shell; the key is removed from the test profile when the run ends.

YouTube rejects the caption proof-of-origin token of any browser driven over
the DevTools protocol (`navigator.webdriver` is true), signed in or not, so
real captions cannot be fetched this way. Replay a track instead: export
"Original" SRT from the popup in your everyday Chrome and pass it with
`--cues-file`. Only the caption fetch is then not exercised; cover it with the
manual smoke checks below.

## Manual Chrome smoke checks

Perform the relevant checks whenever behavior crosses the browser boundary:

- Reload the unpacked extension, then open the first video in a fresh browser
  session; original captions, loading state, and translation must all appear.
- Seek forward and backward while urgent and prefetch requests are active; stale
  translations must not flash or overwrite the new position.
- Toggle fullscreen and resize the player; source/translation pages stay paired
  and within the configured line budget.
- Switch configuration profiles, including two profiles sharing one Base URL;
  exactly the selected model/key/parameters apply and only one retranslation starts.
- Set a new non-DeepSeek Base URL: Chrome asks for that origin only; after
  granting (even if the popup closed), the open video retries translation. With
  the grant revoked in `chrome://extensions`, captions show
  `AI_HOST_PERMISSION_MISSING` and the popup offers **Allow access**.
- Exercise one successful stream, one usage-only final event, one timeout, and
  one cancellation. Token totals and diagnostics must reflect the real outcome.
- Inspect extension storage and copied debug logs: no API key or complete secret
  profile may appear outside local storage.
- For lifecycle bugs, the copied diagnostic bundle must show ordered
  `state-transition` events with session revision, request ID, and the explicit
  reason whenever a stale callback or timer is discarded.

For a pure popup presentation change, reload the unpacked extension and inspect
the affected workspace at its normal, hover, focus, and open-menu states. Check
that text remains readable, controls stay within the fixed popup width, and no
nearby control changes state unexpectedly. This replaces a regression test for
CSS-only edits.

Record which checks were run in the pull request. If a check cannot be run, say
why and describe the residual risk rather than calling the change fully verified.

## Definition of done

- Acceptance criteria are met without example-specific branches.
- Runtime or behavioral changes have a regression test that fails on the old
  behavior and passes on the fix. CSS-only changes have the relevant manual UI
  check instead.
- The applicable architecture/tests check and `git diff --check` pass.
- Required manual checks are recorded for UI/lifecycle changes.
- No new permission, secret exposure, compatibility branch, or duplicated state
  owner was introduced without explicit justification.
- Documentation and agent instructions still describe the code that exists.

## Effective request template

```text
Problem: <observable behavior and evidence>
Expected: <acceptance criteria>
Scope: <components/files if known>
Must preserve: <non-goals/invariants>
Verify: <focused examples plus npm run check and relevant Chrome smoke checks>
```
