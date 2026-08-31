"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const popupSource = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

function popupContext() {
  const nodes = {
    captionTrackSelect: {
      options: [],
      value: "",
      replaceChildren(...children) { this.options = children; }
    },
    translationTrackSelect: {
      options: [],
      value: "",
      replaceChildren(...children) { this.options = children; }
    },
    captionTrackHint: {
      hidden: false,
      textContent: "",
      classList: { add: () => {}, remove: () => {} }
    }
  };
  const context = {
    YTDS_SHARED: { DEFAULTS: {} },
    chrome: {
      i18n: { getMessage: () => "", getUILanguage: () => "en" },
      storage: {
        onChanged: { addListener: () => {} },
        sync: { get: () => {} },
        local: { get: () => {} }
      }
    },
    document: {
      addEventListener: () => {},
      querySelectorAll: () => [],
      getElementById: (id) => nodes[id] || null,
      createElement: () => ({ value: "", textContent: "" })
    },
    window: { addEventListener: () => {} }
  };
  vm.createContext(context);
  vm.runInContext(popupSource, context, { filename: "popup.js" });
  context.nodes = nodes;
  return context;
}

test("caption labels use YouTube's track name without rewriting it", () => {
  const context = popupContext();
  assert.equal(vm.runInContext(
    "safeCaptionTrack({id: 'track:en:asr:a.en', label: 'English (auto-generated)', languageCode: 'en', kind: 'asr'}).label",
    context
  ), "English (auto-generated)");
  assert.equal(vm.runInContext(
    "safeCaptionTrack({id: 'track:zh-cn:asr:a.zh', label: '英语（自动生成）', languageCode: 'zh-CN', kind: 'asr'}).label",
    context
  ), "英语（自动生成）");
  assert.equal(vm.runInContext(
    "safeCaptionTrack({id: 'track:en:manual:m.en', label: 'English (auto-generated)', languageCode: 'en', kind: 'manual'}).label",
    context
  ), "English (auto-generated)");
});

test("code-only caption labels get a readable fallback without changing track identity", () => {
  const context = popupContext();
  const track = vm.runInContext(
    "safeCaptionTrack({id: 'track:en:asr:a.en', label: 'en', languageCode: 'en', kind: 'asr'})",
    context
  );
  assert.equal(track.label, "English (auto-generated)");
  assert.equal(track.id, "track:en:asr:a.en");
  assert.equal(track.kind, "asr");
});

test("automatic caption selection displays the resolved track without an auto option", () => {
  const context = popupContext();
  context.paintCaptionTrackOptions({
    tracks: [{
      id: "track:en:asr:a.en",
      label: "English (auto-generated)",
      languageCode: "en",
      kind: "asr"
    }, {
      id: "track:en:manual:preferred",
      label: "English (United Kingdom)",
      languageCode: "en",
      kind: "manual"
    }],
    preferredTrackId: "track:en:manual:preferred",
    selectedTrackId: "auto",
    selectedTranslationTrackId: "ai"
  });

  const preferred = context.nodes.captionTrackSelect.options.find(
    (option) => option.value === "track:en:manual:preferred"
  );
  assert.equal(preferred.textContent, "English (United Kingdom)");
  assert.equal(context.nodes.captionTrackSelect.value, "track:en:manual:preferred");
  assert.deepEqual(
    context.nodes.captionTrackSelect.options.map((option) => [option.value, option.textContent]),
    [["track:en:asr:a.en", "English (auto-generated)"],
      ["track:en:manual:preferred", "English (United Kingdom)"]]
  );
  assert.deepEqual(
    context.nodes.translationTrackSelect.options.map((option) => [option.value, option.textContent]),
    [["ai", "AI 翻译"], ["track:en:asr:a.en", "English (auto-generated)"],
      ["track:en:manual:preferred", "English (United Kingdom)"]]
  );

  context.paintCaptionTrackOptions({
    tracks: [{
      id: "track:en:asr:a.en",
      label: "English (auto-generated)",
      languageCode: "en",
      kind: "asr"
    }, {
      id: "track:en:manual:preferred",
      label: "English (United Kingdom)",
      languageCode: "en",
      kind: "manual"
    }],
    preferredTrackId: "track:en:manual:preferred",
    selectedTrackId: "track:en:manual:preferred",
    selectedTranslationTrackId: "ai"
  });
  assert.equal(context.nodes.captionTrackSelect.value, "track:en:manual:preferred");
  assert.equal(context.nodes.captionTrackSelect.options.length, 2);
});
