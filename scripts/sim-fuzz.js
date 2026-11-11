#!/usr/bin/env node
// Deterministic simulation fuzzing of the real extension runtime.
//   node scripts/sim-fuzz.js [--seeds N] [--from S] [--seed S] [--profile fast|limited|flaky]
// Every failure prints its seed; rerun it alone with --seed to reproduce the
// identical event sequence.
"use strict";

const path = require("node:path");
const { runSeed } = require(path.join(__dirname, "..", "tests", "sim", "run.js"));

const args = { seeds: 50, from: 1, seed: null, profile: null, verbose: false, rpm: null, rate: null, ttfb: null };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  const next = () => process.argv[++i];
  if (flag === "--seeds") args.seeds = Math.max(1, Number(next()) || 1);
  else if (flag === "--from") args.from = Number(next()) || 1;
  else if (flag === "--seed") args.seed = Number(next());
  else if (flag === "--profile") args.profile = next();
  else if (flag === "--verbose") args.verbose = true;
  else if (flag === "--rpm") args.rpm = Number(next());
  else if (flag === "--rate") args.rate = Number(next());
  else if (flag === "--ttfb") args.ttfb = next().split("-").map(Number);
  else if (flag === "--json") args.json = true;
  else throw new Error(`unknown argument ${flag}`);
}

(async () => {
  const seeds = args.seed != null ? [args.seed]
    : Array.from({ length: args.seeds }, (_v, i) => args.from + i);
  const failures = [];
  const totals = { stallMs: 0, virtualMs: 0, translateBatches: 0, providerRequests: 0, provider429: 0,
    sentItems: 0, cancels: 0 };
  for (const seed of seeds) {
    const started = Date.now();
    const result = await runSeed(seed, {
      ...(args.profile ? { profile: args.profile } : {}),
      ...(Number.isFinite(args.rpm) ? { rpm: args.rpm } : {}),
      ...(Number.isFinite(args.rate) ? { rate: args.rate } : {}),
      ...(args.ttfb ? { ttfb: args.ttfb } : {})
    });
    const wallMs = Date.now() - started;
    if (!result.ok) {
      failures.push(result);
      console.log(`seed ${seed} [${result.profile}] FAIL ${result.invariant} at ${result.at}ms ` +
        JSON.stringify(result.detail));
      if (args.verbose || args.seed != null) {
        console.log(JSON.stringify({ trace: result.trace, paints: result.paints }, null, 1));
        for (const entry of result.debug || []) console.log(entry.t, entry.event, entry.data);
      }
      continue;
    }
    totals.stallMs += result.metrics.stallMs;
    totals.virtualMs += result.virtualMs;
    totals.translateBatches += result.metrics.translateBatches;
    totals.providerRequests += result.providerRequests;
    totals.cancels += result.metrics.cancels;
    totals.provider429 += result.provider429;
    totals.sentItems += result.metrics.sentItems;
    if (args.verbose || args.seed != null) {
      console.log(`seed ${seed} [${result.profile}] ok ${wallMs}ms wall ` + JSON.stringify(result.metrics));
    }
  }
  console.log(JSON.stringify({ seeds: seeds.length, failures: failures.length,
    failingSeeds: failures.map((f) => f.seed), ...totals }));
  process.exitCode = failures.length ? 1 : 0;
})().catch((error) => { console.error(error && error.stack || error); process.exitCode = 2; });
