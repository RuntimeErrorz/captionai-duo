#!/usr/bin/env node
// Translation quality of an end-to-end run, judged by a model.
//
//   node --use-env-proxy scripts/quality-eval.js --result e2e-results/e2e-....json
//        [--base-url URL] [--model NAME] [--judge-model NAME] [--limit N] [--dry-run]
//
// For every unit the extension committed, a reference translation is made
// with the same segmentation but generous context (the whole neighbourhood
// of units at once). A judge model then scores the committed translation for
// accuracy, fluency and segmentation (1-5, the reference shown as one good
// rendering) and names any issue. Scores are grouped by provenance — the
// request class that committed the unit and how close it ended to that
// request's uncommitted runway — to see whether speed choices cost quality.
//
// The API key is read from CAPTIONAI_E2E_API_KEY in your own shell and never
// written anywhere. --dry-run uses local stand-ins instead of any API.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const args = { result: "", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  model: "gemini-3.5-flash-lite", judgeModel: "", limit: 400, dryRun: false, batch: 20, context: 20 };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  const next = () => process.argv[++i];
  if (flag === "--result") args.result = path.resolve(next());
  else if (flag === "--base-url") args.baseUrl = next().replace(/\/$/, "");
  else if (flag === "--model") args.model = next();
  else if (flag === "--judge-model") args.judgeModel = next();
  else if (flag === "--limit") args.limit = Math.max(1, Number(next()) || 1);
  else if (flag === "--dry-run") args.dryRun = true;
  else throw new Error(`unknown argument ${flag}`);
}
if (!args.result) throw new Error("--result <e2e-results/....json> is required");
args.judgeModel = args.judgeModel || args.model;
const key = String(process.env.CAPTIONAI_E2E_API_KEY || "").trim();
if (!args.dryRun && !key) throw new Error("set CAPTIONAI_E2E_API_KEY (or use --dry-run)");

const { committed, bundle } = JSON.parse(fs.readFileSync(args.result, "utf8"));
if (!committed || !Array.isArray(committed.units) || !committed.units.length) {
  throw new Error("this result has no committed units (re-run scripts/e2e-chrome.js)");
}
const targetLang = committed.targetLang || "zh-CN";

// ---- provenance from the extension's own debug log ------------------------------
function provenance(entries) {
  const classes = [];
  for (const entry of entries || []) {
    if (entry.event === "batch-start") {
      const d = entry.data || {};
      classes.push({ start: d.requestStart, end: d.requestEnd, requestClass: d.requestClass || "", items: d.itemCount });
    }
  }
  const byUnit = new Map();
  for (const entry of entries || []) {
    if (entry.event !== "semantic-prefix-committed") continue;
    const d = entry.data || {};
    const request = classes.findLast((c) => c.start <= d.requestStart && d.requestStart <= c.end) || {};
    for (const unit of d.units || []) {
      const last = Math.max(...unit.members);
      byUnit.set(unit.unitId, {
        requestClass: request.requestClass || "unknown",
        windowItems: request.items || null,
        itemsBeforeGuard: Number.isFinite(d.guardStart) ? d.guardStart - last - 1 : null
      });
    }
  }
  return byUnit;
}
const origin = provenance(bundle && bundle.entries);
const units = committed.units.slice(0, args.limit).map((unit, index) => ({ index, ...unit,
  ...(origin.get(unit.unitId) || { requestClass: "ledger-or-unknown", windowItems: null, itemsBeforeGuard: null }) }));

// ---- model calls -------------------------------------------------------------------
async function chat(model, system, user) {
  const response = await fetch(`${args.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.replace(/AIza[0-9A-Za-z_-]{20,}/g, "<key>").slice(0, 300)}`);
  const content = JSON.parse(text).choices[0].message.content;
  const json = content.slice(content.indexOf("["), content.lastIndexOf("]") + 1);
  return JSON.parse(json);
}

async function referenceTranslations(batch, before, after) {
  if (args.dryRun) return batch.map((unit) => ({ id: unit.index, translation: unit.translation }));
  const line = (unit) => `${unit.index}\t${unit.source}`;
  return chat(args.model,
    `You translate subtitles into ${targetLang}. Translate each numbered segment completely and naturally, ` +
    "using all the context given. Keep the segmentation: one translation per id. " +
    'Return only a JSON array [{"id": <id>, "translation": "..."}].',
    `CONTEXT BEFORE (do not translate):\n${before.map(line).join("\n")}\n\n` +
    `SEGMENTS:\n${batch.map(line).join("\n")}\n\nCONTEXT AFTER (do not translate):\n${after.map(line).join("\n")}`);
}

async function judge(batch, reference) {
  if (args.dryRun) {
    return batch.map((unit) => ({ id: unit.index, accuracy: 5, fluency: 5, segmentation: 5, issue: "" }));
  }
  const rows = batch.map((unit) => JSON.stringify({ id: unit.index, source: unit.source,
    candidate: unit.translation, reference: reference.get(unit.index) || "" }));
  return chat(args.judgeModel,
    `You evaluate subtitle translations into ${targetLang}. For each item, score the CANDIDATE from 1 to 5 for ` +
    "accuracy (meaning, facts, names, numbers, negation; nothing omitted or added), fluency (natural target " +
    "language), and segmentation (the source segment is a natural sentence or clause, not a fragment or two " +
    "sentences glued together). The REFERENCE is one good translation made with more context; the candidate " +
    "need not match it word for word. Name the main problem in a few words, or leave it empty. " +
    'Return only a JSON array [{"id": <id>, "accuracy": n, "fluency": n, "segmentation": n, "issue": "..."}].',
    rows.join("\n"));
}

// ---- run -------------------------------------------------------------------------
(async () => {
  const reference = new Map();
  const scores = new Map();
  for (let i = 0; i < units.length; i += args.batch) {
    const batch = units.slice(i, i + args.batch);
    const before = units.slice(Math.max(0, i - args.context), i);
    const after = units.slice(i + args.batch, i + args.batch + args.context);
    for (const row of await referenceTranslations(batch, before, after)) reference.set(Number(row.id), String(row.translation || ""));
    for (const row of await judge(batch, reference)) scores.set(Number(row.id), row);
    process.stdout.write(`\rjudged ${Math.min(units.length, i + args.batch)}/${units.length}`);
  }
  process.stdout.write("\n");

  const scored = units.filter((unit) => scores.has(unit.index)).map((unit) => ({ ...unit,
    reference: reference.get(unit.index) || "", ...scores.get(unit.index) }));
  const mean = (list, field) => list.length ? +(list.reduce((sum, item) => sum + Number(item[field] || 0), 0) / list.length).toFixed(2) : null;
  const summarize = (list) => ({ units: list.length, accuracy: mean(list, "accuracy"), fluency: mean(list, "fluency"),
    segmentation: mean(list, "segmentation"), issues: list.filter((item) => item.issue).length });
  const groupBy = (keyOf) => {
    const groups = {};
    for (const item of scored) (groups[keyOf(item)] = groups[keyOf(item)] || []).push(item);
    return Object.fromEntries(Object.entries(groups).map(([name, list]) => [name, summarize(list)]));
  };
  const report = {
    result: path.basename(args.result), model: args.model, judgeModel: args.judgeModel, dryRun: args.dryRun,
    overall: summarize(scored),
    byRequestClass: groupBy((item) => item.requestClass),
    byDistanceToRunway: groupBy((item) => item.itemsBeforeGuard == null ? "unknown"
      : item.itemsBeforeGuard < 16 ? "<16 items" : item.itemsBeforeGuard < 64 ? "16-63 items" : ">=64 items"),
    worst: scored.slice().sort((a, b) => (a.accuracy + a.fluency + a.segmentation) - (b.accuracy + b.fluency + b.segmentation))
      .slice(0, 10).map(({ source, translation, reference: ref, accuracy, fluency, segmentation, issue, requestClass }) =>
        ({ source, candidate: translation, reference: ref, accuracy, fluency, segmentation, issue, requestClass }))
  };
  const out = args.result.replace(/\.json$/, "") + `.quality${args.dryRun ? "-dry" : ""}.json`;
  fs.writeFileSync(out, JSON.stringify({ report, scored }, null, 1));
  console.log(JSON.stringify({ ...report, worst: report.worst.slice(0, 3) }, null, 1));
  console.log("full report:", out);
})().catch((error) => { console.error(String(error && error.stack || error)); process.exitCode = 1; });
