#!/usr/bin/env node
// Replay real captions through the real runtime, without Chrome or YouTube.
//
//   node scripts/sim-replay.js --cues-file <file.srt|json3>
//        [--provider fake|gemini] [--model NAME] [--base-url URL] [--rpm N]
//        [--rate R] [--minutes M] [--request-items N] [--seed N] [--scenario continuous|seeks]
//
// --scenario seeks plays like a viewer who skips around: 1x, a jump forward,
// 3x, a jump back, 2x (about 4 minutes of wall time), so urgent requests,
// seek adoption and fast playback are measured with the real model too.
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
// --key-env NAME reads another variable (for example DEEPSEEK_API_KEY with
// --base-url https://api.deepseek.com --model deepseek-v4-flash --rpm 0).
// --extra-body JSON sets the popup's extra request parameters for the run.
// --root DIR replays another checkout of the runtime (an older release) and
// --label names the result, so versions can be compared on the same captions.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const rootIndex = process.argv.indexOf("--root");
if (rootIndex > 0) process.env.SIM_ROOT = path.resolve(process.argv[rootIndex + 1]);
const { runSeed } = require("../tests/sim/run");
const { RealProvider } = require("../tests/sim/real-provider");
const { startFakeProvider, cuesFromFile, analyze } = require("./lib/e2e-common");

const root = path.resolve(__dirname, "..");
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
const args = { cuesFile: "", provider: "fake", model: "gemini-3.5-flash-lite", baseUrl: GEMINI, rpm: 15,
  rate: 1, minutes: 0, scenario: "continuous", requestItems: null, seed: 1, out: path.join(root, "e2e-results") };
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
  else if (flag === "--scenario") args.scenario = next();
  else if (flag === "--request-items") args.requestItems = Number(next());
  else if (flag === "--seed") args.seed = Number(next());
  else if (flag === "--out") args.out = path.resolve(next());
  else if (flag === "--key-env") args.keyEnv = next();
  else if (flag === "--extra-body") args.extraBody = next();
  else if (flag === "--label") args.label = next().replace(/[^A-Za-z0-9._-]/g, "");
  else if (flag === "--root") next(); // applied before the runtime loads
  else throw new Error(`unknown argument ${flag}`);
}
if (!["continuous", "seeks"].includes(args.scenario)) throw new Error("--scenario is continuous or seeks");
if (args.extraBody) {
  try { if (!args.extraBody.trim().startsWith("{")) throw 0; JSON.parse(args.extraBody); }
  catch (_e) { throw new Error(`--extra-body is not a JSON object: ${args.extraBody}`); }
}
if (!args.cuesFile) throw new Error("--cues-file <captions.srt | json3> is required");
if (!["fake", "gemini"].includes(args.provider)) throw new Error("--provider is fake or gemini");
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

(async () => {
  const keyEnv = args.keyEnv || "CAPTIONAI_E2E_API_KEY";
  if (!/^[A-Z][A-Z0-9_]*$/.test(keyEnv)) throw new Error("--key-env must be an environment variable name");
  const secret = args.provider === "gemini" ? String(process.env[keyEnv] || "").trim()
    : "replay-fake-key-not-a-secret";
  if (!secret) throw new Error(`set ${keyEnv} to replay against a real provider`);
  const fake = args.provider === "fake" ? await startFakeProvider() : null;
  const settings = fake ? { aiBaseUrl: fake.baseUrl, aiModel: "fake-model", aiRateLimitRpm: 0 }
    : { aiBaseUrl: args.baseUrl, aiModel: args.model, aiRateLimitRpm: args.rpm };
  const cues = cuesFromFile(args.cuesFile);
  if (!cues.length) throw new Error("no cues in the caption file");
  const videoMs = cues[cues.length - 1].start + cues[cues.length - 1].dur;
  const playMs = Math.round((args.minutes > 0 ? Math.min(videoMs, args.minutes * 60000) : videoMs) / args.rate);
  log(`${cues.length} cues, ${Math.round(videoMs / 1000)} s of video; ${args.scenario === "seeks" ? "seek scenario (1x, 3x, 2x, 1x with three jumps)" : `playing ${Math.round(playMs / 1000)} s at ${args.rate}x`}`,
    `against ${fake ? "the local stand-in" : settings.aiModel}`);
  const provider = new RealProvider();
  const progress = setInterval(() => log(`requests ${provider.requests}, in flight ${provider.inFlight}`), 30000);
  let result;
  try {
    result = await runSeed(args.seed, {
      cues, provider, secret, realTime: true, collect: true, profile: "limited",
      // The popup's "extra request parameters" for this endpoint and model,
      // e.g. '{"thinking":{"type":"disabled"}}'.
      ...(args.extraBody ? { local: { aiExtraBodyProfiles: {
        [require("../tests/helpers").loadShared().aiRequestProfileScope(settings.aiBaseUrl, settings.aiModel)]: args.extraBody
      } } } : {}),
      settings: { ...settings, aiMaxConcurrency: 3, ...(Number.isFinite(args.requestItems) ? { aiRequestItems: args.requestItems } : {}) },
      actions: args.scenario === "seeks" ? [
        { type: "play", rate: 1, ms: 45000 },
        { type: "seek", to: Math.round(videoMs * 0.55) },
        { type: "play", rate: 3, ms: 60000 },
        { type: "seek", to: Math.round(videoMs * 0.2) },
        { type: "play", rate: 2, ms: 60000 },
        { type: "seek", to: Math.round(videoMs * 0.8) },
        { type: "play", rate: 1, ms: 30000 }
      ] : [{ type: "play", rate: args.rate, ms: playMs }]
    });
  } finally {
    clearInterval(progress);
    if (fake) fake.server.close();
  }
  if (!result.ok) {
    console.error("INVARIANT", JSON.stringify({ invariant: result.invariant, detail: result.detail, at: result.at }));
    process.exitCode = 1;
    if (!result.committed) return;
  }
  const report = {
    source: "sim-replay", violation: result.ok ? null : { invariant: result.invariant, detail: result.detail, at: result.at, debug: result.debug }, label: args.label || "", runtimeRoot: process.env.SIM_ROOT ? path.basename(process.env.SIM_ROOT) : "working-tree", provider: args.provider, model: settings.aiModel, captionSource: `file:${path.basename(args.cuesFile)}`,
    scenario: args.scenario, rate: args.scenario === "seeks" ? "1/3/2/1" : args.rate,
    playedSeconds: args.scenario === "seeks" ? null : Math.round(playMs * args.rate / 1000),
    stallMs: result.metrics.stallMs, stallBreakdown: result.metrics.stallBreakdown,
    providerRequests: result.providerRequests, provider429: result.provider429,
    httpLog: provider.log.map(({ requestId, status, firstByteMs, totalMs, chars }) => ({ requestId, status, firstByteMs, totalMs, chars })),
    ...analyze(result.bundle, secret, Boolean(fake))
  };
  if (JSON.stringify({ report, committed: result.committed, bundle: result.bundle }).includes(secret)) {
    throw new Error("the API key appeared in the replay output; nothing was written");
  }
  fs.mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `replay-${args.label ? args.label + "-" : ""}${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ report, committed: result.committed, bundle: result.bundle }, null, 1));
  const { requestLog, httpLog, transitions, ...brief } = report;
  console.log(JSON.stringify(brief, null, 1));
  log("committed units", result.committed.units.length, "of", result.committed.groupCount, "groups");
  log("result:", file);
  if (report.failures.length) process.exitCode = 1;
})().catch((error) => { console.error(String(error && error.stack || error)); process.exitCode = 2; });
