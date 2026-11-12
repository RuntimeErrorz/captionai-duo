#!/usr/bin/env node
// Replay real captions through the real runtime, without Chrome or YouTube.
//
//   node scripts/sim-replay.js --cues-file <file.srt|json3>
//        [--provider fake|gemini] [--model NAME] [--base-url URL] [--rpm N]
//        [--rate R] [--minutes M] [--request-items N] [--seed N]
//   node --use-env-proxy scripts/sim-replay.js --provider gemini --cues-file ...
//
// The simulator (tests/sim) loads the real background and content code and
// plays the captions start to finish at --rate, paced to wall time so the
// provider's real latency shapes every scheduling decision. The result file
// has the same {report, committed, bundle} shape scripts/e2e-chrome.js
// writes, so scripts/quality-eval.js reads it directly.
//
// --provider gemini reads the key from CAPTIONAI_E2E_API_KEY in your own shell;
// it lives only in the simulated chrome.storage.local and is never written out
// (the run fails if it appears in the transport, storage or debug log).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { runSeed } = require("../tests/sim/run");
const { RealProvider } = require("../tests/sim/real-provider");
const { startFakeProvider, cuesFromFile, analyze } = require("./lib/e2e-common");

const root = path.resolve(__dirname, "..");
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
const args = { cuesFile: "", provider: "fake", model: "gemini-3.5-flash-lite", baseUrl: GEMINI, rpm: 15,
  rate: 1, minutes: 0, requestItems: null, seed: 1, out: path.join(root, "e2e-results") };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  const next = () => process.argv[++i];
  if (flag === "--cues-file") args.cuesFile = path.resolve(next());
  else if (flag === "--provider") args.provider = next();
  else if (flag === "--model") args.model = next();
  else if (flag === "--base-url") args.baseUrl = next().replace(/\/$/, "");
  else if (flag === "--rpm") args.rpm = Number(next());
  else if (flag === "--rate") args.rate = Number(next());
  else if (flag === "--minutes") args.minutes = Number(next());
  else if (flag === "--request-items") args.requestItems = Number(next());
  else if (flag === "--seed") args.seed = Number(next());
  else if (flag === "--out") args.out = path.resolve(next());
  else throw new Error(`unknown argument ${flag}`);
}
if (!args.cuesFile) throw new Error("--cues-file <captions.srt | json3> is required");
if (!["fake", "gemini"].includes(args.provider)) throw new Error("--provider is fake or gemini");
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

(async () => {
  const secret = args.provider === "gemini" ? String(process.env.CAPTIONAI_E2E_API_KEY || "").trim()
    : "replay-fake-key-not-a-secret";
  if (!secret) throw new Error("set CAPTIONAI_E2E_API_KEY to replay against Gemini");
  const fake = args.provider === "fake" ? await startFakeProvider() : null;
  const settings = fake ? { aiBaseUrl: fake.baseUrl, aiModel: "fake-model", aiRateLimitRpm: 0 }
    : { aiBaseUrl: args.baseUrl, aiModel: args.model, aiRateLimitRpm: args.rpm };
  const cues = cuesFromFile(args.cuesFile);
  if (!cues.length) throw new Error("no cues in the caption file");
  const videoMs = cues[cues.length - 1].start + cues[cues.length - 1].dur;
  const playMs = Math.round((args.minutes > 0 ? Math.min(videoMs, args.minutes * 60000) : videoMs) / args.rate);
  log(`${cues.length} cues, ${Math.round(videoMs / 1000)} s of video; playing ${Math.round(playMs / 1000)} s at ${args.rate}x`,
    `against ${fake ? "the local stand-in" : settings.aiModel}`);
  const provider = new RealProvider();
  const progress = setInterval(() => log(`requests ${provider.requests}, in flight ${provider.inFlight}`), 30000);
  let result;
  try {
    result = await runSeed(args.seed, {
      cues, provider, secret, realTime: true, collect: true, profile: "limited",
      settings: { ...settings, aiMaxConcurrency: 3, ...(Number.isFinite(args.requestItems) ? { aiRequestItems: args.requestItems } : {}) },
      actions: [{ type: "play", rate: args.rate, ms: playMs }]
    });
  } finally {
    clearInterval(progress);
    if (fake) fake.server.close();
  }
  if (!result.ok) {
    console.error(JSON.stringify({ invariant: result.invariant, detail: result.detail, at: result.at, debug: result.debug.slice(-15) }, null, 1));
    process.exitCode = 1;
    return;
  }
  const report = {
    source: "sim-replay", provider: args.provider, model: settings.aiModel, captionSource: `file:${path.basename(args.cuesFile)}`,
    rate: args.rate, playedSeconds: Math.round(playMs * args.rate / 1000),
    stallMs: result.metrics.stallMs, stallBreakdown: result.metrics.stallBreakdown,
    providerRequests: result.providerRequests, provider429: result.provider429,
    httpLog: provider.log.map(({ requestId, status, firstByteMs, totalMs, chars }) => ({ requestId, status, firstByteMs, totalMs, chars })),
    ...analyze(result.bundle, secret, Boolean(fake))
  };
  if (JSON.stringify({ report, committed: result.committed, bundle: result.bundle }).includes(secret)) {
    throw new Error("the API key appeared in the replay output; nothing was written");
  }
  fs.mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `replay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ report, committed: result.committed, bundle: result.bundle }, null, 1));
  const { requestLog, httpLog, transitions, ...brief } = report;
  console.log(JSON.stringify(brief, null, 1));
  log("committed units", result.committed.units.length, "of", result.committed.groupCount, "groups");
  log("result:", file);
  if (report.failures.length) process.exitCode = 1;
})().catch((error) => { console.error(String(error && error.stack || error)); process.exitCode = 2; });
