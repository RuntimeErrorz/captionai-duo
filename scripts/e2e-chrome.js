#!/usr/bin/env node
// End-to-end check in real Chrome on a real YouTube page.
//
//   node scripts/e2e-chrome.js [--video ID] [--proxy HOST:PORT] [--headful] [--cues auto|real|synthetic]
//   node scripts/e2e-chrome.js --cues-file captions.orig.srt   replay a caption track you exported
//   node scripts/e2e-chrome.js --login        sign in to YouTube once in the test profile
//   node scripts/e2e-chrome.js --persistent   reuse that signed-in profile (real captions)
//   node scripts/e2e-chrome.js --persistent --provider gemini --model gemini-3.5-flash-lite --rpm 15
//
// Loads a temporary copy of this extension into a fresh Chrome profile over
// the DevTools pipe, plays the video with seeks, scrubs, rate changes, a
// settings change and a reload, then exports the extension's own debug log
// and checks it. The default provider is a local fake OpenAI-compatible
// server that "translates" by quoting the source words, so a painted
// translation can be checked against the subtitle on screen.
//
// --provider gemini uses the real API. The key is read from the
// CAPTIONAI_E2E_API_KEY environment variable on your machine only; it is
// written to the test profile's chrome.storage.local, removed again when the
// run ends, and never logged.
//
// YouTube serves empty captions to fresh automated sessions. --login opens a
// normal Chrome (no debugging flags, so Google sign-in works) on a dedicated
// profile outside the repository; sign in, close the window, and later runs
// with --persistent reuse it. It never touches your everyday Chrome profile.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const args = {
  video: "v9PmiWRdDA0", proxy: "127.0.0.1:7890", headful: false, provider: "fake",
  model: "gemini-3.5-flash-lite", rpm: 15, keep: false, out: path.join(root, "e2e-results"), cues: "auto",
  login: false, persistent: false,
  profileDir: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "CaptionAI-E2E", "profile")
};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  const next = () => process.argv[++i];
  if (flag === "--video") args.video = next();
  else if (flag === "--proxy") args.proxy = next();
  else if (flag === "--no-proxy") args.proxy = "";
  else if (flag === "--headful") args.headful = true;
  else if (flag === "--provider") args.provider = next();
  else if (flag === "--model") args.model = next();
  else if (flag === "--rpm") args.rpm = Number(next());
  else if (flag === "--keep") args.keep = true;
  else if (flag === "--probe") args.probe = true;
  else if (flag === "--cues") args.cues = next();
  else if (flag === "--cues-file") { args.cuesFile = path.resolve(next()); args.cues = "file"; }
  else if (flag === "--login") args.login = true;
  else if (flag === "--persistent") args.persistent = true;
  else if (flag === "--profile-dir") { args.profileDir = path.resolve(next()); args.persistent = true; }
  else if (flag === "--out") args.out = path.resolve(next());
  else throw new Error(`unknown argument ${flag}`);
}
const CHROME = [
  path.join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
  path.join(process.env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome"
].find((file) => file && fs.existsSync(file));
if (!CHROME) throw new Error("Chrome not found");
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- fake provider -----------------------------------------------------------
// Segments the real prompt's CURRENT_CUES at sentence punctuation and hard
// boundaries and streams the documented JSONL protocol. Each translation is
// the source words with their letters reversed: never a verbatim copy (which
// the extension rightly rejects as untranslated), yet reversible, so the
// checker can match every paint to the subtitle on screen.
function startFakeProvider() {
  const stats = { requests: 0, promptChars: 0, completionChars: 0 };
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      stats.requests++;
      stats.promptChars += body.length;
      let rows;
      try {
        const user = JSON.parse(body).messages[1].content;
        const start = user.indexOf("CURRENT_CUES:\n") + "CURRENT_CUES:\n".length;
        rows = JSON.parse(user.slice(start, user.indexOf("\nFUTURE_CONTEXT:")));
      } catch (_e) { res.writeHead(400).end("{}"); return; }
      const lines = [];
      let unit = [];
      const flush = (complete) => {
        if (!unit.length || !complete) return;
        const chunks = [];
        const half = unit.length >= 10 ? Math.floor(unit.length / 2) : unit.length;
        for (const part of [unit.slice(0, half), unit.slice(half)]) {
          if (!part.length) continue;
          chunks.push([part[0][0], part[part.length - 1][0],
            `「${part.map((row) => [...String(row[1])].reverse().join("")).join(" ")}」`]);
        }
        lines.push(JSON.stringify(chunks));
        unit = [];
      };
      for (const row of rows) {
        unit.push(row);
        const ends = /[.?!…]["')\]]*$/.test(String(row[1])) || row[3] === "h" || unit.length >= 14;
        if (ends) flush(true);
      }
      // A trailing unfinished sentence is the unresolved suffix.
      const text = [...lines, "[]"].join("\n") + "\n";
      stats.completionChars += text.length;
      await sleep(600 + Math.floor(Math.random() * 1600));
      if (res.destroyed) return;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (let i = 0; i < text.length && !res.destroyed; i += 24) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 24) } }] })}\n\n`);
        await sleep(15);
      }
      if (!res.destroyed) {
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: Math.round(body.length / 4), completion_tokens: Math.round(text.length / 4) } })}\n\n`);
        res.end("data: [DONE]\n\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ server, stats, baseUrl: `http://127.0.0.1:${server.address().port}/v1` })));
}

// ---- synthetic captions ------------------------------------------------------------
// YouTube serves an empty timedtext body to fresh automated sessions. The
// fallback keeps the real page, player and extension and replaces only the
// caption fetch: it answers the content script's config handshake the way
// inject.js does, with an ASR-shaped track of punctuated sentences and long
// pauses that create hard-boundary regions. Every word is unique.
function syntheticCues(durationSeconds) {
  let seed = 7;
  const rand = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  const pick = (list) => list[rand(list.length)];
  const firms = ["the chip maker", "a cloud provider", "the carmaker", "a small startup", "the bank", "the retailer"];
  const people = ["the chief executive", "an analyst", "the minister", "a reporter", "the founder", "a trader"];
  const days = ["on Monday", "on Tuesday", "last week", "this morning", "in March", "after the vote"];
  const templates = [
    () => `Shares of ${pick(firms)} fell ${1 + rand(9)}.${rand(10)} percent ${pick(days)}.`,
    () => `${pick(people)} said the new rules would take effect within ${2 + rand(20)} months.`,
    () => `Is it really possible to build ${10 + rand(90)} factories before the deadline?`,
    () => `According to ${pick(people)}, demand rose sharply in ${3 + rand(40)} countries.`,
    () => `We spoke with ${pick(people)} about why prices doubled ${pick(days)}.`,
    () => `The company plans to hire ${100 + rand(900)} engineers and open a second office.`,
    () => `Nobody expected ${pick(firms)} to announce a recall of ${1000 + rand(9000)} vehicles.`,
    () => `So what happens next, and who pays for it?`,
    () => `Critics argue that the plan ignores ${2 + rand(8)} key risks to small suppliers.`,
    () => `In the end, ${pick(firms)} agreed to pay ${5 + rand(95)} million dollars to settle the case.`
  ];
  const cues = [];
  let t = 1500;
  const end = Math.max(60, durationSeconds - 10) * 1000;
  while (t < end) {
    const words = templates[rand(templates.length)]().replace(/^./, (c) => c.toUpperCase()).split(" ");
    for (let i = 0; i < words.length;) {
      const size = Math.min(words.length - i, 2 + rand(6));
      const part = words.slice(i, i + size);
      const dur = part.length * (260 + rand(200));
      cues.push({ start: t, dur, text: part.join(" "),
        parts: part.map((text, k) => ({ text, offsetMs: Math.round(k * dur / part.length) })) });
      t += dur + 40;
      i += size;
    }
    t += rand(7) === 0 ? 5000 + rand(3000) : 300 + rand(500);
  }
  return cues;
}

// A caption track you exported: the extension's SRT ("orig" export) or a
// YouTube json3 timedtext body. SRT carries cue times only, so words inside a
// cue are spread evenly across its duration.
function cuesFromFile(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const cue = (start, end, words) => {
    const dur = Math.max(1, end - start);
    return { start, dur, text: words.join(" "),
      parts: words.map((word, k) => ({ text: word, offsetMs: Math.round(k * dur / words.length) })) };
  };
  if (text.trim().startsWith("{")) {
    const events = JSON.parse(text).events || [];
    return events.filter((event) => Array.isArray(event.segs)).map((event) => {
      const parts = event.segs.map((seg) => ({ text: String(seg.utf8 || "").trim(), offsetMs: Number(seg.tOffsetMs) || 0 }))
        .filter((part) => part.text);
      return { start: event.tStartMs, dur: event.dDurationMs || 0, text: parts.map((p) => p.text).join(" "), parts };
    }).filter((item) => item.text);
  }
  const time = (value) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(value);
    return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) : NaN;
  };
  const cues = [];
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    const [from, to] = lines[at].split("-->");
    const words = lines.slice(at + 1).join(" ").split(/\s+/).filter(Boolean);
    const start = time(from), end = time(to);
    if (Number.isFinite(start) && Number.isFinite(end) && words.length) cues.push(cue(start, end, words));
  }
  return cues;
}

// ---- extension test copy ---------------------------------------------------------
function prepareExtension(extraHostPermission) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "captionai-e2e-ext-"));
  for (const entry of ["manifest.json", "background.js", "content.css", "inject.js", "popup.html", "popup.css",
    "popup.js", "shared.js", "_locales", "background", "content", "icons", "inject", "popup", "shared"]) {
    fs.cpSync(path.join(root, entry), path.join(dir, entry), { recursive: true });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  // Test copy only: grant the provider origin up front instead of through
  // the popup's permission prompt.
  manifest.host_permissions = [...manifest.host_permissions, extraHostPermission];
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

// ---- DevTools protocol over the pipe -----------------------------------------------
class Cdp {
  constructor(child) {
    this.out = child.stdio[3];
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = [];
    let buffer = "";
    child.stdio[4].on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\0")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.id && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) reject(new Error(`${message.error.message} ${message.error.data || ""}`));
          else resolve(message.result);
        } else {
          for (const handler of this.handlers) handler(message);
        }
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.out.write(JSON.stringify(message) + "\0");
    });
  }
  async evaluate(sessionId, expression) {
    const result = await this.send("Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception && result.exceptionDetails.exception.description ||
        result.exceptionDetails.text);
    }
    return result.result.value;
  }
}

// ---- checks ---------------------------------------------------------------------
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((x, y) => x - y);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function requestStats(entries) {
  const byId = new Map();
  const get = (id) => { if (!byId.has(id)) byId.set(id, { requestId: id }); return byId.get(id); };
  for (const entry of entries) {
    const data = entry.data || {};
    if (!data.requestId) continue;
    if (entry.event === "batch-start") Object.assign(get(data.requestId), { items: data.itemCount, requestClass: data.requestClass, sourceChars: data.sourceChars });
    else if (entry.event === "prompt-context-budget") Object.assign(get(data.requestId), { promptChars: data.usedChars });
    else if (entry.event === "ai-http-first-byte") Object.assign(get(data.requestId), { firstByteMs: data.firstByteMs, status: data.status });
    else if (entry.event === "ai-http-body-complete") Object.assign(get(data.requestId), { totalMs: data.totalMs, responseChars: data.responseChars, earlyStopReason: data.earlyStopReason || "" });
  }
  const requests = [...byId.values()].filter((request) => Number.isFinite(request.items));
  const buckets = {};
  for (const request of requests) {
    const bucket = request.items <= 96 ? "<=96" : request.items <= 192 ? "97-192" : "193-320";
    (buckets[bucket] = buckets[bucket] || []).push(request);
  }
  const summary = Object.fromEntries(Object.entries(buckets).map(([bucket, list]) => [bucket, {
    count: list.length, medianFirstByteMs: median(list.map((r) => r.firstByteMs)),
    medianTotalMs: median(list.map((r) => r.totalMs)), medianResponseChars: median(list.map((r) => r.responseChars))
  }]));
  return { requests, summary };
}

function analyze(bundle, secret, quotedTranslations) {
  const entries = Array.isArray(bundle && bundle.entries) ? bundle.entries : [];
  const failures = [];
  const fail = (name, detail) => { if (failures.length < 30) failures.push({ name, ...detail }); };
  if (secret && JSON.stringify(bundle).includes(secret)) fail("secret-in-debug-log", {});
  const batches = new Map();
  const cancels = [];
  const perSecond = new Map();
  let paints = 0, stalePaints = 0, stopped = 0, networkErrors = 0;
  const errors = {};
  const transitions = {};
  for (const entry of entries) {
    const data = entry.data || {};
    const t = Date.parse(entry.ts);
    if (entry.event === "batch-start") {
      const key = `${data.requestStart}-${data.requestEnd}`;
      for (const cancel of cancels) {
        if (t - cancel.t <= 200 && cancel.range === key && cancel.requestId !== data.requestId) {
          fail("cancelled-range-resent", { range: key, cancelled: cancel.requestId, resent: data.requestId });
        }
      }
      batches.set(data.requestId, { key, t, done: false });
      const second = Math.floor(t / 1000);
      perSecond.set(second, (perSecond.get(second) || 0) + 1);
      if (perSecond.get(second) > 20) fail("request-hot-loop", { second, count: perSecond.get(second) });
    } else if (entry.event === "batch-complete" || entry.event === "batch-error" || entry.event === "batch-cancelled") {
      for (const batch of batches.values()) if (!batch.done) { batch.done = true; break; }
    } else if (entry.event === "state-transition") {
      const key = `${data.machine}:${data.transition}${data.reason ? ":" + data.reason : ""}`;
      transitions[key] = (transitions[key] || 0) + 1;
      if (data.machine === "semantic-request" && data.transition === "cancelled") {
        const range = data.requestStart != null ? `${data.requestStart}-${data.requestEnd}` : "";
        cancels.push({ t, range, requestId: data.requestId });
      }
    } else if (entry.event === "translation-painted") {
      paints++;
      if (!quotedTranslations) continue;
      const source = String(data.source || "").toLowerCase();
      for (const match of String(data.translation || "").matchAll(/「([^」]*)」/g)) {
        const words = match[1].toLowerCase().split(/\s+/).filter(Boolean)
          .map((word) => [...word].reverse().join(""));
        if (words.some((word) => !source.includes(word))) {
          stalePaints++;
          fail("translation-does-not-match-subtitle", { source: data.source, translation: data.translation });
          break;
        }
      }
    } else if (entry.event === "ai-network-error") {
      networkErrors++;
    } else if (entry.event === "ai-network-stopped") {
      stopped++;
    } else if (/error/i.test(entry.event) && entry.event !== "ai-network-error") {
      errors[entry.event] = (errors[entry.event] || 0) + 1;
    }
  }
  const stats = requestStats(entries);
  return {
    requestSummary: stats.summary, requestLog: stats.requests,
    entries: entries.length, requests: batches.size, paints, stalePaints, networkErrors,
    networkStopped: stopped, errorEvents: errors, // inject-cue-fetch-error is expected when captions are replayed
    cancelled: transitions["semantic-request:cancelled"] || 0, transitions, failures
  };
}

// ---- driver ---------------------------------------------------------------------
async function login() {
  fs.mkdirSync(args.profileDir, { recursive: true });
  log("opening Chrome with the test profile:", args.profileDir);
  log("sign in to YouTube (a secondary Google account is best), then close the window.");
  const child = spawn(CHROME, [
    `--user-data-dir=${args.profileDir}`, "--no-first-run", "--no-default-browser-check",
    ...(args.proxy ? [`--proxy-server=${args.proxy}`] : []),
    "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F"
  ], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  log("done. Run tests with --persistent to reuse this profile.");
}

async function main() {
  if (args.login) { await login(); return; }
  if (args.persistent && !fs.existsSync(path.join(args.profileDir, "Local State"))) {
    throw new Error(`no test profile at ${args.profileDir}; run with --login first`);
  }
  fs.mkdirSync(args.out, { recursive: true });
  let provider = null;
  let settings;
  let secret = "";
  if (args.provider === "gemini") {
    secret = String(process.env.CAPTIONAI_E2E_API_KEY || "").trim();
    if (!secret) throw new Error("set CAPTIONAI_E2E_API_KEY to run against Gemini");
    settings = { aiBaseUrl: GEMINI, aiModel: args.model, aiRateLimitRpm: args.rpm };
  } else {
    provider = await startFakeProvider();
    settings = { aiBaseUrl: provider.baseUrl, aiModel: "fake-model", aiRateLimitRpm: 0 };
  }
  const extDir = prepareExtension(args.provider === "gemini"
    ? "https://generativelanguage.googleapis.com/*" : "http://127.0.0.1/*");
  const profile = args.persistent ? args.profileDir : fs.mkdtempSync(path.join(os.tmpdir(), "captionai-e2e-profile-"));
  const chromeArgs = [
    "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,800", ...(args.headful ? ["--window-position=-2400,-2400"] : ["--headless=new"]),
    ...(args.proxy ? [`--proxy-server=${args.proxy}`, "--proxy-bypass-list=<-loopback>;127.0.0.1;localhost"] : []),
    "about:blank"
  ];
  const child = spawn(CHROME, chromeArgs, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const cdp = new Cdp(child);
  const cleanup = () => {
    try { child.kill(); } catch (_e) { /* gone */ }
    if (provider) provider.server.close();
    if (!args.keep) {
      const dirs = args.persistent ? [extDir] : [extDir, profile];
      for (const dir of dirs) try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* locked */ }
    }
  };
  let removeKey = null;
  try {
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: extDir });
    log("extension", extensionId);
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const worker = async () => {
      for (let i = 0; i < 40; i++) {
        const { targetInfos } = await cdp.send("Target.getTargets");
        const target = targetInfos.find((info) => info.type === "service_worker" &&
          info.url.startsWith(`chrome-extension://${extensionId}/`));
        if (target) return (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
        await sleep(250);
      }
      throw new Error("extension service worker did not start");
    };
    let workerSession = await worker();
    removeKey = async () => {
      const remove = "chrome.storage.local.remove('aiApiKeys').then(() => true)";
      try { await cdp.evaluate(workerSession, remove); }
      catch (_e) { workerSession = await worker(); await cdp.evaluate(workerSession, remove); }
    };
    const storageSet = async (area, values) => {
      try {
        await cdp.evaluate(workerSession, `chrome.storage.${area}.set(${JSON.stringify(values)})`);
      } catch (_e) {
        workerSession = await worker(); // MV3 may have stopped the worker
        await cdp.evaluate(workerSession, `chrome.storage.${area}.set(${JSON.stringify(values)})`);
      }
    };
    await storageSet("sync", { ...settings, debugEnabled: true, enabled: true });
    if (secret) {
      await cdp.evaluate(workerSession, `chrome.storage.local.set({ aiApiKeys: { [YTDS_SHARED.aiCredentialScope(${JSON.stringify(settings.aiBaseUrl)})]: ${JSON.stringify(secret)} } }).then(() => true)`);
    }

    const cueLoadCount = async () => {
      const text = await cdp.evaluate(workerSession, "exportDebugLogs()").catch(() => "{}");
      return (JSON.parse(text).entries || []).filter((entry) => entry.event === "cues-loaded").length;
    };
    let targetId = null;
    let page = null;
    const pageEval = (expression) => cdp.evaluate(page, expression);
    // YouTube's player only gets a caption proof-of-origin token when no
    // debugger is attached while it starts, so the tab opens detached and is
    // attached once the extension has its cues (or after a grace period).
    const open = async () => {
      if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      const before = await cueLoadCount();
      ({ targetId } = await cdp.send("Target.createTarget", { url: `https://www.youtube.com/watch?v=${args.video}` }));
      for (let i = 0; i < 50 && (await cueLoadCount()) <= before; i++) await sleep(500);
      page = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
      for (let i = 0; i < 120; i++) {
        await sleep(500);
        const state = await pageEval(`(() => {
          const reject = [...document.querySelectorAll("button, tp-yt-paper-button")]
            .find((b) => /reject all|全部拒绝/i.test(b.textContent || ""));
          if (reject) { reject.click(); return "consent"; }
          const v = document.querySelector("video");
          return v && v.readyState >= 2 ? "ready" : (location.host || "loading");
        })()`).catch(() => "loading");
        if (state === "ready") return;
      }
      throw new Error("YouTube video did not become ready");
    };
    const waitForAds = async () => {
      for (let i = 0; i < 120; i++) {
        const ad = await pageEval(`(() => {
          const player = document.querySelector("#movie_player");
          if (!player || !player.classList.contains("ad-showing")) return false;
          const skip = document.querySelector(".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern");
          if (skip) skip.click();
          return true;
        })()`).catch(() => false);
        if (!ad) return;
        await sleep(1000);
      }
    };
    const video = (code) => pageEval(`(() => { const v = document.querySelector("video"); ${code} })()`);
    const play = async (rate, ms) => {
      await waitForAds();
      await video(`v.playbackRate = ${rate}; v.play(); return true;`);
      await sleep(ms);
    };
    const seek = (seconds) => video(`v.currentTime = ${seconds}; return true;`);

    log("opening", args.video, args.provider);
    await open();
    const duration = await video("return v.duration || 0;");
    log("duration", Math.round(duration), "s");
    const cuesLoaded = async () => (await cueLoadCount()) > 0;
    let captionSource = "real";
    const replayCues = args.cuesFile ? cuesFromFile(args.cuesFile) : syntheticCues(duration);
    const installSynthetic = () => pageEval(`(() => {
      const cues = ${JSON.stringify(replayCues)};
      const videoId = new URL(location.href).searchParams.get("v");
      const answer = (nonce) => window.postMessage({ source: "ytds-inject", type: "cues", videoId, nonce,
        cues, trackKind: "asr", sourceLang: "en", captionTrackId: "auto" }, location.origin);
      if (!window.__e2eCues) {
        window.__e2eCues = true;
        window.addEventListener("message", (event) => {
          const d = event.data;
          if (event.source === window && d && d.source === "ytds-content" && d.type === "config") {
            setTimeout(() => answer(d.nonce), 50);
          }
        });
      }
      return cues.length;
    })()`);
    const ensureCues = async () => {
      if (args.cues !== "synthetic" && args.cues !== "file") {
        for (let i = 0; i < 40 && !(await cuesLoaded()); i++) await sleep(500);
        if (await cuesLoaded()) return;
        if (args.cues === "real") {
          const diagnosis = await pageEval(`(async () => {
            const cfg = window.ytcfg && window.ytcfg.get ? window.ytcfg.get("LOGGED_IN") : null;
            const player = document.querySelector("#movie_player");
            const response = player && player.getPlayerResponse ? player.getPlayerResponse() : window.ytInitialPlayerResponse;
            const tracks = (((response || {}).captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [];
            const track = tracks[0];
            let probe = null;
            if (track) {
              const url = new URL(track.baseUrl, location.origin);
              url.searchParams.set("fmt", "json3");
              const r = await fetch(url, { credentials: "include" });
              const body = await r.text();
              probe = { status: r.status, chars: body.length, hasPot: url.searchParams.has("pot"),
                params: [...url.searchParams.keys()].join(",") };
            }
            const playerRequests = performance.getEntriesByType("resource")
              .filter((e) => e.name.includes("/api/timedtext"))
              .map((e) => { const u = new URL(e.name); return { pot: u.searchParams.has("pot"), c: u.searchParams.get("c"), size: e.transferSize }; });
            return { playerRequests, loggedIn: cfg, playability: response && response.playabilityStatus && response.playabilityStatus.status,
              trackCount: tracks.length, kinds: tracks.map((t) => t.kind || "manual").join(","), probe };
          })()`).catch((e) => String(e));
          log("caption diagnosis", JSON.stringify(diagnosis));
          throw new Error("YouTube returned no captions for this session");
        }
      }
      captionSource = args.cuesFile ? `file:${path.basename(args.cuesFile)}` : "synthetic";
      const count = await installSynthetic();
      log(captionSource, "captions", count, "cues");
      // Ask the content script for a fresh handshake so it receives them.
      await storageSet("sync", { targetLang: "en" });
      await storageSet("sync", { targetLang: "zh-CN" });
      for (let i = 0; i < 40 && !(await cuesLoaded()); i++) await sleep(500);
      if (!(await cuesLoaded())) throw new Error("synthetic captions were not accepted");
    };
    await ensureCues();
    const at = (fraction) => Math.max(5, Math.floor(duration * fraction));
    const steps = [
      ["play 1x", () => play(1, 30000)],
      ["play 3x", () => play(3, 25000)],
      ["seek forward", async () => { await seek(at(0.5)); await play(3, 20000); }],
      ["seek back", async () => { await seek(at(0.1)); await play(1, 15000); }],
      ["scrub", async () => { for (const f of [0.6, 0.62, 0.3, 0.32]) { await seek(at(f)); await sleep(300); } await play(2, 20000); }],
      ["settings change", async () => { await storageSet("sync", { aiMaxConcurrency: 2 }); await play(2, 15000); }],
      ["reload", async () => { await open(); if (captionSource !== "real") { await installSynthetic(); await storageSet("sync", { targetLang: "en" }); await storageSet("sync", { targetLang: "zh-CN" }); } await seek(at(0.32)); await play(1.5, 20000); }],
      ["pause", async () => { await video("v.pause(); return true;"); await sleep(5000); }]
    ];
    const probe = async (label) => {
      if (!args.probe) return;
      const pageState = await pageEval(`(() => ({
        overlay: !!document.querySelector("#ytds-overlay"),
        overlayText: (document.querySelector("#ytds-overlay") || {}).innerText || "",
        active: document.documentElement.classList.contains("ytds-active"),
        cc: (document.querySelector(".ytp-subtitles-button") || {}).ariaPressed || null,
        t: (document.querySelector("video") || {}).currentTime
      }))()`).catch((e) => String(e));
      const sync = await cdp.evaluate(workerSession, "chrome.storage.sync.get(null)").catch((e) => String(e));
      const logs = await cdp.evaluate(workerSession, `exportDebugLogs().then((text) => {
        const entries = JSON.parse(text).entries || [];
        const counts = {};
        for (const entry of entries) counts[entry.event] = (counts[entry.event] || 0) + 1;
        return { count: entries.length, counts };
      })`).catch((e) => String(e));
      log("probe", label, JSON.stringify({ pageState, sync, logs }).slice(0, 900));
    };
    for (const [name, step] of steps) { log(name); await step(); await probe(name); }

    let bundle = null;
    for (let i = 0; i < 3 && !bundle; i++) {
      // exportDebugLogs() resolves to the bundle's JSON text.
      try { bundle = JSON.parse(await cdp.evaluate(workerSession, "exportDebugLogs()")); }
      catch (_e) { workerSession = await worker(); }
    }
    const report = { video: args.video, provider: args.provider, model: settings.aiModel, captionSource,
      providerStats: provider ? provider.stats : null,
      tokenUsage: await cdp.evaluate(workerSession, "currentAiTokenUsage()").catch(() => null),
      ...analyze(bundle, secret, args.provider === "fake") };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(args.out, `e2e-${stamp}.json`), JSON.stringify({ report, bundle }, null, 1));
    const { requestLog, ...brief } = report;
    console.log(JSON.stringify(brief, null, 1));
    process.exitCode = report.failures.length ? 1 : 0;
  } finally {
    // The key must not outlive the run in the (possibly persistent) profile.
    if (secret && removeKey) {
      try { await removeKey(); }
      catch (_e) { log("warning: could not remove the API key from the test profile"); }
    }
    cleanup();
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 2; });
