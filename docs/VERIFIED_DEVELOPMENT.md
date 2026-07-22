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
2. Reproduce with a focused test or documented Chrome scenario.
3. Fix the invariant at its owner boundary; avoid parallel state machines and
   downstream repair heuristics.
4. Run the focused test after each meaningful edit.
5. Run `npm run check` for syntax, load order, module size, and all regressions.
6. Inspect `git diff --check` and the final diff. Explain the root cause, why the
   fix is general, verification evidence, and remaining risk.

## Manual Chrome smoke checks

Perform the relevant checks whenever behavior crosses the browser boundary:

- Reload the unpacked extension, then open the first video in a fresh browser
  session; original captions, loading state, and translation must all appear.
- Seek forward and backward while urgent and prefetch requests are active; stale
  translations must not flash or overwrite the new position.
- Toggle fullscreen and resize the player; source/translation pages stay paired
  and within the configured line budget.
- Switch connection profiles, including two profiles sharing one Base URL;
  exactly the selected model/key/parameters apply and only one retranslation starts.
- Exercise one successful stream, one usage-only final event, one timeout, and
  one cancellation. Token totals and diagnostics must reflect the real outcome.
- Inspect extension storage and copied debug logs: no API key or complete secret
  profile may appear outside local storage.
- For lifecycle bugs, the copied diagnostic bundle must show ordered
  `state-transition` events with session revision, request ID, and the explicit
  reason whenever a stale callback or timer is discarded.

Record which checks were run in the pull request. If a check cannot be run, say
why and describe the residual risk rather than calling the change fully verified.

## Definition of done

- Acceptance criteria are met without example-specific branches.
- The regression test fails on the old behavior and passes on the fix.
- `npm run check` and `git diff --check` pass.
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
