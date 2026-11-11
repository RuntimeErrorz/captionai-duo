#!/usr/bin/env node
// Real-provider benchmark for request sizing and prompt variants.
//
//   node scripts/benchmark-providers.js --config <settings-backup.json> --log <debug-log.json> [--log ...]
//        [--windows 64,96,160,320] [--prompt-append "candidate rule"] [--repeat 2]
//        [--profiles name1,name2] [--samples 3] [--span] [--dry-run]
// --span joins two unrelated samples at a hard 4 s pause, as a request that
// spans hard-pause regions does; units must not cross that boundary.
//
// --config is the file exported from the popup (Tools > Export settings); API
// keys are read from it and used only for requests from this machine. --log
// is an exported debug log whose request rows provide real subtitle samples.
// The results file holds timings, token counts and protocol statistics only:
// no API key and no subtitle or translated text.
//
// Node's fetch ignores the system proxy. Where a provider needs one (Gemini
// from an unsupported region answers HTTP 400 "User location is not
// supported"), set HTTPS_PROXY and run Node with --use-env-proxy (Node 22.21+).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const { loadShared } = require(path.join(root, "tests/helpers.js"));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// ---- arguments ---------------------------------------------------------------
const args = { logs: [], windows: [64, 96, 160, 320], variants: ["current"], promptAppend: "",
  repeat: 2, samples: 3, profiles: null, dryRun: false, config: "" };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  const next = () => process.argv[++i];
  if (flag === "--config") args.config = next();
  else if (flag === "--log") args.logs.push(next());
  else if (flag === "--windows") args.windows = next().split(",").map(Number).filter((n) => n > 0);
  else if (flag === "--prompt-append") { args.promptAppend = next(); args.variants = ["current", "appended"]; }
  else if (flag === "--repeat") args.repeat = Math.max(1, Number(next()) || 1);
  else if (flag === "--samples") args.samples = Math.max(1, Number(next()) || 1);
  else if (flag === "--profiles") args.profiles = next().split(",");
  else if (flag === "--dry-run") args.dryRun = true;
  else if (flag === "--span") args.span = true;
  else if (flag === "--urgent") args.urgent = true;
  else throw new Error(`unknown argument ${flag}`);
}
if (!args.config && !args.dryRun) throw new Error("--config <exported settings> is required");
if (!args.logs.length) throw new Error("--log <exported debug log> is required");

const shared = loadShared();

// ---- prompt variants -----------------------------------------------------------
// "current" is the shipped prompt. --prompt-append adds a candidate rule to
// the system prompt as the "appended" variant, so a wording can be measured
// against the shipped one before it is adopted.
function translationSource(variant) {
  let source = read("background/translation.js");
  if (variant === "appended") {
    const text = String(args.promptAppend || "");
    const fullEnd = source.indexOf("`;", source.indexOf("const FULL_SEGMENT_SYSTEM_PROMPT"));
    if (!text || fullEnd < 0) throw new Error("--prompt-append needs text and a known prompt anchor");
    source = source.slice(0, fullEnd) + "\n\n" + text.replace(/[`\\$]/g, "\\$&") + source.slice(fullEnd);
  } else if (variant !== "current") {
    throw new Error(`unknown variant ${variant}`);
  }
  return source;
}

// ---- samples from debug logs ---------------------------------------------------
function samplesFromLogs(files, count) {
  const found = [];
  for (const file of files) {
    const log = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const entry of log.entries || []) {
      const data = entry && entry.data;
      if (entry.event !== "semantic-batch-request" || !data || !Array.isArray(data.currentRows)) continue;
      found.push({
        rows: data.currentRows, sourceLang: data.sourceLang || "en",
        contextBefore: data.contextBefore || [], contextAfter: data.contextAfter || []
      });
    }
  }
  // Longest distinct samples first, so wide windows have real text.
  const seen = new Set();
  return found.sort((a, b) => b.rows.length - a.rows.length).filter((sample) => {
    const key = sample.rows.slice(0, 4).map((row) => row[1]).join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, count);
}

// Half of the window from one sample, cut after its last sentence end, then
// a hard 4 s pause, then another sample.
function spanItems(first, second, size) {
  const firstRows = first.rows.slice(0, Math.floor(size / 2));
  let cut = firstRows.length;
  for (let index = firstRows.length - 1; index > 0; index--) {
    if (/[.?!]["')\]]*$/.test(String(firstRows[index][1] || "").trim())) { cut = index + 1; break; }
  }
  const rows = firstRows.slice(0, cut).map((row, index) =>
    index === cut - 1 ? [row[0], row[1], 4500, "h"] : row);
  return sampleItems({ rows: rows.concat(second.rows.slice(0, size - cut)) }, size);
}

function sampleItems(sample, size) {
  let clock = 0;
  return sample.rows.slice(0, size).map((row, index) => {
    const pause = Number(row[2]) || 0;
    const boundary = row[3] || "";
    const item = {
      id: String(index), cueId: String(index), text: String(row[1] || ""),
      startMs: clock, endMs: clock + 400, pauseAfterMs: pause,
      softAfter: boundary === "s", hardAfter: boundary === "h"
    };
    clock += 400 + pause;
    return item;
  });
}

// ---- background runtime ------------------------------------------------------------
function storageArea(seed = {}) {
  const data = structuredClone(seed);
  return {
    async get(keys) {
      if (keys == null) return structuredClone(data);
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
      if (typeof keys === "string") return keys in data ? { [keys]: data[keys] } : {};
      return { ...keys, ...structuredClone(data) };
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; }
  };
}

function dryRunFetch(_url, options) {
  // A well-behaved provider: one sentence per line, every 12 items.
  const body = JSON.parse(options.body);
  const user = body.messages[1].content;
  const rows = JSON.parse(user.split("CURRENT_CUES:\n")[1].split("\nFUTURE_CONTEXT:")[0]);
  const lines = [];
  for (let start = 0; start + 11 < rows.length; start += 12) lines.push(JSON.stringify([[start, start + 11, "句子。"]]));
  lines.push("[]");
  const text = lines.join("\n") + "\n";
  const events = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } })}\n\n`,
    "data: [DONE]\n\n"
  ];
  const encoder = new TextEncoder();
  let index = 0;
  return Promise.resolve({
    ok: true, status: 200, headers: { get: () => "text/event-stream" },
    body: { getReader: () => ({
      async read() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return index < events.length ? { done: false, value: encoder.encode(events[index++]) } : { done: true };
      },
      async cancel() {}
    }) }
  });
}

// Keep the provider's error text (keys redacted) so an HTTP failure explains itself.
let lastErrorBody = "";
async function inspectingFetch(url, options) {
  const response = await globalThis.fetch(url, options);
  if (!response.ok) {
    try {
      lastErrorBody = (await response.clone().text())
        .replace(/AIza[0-9A-Za-z_-]{20,}/g, "<key>").replace(/sk-[0-9A-Za-z]{16,}/g, "<key>")
        .replace(/\s+/g, " ").slice(0, 400);
    } catch (_e) { lastErrorBody = ""; }
  }
  return response;
}

function createRuntime(variant, profile) {
  const baseUrl = shared.normalizeAiBaseUrl(profile.baseUrl) || shared.AI_DEFAULT_BASE_URL;
  const sync = storageArea({
    aiBaseUrl: baseUrl, aiModel: profile.model, targetLang: profile.targetLang || "zh-CN",
    aiContextPast: profile.contextPast ?? 1, aiContextFuture: profile.contextFuture ?? 1,
    aiRateLimitRpm: profile.rateLimitRpm ?? 0
  });
  const local = storageArea({
    aiApiKeys: { [shared.aiCredentialScope(baseUrl)]: profile.apiKey || "" },
    aiExtraBodyProfiles: profile.extraBody && profile.extraBody !== "{}"
      ? { [shared.aiRequestProfileScope(baseUrl, profile.model)]: profile.extraBody } : {}
  });
  const events = [];
  let usage = null;
  const context = {
    console, Date, Math, JSON, Map, Set, URL, Promise, AbortController, TextDecoder, TextEncoder,
    Uint8Array, setTimeout, clearTimeout, queueMicrotask, structuredClone,
    YTDS_SHARED: shared,
    fetch: args.dryRun ? dryRunFetch : inspectingFetch,
    chrome: {
      runtime: { onMessage: { addListener: () => {} }, onInstalled: { addListener: () => {} } },
      tabs: { sendMessage: () => Promise.resolve() },
      permissions: { contains: async () => true, onAdded: { addListener: () => {} } },
      webRequest: Object.fromEntries(["onBeforeSendHeaders", "onErrorOccurred", "onCompleted"]
        .map((name) => [name, { addListener: () => {} }])),
      storage: { sync, local, session: storageArea(), onChanged: { addListener: () => {} } }
    }
  };
  vm.createContext(context);
  vm.runInContext(read("background/state.js"), context, { filename: "background/state.js" });
  vm.runInContext(read("background/network.js"), context, { filename: "background/network.js" });
  vm.runInContext(read("background/http.js"), context, { filename: "background/http.js" });
  vm.runInContext(translationSource(variant), context, { filename: "background/translation.js" });
  context.appendDebug = (scope, event, data) => events.push({ t: Date.now(), event, data });
  context.recordAiTokenUsage = async (raw) => { usage = shared.normalizeAiTokenUsage(raw); return usage; };
  return { context, events, takeUsage: () => { const value = usage; usage = null; return value; } };
}

// ---- one measured request ------------------------------------------------------------
const SENTENCE_END = /[。！？!?.…]["'”’」』）)\]]*$/;
function lineStats(raw) {
  const lines = String(raw || "").split("\n").map((line) => line.trim())
    .filter((line) => line.startsWith("[[") && line !== "[]");
  let sentences = 0;
  let maxItems = 0;
  let nextStart = 0;
  // Chunks are [start,end,text] or end-only [end,text].
  const endOf = (chunk) => Number(chunk.length === 2 ? chunk[0] : chunk[1]);
  const textOf = (chunk) => String(chunk[chunk.length - 1] || "").trim();
  for (const line of lines) {
    try {
      const chunks = JSON.parse(line.replace(/,\s*$/, ""));
      sentences += chunks.filter((chunk) => SENTENCE_END.test(textOf(chunk))).length;
      const start = chunks[0].length === 2 ? nextStart : Number(chunks[0][0]);
      const end = endOf(chunks[chunks.length - 1]);
      maxItems = Math.max(maxItems, end - start + 1);
      nextStart = end + 1;
    } catch (_e) { /* counted as a line, not parsed */ }
  }
  return { lines: lines.length, sentencesPerLine: lines.length ? +(sentences / lines.length).toFixed(2) : 0, maxLineItems: maxItems };
}

async function measure(runtime, sample, size, requestId, spanWith) {
  const items = spanWith ? spanItems(sample, spanWith, size) : sampleItems(sample, size);
  const runway = 32;
  const guardLocal = items.length > runway * 2 ? items.length - runway : -1;
  const before = sample.contextBefore.map(([id, text]) => ({ id, text }));
  const after = sample.contextAfter.map(([id, text]) => ({ id, text }));
  runtime.events.length = 0;
  lastErrorBody = "";
  const started = Date.now();
  let result = null;
  let error = "";
  try {
    result = await vm.runInContext("aiTranslateBatch", runtime.context)(
      items, runtime.context.chrome && "zh-CN", sample.sourceLang, before, after, true,
      `bench:${requestId}`, undefined,
      { requestId, urgent: !!args.urgent, fastPath: false, bypassCache: true, commitGuardLocal: guardLocal }
    );
  } catch (err) {
    error = String(err && (err.errorCode || err.message) || err);
  }
  const at = (name) => runtime.events.find((event) => event.event === name);
  const firstUnit = at("semantic-jsonl-unit");
  const body = runtime.events.filter((event) => event.event === "ai-http-body-complete").pop();
  const raw = runtime.events.filter((event) => event.event === "semantic-jsonl-raw-response").pop();
  // What the content commit rule would keep: whole units ending before the runway.
  let committable = 0;
  if (result && Array.isArray(result)) {
    const guardStart = guardLocal >= 0 ? guardLocal : items.length;
    const ends = new Map();
    for (const item of result) ends.set(item.unitId, Math.max(ends.get(item.unitId) ?? -1, Number(item.id)));
    let cursor = 0;
    for (const end of Array.from(ends.values()).sort((a, b) => a - b)) {
      if (end >= guardStart) break;
      cursor = end + 1;
    }
    committable = guardLocal >= 0 ? cursor : result.length;
  }
  const usage = runtime.takeUsage();
  return {
    items: items.length, error: error || (result && result.errorCode) || "",
    providerMessage: lastErrorBody,
    ttfbMs: (at("ai-http-first-byte") || {}).data?.firstByteMs ?? null,
    firstUnitMs: firstUnit ? firstUnit.t - started : null,
    totalMs: Date.now() - started,
    earlyStop: body && body.data.earlyStopReason || "",
    // Why the parser stopped early: protocol reasons carry positions only,
    // never subtitle text (quoted fragments are removed to be sure).
    rejectReason: String(((runtime.events.find((event) => /semantic-jsonl-(tail-recovered|prefix-recovered|rejected)/.test(event.event)) || {}).data || {})
      .reason || ((runtime.events.find((event) => event.event === "semantic-jsonl-prefix-recovered") || {}).data || {}).rejectedReason || "")
      .replace(/"[^"]*"/g, '"…"').slice(0, 160),
    // Structure of the first lines of a response the parser stopped early:
    // numbers and brackets only, every string replaced by "…".
    rawShape: (() => {
      const stopped = runtime.events.some((event) =>
        /semantic-jsonl-(tail-recovered|prefix-recovered|rejected)/.test(event.event));
      const text = stopped && raw && raw.data ? String(raw.data.rawResponse || "") : "";
      return text ? text.split("\n").slice(0, 14)
        .map((line) => line.replace(/"(?:[^"\\]|\\.)*"/g, (match) => match === '""' ? '""' : '"…"')
          .slice(0, 200)) : [];
    })(),
    attempts: runtime.events.filter((event) => event.event === "ai-http-attempt-start").length,
    fallbacks: runtime.events.filter((event) => /fallback-request|alignment-fallback/.test(event.event)).length,
    committable, committableRatio: +(committable / items.length).toFixed(2),
    units: result ? new Set(result.map((item) => item.unitId)).size : 0,
    ...lineStats(raw && raw.data.rawResponse),
    promptTokens: usage ? usage.promptTokens : null,
    completionTokens: usage ? usage.completionTokens : null,
    cacheHitTokens: usage ? usage.cacheHitTokens : null,
    reasoningTokens: usage ? usage.reasoningTokens : null
  };
}

// ---- driver ---------------------------------------------------------------------------
function loadProfiles() {
  if (args.dryRun && !args.config) {
    return [{ name: "dry-run", baseUrl: "https://gateway.example/v1", model: "m", apiKey: "x", rateLimitRpm: 0 }];
  }
  const backup = JSON.parse(fs.readFileSync(args.config, "utf8"));
  const store = backup.local && backup.local.aiConfigProfileStoreV1;
  const profiles = store && Array.isArray(store.profiles) ? store.profiles : [];
  return profiles.filter((profile) => !args.profiles || args.profiles.includes(profile.name));
}

const median = (values) => {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return list.length ? list[Math.floor((list.length - 1) / 2)] : null;
};

(async () => {
  const samples = samplesFromLogs(args.logs, args.samples);
  if (!samples.length) throw new Error("no semantic-batch-request rows found; enable debug logging and export a log");
  const profiles = loadProfiles();
  if (!profiles.length) throw new Error("no matching profiles in the settings backup");
  const runs = [];
  const reported = new Set();
  let serial = 0;
  if (process.env.HTTPS_PROXY && !process.execArgv.includes("--use-env-proxy") &&
      process.env.NODE_USE_ENV_PROXY !== "1") {
    console.warn("HTTPS_PROXY is set but Node will not use it; add --use-env-proxy.");
  }
  for (const profile of profiles) {
    for (const variant of args.variants) {
      const runtime = createRuntime(variant, profile);
      for (const size of args.windows) {
        for (const [sampleIndex, sample] of samples.entries()) {
          if (sample.rows.length < Math.min(size, 64)) continue;
          for (let repeat = 0; repeat < args.repeat; repeat++) {
            const spanWith = args.span ? samples[(sampleIndex + 1) % samples.length] : null;
            const metrics = await measure(runtime, sample, size, `bench-${++serial}`, spanWith);
            const run = { profile: profile.name, model: profile.model, rpm: profile.rateLimitRpm ?? 0,
              variant, window: size, sample: sampleIndex, repeat, span: !!spanWith, ...metrics };
            runs.push(run);
            process.stdout.write(`${run.profile} ${variant} w${size} s${sampleIndex} r${repeat}: ` +
              `ttfb ${run.ttfbMs}ms first ${run.firstUnitMs}ms total ${run.totalMs}ms ` +
              `sent/line ${run.sentencesPerLine} commit ${run.committableRatio} ${run.error}\n`);
            if (run.providerMessage && !reported.has(`${profile.name}|${run.error}`)) {
              reported.add(`${profile.name}|${run.error}`);
              process.stdout.write(`  provider says: ${run.providerMessage}\n`);
              if (/location is not supported/i.test(run.providerMessage)) {
                process.stdout.write("  -> this provider needs your proxy: set HTTPS_PROXY and run node --use-env-proxy\n");
              }
            }
          }
        }
      }
    }
  }
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.profile}|${run.variant}|${run.window}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const summary = Array.from(groups, ([key, list]) => {
    const [profile, variant, window] = key.split("|");
    return {
      profile, variant, window: Number(window), runs: list.length,
      errors: list.filter((run) => run.error).length,
      ttfbMs: median(list.map((run) => run.ttfbMs)),
      firstUnitMs: median(list.map((run) => run.firstUnitMs)),
      totalMs: median(list.map((run) => run.totalMs)),
      sentencesPerLine: median(list.map((run) => run.sentencesPerLine)),
      maxLineItems: median(list.map((run) => run.maxLineItems)),
      committableRatio: median(list.map((run) => run.committableRatio)),
      completionTokens: median(list.map((run) => run.completionTokens)),
      promptTokens: median(list.map((run) => run.promptTokens)),
      // Throughput the lane can sustain: committed items per second of wall time.
      committedItemsPerSecond: median(list.map((run) => run.totalMs ? run.committable / (run.totalMs / 1000) : null))
    };
  });
  console.table(summary);
  const out = `benchmark-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(out, JSON.stringify({ createdAt: new Date().toISOString(), dryRun: args.dryRun,
    windows: args.windows, variants: args.variants, summary, runs }, null, 2));
  console.log(`\nResults written to ${path.resolve(out)} (no keys, no subtitle text).`);
})().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
