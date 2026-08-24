"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  SHARED_FILES,
  MAIN_FILES,
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
assert.equal("captionTrackMode" in shared.DEFAULTS, false);
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
assert.equal(shared.isSameLanguage("EN", "en"), true);
assert.equal(shared.isSameLanguage("en-US", "en"), true);
assert.equal(shared.isSameLanguage("zh-Hant", "zh-CN"), false);
assert.equal(shared.isSameLanguage("", "en"), false);
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
assert.equal(shared.resolveFullscreenState(true, {}, false), true);
assert.equal(shared.resolveFullscreenState(true, null, true), false,
  "native fullscreen exit must win over a stale YouTube fullscreen class");
assert.equal(shared.resolveFullscreenState(false, null, true), true,
  "the player class remains a fallback when the native API is unavailable");
assert.equal(shared.semanticPauseKind(899, 900, 4000), "none");
assert.equal(shared.semanticPauseKind(900, 900, 4000), "soft");
assert.equal(shared.semanticPauseKind(3999, 900, 4000), "soft");
assert.equal(shared.semanticPauseKind(4000, 900, 4000), "hard");

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
assert.deepEqual(manifest.content_scripts[0].js, [...SHARED_FILES, ...MAIN_FILES]);
assert.deepEqual(manifest.content_scripts[1].js, [...SHARED_FILES, ...CONTENT_FILES]);
assert.deepEqual(manifest.host_permissions, [
  "https://*/*",
  "http://localhost/*",
  "http://127.0.0.1/*"
]);
assert.equal("optional_host_permissions" in manifest, false);

const content = readSourceFiles(CONTENT_FILES);
const background = readSourceFiles(BACKGROUND_FILES);
const sharedSource = readSourceFiles(SHARED_FILES);
const mainSource = readSourceFiles(MAIN_FILES);
const popup = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const popupSource = readSourceFiles(POPUP_FILES);
assert.doesNotMatch(content, /settings\.engine|gtxRequest|tlang/);
assert.doesNotMatch(background, /translate\.googleapis|function gtxFetch|ytdsGtxGate/);
assert.doesNotMatch(content, /ytds-toggle|ensureToggleButton|controlsObserver/);
assert.doesNotMatch(content, /postMessage\([\s\S]{0,240}["']\*["']/);
assert.match(background, /contextFuture/);
assert.match(background, /FUTURE_CONTEXT/);
assert.match(background, /isYoutubeSender\(sender\)/);
assert.match(background, /videoIdMatchesPageUrls\(msg\.videoId, senderPageUrls\(sender\)\)/);
assert.doesNotMatch(background, /videoIdFromUrl\(sender\.url \|\| sender\.tab\.url/);
assert.doesNotMatch(background, /repairSuspiciousSemanticTranslations/);
assert.doesNotMatch(background, /semantic-translation-repair/);
assert.doesNotMatch(sharedSource, /translationQualityIssue/);
assert.doesNotMatch(background, /final line shaped \{"type":"done","deferred_ids"/);
assert.doesNotMatch(background, /function deepseekTranslateCueFallback/);
assert.doesNotMatch(background, /causal-cue-request/);
assert.match(background, /chrome\.webRequest\.onErrorOccurred/);
assert.doesNotMatch(background, /MAX_UNITS_PER_MINUTE/);
assert.doesNotMatch(background, /state\.recent/);
assert.doesNotMatch(content, /const inflightKey = `dsb:\$\{regionIndex\}:\$\{requestStart\}:\$\{requestEnd\}`/);
assert.doesNotMatch(content, /semantic-unit-overlap-resolved/);
assert.doesNotMatch(content, /semantic-coverage-repair-start/);
assert.doesNotMatch(content, /resp\.partial \? "partial response" : "missing items"/);
assert.doesNotMatch(sharedSource, /function splitCueAtomsAtSentenceBoundaries/);
assert.doesNotMatch(
  content,
  /groups: (?:captionSession\.)?sentGroups \? (?:captionSession\.)?sentGroups\.map/
);
assert.doesNotMatch(content, /DEEPSEEK_DISPLAY_GAP_BRIDGE_MS/);
assert.equal((content.match(/chrome\.runtime\.sendMessage/g) || []).length, 1);
assert.match(popup, /id="deepseekContextFuture"/);
assert.match(popup, /id="deepseekPrefetchBatches"/);
assert.match(popup, /id="deepseekContextPast" type="number" min="0" max="20"/);
assert.match(popup, /id="deepseekContextFuture" type="number" min="0" max="20"/);
assert.match(popup, /id="deepseekPrefetchBatches" type="number" min="0" max="10"/);
assert.doesNotMatch(popup, /value="zh-TW"|中文（繁體）/);
assert.match(popupSource, /normalizeTargetLang\(state\.targetLang\)/);
assert.match(popup, /id="captionTrackSelect"/);
assert.match(popup, /<option value="auto"[\s\S]*?captionTrackAuto/);
assert.match(popupSource, /setCaptionTrack/);
assert.doesNotMatch(popup, /captionTrackMode/);
assert.doesNotMatch(popupSource, /setKey\("captionTrackMode"/);
assert.match(content, /type === "getCaptionTracks"/);
assert.match(content, /type === "setCaptionTrack"/);
assert.match(content, /availableCaptionTracks/);
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
assert.doesNotMatch(popupSource, /visualDefaultsVersion|contextDefaultsVersion|lineDefaultsVersion/);
assert.doesNotMatch(popup, /deepseekFutureWarning|下文大于 0/);
assert.doesNotMatch(popupSource, /deepseekFutureWarning/);
assert.doesNotMatch(popup, /data-i18n="(?:logHelp|debugHint)"|日志说明/);
assert.doesNotMatch(popup, /tokenMeta|tokenUsageHint|已报告响应/);
assert.doesNotMatch(popupSource, /debugCopied|debugCleared|tokenReportedRequests|tokenUnreportedRequests/);
assert.match(popup, /data-workspace-panel="translation"/);
assert.match(popup, /data-workspace-panel="display"/);
assert.match(popup, /data-workspace-panel="tools"/);
assert.doesNotMatch(popup, /<h1[^>]*>CaptionAI Duo<\/h1>/);
assert.match(popupSource, /function activateWorkspace/);
assert.doesNotMatch(popup, /class="hd"|id="enabled"/);
assert.match(popup, /id="toolsFooter"[\s\S]*?id="importConfig"[\s\S]*?id="exportConfig"[\s\S]*?id="reset"/);
assert.match(popupSource, /document\.body\.dataset\.workspace = activeWorkspace/);
assert.match(popupSource, /const compactTokenFormatter = new Intl\.NumberFormat/);
assert.match(popupSource, /element\.title = exact/);
assert.equal(manifest.action.default_title, "__MSG_extName__");
assert.match(mainSource, /parts\.push\(part\)/);

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
assert.doesNotMatch(`${popup}\n${popupSource}\n${content}\n${currentDocs}`, /LingoCue/);
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
