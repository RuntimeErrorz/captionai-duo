"use strict";

// A fake OpenAI-compatible chat endpoint that answers the real prompt. It reads
// CURRENT_CUES from the request, segments by a ground-truth sentence map, and
// streams the documented JSONL protocol over SSE in arbitrary byte chunks.
// Translations are tags "T<start>-<end>" in global coordinates, so every
// committed or painted text can be checked against the truth it came from.

const SECRET_KEY = "simulated-api-key-not-a-secret-7f3a9c";

const PROFILES = Object.freeze({
  // DeepSeek-like: fast, unlimited RPM, rare faults.
  fast: { rpm: 0, ttfb: [700, 2600], faults: 0.02 },
  // Free-tier Gemini-like: 15 RPM, slower first byte, overload spikes.
  limited: { rpm: 15, ttfb: [900, 4200], faults: 0.06, overload: 0.08 },
  // Everything that can go wrong, often.
  flaky: { rpm: 60, ttfb: [400, 9000], faults: 0.25, overload: 0.12 },
  // A thinking model behind a free tier: long first byte, few requests.
  slow: { rpm: 15, ttfb: [5000, 14000], faults: 0.04, overload: 0.04 }
});

function parseCurrentRows(body) {
  const user = body && Array.isArray(body.messages) && body.messages[1] && String(body.messages[1].content || "");
  const start = user.indexOf("CURRENT_CUES:\n");
  const end = user.indexOf("\nFUTURE_CONTEXT:");
  if (start < 0 || end < 0) throw new Error("fake provider: prompt has no CURRENT_CUES block");
  const rows = JSON.parse(user.slice(start + "CURRENT_CUES:\n".length, end));
  return rows.map((row) => {
    const match = /^w(\d+)$/.exec(String(row[1]));
    if (!match) throw new Error(`fake provider: unexpected row text ${row[1]}`);
    return { local: Number(row[0]), id: Number(match[1]) };
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
      lines.push(JSON.stringify(chunks));
      id = unitEnd + 1;
    }
    return lines;
  }

  async fetch(url, init) {
    const signal = init && init.signal;
    const headers = init && init.headers || {};
    const auth = String(headers.Authorization || headers.authorization || "");
    const body = JSON.parse(String(init && init.body || "{}"));
    const rows = parseCurrentRows(body);
    this.requests++;
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
      return this.errorResponse(429, "RESOURCE_EXHAUSTED", { "retry-after": String(r.int(1, 8)) }, signal);
    }
    this.starts.push(now);
    if (profile.overload && r.chance(profile.overload)) {
      return this.errorResponse(503, "UNAVAILABLE", {}, signal);
    }
    const fault = r.chance(profile.faults) ? r.pick(["hang", "truncate", "malformed", "duplicate",
      "no-marker", "stall", "garbage"]) : "";
    const ttfb = r.int(profile.ttfb[0], profile.ttfb[1]);
    if (fault === "hang") {
      // No headers until long after any connect timeout.
      await this.wait(120000, signal);
    } else {
      await this.wait(ttfb, signal);
    }

    let lines = this.linesFor(rows);
    if (fault === "truncate") lines = lines.slice(0, r.int(0, lines.length));
    if (fault === "malformed" && lines.length) lines.splice(r.int(0, lines.length - 1), 0, "[[0,");
    if (fault === "duplicate" && lines.length) lines.splice(r.int(0, lines.length - 1), 0, lines[0]);
    if (fault === "garbage") lines = ["I am sorry, here is the translation:", ...lines];
    const marker = fault === "truncate" || fault === "no-marker" ? [] : ["[]"];
    const text = [...lines, ...marker].join("\n") + "\n";
    return this.streamResponse(text, fault === "stall", signal);
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

  streamResponse(text, stall, signal) {
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
    const encoder = new TextEncoder();
    const provider = this;
    let index = 0;
    let cancelled = false;
    this.inFlight++;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; provider.inFlight--; } };
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
            const pause = index === stallAt ? r.int(30000, 100000) : r.int(5, 60);
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
