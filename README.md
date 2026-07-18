# CaptionAI Duo

An AI bilingual-subtitle extension for YouTube. It reads the active caption track, performs semantic segmentation, translation, and bilingual alignment, then paginates the result using the player width and actual font metrics.

## Features

- Original and translated subtitles share one non-overlapping overlay.
- Defaults to `https://api.deepseek.com`; another Chat Completions-compatible Base URL and model can be entered directly.
- Accepts streaming SSE and ordinary JSON; complete streamed semantic units are validated and painted line by line.
- Per-line font, size, color, background, outline, spacing, and line order controls.
- The overlay can be dragged vertically; font, player-size, and fullscreen changes trigger repagination.
- 15 target languages plus original, translated, and bilingual SRT export.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project directory, which contains `manifest.json`.
5. Open a YouTube video with captions.

Chrome, Edge, or another Chromium browser version 111 or newer is required.

## Settings reference

### Translation

| Setting | Default / range | Meaning |
| --- | --- | --- |
| Enabled | On | Controls the overlay and translation work. Turning it off cancels this video's requests and restores YouTube CC if the extension enabled it. |
| Target language | Simplified Chinese | The requested AI output language. Changing it clears this video's old translation and retranslates in the new language. |
| API Base URL | `https://api.deepseek.com` | The base of the request URL. `/chat/completions` is appended unless already present. Remote URLs must use HTTPS; `localhost` and `127.0.0.1` may use HTTP. A custom origin must be granted access with **Authorize**. |
| Model | `deepseek-v4-flash` | Sent unchanged as the Chat Completions `model`; it must exactly match a model offered by the endpoint. |
| Reasoning effort | Off / `High` / `Max` | Off uses ordinary generation; DeepSeek receives its explicit thinking-off field and compatible endpoints receive normal `temperature`. `High` and `Max` send `reasoning_effort`, and also enable thinking for DeepSeek. Leave this off if the endpoint does not accept those fields. Reasoning is generally slower and more expensive, and extends the request timeout from 30 to 90 seconds. |
| API key | Empty | Stored separately for the normalized Base URL in `chrome.storage.local`, never synced, and sent as `Authorization: Bearer …`. It can be empty for an unauthenticated local endpoint; DeepSeek requires it. |
| Previous context | `1`, range `0–20` | Adds original YouTube cues before the request as read-only reference for names, pronouns, terminology, and tone. Rolling-caption duplicates are removed first, and context remains subject to the aggregate input budget. |
| Future context | `1`, range `0–20` | Adds original cues after the request as explicitly marked, read-only future reference. It can disambiguate current text but reveals more future material; duplicates and distant entries that exceed the aggregate budget are dropped. |
| Prefetch batches | `1`, range `0–10` | Starts that many future scheduling ranges ahead of playback; `0` disables prefetch. A batch is a scope of about 32 lexical coordinates, not 32 subtitle cues and not necessarily one HTTP call. Higher values may reduce playback waits but increase concurrency, traffic, and cost. |

Changing the Base URL, model, reasoning effort, or either context count retranslates the current video. Changing only prefetch depth cancels obsolete speculative work and continues with the new distance; already validated translations remain reusable.

### Display

| Setting | Default / range | Meaning |
| --- | --- | --- |
| Order | Translation above original | Changes visual order only, not translation, timing, or SRT order. |
| Row gap | `4px`, range `0–30px` | Vertical space between the two languages; it does not enter horizontal page-width calculations. |
| Show this line | Both lines on | Each language may be hidden independently. A hidden language no longer constrains page capacity, so fewer pages may be needed. |
| Font | System | Selected independently for each language. Actual glyph widths are used for pagination. |
| Window size | `24px`, range `12–48px` | Font size in the ordinary player. |
| Fullscreen size | `34px`, range `12–72px` | Font size in YouTube fullscreen. |
| Text color | White `#ffffff` | Paint-only; it does not affect pagination. |
| Background color / opacity | `#080808` / `0%` | At `0%`, the background is fully transparent regardless of its selected color. |
| Outline color / opacity | Black `#000000` / `100%` | Outline opacity is independent of text opacity. |
| Outline width | `4px`, range `0–8px` | A zero width or zero outline opacity disables the outline. |

The overlay can be dragged vertically and stores its position as a percentage of the player. Font, size, and line visibility changes immediately repaginate locally. Color, background, outline, order, and gap only repaint. Overlay width, browser resizing, fullscreen transitions, and completed web-font loads also repaginate. **Reset all settings** restores the defaults above.

### Tools

- **Token usage** shows session totals reported by the configured API: input, output, reasoning, prompt-cache hit/miss, and reported/unreported response counts. It can be cleared independently. Local response-cache hits make no API call and add no tokens.
- **Debug log** is off by default. When enabled, it records the caption startup handshake and recovery attempts, track selection, compact request windows, network attempts, structural validation failures, and pagination. Logs live in session storage and may contain subtitle text, so inspect them before sharing.
- **SRT export** reads original entries from the full captured track. Translated and bilingual exports contain only translations that are already complete and structurally valid; exporting does not translate the rest of a video merely to fill the file.

## Translation pipeline

### 1. Capture and normalize the timed track

The primary path captures the `timedtext` URL actually requested by the YouTube player and reads its JSON3 track, so it follows the selected manual or automatic captions. Cues are sorted, missing durations are repaired, and repeated overlap from rolling captions is merged. Only when no timed track arrives does the extension fall back to scraping the currently rendered caption; that path has no complete timeline and is necessarily more limited.

### 2. Create lexical coordinates without making local semantic decisions

Each original cue becomes addressable units. Text containing whitespace is split into non-whitespace words; text without spaces uses `Intl.Segmenter({ granularity: "word" })`, with characters as the final fallback. Exact YouTube word offsets are used when they match the text; otherwise timing is interpolated inside the cue.

These units are timing and coverage coordinates, **not semantic sentences or display pages**. Adjacent coordinates may still be grouped by the AI into a complete, indivisible semantic alignment chunk. Sentence-mode `Intl.Segmenter` is used only by fallback display pagination, not to decide translation segments.

A cue gap of at least 900 ms is only a soft hint that the AI may cross when grammar requires. A gap reaches an uncrossable hard boundary only at 4000 ms. YouTube cue changes and transport-window edges are not sentence endings by themselves.

### 3. Rolling requests and context

Pending coordinates near playback enter a bounded rolling window: the base cold window is 48 lexical items and continuous work uses about 80. A visible or newly sought target receives 48 additional items of right-side semantic runway, followed by a separate 16-item private trailing guard, so the target is not placed directly against the guard and forced into a duplicate request. Unusually long cross-edge semantic units may still expand the total window up to 160. Current-coordinate text also has an 18,000-character ceiling. Current text plus deduplicated context share an approximately 28,000-character budget; current content and the nearest context entries win when space is tight.

Every prompt distinguishes:

- `PAST_CONTEXT`, controlled by Previous context and read-only;
- `CURRENT_CUES`, whose coordinates must be covered exactly and in order;
- `FUTURE_CONTEXT`, controlled by Future context and read-only.

To avoid repeating verbose field names for every word, current coordinates are transmitted as compact `[id, text, pauseAfterMs, boundary]` rows, where boundary is empty, soft, or hard. Context uses compact `[id, text]` rows. Full cue IDs and absolute timing remain local for validation, playback, pagination, and export.

The AI first groups contiguous current coordinates into natural sentences or clauses, then returns coarse bilingual alignment chunks within each semantic unit. Context may inform interpretation but must never be translated, repeated, or merged into current output.

### 4. Streaming transport and model output

Requests use Chat Completions JSON with `stream: true`. The primary translation contract is JSONL: each finalized semantic unit occupies one physical line, followed by exactly one `{"type":"done","deferred_ids":[...]}` line declaring the unresolved contiguous suffix. DeepSeek receives thinking controls and `stream_options.include_usage`; the JSONL request deliberately omits the single-object `response_format`. A custom compatible endpoint only needs to accept the request and return OpenAI-style `choices`.

Both SSE network chunks and model tokens may split at arbitrary byte positions, so buffering happens in two layers: first through a complete blank-line-delimited SSE event, then through a complete JSONL newline. A unit reaches the immutable cache and page immediately only after that whole line parses independently with ordered, structurally complete IDs. Half a JSON string, half a sentence, or an arbitrary token delta is never painted. Usage-only events are accumulated separately, and `[DONE]` flushes the last line. A server that ignores SSE and returns ordinary JSON is accepted, including top-level `usage`; the previous complete-JSON schema remains a compatibility path.

### 5. Validation, monotonic commit, and fallback

A response is accepted only when:

- every current coordinate appears exactly once and in order, with no omission, duplicate, or invented ID;
- unresolved content is a contiguous suffix only;
- semantic units do not cross hard boundaries or exceed duration/text safety ceilings;
- alignment chunks are contiguous and complete inside their semantic unit, with non-empty translation.

The extension no longer judges translation quality with numeric multiplicity, text length, script, source-similarity, URL, or email heuristics. Those requirements remain model instructions only; they cannot trigger repair requests or block structurally valid output.

Even if the model calls the window tail complete, any unit touching the private 16-item guard is carried whole into the next, longer window. Each hard-boundary region commits only a contiguous prefix from left to right. A later response therefore cannot leave a hole or overwrite an earlier decision; fixed request edges do not split a cross-cue phrase.

If JSONL fails before its first valid unit, the extension can still try the previous complete aligned JSON and then a simpler whole-segment JSON contract. If malformed output, disconnection, timeout, or cancellation happens after valid lines, the already committed contiguous prefix survives and only the uncommitted suffix is requested again. This prevents a bad tail from wasting completed translation or overwriting older results. HTTP work receives up to three attempts with timeout, `429`, and temporary-server-error handling; after a stream has produced a valid unit, that HTTP request is not replayed from the beginning because replay could duplicate emitted lines.

### 6. Playback, seek, prefetch, and concurrency

Visible playback work has priority, and future scopes are started according to Prefetch batches. A tab normally allows at most three simultaneous AI requests so speculative look-ahead cannot consume unbounded connections, quota, or cost. A request for the subtitle being watched or the new seek target is urgent and may bypass a limit already occupied by prefetch.

Seeking to an uncached location clears the stale translation immediately and shows loading. A distant seek cancels obsolete focus work and reseeds a safety window around the target: left-side coordinates provide read-only boundary evidence, while independent right-side semantic runway separates the target from the final guard. The complete target unit can therefore normally commit during the first streamed response; exceptionally long units still expand the window. An unproven unit touching the new left edge is not displayed prematurely, and validated cached units are reused directly.

If the full timed track is unavailable and rendered-caption fallback is used, only the latest translation request remains active; a caption change aborts the old request instead of merely ignoring its response. Validated complete-request results also enter a session LRU capped at 96 entries and about 2 MB. Its key includes endpoint, model, reasoning mode, languages, context configuration, and exact source content. Matching work can be reused after refresh, and the cache is cleared with the browser session.

## Pagination pipeline

An AI **semantic unit** and an on-screen **display page** are separate layers. The AI decides which contiguous coordinates form a sentence or clause and supplies source-to-translation alignment chunks. The browser then decides how many complete chunks fit the current player. Changing fonts does not ask the AI to translate that unit again.

Pagination works as follows:

1. Determine usable overlay width, normally about 98% of player width minus padding, with a 260 px minimum measurement width.
2. Measure source and translation independently in Canvas with their current font and window/fullscreen size; character counts are not used as a width proxy.
3. Use approximately `usable width × 1.68` per language as page capacity, leaving headroom for proportional-font wrapping and padding and targeting no more than about two rows. The larger page requirement wins, capped by the semantic unit's timed-coordinate count.
4. Pack complete AI alignment chunks from left to right. A new page starts only when adding the next chunk would overflow either language, so proper names, fixed expressions, and complete clauses stay intact when the model aligned them as one chunk.
5. If one chunk is wider than the viewport by itself, split only that oversized chunk with pixel-aware pagination while preserving every other AI chunk boundary. Responses without chunks still use whole-unit fallback pagination: sentence endings first, then clause punctuation, spaces, and CJK character boundaries. Articles, prepositions, and conjunctions are penalized at page ends.
6. URLs, email addresses, abbreviation or initial chains, dates, times, versions, decimals, and ellipses are marked as protected shapes that cannot be split internally. This is generic shape protection, not a name or phrase dictionary.
7. Pair source and translation pages by semantic order, then assign timed coordinates monotonically to page numbers. Playback can advance but does not oscillate between pages around adjacent cues. A short raw-cue gap inside the same semantic unit may be bridged for up to 2200 ms.

Existing translations are repaginated after font, window-size, fullscreen-size, or line-visibility changes; overlay/browser width changes; fullscreen transitions; and completed web-font loads. Text color, background, outline, order, row gap, and vertical drag position do not change horizontal text capacity, so they neither repaginate nor send a new AI request.

## Privacy

No accounts, analytics, or tracking. Caption text is sent only to the configured AI endpoint. Ordinary settings use `chrome.storage.sync`; endpoint-scoped API keys use `chrome.storage.local`; the bounded validated-translation cache and API-reported token totals use `chrome.storage.session` and are cleared with the browser session.

## Development

The project uses plain JavaScript and CSS with no build step:

```text
npm test
npm run check
```

- `inject.js`: captures the caption-track request used by the player.
- `content.js`: overlay, timeline, pagination, dragging, and export data.
- `background.js`: AI requests, dynamic endpoint permission, retries, and SSE/JSON parsing.
- `shared.js`: defaults, structural validation, and pure helpers.
- `popup.html/.css/.js`: settings UI.

## License

[GNU General Public License v3.0](LICENSE). If you distribute a modified version,
you must make its corresponding source code available under the same license.
