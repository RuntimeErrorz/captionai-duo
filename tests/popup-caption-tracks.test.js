"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const popupSource = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

function popupContext() {
  const context = {
    YTDS_SHARED: { DEFAULTS: {} },
    chrome: {
      i18n: { getMessage: () => "" },
      storage: {
        onChanged: { addListener: () => {} },
        sync: { get: () => {} },
        local: { get: () => {} }
      }
    },
    document: { addEventListener: () => {}, querySelectorAll: () => [] },
    window: { addEventListener: () => {} }
  };
  vm.createContext(context);
  vm.runInContext(popupSource, context, { filename: "popup.js" });
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
