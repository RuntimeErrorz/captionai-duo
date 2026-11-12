"use strict";

// Shared by scripts/e2e-chrome.js and scripts/sim-replay.js: the local
// OpenAI-compatible stand-in, caption-file parsing and the debug-log analysis.

const fs = require("node:fs");
const http = require("node:http");

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

// ---- caption files ------------------------------------------------------------
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
  let paints = 0, stalePaints = 0, stopped = 0, networkErrors = 0, provider429 = 0;
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
    } else if (entry.event === "ai-http-retry" && Number(data.status) === 429) {
      provider429++;
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
    networkStopped: stopped, provider429, errorEvents: errors, // inject-cue-fetch-error is expected when captions are replayed
    cancelled: transitions["semantic-request:cancelled"] || 0, transitions, failures
  };
}

module.exports = { startFakeProvider, cuesFromFile, analyze, requestStats, median };
