# Popup and configuration invariants

- A configuration profile is one atomic local unit: name, target language, Base
  URL, model, API key, request parameters, context counts, and prefetch depth.
- Secrets and complete profiles stay in `chrome.storage.local`. Sync storage may
  contain only the currently materialized non-secret settings and a revision.
- One user action must produce one configuration revision and one retranslation;
  avoid independent local/sync listeners that restart the same work twice.
- Every visible string and accessible label needs both English and Simplified
  Chinese locale entries. Keep controls keyboard accessible and usable at the
  fixed popup width.
- Provider-specific JSON is untrusted input: canonicalize it, reject unsafe or
  protected fields, and include its canonical value in request/cache identity.
