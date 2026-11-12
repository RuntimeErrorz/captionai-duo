"use strict";

// A fake OpenAI-compatible chat endpoint that answers the real prompt. It reads
// CURRENT_CUES from the request, segments by a ground-truth sentence map, and
// streams the documented JSONL protocol over SSE in arbitrary byte chunks.
// Translations are tags "T<start>-<end>" in global coordinates, so every
// committed or painted text can be checked against the truth it came from.

const SECRET_KEY = "simulated-api-key-not-a-secret-7f3a9c";

// Latency follows the request: first byte = a base range plus prefill time per
// current item, and the body streams at a content rate in characters per
// second. Calibrated on real runs (gemini-3.5-flash-lite: ~1.6 s first byte at
// 128 items, ~2.2 s at 320, ~350 content chars/s; DeepSeek ~550 chars/s).
// scripts/e2e-chrome.js --provider gemini reports the same figures.
const PROFILES = Object.freeze({
  // DeepSeek-like: fast, unlimited RPM, rare faults.
  fast: { rpm: 0, ttfb: [500, 2000], ttfbPerItemMs: 2, charsPerSecond: 550, faults: 0.02 },
  // Free-tier Gemini-like: 15 RPM, slower first byte, overload spikes.
  limited: { rpm: 15, ttfb: [700, 3000], ttfbPerItemMs: 3.5, charsPerSecond: 350, faults: 0.06, overload: 0.08 },
  // Everything that can go wrong, often.
  flaky: { rpm: 60, ttfb: [300, 8000], ttfbPerItemMs: 3.5, charsPerSecond: 300, faults: 0.25, overload: 0.12 },
  // A thinking model behind a free tier: long first byte, few requests.
  slow: { rpm: 15, ttfb: [4000, 12500], ttfbPerItemMs: 5, charsPerSecond: 250, faults: 0.04, overload: 0.04 }
});

function parseCurrentRows(body) {
  const user = body && Array.isArray(body.messages) && body.messages[1] && String(body.messages[1].content || "");
  const start = user.indexOf("CURRENT_CUES:\n");
  const end = user.indexOf("\nFUTURE_CONTEXT:");
  if (start < 0 || end < 0) throw new Error("fake provider: prompt has no CURRENT_CUES block");
  const rows = JSON.parse(user.slice(start + "CURRENT_CUES:\n".length, end));
  return rows.map((row) => {
    const match = /^[wW](\d+)\.?$/.exec(String(row[1]));
    if (!match) throw new Error(`fake provider: unexpected row text ${row[1]}`);
    return { local: Number(row[0]), id: Number(match[1]), text: String(row[1]) };
  });
}

class FakeProvider {
  constructor({ truth, random, clock, profile, onRequest, overrides }) {
    this.truth = truth;
    this.random = random;
    this.clock = clock;
    this.profile = { ...(PROFILES[profile] || PROFILES.fast), ...(overrides || {}) };
    this.onRequest = onRequest || (() => {});
    this.starts = [];
    this.inFlight = 0;
    this.requests = 0;
    // Token cost of everything sent and generated (about 4 chars per token),
    // including the system prompt and context every request repeats.
    this.promptChars = 0;
    // requestId -> "first-byte" | "generating", for stall attribution.
    this.phases = new Map();
    this.completionChars = 0;
    this.rejected429 = 0;
  }

  // Complete truth units from local position 0, in order; stop before the
  // first unit that continues past the window (the unresolved suffix).
  linesFor(rows) {
    const lines = [];
    const firstId = rows[0].id;
    const lastId = rows[rows.length - 1].id;
    const localOf = (id) => id - firstId;
    for (let id = firstId; id <= lastId;) {
      const [unitStart, unitEnd] = this.truth.unitOf(id);
      if (unitEnd > lastId) break;
      const start = Math.max(unitStart, id);
      // Long units get two alignment chunks, as the prompt asks.
      const chunks = [];
      if (unitEnd - start >= 9) {
        const mid = start + Math.floor((unitEnd - start) / 2);
        chunks.push([localOf(start), localOf(mid), `T${start}-${mid}`]);
        chunks.push([localOf(mid + 1), localOf(unitEnd), `T${mid + 1}-${unitEnd}`]);
      } else {
        chunks.push([localOf(start), localOf(unitEnd), `T${start}-${unitEnd}`]);
      }
      lines.push(chunks);
      id = unitEnd + 1;
    }
    // Real models end 15-17% of chunks one word late, on the next sentence's
    // opening word, and then start the next line after it (real Gemini and
    // DeepSeek replays). Tags stay the truth, so a commit that keeps the
    // overrun fails the alignment invariant.
    const overrun = Number.isFinite(this.profile.overrun) ? this.profile.overrun : 0.15;
    for (let i = 0; i + 1 < lines.length; i++) {
      const last = lines[i][lines[i].length - 1];
      const next = lines[i + 1][0];
      const nextUnitEnd = this.truth.unitOf(next[0] + firstId)[1];
      const crossesHard = this.truth.words[last[1] + firstId].hardAfter;
      // Only after a word that visibly closes its sentence, as in the wild.
      const closes = rows[last[1]] && rows[last[1]].text.endsWith(".");
      if (crossesHard || !closes || nextUnitEnd - (next[0] + firstId) < 1 || next[1] <= next[0] ||
          !this.random.chance(overrun)) continue;
      last[1] += 1;
      next[0] += 1;
    }
    return lines.map((chunks) => JSON.stringify(chunks));
  }

  async fetch(url, init) {
    const signal = init && init.signal;
    const headers = init && init.headers || {};
    const auth = String(headers.Authorization || headers.authorization || "");
    const body = JSON.parse(String(init && init.body || "{}"));
    this.promptChars += String(init && init.body || "").length;
    const rows = parseCurrentRows(body);
    this.requests++;
    const trace = String(headers["X-CaptionAI-Trace"] || headers["x-captionai-trace"] || "");
    const requestId = trace.replace(/\.\d+$/, "");
    if (requestId) this.phases.set(requestId, "first-byte");
    const endPhase = () => { if (requestId) this.phases.delete(requestId); };
    if (signal) signal.addEventListener("abort", endPhase, { once: true });
    const now = this.clock.now;
    const record = { url: String(url), auth: auth === `Bearer ${SECRET_KEY}`, first: rows[0].id,
      last: rows[rows.length - 1].id, at: now };
    this.onRequest(record);
    const r = this.random;
    const profile = this.profile;

    // Provider-side RPM: excess starts get 429, which the client must absorb.
    this.starts = this.starts.filter((t) => now - t < 60000);
    if (profile.rpm && this.starts.length >= profile.rpm) {
      this.rejected429++;
      return this.errorResponse(429, "RESOURCE_EXHAUSTED", { "retry-after": String(r.int(1, 8)) }, signal)
        .finally(endPhase);
    }
    this.starts.push(now);
    if (profile.overload && r.chance(profile.overload)) {
      return this.errorResponse(503, "UNAVAILABLE", {}, signal).finally(endPhase);
    }
    // Real models skip a few positions mid-response in about one request in
    // ten (real replays); "skip" reproduces it alongside the other faults.
    const skip = r.chance(Number.isFinite(profile.skips) ? profile.skips : 0.1);
    const fault = r.chance(profile.faults) ? r.pick(["hang", "truncate", "malformed", "duplicate",
      "no-marker", "stall", "garbage"]) : "";
    const ttfb = r.int(profile.ttfb[0], profile.ttfb[1]) + Math.round((profile.ttfbPerItemMs || 0) * rows.length);
    if (fault === "hang") {
      // No headers until long after any connect timeout.
      await this.wait(120000, signal);
    } else {
      await this.wait(ttfb, signal);
    }

    let lines = this.linesFor(rows);
    if (skip && lines.length > 1) {
      const index = r.int(1, lines.length - 1);
      const chunks = JSON.parse(lines[index]);
      if (chunks[0][1] > chunks[0][0]) {
        chunks[0][0] += 1;
        lines[index] = JSON.stringify(chunks);
      }
    }
    if (fault === "truncate") lines = lines.slice(0, r.int(0, lines.length));
    if (fault === "malformed" && lines.length) lines.splice(r.int(0, lines.length - 1), 0, "[[0,");
    if (fault === "duplicate" && lines.length) lines.splice(r.int(0, lines.length - 1), 0, lines[0]);
    if (fault === "garbage") lines = ["I am sorry, here is the translation:", ...lines];
    const marker = fault === "truncate" || fault === "no-marker" ? [] : ["[]"];
    const text = [...lines, ...marker].join("\n") + "\n";
    if (requestId) this.phases.set(requestId, "generating");
    return this.streamResponse(text, fault === "stall", signal, endPhase);
  }

  wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(abortError()); return; }
      const id = this.clock.schedule("provider", ms, resolve, false);
      if (signal) signal.addEventListener("abort", () => { this.clock.cancel(id); reject(abortError()); }, { once: true });
    });
  }

  errorResponse(status, code, headerValues, signal) {
    const text = JSON.stringify({ error: { code: status, status: code, message: "simulated" } });
    return this.wait(this.random.int(100, 600), signal).then(() => ({
      ok: false,
      status,
      headers: { get: (name) => headerValues[String(name).toLowerCase()] || null },
      text: async () => text,
      json: async () => JSON.parse(text),
      clone() { return this; }
    }));
  }

  streamResponse(text, stall, signal, onFinish) {
    this.completionChars += text.length;
    const charsPerSecond = this.profile.charsPerSecond || 500;
    const r = this.random;
    const events = [];
    // Split the JSONL into deltas at arbitrary character boundaries.
    for (let i = 0; i < text.length;) {
      const size = r.int(1, 40);
      events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + size) } }] })}\n\n`);
      i += size;
    }
    events.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } })}\n\n`);
    events.push("data: [DONE]\n\n");
    // Frame the SSE bytes at arbitrary boundaries too.
    const wire = events.join("");
    const frames = [];
    for (let i = 0; i < wire.length;) {
      const size = r.int(5, 300);
      frames.push(wire.slice(i, i + size));
      i += size;
    }
    const stallAt = stall ? r.int(0, Math.max(0, frames.length - 1)) : -1;
    // Each frame arrives after the time the model needs to generate the
    // content it carries (SSE framing itself costs nothing), with jitter.
    const contentShare = text.length / Math.max(1, wire.length);
    const frameDelay = (frame) => Math.max(2, Math.round(
      (frame.length * contentShare * 1000 / charsPerSecond) * (0.7 + r() * 0.6)));
    const encoder = new TextEncoder();
    const provider = this;
    let index = 0;
    let cancelled = false;
    this.inFlight++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      provider.inFlight--;
      if (onFinish) onFinish();
    };
    // An aborted request releases its stream even when nobody is reading.
    if (signal) signal.addEventListener("abort", finish, { once: true });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "text/event-stream" : null },
      body: {
        getReader: () => ({
          async read() {
            if (cancelled) return { done: true, value: undefined };
            const pause = index === stallAt ? r.int(30000, 100000)
              : frameDelay(frames[Math.min(index, frames.length - 1)] || "");
            try { await provider.wait(pause, signal); } catch (error) { finish(); throw error; }
            if (index >= frames.length) { finish(); return { done: true, value: undefined }; }
            const value = encoder.encode(frames[index++]);
            // The server is done once its last byte is on the wire.
            if (index >= frames.length) finish();
            return { done: false, value };
          },
          async cancel() { cancelled = true; finish(); },
          releaseLock() {}
        })
      },
      text: async () => wire,
      clone() { return this; }
    };
  }
}

function abortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

module.exports = { FakeProvider, PROFILES, SECRET_KEY };
