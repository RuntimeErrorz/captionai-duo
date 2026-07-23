"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  SHARED_FILES,
  CONTENT_FILES,
  BACKGROUND_FILES,
  POPUP_FILES,
  readSourceFiles,
  loadSharedGlobal
} = require("./helpers");

const root = path.resolve(__dirname, "..");
const shared = loadSharedGlobal();
assert.equal(shared.DEFAULTS.deepseekContextPast, 1);
assert.equal(shared.DEFAULTS.deepseekContextFuture, 1);
assert.equal(shared.DEFAULTS.deepseekPrefetchBatches, 1);
assert.equal("aiProvider" in shared.DEFAULTS, false);
assert.equal(shared.DEFAULTS.aiBaseUrl, "https://api.deepseek.com");
assert.equal(shared.DEFAULTS.aiModel, "deepseek-v4-flash");
assert.equal("aiThinking" in shared.DEFAULTS, false);
assert.equal(shared.DEFAULTS.aiExtraBodyRevision, 0);
assert.equal(shared.DEFAULTS.order, "trans-top");
assert.equal(shared.DEFAULTS.transColor, "#ffffff");
assert.equal(shared.DEFAULTS.transBgOpacity, 0);
assert.equal(shared.DEFAULTS.transStrokeOpacity, 1);
assert.equal(shared.DEFAULTS.origFont, shared.DEFAULTS.transFont);
assert.equal(shared.DEFAULTS.origSize, shared.DEFAULTS.transSize);
assert.equal(shared.DEFAULTS.origFullscreenSize, shared.DEFAULTS.transFullscreenSize);
assert.equal(shared.DEFAULTS.origColor, shared.DEFAULTS.transColor);
assert.equal(shared.DEFAULTS.origBg, shared.DEFAULTS.transBg);
assert.equal(shared.DEFAULTS.origBgOpacity, shared.DEFAULTS.transBgOpacity);
assert.equal(shared.DEFAULTS.origStroke, shared.DEFAULTS.transStroke);
assert.equal(shared.DEFAULTS.origStrokeOpacity, shared.DEFAULTS.transStrokeOpacity);
assert.equal(shared.DEFAULTS.origStrokeWidth, shared.DEFAULTS.transStrokeWidth);
assert.equal(shared.TARGET_LANGS.length, 15);
assert.equal(shared.TARGET_LANGS.includes("zh-TW"), false);
assert.equal(shared.aiEndpointKind("https://api.deepseek.com"), "deepseek");
assert.equal(shared.aiEndpointKind("https://gateway.example/v1"), "compatible");
assert.equal(shared.normalizeAiBaseUrl("https://gateway.example/v1/"),
  "https://gateway.example/v1");
assert.equal(shared.normalizeAiBaseUrl("http://localhost:11434/v1"),
  "http://localhost:11434/v1");
assert.equal(shared.normalizeAiBaseUrl("http://gateway.example/v1"), "");
assert.equal(shared.normalizeAiBaseUrl("https://user:pass@gateway.example/v1"), "");
assert.equal(shared.aiChatCompletionsUrl("https://gateway.example/v1"),
  "https://gateway.example/v1/chat/completions");
assert.equal(shared.aiChatCompletionsUrl(
  "https://gateway.example/v1/chat/completions"
), "https://gateway.example/v1/chat/completions");
assert.equal(shared.aiOriginPattern("https://gateway.example:8443/v1"),
  "https://gateway.example/*");
assert.equal(shared.aiCredentialScope("https://api.deepseek.com"), "deepseek");
assert.equal(shared.aiCredentialScope("https://gateway.example/v1"),
  "custom:https://gateway.example/v1");
assert.equal(shared.aiCompletionText({ choices: [{ message: { content: "complete" } }] }),
  "complete");
assert.equal(shared.aiCompletionText({ choices: [{ delta: { content: [
  { type: "text", text: "stream" }, { type: "text", text: "ed" }
] } }] }), "streamed");
const deepseekRequestBody = shared.aiChatCompletionBody({
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  extraBody: { thinking: { type: "enabled" }, reasoning_effort: "high" }
}, [{ role: "user", content: "JSON only" }], 4096, 0.1);
assert.equal(deepseekRequestBody.stream, true);
assert.equal(deepseekRequestBody.stream_options.include_usage, true);
assert.equal(deepseekRequestBody.response_format.type, "json_object");
assert.equal(deepseekRequestBody.thinking.type, "enabled");
assert.equal(deepseekRequestBody.reasoning_effort, "high");
assert.equal("temperature" in deepseekRequestBody, false);
assert.equal(shared.aiExtraBodyUsesThinking({
  thinking: { type: "enabled" }, reasoning_effort: "high"
}), true);
const deepseekJsonlRequestBody = shared.aiChatCompletionBody({
  baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash"
}, [{ role: "user", content: "JSONL only" }], 4096, 0.1, { jsonLines: true });
assert.equal(deepseekJsonlRequestBody.stream, true);
assert.equal(deepseekJsonlRequestBody.stream_options.include_usage, true);
assert.equal("response_format" in deepseekJsonlRequestBody, false);
assert.equal("thinking" in deepseekJsonlRequestBody, false);
assert.equal("reasoning_effort" in deepseekJsonlRequestBody, false);
assert.equal(shared.aiExtraBodyUsesThinking({ enable_thinking: false }), false);
const customRequestBody = shared.aiChatCompletionBody({
  baseUrl: "http://localhost:11434/v1", model: "local-model"
}, [{ role: "user", content: "JSON only" }], 4096, 0.1);
assert.equal(customRequestBody.stream, true);
assert.equal(customRequestBody.model, "local-model");
assert.equal(customRequestBody.temperature, 0.1);
assert.equal("response_format" in customRequestBody, false);
assert.equal("thinking" in customRequestBody, false);
assert.equal(customRequestBody.stream_options.include_usage, true);
assert.equal(shared.normalizeDeepseekPrefetchBatches(-3), 0);
assert.equal(shared.normalizeDeepseekPrefetchBatches(2.6), 3);
assert.equal(shared.normalizeDeepseekPrefetchBatches(99), 10);
assert.equal(shared.normalizeAiContextCount(-2, 5), 0);
assert.equal(shared.normalizeAiContextCount(12.6, 5), 13);
assert.equal(shared.normalizeAiContextCount(99, 5), 20);
assert.equal(typeof shared.splitTextForDisplay, "function");
assert.equal(typeof shared.splitAlignedSentencesForDisplay, "function");
assert.equal(typeof shared.displayPageAssignments, "function");
assert.equal(typeof shared.semanticDisplayPlan, "function");
assert.equal(typeof shared.shouldBridgeSemanticCueGap, "function");
assert.equal(typeof shared.semanticDisplayClusters, "function");
assert.equal(typeof shared.semanticUnitsFromAlignedChunks, "function");
assert.equal(typeof shared.semanticBatchWindows, "function");
assert.equal(typeof shared.semanticPrefetchBatchStarts, "function");
assert.equal(typeof shared.deepSeekConcurrencyStatus, "function");
assert.equal(typeof shared.mergeTimedCueTexts, "function");
assert.equal(shared.semanticPauseKind(899, 900, 4000), "none");
assert.equal(shared.semanticPauseKind(900, 900, 4000), "soft");
assert.equal(shared.semanticPauseKind(3999, 900, 4000), "soft");
assert.equal(shared.semanticPauseKind(4000, 900, 4000), "hard");
assert.equal(typeof shared.cueReferenceAtoms, "function");
assert.equal(typeof shared.referenceBatchWindows, "function");
assert.equal(typeof shared.ownedSemanticTranslations, "function");
assert.equal(typeof shared.shouldReseedSemanticCommitState, "function");
assert.equal(typeof shared.semanticCommitRequestPlan, "function");
assert.equal(typeof shared.canonicalSemanticUnits, "function");
assert.equal(typeof shared.pendingTranslationScopeKey, "function");
assert.equal(typeof shared.semanticCoverageGaps, "function");
assert.equal(typeof shared.groupReferenceItemsByCue, "function");
assert.equal(typeof shared.preparePromptContexts, "function");
assert.equal(typeof shared.normalizeAiTokenUsage, "function");
assert.equal(typeof shared.compactAiPromptCueRows, "function");
assert.equal(typeof shared.compactAiPromptContextRows, "function");
assert.equal(typeof shared.alignedTranslationsFromJsonText, "function");
assert.equal(typeof shared.alignedChunkDisplayPlan, "function");
assert.equal(typeof shared.aiJsonlLines, "function");
assert.equal(typeof shared.aiJsonlRecordFromLine, "function");
assert.equal(typeof shared.createAiJsonlTranslationState, "function");
assert.equal(typeof shared.pushAiJsonlTranslationRecord, "function");
assert.equal(typeof shared.aiJsonlTranslationResult, "function");

assert.equal(shared.videoIdFromUrl("https://www.youtube.com/watch?v=abcdefghijk"), "abcdefghijk");
assert.equal(shared.videoIdFromUrl("https://www.youtube.com/shorts/abcdefghijk"), "abcdefghijk");
assert.equal(shared.videoIdFromUrl("https://www.youtube.com/live/abcdefghijk?feature=share"), "abcdefghijk");
assert.equal(shared.videoIdFromUrl("https://www.youtube.com/embed/abcdefghijk"), "abcdefghijk");
assert.equal(shared.videoIdFromUrl("https://www.youtube.com/"), "");

assert.equal(shared.isYoutubePageUrl("https://www.youtube.com/"), true);
assert.equal(shared.isYoutubePageUrl("https://evil.example/watch?v=abcdefghijk"), false);
assert.equal(shared.videoIdMatchesPageUrls("abcdefghijk", [
  "https://www.youtube.com/watch?v=abcdefghijk",
  "https://www.youtube.com/"
]), true);
// Browser cold start: the restored document URL has no video id yet.
assert.equal(shared.videoIdMatchesPageUrls("abcdefghijk", [
  "https://www.youtube.com/"
]), true);
// YouTube SPA: current tab URL wins over a stale sender document URL.
assert.equal(shared.videoIdMatchesPageUrls("abcdefghijk", [
  "https://www.youtube.com/watch?v=abcdefghijk",
  "https://www.youtube.com/watch?v=oldvideo123"
]), true);
assert.equal(shared.videoIdMatchesPageUrls("oldvideo123", [
  "https://www.youtube.com/watch?v=abcdefghijk",
  "https://www.youtube.com/watch?v=oldvideo123"
]), false);
assert.equal(shared.videoIdMatchesPageUrls("abcdefghijk", ["https://evil.example/"]), false);

assert.equal(shared.isAllowedTimedtextUrl("https://www.youtube.com/api/timedtext?v=abcdefghijk"), true);
assert.equal(shared.isAllowedTimedtextUrl("https://evil.example/api/timedtext?v=abcdefghijk"), false);
assert.equal(shared.isAllowedTimedtextUrl("http://www.youtube.com/api/timedtext?v=abcdefghijk"), false);
assert.equal(shared.isAllowedTimedtextUrl("https://www.youtube.com/not/api/timedtext"), false);

// Overlapping ASR cues are never a pause, even when lastOff is missing/early.
assert.equal(shared.cuePauseMs(
  { start: 195200, end: 201200, dur: 6000, lastOff: 195200 },
  { start: 199280 }
), -1920);
assert.equal(shared.cuePauseMs(
  { start: 1000, end: 2000, dur: 1000, lastOff: 1800 },
  { start: 3800 }
), 1800);

assert.equal(shared.translationFromJsonText('{"translation":"译文"}'), "译文");
assert.equal(shared.translationFromJsonText('```json\n{"translation":"带代码块"}\n```'), "带代码块");
assert.equal(shared.translationFromJsonText('Result: {"translation":"带前缀"}'), "带前缀");
assert.equal(shared.translationFromJsonText("not json"), "");

const segmentItems = [
  { id: "0", text: "its own police force,", startMs: 0, endMs: 1200, hardAfter: false },
  { id: "1", text: "its own mayor,", startMs: 1200, endMs: 2200, hardAfter: false },
  { id: "2", text: "and its government.", startMs: 2200, endMs: 3500, hardAfter: true }
];
const segmented = shared.segmentedTranslationsFromJsonText(JSON.stringify({ segments: [
  { ids: ["0", "1", "2"], translation: "它拥有自己的警察、市长和政府。" }
] }), segmentItems);
assert.equal(segmented.length, 3);
assert.equal(segmented[0].translation, segmented[2].translation);
assert.equal(segmented[0].unitId, "semantic-0-2");
assert.equal(shared.segmentedTranslationsFromJsonText(JSON.stringify({ segments: [
  { ids: ["0", "2"], translation: "invalid" }
] }), segmentItems), null);
assert.equal(shared.segmentedTranslationsFromJsonText(JSON.stringify({ segments: [
  { ids: ["0", "1"], translation: "invalid hard-boundary merge" },
  { ids: ["2"], translation: "ok" }
] }), [{ ...segmentItems[0], hardAfter: true }, segmentItems[1], segmentItems[2]]), null);

// Rolling YouTube cues can make one valid semantic sentence span more than
// fifteen seconds even though the source remains a compact display unit.
const rollingItems = [
  { id: "42", text: "You can leave it a mess on a", startMs: 195200, endMs: 201200, hardAfter: false },
  { id: "43", text: "Friday night and not worry about it, but it's also got", startMs: 199280, endMs: 207280, hardAfter: false },
  { id: "44", text: "that awesome flow.", startMs: 203760, endMs: 211760, hardAfter: false }
];
const rollingSegment = shared.segmentedTranslationsFromJsonText(JSON.stringify({ segments: [
  { ids: ["42", "43", "44"], translation: "你可以在周五晚上把这里弄得一团糟，也不用担心，而且动线也很棒。" }
] }), rollingItems);
assert.equal(rollingSegment.length, 3);
assert.equal(rollingSegment[0].unitId, "semantic-42-44");

const diagnostics = {};
assert.equal(shared.segmentedTranslationsFromJsonText(JSON.stringify({ segments: [
  { ids: ["42", "43", "44"], translation: "too long" }
] }), rollingItems.map((item, index) => index === 2 ? { ...item, endMs: 240201 } : item), diagnostics), null);
assert.match(diagnostics.reason, /oversized segment/);

const displayPages = shared.splitTextForDisplay(
  "You can cook in here. You can make a mess. You can leave it a mess on a Friday night and not worry about it.",
  2,
  (text) => text.length
);
assert.equal(displayPages.length, 2);
assert.ok(displayPages.some((page) => page.text.includes("on a Friday night")));
assert.ok(displayPages.every((page) => !/\bon a$/i.test(page.text)));

const alignedDisplay = shared.splitAlignedSentencesForDisplay(
  "Did you notice this space? This is dead space. It's not in line with your bar. Now, put the closet here. Imagine waking up and running up and down the Westside Highway. How amazing is that? Getting on your bike and going to",
  "你注意到这个空间了吗？这是一个死空间，甚至与你的吧台不在一条线上。现在，把衣柜放在这里。想象一下，醒来后在西区高速公路上来回奔跑。这有多棒？骑上自行车去",
  4
);
assert.equal(alignedDisplay.sourcePages.length, 4);
const highwayPage = alignedDisplay.sourcePages.findIndex((page) => page.text.includes("Westside Highway"));
assert.ok(highwayPage >= 0);
assert.match(alignedDisplay.translationPages[highwayPage].text, /西区高速公路上来回奔跑/);
assert.match(alignedDisplay.sourcePages[highwayPage].text, /put the closet here/);
assert.match(alignedDisplay.translationPages[highwayPage].text, /衣柜放在这里/);

const dwellDisplay = shared.splitAlignedSentencesForDisplay(
  ">> But my job is to analyze and commentate and give life to what's happening inside the octagon. And I try not to dwell too much on the money. I just want them",
  ">> 但我的工作只是分析、评论并为八角笼内发生的事情增添活力。我尽量不过多纠结于钱，我只希望他们",
  2
);
assert.equal(dwellDisplay.sourcePages.length, 2);
assert.doesNotMatch(dwellDisplay.sourcePages[0].text, /dwell/i);
assert.match(dwellDisplay.sourcePages[1].text, /dwell too much on the money/i);
assert.match(dwellDisplay.translationPages[1].text, /纠结于钱/);

assert.deepEqual(shared.displayPageAssignments(
  [{ start: 0, end: 108 }, { start: 109, end: 140 }],
  [{ start: 0, end: 100 }, { start: 84, end: 140 }]
), [0, 1]);

const groups = shared.causalCueGroups([
  { start: 0, end: 900, text: "I bought" },
  { start: 900, end: 1800, text: "a car." }
]);
assert.equal(groups.length, 2);
assert.equal(groups[0].text, "I bought");
assert.equal(groups[1].text, "a car.");
assert.equal(groups[0].endIdx, 0);

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert.equal(manifest.minimum_chrome_version, "111");
assert.equal(manifest.version, "1.0.0");
assert.deepEqual(manifest.content_scripts[0].js, [...SHARED_FILES, "inject.js"]);
assert.deepEqual(manifest.content_scripts[1].js, [...SHARED_FILES, ...CONTENT_FILES]);
assert.deepEqual(manifest.host_permissions, [
  "https://*/*",
  "http://localhost/*",
  "http://127.0.0.1/*"
]);
assert.equal("optional_host_permissions" in manifest, false);

const content = readSourceFiles(CONTENT_FILES);
const contentCss = fs.readFileSync(path.join(root, "content.css"), "utf8");
const background = readSourceFiles(BACKGROUND_FILES);
const sharedSource = readSourceFiles(SHARED_FILES);
const popup = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const popupSource = readSourceFiles(POPUP_FILES);
const popupCss = fs.readFileSync(path.join(root, "popup.css"), "utf8");
assert.doesNotMatch(content, /settings\.engine|gtxRequest|tlang/);
assert.doesNotMatch(background, /translate\.googleapis|function gtxFetch|ytdsGtxGate/);
assert.doesNotMatch(content, /ytds-toggle|ensureToggleButton|controlsObserver/);
assert.doesNotMatch(contentCss, /ytds-toggle/);
assert.doesNotMatch(content, /postMessage\([\s\S]{0,240}["']\*["']/);
assert.match(background, /contextFuture/);
assert.match(background, /FUTURE_CONTEXT/);
assert.match(background, /isYoutubeSender\(sender\)/);
assert.match(background, /videoIdMatchesPageUrls\(msg\.videoId, senderPageUrls\(sender\)\)/);
assert.doesNotMatch(background, /videoIdFromUrl\(sender\.url \|\| sender\.tab\.url/);
assert.match(background, /alignedTranslationsFromJsonText/);
assert.match(background, /prompt-v25-jsonl-cursor-done/);
assert.match(background, /MAX_PROMPT_SOURCE_CHARS = 28000/);
assert.match(background, /preparePromptContexts/);
assert.match(background, /cleanContext\(msg\.contextAfter, 20, "future"\)/);
assert.match(background, /cleanContext\(msg\.contextBefore, 20, "past"\)/);
assert.doesNotMatch(background, /repairSuspiciousSemanticTranslations/);
assert.doesNotMatch(background, /semantic-translation-repair/);
assert.doesNotMatch(sharedSource, /translationQualityIssue/);
assert.match(background, /one completed semantic unit per physical JSONL line/i);
assert.match(background, /final line \{"type":"done"\}/);
assert.doesNotMatch(background, /final line shaped \{"type":"done","deferred_ids"/);
assert.match(background, /jsonLines: true/);
assert.match(background, /semantic-jsonl-unit/);
assert.match(background, /translationBatchProgress/);
assert.match(background, /roughly 35-90 source characters/);
assert.match(background, /compact lexical rows shaped \[id,text,pauseAfterMs,boundary\]/);
assert.match(background, /function deepseekTranslateSemanticFallback/);
assert.doesNotMatch(background, /function deepseekTranslateCueFallback/);
assert.doesNotMatch(background, /causal-cue-request/);
assert.match(background, /semantic-batch-request/);
assert.match(background, /DEBUG_MAX_ENTRY_CHARS = 30000/);
assert.match(background, /sendResponse\(\{ ok: true, truncated: true \}\)/);
assert.match(background, /currentRows: items\.map/);
assert.match(background, /translationCount: translations\.length/);
assert.doesNotMatch(background, /durationMs: Date\.now\(\) - batchStarted,\s*translations,/);
assert.match(background, /semantic-batch-alignment-fallback/);
assert.match(background, /semantic-simple-fallback-request/);
assert.match(background, /semantic-simple-fallback-response/);
assert.match(background, /MAX_BATCH_ITEMS = 160/);
assert.match(background, /retryAfterMs: Number\(err && err\.retryAfterMs\)/);
assert.match(background, /DEEPSEEK_MAX_ACTIVE_REQUESTS_PER_TAB = 3/);
assert.match(background, /DEEPSEEK_CONNECT_TIMEOUT_URGENT_MS = 8000/);
assert.match(background, /DEEPSEEK_CONNECT_TIMEOUT_PREFETCH_MS = 12000/);
assert.match(background, /chrome\.webRequest\.onErrorOccurred/);
assert.match(background, /ai-network-error/);
assert.match(background, /acquireDeepSeekSlot\(sender, !!msg\.urgent\)/);
assert.match(background, /beforeFocusGeneration/);
assert.match(background, /entry\.focusGeneration < cutoff/);
assert.doesNotMatch(background, /MAX_UNITS_PER_MINUTE/);
assert.doesNotMatch(background, /state\.recent/);
assert.match(sharedSource, /outsideIsland && \(!!urgent \|\| !playbackActive\)/);
assert.doesNotMatch(content, /const inflightKey = `dsb:\$\{regionIndex\}:\$\{requestStart\}:\$\{requestEnd\}`/);
assert.doesNotMatch(content, /YTDS_SHARED\.canonicalSemanticUnits/);
assert.doesNotMatch(content, /semantic-unit-overlap-resolved/);
assert.doesNotMatch(content, /semantic-coverage-repair-start/);
assert.doesNotMatch(content, /resp\.partial \? "partial response" : "missing items"/);
assert.doesNotMatch(sharedSource, /function splitCueAtomsAtSentenceBoundaries/);
assert.doesNotMatch(
  content,
  /groups: (?:captionSession\.)?sentGroups \? (?:captionSession\.)?sentGroups\.map/
);
assert.match(fs.readFileSync(path.join(root, "inject.js"), "utf8"), /bridge-config-received/);
assert.match(fs.readFileSync(path.join(root, "inject.js"), "utf8"), /timedtext-watchdog-expired/);
assert.match(background, /fetchAiStreamWithTimeout/);
assert.match(background, /deepseek-http-first-byte/);
assert.match(background, /deepseek-http-body-complete/);
assert.match(background, /semantic-jsonl-legacy-done-stopped/);
assert.match(background, /DEEPSEEK_STREAM_COMPLETION_GRACE_MS = 750/);
const fullBodyTimeout = background.slice(
  background.indexOf("async function fetchAiStreamWithTimeout"),
  background.indexOf("function registerDeepSeekController")
);
assert.match(fullBodyTimeout, /response\.body\.getReader\(\)/);
assert.match(fullBodyTimeout, /deepSeekSseEvents\(buffer, !!part\.done\)/);
assert.match(fullBodyTimeout, /event === "\[DONE\]"/);
assert.match(fullBodyTimeout, /reader\.cancel\(earlyStopReason\)/);
assert.match(sharedSource, /stream: true/);
assert.match(sharedSource, /stream_options: \{ include_usage: true \}/);
assert.match(background, /const chunkUsage =/);
assert.match(background, /recordAiTokenUsage/);
assert.match(background, /AI_TOKEN_USAGE_KEY = "ytdsAiTokenUsageV1"/);
assert.match(background, /priority:\$\{priority\}/);
assert.match(background, /AI_RESPONSE_CACHE_MAX_ENTRIES = 96/);
assert.match(background, /AI_RESPONSE_CACHE_MAX_CHARS = 2000000/);
assert.match(background, /semantic-batch-cache-hit/);
assert.match(background, /bypassCache \? null : await readAiResponseCache/);
assert.match(background, /writeAiResponseCache/);
assert.match(background, /cancelDeepSeekRequestForSender/);
assert.match(contentCss, /#ytds-overlay[\s\S]*?width:\s*98%/);
assert.match(content, /function extensionContextAlive/);
assert.match(content, /function stopForInvalidatedExtensionContext/);
assert.match(content, /function sendRuntimeMessage/);
assert.doesNotMatch(content, /DEEPSEEK_DISPLAY_GAP_BRIDGE_MS/);
assert.equal((content.match(/chrome\.runtime\.sendMessage/g) || []).length, 1);
assert.equal(typeof shared.displayProtectedRanges, "function");
assert.match(popup, /id="deepseekContextFuture"/);
assert.match(popup, /id="deepseekPrefetchBatches"/);
assert.match(popup, /id="deepseekContextPast" type="number" min="0" max="20"/);
assert.match(popup, /id="deepseekContextFuture" type="number" min="0" max="20"/);
assert.match(popup, /id="deepseekPrefetchBatches" type="number" min="0" max="10"/);
assert.doesNotMatch(popup, /value="zh-TW"|中文（繁體）/);
assert.match(popupSource, /normalizeTargetLang\(state\.targetLang\)/);
assert.doesNotMatch(popup, /id="aiProvider"|data-i18n="aiProvider"/);
assert.match(popup, /id="aiBaseUrl"/);
assert.doesNotMatch(popup, /id="authorizeAiBase"/);
assert.match(popup, /id="aiModel"/);
assert.match(popup, /data-i18n="secModelConfig"/);
assert.match(popup, /id="aiProfileSelect"[\s\S]*?id="newAiProfile"[\s\S]*?id="renameAiProfile"[\s\S]*?id="deleteAiProfile"/);
assert.doesNotMatch(popup, /id="aiProfileName"|class="ai-profile-manager"/);
assert.doesNotMatch(popup, /<label[^>]+for="aiProfileSelect"/);
assert.ok(popup.indexOf('id="aiProfileSelect"') < popup.indexOf('id="targetLang"'));
assert.match(popup, /id="deleteAiProfile"[\s\S]*?class="section-divider configuration-divider"[\s\S]*?id="targetLang"/);
assert.match(popup, /id="aiProfileNameEditor"[\s\S]*?id="cancelRenameAiProfile"/);
assert.doesNotMatch(popup, /id="aiThinking"|data-i18n="aiThinking"/);
assert.match(popup, /class="compact-grid grid-2 translation-basics"/);
assert.doesNotMatch(popup, /aiModelSuggestions|<datalist/);
assert.match(popup, /id="aiApiKey"/);
assert.match(popup, /id="aiExtraBody"/);
assert.doesNotMatch(popup, /id="saveAiExtraBody"|aiExtraBodySave/);
assert.match(popupSource, /scheduleAiExtraBodySave\(e\.currentTarget\.value\)/);
assert.match(popup, /id="panel-token-usage"/);
assert.match(popup, /id="tokenTotal"/);
assert.match(popup, /id="resetTokenUsage"/);
assert.match(popupSource, /function paintAiTokenUsage/);
assert.doesNotMatch(popupSource, /chrome\.permissions/);
assert.match(background, /aiEndpointKind\(baseUrl\)/);
assert.match(background, /config\.endpoint/);
assert.match(background, /config\.endpointKind === "deepseek"/);
assert.match(background, /YTDS_SHARED\.aiCompletionText/);
assert.doesNotMatch(popup, /id="preview"|id="version"|data-i18n="disclaimer"/);
assert.doesNotMatch(popup, /data-i18n="posHint"|<label[^>]+data-i18n="(?:orderLabel|positionLabel)"/);
assert.doesNotMatch(popup, /id="resetPos"|data-i18n="resetPos"/);
assert.doesNotMatch(popupSource, /resetPos/);
assert.doesNotMatch(popup, /id="position"|data-i18n="(?:posTop|posCenter|posBottom)"/);
assert.match(popup, /class="layout-row"/);
assert.equal((popup.match(/data-workspace-panel="display"/g) || []).length, 1);
assert.match(popup, /id="panel-display"[\s\S]*?data-i18n="secSubtitleAppearance"[\s\S]*?class="layout-row"[\s\S]*?class="section-divider display-divider"[\s\S]*?class="line-tabs-row"/);
assert.doesNotMatch(popup, /id="panel-(?:layout|style)"/);
assert.match(popup, /class="gap-control"/);
assert.match(popupSource, /visualDefaultsVersion/);
assert.match(popupSource, /contextDefaultsVersion/);
assert.match(popupSource, /lineDefaultsVersion/);
assert.doesNotMatch(popup, /deepseekFutureWarning|下文大于 0/);
assert.doesNotMatch(popupSource, /deepseekFutureWarning/);
assert.doesNotMatch(popup, /data-i18n="(?:logHelp|debugHint)"|日志说明/);
assert.doesNotMatch(popup, /tokenMeta|tokenUsageHint|已报告响应/);
assert.doesNotMatch(popupSource, /debugCopied|debugCleared|tokenReportedRequests|tokenUnreportedRequests/);
assert.match(popup, /data-workspace-panel="translation"/);
assert.match(popup, /data-workspace-panel="display"/);
assert.match(popup, /data-workspace-panel="tools"/);
assert.match(popupSource, /function activateWorkspace/);
assert.match(popupCss, /\.workspace-tab\.on::after/);
assert.match(popupCss, /prefers-reduced-motion/);
assert.match(popupCss, /--surface:\s*#ffffff/);
assert.match(popupCss, /body\s*\{[\s\S]*?width:\s*320px/);
assert.match(popupCss, /:root[\s\S]*?font-size:\s*15px/);
assert.match(popupCss, /\.export-btn[\s\S]*?font-size:\s*13\.5px;[\s\S]*?font-weight:\s*400/);
assert.match(popup, /id="toolsFooter"[\s\S]*?id="importConfig"[\s\S]*?id="exportConfig"[\s\S]*?id="reset"/);
assert.match(popupCss, /\.ft\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(3/);
assert.doesNotMatch(popupCss, /\.ft\s*\{[^}]*border-top/);
assert.match(popupSource, /document\.body\.dataset\.workspace = activeWorkspace/);
assert.match(popupCss, /body\[data-workspace="tools"\]\s*\{[^}]*overflow-y:\s*hidden/);
assert.match(popupCss, /\.token-grid span\s*\{\s*white-space:\s*nowrap/);
assert.doesNotMatch(popupCss, /\.token-grid > div\s*\{[^}]*flex-direction:\s*column/);
assert.match(popupSource, /const compactTokenFormatter = new Intl\.NumberFormat/);
assert.match(popupSource, /element\.title = exact/);
assert.match(popupCss, /\.ft button\.danger/);
assert.match(popupCss, /#deleteAiProfile\s*\{[\s\S]*?color:\s*var\(--danger\)/);
assert.match(popupCss, /\.section-divider\s*\{[^}]*border-top:\s*1px solid var\(--line\)/);
assert.doesNotMatch(popupCss, /\.section-divider\s*\{[^}]*linear-gradient/);
assert.doesNotMatch(popupCss, /Bahnschrift|Cascadia Code|monospace/);
assert.equal(manifest.action.default_title, "__MSG_extName__");
assert.match(popup, /class="hd-mark" src="icons\/icon48\.png"/);
assert.match(fs.readFileSync(path.join(root, "inject.js"), "utf8"), /parts\.push\(part\)/);

const localeNames = ["en", "zh_CN"];
const popupI18nKeys = Array.from(popup.matchAll(
  /data-i18n(?:-html|-title|-aria)?="([A-Za-z0-9_]+)"/g
), (match) => match[1]);
const localeKeys = localeNames.map((name) => Object.keys(JSON.parse(
  fs.readFileSync(path.join(root, "_locales", name, "messages.json"), "utf8")
)).sort());
assert.deepEqual(localeKeys[1], localeKeys[0]);
for (const name of localeNames) {
  const messages = JSON.parse(fs.readFileSync(
    path.join(root, "_locales", name, "messages.json"), "utf8"
  ));
  assert.ok(messages.extName.message.length <= 45, `${name} extension name is too long`);
  assert.ok(messages.extDesc.message.length <= 132, `${name} extension description is too long`);
  assert.doesNotMatch(messages.extDesc.message, /DeepSeek/i);
  for (const key of popupI18nKeys) assert.ok(messages[key], `${name} missing popup i18n key ${key}`);
}
assert.equal(fs.existsSync(path.join(root, "_locales", "zh_TW", "messages.json")), false);
const currentDocs = ["README.md", "README.zh-CN.md"]
  .map((name) => fs.readFileSync(path.join(root, name), "utf8")).join("\n");
assert.doesNotMatch(`${popup}\n${popupSource}\n${currentDocs}`, /兼容优先|most compatible/);
assert.doesNotMatch(`${popup}\n${popupCss}\n${content}\n${currentDocs}`, /LingoCue/);
assert.doesNotMatch(currentDocs,
  /gythiro\.github\.io|chromewebstore\.google\.com|ndifcigakimmibkgeabchfaolhjpcmge|Official Website|官方网站/);
assert.doesNotMatch(currentDocs, /16 target languages|16 种目标语言|0[–～-]3 batches|0[–～-]3 批/);
assert.doesNotMatch(currentDocs, /1600\s*ms|1600ms/);
assert.match(currentDocs, /4000\s*ms|4000ms/);
assert.match(currentDocs, /chrome\.storage\.session/);
assert.match(currentDocs, /词法坐标/);
assert.match(currentDocs, /lexical coordinates/);
assert.match(currentDocs, /stream: true/);
assert.match(currentDocs, /16-item guard|16 个坐标/);
assert.match(currentDocs, /Canvas/);
assert.match(currentDocs, /0[–-]20/);
assert.match(currentDocs, /0[–-]10/);
for (const size of [16, 48, 128]) {
  assert.ok(fs.existsSync(path.join(root, "icons", `icon${size}.png`)));
}

console.log("Regression checks passed.");
