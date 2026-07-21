## Problem and acceptance criteria

<!-- Describe observable behavior, expected behavior, and non-goals. -->

## Root cause and invariant

<!-- Which general invariant was violated? Why is this not an example-specific fix? -->

## Change

<!-- Summarize the state/data path changed and any compatibility or permission impact. -->

## Verification evidence

- [ ] Focused regression test fails without the fix and passes with it
- [ ] `npm run check`
- [ ] `git diff --check`
- [ ] Relevant manual Chrome checks from `docs/VERIFIED_DEVELOPMENT.md`

Manual evidence / checks not run:

## Risk review

- [ ] No API key, Authorization header, or complete secret profile is logged/synced
- [ ] No phrase/video/timestamp-specific exception was added
- [ ] No manifest permission was broadened without explicit justification
- [ ] Stale callbacks, cancellation, seeking, and first-load behavior were considered
