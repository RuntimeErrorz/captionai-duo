# Background runtime invariants

- Keep request construction provider-neutral when the OpenAI-compatible contract
  suffices. Provider-specific fields need a current documented contract and a
  focused test.
- SSE events and JSONL records can split at any byte boundary. Commit only fully
  parsed, structurally validated records; retain usage-only events through stream
  completion.
- Cancellation, connect timeout, body timeout, HTTP failure, and Chromium
  transport failure are distinct states. Preserve their original diagnostics.
- Urgent playback may outrank speculative prefetch, but promotion must reuse safe
  in-flight work rather than duplicate it.
- Never log Authorization headers, API keys, complete local profile objects, or
  unredacted provider error payloads that may echo credentials.
- Treat stored and incoming diagnostic entries as untrusted legacy data. Apply
  shared recursive redaction before persistence and again when exporting.
- Any new external origin requires explicit user authorization and a permission
  review; do not broaden manifest host permissions as a convenience.
