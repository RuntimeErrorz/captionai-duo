"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CONTENT_FILES,
  MAIN_FILES,
  POPUP_FILES,
  readSourceFiles,
  loadSharedGlobal
} = require("./helpers");

const root = path.resolve(__dirname, "..");
const shared = loadSharedGlobal();
const readRoot = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(readRoot("manifest.json"));
const popupHtml = readRoot("popup.html");
const popupSource = readSourceFiles(POPUP_FILES);
const localeNames = ["en", "zh_CN"];
const locales = Object.fromEntries(localeNames.map((name) =>
  [name, JSON.parse(readRoot(`_locales/${name}/messages.json`))]));

// ---- shared settings and provider contracts --------------------------------

test("defaults keep both caption lines visually identical and target DeepSeek", () => {
  const d = shared.DEFAULTS;
  assert.equal(d.aiContextPast, 1);
  assert.equal(d.aiContextFuture, 1);
  assert.equal(d.aiPrefetchBatches, 5);
  assert.equal(d.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(d.aiModel, "deepseek-v4-flash");
  assert.equal(d.aiExtraBodyRevision, 0);
  assert.equal(d.order, "trans-top");
  assert.equal(d.transColor, "#ffffff");
  assert.equal(d.transBgOpacity, 0);
  assert.equal(d.transStrokeOpacity, 1);
  for (const suffix of ["Font", "Size", "FullscreenSize", "Color", "Bg", "BgOpacity",
    "Stroke", "StrokeOpacity", "StrokeWidth"]) {
    assert.equal(d[`orig${suffix}`], d[`trans${suffix}`], suffix);
  }
});

test("target languages and same-language detection", () => {
  assert.equal(shared.TARGET_LANGS.length, 15);
  assert.equal(shared.TARGET_LANGS.includes("zh-TW"), false);
  assert.equal(shared.isSameLanguage("EN", "en"), true);
  assert.equal(shared.isSameLanguage("en-US", "en"), true);
  assert.equal(shared.isSameLanguage("zh-Hant", "zh-CN"), false);
  assert.equal(shared.isSameLanguage("", "en"), false);
});

test("provider classification follows only the base URL", () => {
  assert.equal(shared.aiEndpointKind("https://api.deepseek.com"), "deepseek");
  assert.equal(shared.aiEndpointKind("https://gateway.example/v1"), "compatible");
  assert.equal(shared.aiEndpointKind("https://generativelanguage.googleapis.com/v1beta/openai"), "compatible");
  assert.equal(shared.aiProviderKind, undefined);
});

test("API bases require HTTPS except local servers and never carry credentials", () => {
  assert.equal(shared.normalizeAiBaseUrl("https://gateway.example/v1/"),
    "https://gateway.example/v1");
  assert.equal(shared.normalizeAiBaseUrl("http://localhost:11434/v1"),
    "http://localhost:11434/v1");
  assert.equal(shared.normalizeAiBaseUrl("http://gateway.example/v1"), "");
  assert.equal(shared.normalizeAiBaseUrl("https://user:pass@gateway.example/v1"), "");
  assert.equal(shared.aiChatCompletionsUrl("https://gateway.example/v1"),
    "https://gateway.example/v1/chat/completions");
  assert.equal(shared.aiChatCompletionsUrl("https://gateway.example/v1/chat/completions"),
    "https://gateway.example/v1/chat/completions");
  assert.equal(shared.aiCredentialScope("https://api.deepseek.com"), "deepseek");
  assert.equal(shared.aiCredentialScope("https://gateway.example/v1"),
    "custom:https://gateway.example/v1");
});

test("completion text accepts both message and streamed delta shapes", () => {
  assert.equal(shared.aiCompletionText({ choices: [{ message: { content: "complete" } }] }),
    "complete");
  assert.equal(shared.aiCompletionText({ choices: [{ delta: { content: [
    { type: "text", text: "stream" }, { type: "text", text: "ed" }
  ] } }] }), "streamed");
});

test("chat completion bodies adapt to provider, thinking mode and JSONL", () => {
  const thinking = shared.aiChatCompletionBody({
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    extraBody: { thinking: { type: "enabled" }, reasoning_effort: "high" }
  }, [{ role: "user", content: "JSON only" }], 4096, 0.1);
  assert.equal(thinking.stream, true);
  assert.equal(thinking.stream_options.include_usage, true);
  assert.equal(thinking.response_format.type, "json_object");
  assert.equal(thinking.thinking.type, "enabled");
  assert.equal(thinking.reasoning_effort, "high");
  assert.equal("temperature" in thinking, false, "thinking mode rejects temperature");
  assert.equal(shared.aiExtraBodyUsesThinking({
    thinking: { type: "enabled" }, reasoning_effort: "high"
  }), true);
  assert.equal(shared.aiExtraBodyUsesThinking({ enable_thinking: false }), false);

  const jsonl = shared.aiChatCompletionBody({
    baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash"
  }, [{ role: "user", content: "JSONL only" }], 4096, 0.1, { jsonLines: true });
  assert.equal(jsonl.stream, true);
  assert.equal(jsonl.stream_options.include_usage, true);
  for (const key of ["response_format", "thinking", "reasoning_effort"]) {
    assert.equal(key in jsonl, false, key);
  }

  const local = shared.aiChatCompletionBody({
    baseUrl: "http://localhost:11434/v1", model: "local-model"
  }, [{ role: "user", content: "JSON only" }], 4096, 0.1);
  assert.equal(local.stream, true);
  assert.equal(local.model, "local-model");
  assert.equal(local.temperature, 0.1);
  assert.equal("response_format" in local, false);
  assert.equal("thinking" in local, false);
  assert.equal(local.stream_options.include_usage, true);
});

test("numeric AI settings round and clamp", () => {
  assert.equal(shared.normalizeAiPrefetchBatches(2.6), 3);
  assert.equal(shared.normalizeAiRequestItems(96.4), 96);
  assert.equal(shared.normalizeAiRequestItems("invalid", 128), 128);
  assert.equal(shared.normalizeAiContextCount(12.6, 5), 13);
});

test("popup number inputs advertise exactly the range their normalizer enforces", () => {
  const normalizers = {
    aiContextPast: (value) => shared.normalizeAiContextCount(value, 1),
    aiContextFuture: (value) => shared.normalizeAiContextCount(value, 1),
    aiPrefetchBatches: (value) => shared.normalizeAiPrefetchBatches(value),
    aiRequestItems: (value) => shared.normalizeAiRequestItems(value, 96)
  };
  for (const [id, normalize] of Object.entries(normalizers)) {
    const input = popupHtml.match(new RegExp(`<input id="${id}"[^>]*>`));
    assert.ok(input, `popup is missing #${id}`);
    const min = Number(input[0].match(/\bmin="(-?\d+)"/)[1]);
    const max = Number(input[0].match(/\bmax="(-?\d+)"/)[1]);
    assert.equal(normalize(-1e6), min, `${id} min`);
    assert.equal(normalize(1e6), max, `${id} max`);
  }
});

test("fullscreen state prefers the native API over stale player classes", () => {
  assert.equal(shared.resolveFullscreenState(true, {}, false), true);
  assert.equal(shared.resolveFullscreenState(true, null, true), false,
    "native fullscreen exit must win over a stale YouTube fullscreen class");
  assert.equal(shared.resolveFullscreenState(false, null, true), true,
    "the player class remains a fallback when the native API is unavailable");
});

// ---- YouTube identity and timing -------------------------------------------

test("video ids come from every YouTube watch URL shape", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com/shorts/abcdefghijk",
    "https://www.youtube.com/live/abcdefghijk?feature=share",
    "https://www.youtube.com/embed/abcdefghijk"
  ]) assert.equal(shared.videoIdFromUrl(url), "abcdefghijk", url);
  assert.equal(shared.videoIdFromUrl("https://www.youtube.com/"), "");
});

test("sender video ids must match a trusted YouTube page URL", () => {
  assert.equal(shared.isYoutubePageUrl("https://www.youtube.com/"), true);
  assert.equal(shared.isYoutubePageUrl("https://evil.example/watch?v=abcdefghijk"), false);
  assert.equal(shared.videoIdMatchesPageUrls("abcdefghijk", [
    "https://www.youtube.com/watch?v=abcdefghijk", "https://www.youtube.com/"
  ]), true);
  // Browser cold start: the restored document URL has no video id yet.
  assert.equal(shared.videoIdMatchesPageUrls("abcdefghijk", ["https://www.youtube.com/"]), true);
  // YouTube SPA: the current tab URL wins over a stale sender document URL.
  const spaUrls = [
    "https://www.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com/watch?v=oldvideo123"
  ];
  assert.equal(shared.videoIdMatchesPageUrls("abcdefghijk", spaUrls), true);
  assert.equal(shared.videoIdMatchesPageUrls("oldvideo123", spaUrls), false);
  assert.equal(shared.videoIdMatchesPageUrls("abcdefghijk", ["https://evil.example/"]), false);
});

test("only YouTube's HTTPS timedtext endpoint is accepted", () => {
  assert.equal(shared.isAllowedTimedtextUrl("https://www.youtube.com/api/timedtext?v=abcdefghijk"), true);
  assert.equal(shared.isAllowedTimedtextUrl("https://evil.example/api/timedtext?v=abcdefghijk"), false);
  assert.equal(shared.isAllowedTimedtextUrl("http://www.youtube.com/api/timedtext?v=abcdefghijk"), false);
  assert.equal(shared.isAllowedTimedtextUrl("https://www.youtube.com/not/api/timedtext"), false);
});

test("pause classification and overlapping ASR cues", () => {
  assert.equal(shared.semanticPauseKind(899, 900, 4000), "none");
  assert.equal(shared.semanticPauseKind(900, 900, 4000), "soft");
  assert.equal(shared.semanticPauseKind(3999, 900, 4000), "soft");
  assert.equal(shared.semanticPauseKind(4000, 900, 4000), "hard");
  // Overlapping ASR cues are never a pause, even when lastOff is missing/early.
  assert.equal(shared.cuePauseMs(
    { start: 195200, end: 201200, dur: 6000, lastOff: 195200 }, { start: 199280 }
  ), -1920);
  assert.equal(shared.cuePauseMs(
    { start: 1000, end: 2000, dur: 1000, lastOff: 1800 }, { start: 3800 }
  ), 1800);
});

test("causal cue groups keep each cue as its own group", () => {
  const groups = shared.causalCueGroups([
    { start: 0, end: 900, text: "I bought" },
    { start: 900, end: 1800, text: "a car." }
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].text, "I bought");
  assert.equal(groups[1].text, "a car.");
  assert.equal(groups[0].endIdx, 0);
});

// ---- semantic segmentation and display -------------------------------------

const segmentItems = [
  { id: "0", text: "its own police force,", startMs: 0, endMs: 1200, hardAfter: false },
  { id: "1", text: "its own mayor,", startMs: 1200, endMs: 2200, hardAfter: false },
  { id: "2", text: "and its government.", startMs: 2200, endMs: 3500, hardAfter: true }
];
const segmentsJson = (segments) => JSON.stringify({ segments });

test("semantic segments share one unit and never cross a hard boundary", () => {
  const segmented = shared.segmentedTranslationsFromJsonText(segmentsJson([
    { start: 0, end: 2, translation: "它拥有自己的警察、市长和政府。" }
  ]), segmentItems);
  assert.equal(segmented.length, 3);
  assert.equal(segmented[0].translation, segmented[2].translation);
  assert.equal(segmented[0].unitId, "semantic-0-2");
  assert.equal(shared.segmentedTranslationsFromJsonText(segmentsJson([
    { start: 0, end: 0, translation: "invalid" }
  ]), segmentItems), null);
  assert.equal(shared.segmentedTranslationsFromJsonText(segmentsJson([
    { start: 0, end: 1, translation: "invalid hard-boundary merge" },
    { start: 2, end: 2, translation: "ok" }
  ]), [{ ...segmentItems[0], hardAfter: true }, segmentItems[1], segmentItems[2]]), null);
});

test("rolling cues may form a long sentence, but not an oversized one", () => {
  // Rolling YouTube cues can make one valid semantic sentence span more than
  // fifteen seconds even though the source remains a compact display unit.
  const rollingItems = [
    { id: "42", text: "You can leave it a mess on a", startMs: 195200, endMs: 201200, hardAfter: false },
    { id: "43", text: "Friday night and not worry about it, but it's also got", startMs: 199280, endMs: 207280, hardAfter: false },
    { id: "44", text: "that awesome flow.", startMs: 203760, endMs: 211760, hardAfter: false }
  ];
  const rolling = shared.segmentedTranslationsFromJsonText(segmentsJson([
    { start: 0, end: 2, translation: "你可以在周五晚上把这里弄得一团糟，也不用担心，而且动线也很棒。" }
  ]), rollingItems);
  assert.equal(rolling.length, 3);
  assert.equal(rolling[0].unitId, "semantic-42-44");

  const diagnostics = {};
  assert.equal(shared.segmentedTranslationsFromJsonText(segmentsJson([
    { start: 0, end: 2, translation: "too long" }
  ]), rollingItems.map((item, index) => index === 2 ? { ...item, endMs: 240201 } : item),
  diagnostics), null);
  assert.match(diagnostics.reason, /oversized segment/);
});

test("display pages never end on a dangling preposition", () => {
  const pages = shared.splitTextForDisplay(
    "You can cook in here. You can make a mess. You can leave it a mess on a Friday night and not worry about it.",
    2,
    (text) => text.length
  );
  assert.equal(pages.length, 2);
  assert.ok(pages.some((page) => page.text.includes("on a Friday night")));
  assert.ok(pages.every((page) => !/\bon a$/i.test(page.text)));
});

test("aligned display pages keep each source sentence with its translation", () => {
  const aligned = shared.splitAlignedSentencesForDisplay(
    "Did you notice this space? This is dead space. It's not in line with your bar. Now, put the closet here. Imagine waking up and running up and down the Westside Highway. How amazing is that? Getting on your bike and going to",
    "你注意到这个空间了吗？这是一个死空间，甚至与你的吧台不在一条线上。现在，把衣柜放在这里。想象一下，醒来后在西区高速公路上来回奔跑。这有多棒？骑上自行车去",
    4
  );
  assert.equal(aligned.sourcePages.length, 4);
  const page = aligned.sourcePages.findIndex((entry) => entry.text.includes("Westside Highway"));
  assert.ok(page >= 0);
  assert.match(aligned.translationPages[page].text, /西区高速公路上来回奔跑/);
  assert.match(aligned.sourcePages[page].text, /put the closet here/);
  assert.match(aligned.translationPages[page].text, /衣柜放在这里/);

  const dwell = shared.splitAlignedSentencesForDisplay(
    ">> But my job is to analyze and commentate and give life to what's happening inside the octagon. And I try not to dwell too much on the money. I just want them",
    ">> 但我的工作只是分析、评论并为八角笼内发生的事情增添活力。我尽量不过多纠结于钱，我只希望他们",
    2
  );
  assert.equal(dwell.sourcePages.length, 2);
  assert.doesNotMatch(dwell.sourcePages[0].text, /dwell/i);
  assert.match(dwell.sourcePages[1].text, /dwell too much on the money/i);
  assert.match(dwell.translationPages[1].text, /纠结于钱/);

  assert.deepEqual(shared.displayPageAssignments(
    [{ start: 0, end: 108 }, { start: 109, end: 140 }],
    [{ start: 0, end: 100 }, { start: 84, end: 140 }]
  ), [0, 1]);
});

// ---- extension package contracts -------------------------------------------

test("manifest metadata, permissions and icons", () => {
  assert.equal(manifest.minimum_chrome_version, "111");
  assert.equal(manifest.version, "1.6.0");
  assert.equal(manifest.action.default_title, "__MSG_extName__");
  assert.deepEqual(manifest.permissions, ["storage", "webRequest"]);
  assert.deepEqual(manifest.host_permissions, ["https://*/*"]);
  assert.deepEqual(manifest.optional_host_permissions, [
    "http://localhost/*", "http://127.0.0.1/*"
  ]);
  for (const size of [16, 48, 128]) {
    assert.ok(fs.existsSync(path.join(root, "icons", `icon${size}.png`)), `icon${size}.png`);
  }
});

test("window messages are always addressed to the page's own origin", () => {
  // A "*" target would hand caption and track data to any embedded frame.
  const runtime = readSourceFiles([...CONTENT_FILES, ...MAIN_FILES]);
  assert.ok(/\bpostMessage\(/.test(runtime));
  assert.doesNotMatch(runtime, /postMessage\([\s\S]{0,240}["']\*["']/);
});

test("content scripts reach the worker through one guarded sendMessage wrapper", () => {
  const content = readSourceFiles(CONTENT_FILES);
  assert.equal((content.match(/chrome\.runtime\.sendMessage/g) || []).length, 1);
});

test("every element the popup scripts bind exists in popup.html", () => {
  const ids = new Set(Array.from(popupSource.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g), (m) => m[1]));
  assert.ok(ids.size > 30);
  for (const id of ids) {
    assert.match(popupHtml, new RegExp(`\\bid="${id}"`), `popup.html is missing #${id}`);
  }
});

test("popup workspaces keep their documented control order", () => {
  const order = (...needles) => {
    const positions = needles.map((needle) => popupHtml.indexOf(needle));
    positions.forEach((position, index) => assert.ok(position >= 0, needles[index]));
    for (let index = 1; index < positions.length; index++) {
      assert.ok(positions[index - 1] < positions[index], `${needles[index - 1]} before ${needles[index]}`);
    }
  };
  const panelCount = (panel) => popupHtml.split(`data-workspace-panel="${panel}"`).length - 1;
  assert.equal(panelCount("display"), 1);
  assert.ok(panelCount("translation") >= 1);
  assert.ok(panelCount("tools") >= 1);
  order('id="aiProfileSelect"', 'id="newAiProfile"', 'id="renameAiProfile"',
    'id="deleteAiProfile"', 'class="section-divider configuration-divider"', 'id="targetLang"');
  order('id="aiProfileNameEditor"', 'id="cancelRenameAiProfile"');
  order('id="panel-display"', 'data-i18n="secSubtitleAppearance"', 'class="layout-row"',
    'class="section-divider display-divider"', 'class="line-tabs-row"');
  order('id="toolsFooter"', 'id="importConfig"', 'id="exportConfig"', 'id="reset"');
  assert.ok(popupHtml.includes('class="gap-control"'));
  assert.ok(popupHtml.includes('class="compact-grid grid-2 translation-basics"'));
});

test("both locales define the same keys, including every key the UI uses", () => {
  const [en, zh] = localeNames.map((name) => Object.keys(locales[name]).sort());
  assert.deepEqual(zh, en);
  const used = new Set([
    ...Array.from(popupHtml.matchAll(/data-i18n(?:-html|-title|-aria)?="([A-Za-z0-9_]+)"/g), (m) => m[1]),
    ...Array.from(popupSource.matchAll(/\bt\("([A-Za-z0-9_]+)"/g), (m) => m[1])
  ]);
  for (const name of localeNames) {
    const messages = locales[name];
    assert.ok(messages.extName.message.length <= 45, `${name} extension name is too long`);
    assert.ok(messages.extDesc.message.length <= 132, `${name} extension description is too long`);
    for (const key of used) assert.ok(messages[key], `${name} is missing i18n key ${key}`);
  }
});

test("READMEs document the current protocol and limits", () => {
  const docs = ["README.md", "README.zh-CN.md"].map(readRoot).join("\n");
  for (const pattern of [/4000\s*ms|4000ms/, /chrome\.storage\.session/, /词法坐标/,
    /lexical coordinates/, /stream: true/, /16-item guard|16 个坐标/, /Canvas/, /0[–-]20/, /0[–-]10/]) {
    assert.match(docs, pattern);
  }
});
