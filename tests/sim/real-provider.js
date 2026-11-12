"use strict";

// A real HTTP provider for the simulator (scripts/sim-replay.js): requests go
// out through Node's fetch, and the same bookkeeping the fake provider keeps
// (in-flight streams, per-request phase, 429s) feeds the checker and stall
// attribution. The simulation clock is paced to wall time while it runs, so
// real latency lands where it would in a browser.

class RealProvider {
  constructor() {
    this.inFlight = 0;
    this.requests = 0;
    this.rejected429 = 0;
    this.promptChars = 0;
    this.completionChars = 0;
    this.phases = new Map();
    this.log = [];
  }

  async fetch(url, init) {
    const headers = init && init.headers || {};
    const trace = String(headers["X-CaptionAI-Trace"] || headers["x-captionai-trace"] || "");
    const requestId = trace.replace(/\.\d+$/, "");
    const entry = { requestId, startedAt: Date.now(), firstByteMs: null, totalMs: null, status: null, chars: 0 };
    this.requests++;
    this.log.push(entry);
    this.promptChars += String(init && init.body || "").length;
    if (requestId) this.phases.set(requestId, "first-byte");
    this.inFlight++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.inFlight--;
      entry.totalMs = Date.now() - entry.startedAt;
      if (requestId) this.phases.delete(requestId);
    };
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      finish();
      throw error;
    }
    entry.status = response.status;
    entry.firstByteMs = Date.now() - entry.startedAt;
    if (response.status === 429) this.rejected429++;
    if (!response.ok || !response.body) {
      finish();
      return response;
    }
    if (requestId) this.phases.set(requestId, "generating");
    const provider = this;
    const upstream = response.body.getReader();
    // The extension stops reading early (commit guard reached, recoverable
    // tail): cancelling this stream must release the request too.
    const counted = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await upstream.read();
          if (done) { finish(); controller.close(); return; }
          entry.chars += value.byteLength;
          provider.completionChars += value.byteLength;
          controller.enqueue(value);
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      cancel(reason) { finish(); return upstream.cancel(reason); }
    });
    if (init && init.signal) init.signal.addEventListener("abort", finish, { once: true });
    return new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}

module.exports = { RealProvider };
