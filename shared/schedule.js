// When is a writer stuck? Decided from measured provider latency.
//
// Two measured quantities, per endpoint and model, replace the old fixed
// grace times (14 s startup, 4 s progress, 2.5 s stale prefetch) and the
// 48-item lag threshold:
//   firstMs         request start -> its first streamed, committed progress
//   itemsPerSecond  committed items per second once a stream is producing
// A writer is stuck when its wait exceeds OVERDUE_FACTOR times what the
// provider has recently needed. Only then is it replaced: a restart pays a
// fresh first byte, so restarting a healthy writer that is merely far behind
// cost 4-10% more requests in simulation without reducing stall.
(() => {
  "use strict";
  if (globalThis.YTDS_SHARED) return;
  const internal = globalThis["__captionAiDuoSharedModulesV1__"];
  if (!internal) throw new Error("CaptionAI shared modules loaded out of order");

  const SAMPLE_LIMIT = 8;
  // Before anything is measured: a slow, rate-limited provider.
  const PRIOR_FIRST_MS = 7000;
  const PRIOR_ITEMS_PER_SECOND = 40;
  // Simulated against the fixed thresholds: 1.5 was worse everywhere (up
  // to +16% stall on slow providers), 2 cost requests, 3 matched or beat
  // them on every provider profile.
  const OVERDUE_FACTOR = 3;
  // A sentence's worth of items: the next commit of a producing stream is
  // due within this many items at the measured rate.
  const UNIT_ITEMS = 32;
  const MIN_PROGRESS_GAP_MS = 1000;

  function scheduleLatencyCreate(key) {
    return { key: String(key || ""), firstMs: [], rates: [] };
  }

  function trim(list) {
    if (list.length > SAMPLE_LIMIT) list.splice(0, list.length - SAMPLE_LIMIT);
  }

  // One request's measurements: how long until its first committed progress
  // (once per request), and the items it has committed over the time it has
  // been producing (updated in place as the same request streams on).
  function scheduleLatencyNote(stats, sample) {
    if (!stats || !sample) return stats;
    const firstMs = Number(sample.firstMs);
    if (Number.isFinite(firstMs) && firstMs > 0) {
      stats.firstMs.push(firstMs);
      trim(stats.firstMs);
    }
    const items = Number(sample.items);
    const ms = Number(sample.ms);
    if (Number.isFinite(items) && items > 0 && Number.isFinite(ms) && ms >= 250) {
      const id = String(sample.id || "");
      const value = items * 1000 / ms;
      const existing = id ? stats.rates.find((rate) => rate.id === id) : null;
      if (existing) existing.value = value;
      else { stats.rates.push({ id, value }); trim(stats.rates); }
    }
    return stats;
  }

  function median(list) {
    const sorted = list.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  // Conservative for the wait (the slowest recent first progress), typical
  // for the rate (the median), so one fast response does not make a healthy
  // slow writer look stuck.
  function scheduleLatencyEstimate(stats) {
    const firsts = stats && Array.isArray(stats.firstMs) ? stats.firstMs : [];
    const rates = stats && Array.isArray(stats.rates) ? stats.rates.map((rate) => rate.value) : [];
    return {
      firstMs: firsts.length ? Math.max(...firsts) : PRIOR_FIRST_MS,
      itemsPerSecond: rates.length ? median(rates) : PRIOR_ITEMS_PER_SECOND,
      measured: firsts.length > 0
    };
  }

  // A producing stream is still producing while its next commit is not
  // overdue.
  function scheduleProgressFresh(input) {
    const estimate = input && input.estimate || scheduleLatencyEstimate(null);
    const now = Number(input && input.now);
    const lastProgressAt = Number(input && input.lastProgressAt);
    if (!Number.isFinite(now) || !Number.isFinite(lastProgressAt) || lastProgressAt <= 0) return false;
    const gapMs = UNIT_ITEMS * 1000 / Math.max(1, estimate.itemsPerSecond);
    return now - lastProgressAt < OVERDUE_FACTOR * Math.max(MIN_PROGRESS_GAP_MS, gapMs);
  }

  // A request that has produced nothing yet is overdue once it has waited
  // well past the provider's recent first progress. A request whose whole
  // range playback has already passed gets only the usual wait
  // (expectedOnly): its output can no longer be shown in time.
  function scheduleFirstOverdue(input) {
    const estimate = input && input.estimate || scheduleLatencyEstimate(null);
    const elapsed = Number(input && input.now) - Number(input && input.startedAt);
    const factor = input && input.expectedOnly ? 1 : OVERDUE_FACTOR;
    return Number.isFinite(elapsed) && elapsed >= factor * estimate.firstMs;
  }

  // Is this writer stuck: overdue for its first progress, or a producing
  // stream whose next commit is overdue?
  function scheduleWriterStuck(input) {
    const progressCursor = Number(input && input.progressCursor);
    const requestStart = Number(input && input.requestStart);
    const producing = Number.isInteger(progressCursor) && Number.isInteger(requestStart) &&
      progressCursor > requestStart && Number(input.lastProgressAt) > 0;
    return producing ? !scheduleProgressFresh(input) : scheduleFirstOverdue(input);
  }

  Object.assign(internal, {
    scheduleLatencyCreate,
    scheduleLatencyNote,
    scheduleLatencyEstimate,
    scheduleProgressFresh,
    scheduleFirstOverdue,
    scheduleWriterStuck
  });
})();
