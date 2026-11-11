// Per-video translation ledger. Committed semantic units persist in
// chrome.storage.local so replaying, seeking back and reloading a video cost
// no provider requests. The ledger is keyed by everything that can change a
// translation: video, caption track contents, target language, provider,
// model, extra request parameters, context sizes and prompt version.
"use strict";

const AI_LEDGER_KEY_PREFIX = "aiLedgerV1:";
const AI_LEDGER_INDEX_KEY = "aiLedgerIndexV1";
const AI_LEDGER_MAX_VIDEOS = 60;
const AI_LEDGER_MAX_TOTAL_CHARS = 4000000;
const AI_LEDGER_WRITE_DELAY_MS = 1500;
const AI_LEDGER_LOAD_TIMEOUT_MS = 1500;

// One ledger is open at a time: the current track's. Commits of a stale
// session are ignored; a pending write of the previous track is flushed
// before the next one opens.
let aiLedger = null;
let aiLedgerWriteChain = Promise.resolve();

function aiLedgerHash(parts) {
  let hash = 2166136261;
  for (const part of parts) {
    const text = String(part == null ? "" : part);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 31;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function aiLedgerStorageKey() {
  const videoId = String(captionSession.cueVideoId || "");
  const track = String(captionSession.cueTrackSignature || "");
  if (!videoId || !track) return "";
  return AI_LEDGER_KEY_PREFIX + videoId + ":" + aiLedgerHash([
    track, settings.targetLang, settings.aiBaseUrl, settings.aiModel,
    settings.aiExtraBodyRevision, settings.aiContextPast, settings.aiContextFuture,
    YTDS_SHARED.AI_PROMPT_CACHE_VERSION
  ]);
}

function aiLedgerStore() {
  try {
    return typeof extensionContextAlive === "function" && !extensionContextAlive()
      ? null : (chrome.storage && chrome.storage.local) || null;
  } catch (_e) {
    return null;
  }
}

function aiLedgerGroupCached(id) {
  return captionSession.transCache.has(groupKey(id));
}

// True while the current track's ledger is still loading. Requests wait so a
// provider is never asked for units the ledger is about to supply.
function aiLedgerBlocksRequests() {
  return !!(aiLedger && aiLedger.loading && isCaptionSessionCurrent(aiLedger.token));
}

// A unit as stored: [first, last, sourceHash, translation, chunks], where
// chunks are [first, last, translation, sentenceBoundaryAfter ? 1 : 0].
function aiLedgerRecordForUnit(unit) {
  const members = unit.members;
  const first = members[0];
  const last = members[members.length - 1];
  if (!Number.isInteger(first) || !Number.isInteger(last) ||
      last - first + 1 !== members.length) return null;
  let chunks = null;
  if (Array.isArray(unit.alignedChunks) && unit.alignedChunks.length) {
    chunks = [];
    let expected = first;
    for (const chunk of unit.alignedChunks) {
      const ids = chunk.ids.map(Number);
      if (ids[0] !== expected || ids[ids.length - 1] - ids[0] + 1 !== ids.length) {
        chunks = null;
        break;
      }
      chunks.push([ids[0], ids[ids.length - 1], chunk.translation, chunk.sentenceBoundaryAfter ? 1 : 0]);
      expected = ids[ids.length - 1] + 1;
    }
    if (chunks && expected !== last + 1) chunks = null;
  }
  return [first, last, aiLedgerHash([unit.source]), unit.translation, chunks];
}

function recordAiLedgerUnits(units) {
  if (!aiLedger || aiLedger.loading || !isCaptionSessionCurrent(aiLedger.token)) return;
  let changed = false;
  for (const unit of Array.isArray(units) ? units : []) {
    const record = unit && unit.translation ? aiLedgerRecordForUnit(unit) : null;
    if (!record) continue;
    aiLedger.units.set(record[0], record);
    changed = true;
  }
  if (changed) scheduleAiLedgerWrite();
}

function scheduleAiLedgerWrite() {
  if (!aiLedger || aiLedger.timer) return;
  const ledger = aiLedger;
  ledger.timer = setTimeout(() => {
    ledger.timer = null;
    flushAiLedger(ledger);
  }, AI_LEDGER_WRITE_DELAY_MS);
}

function flushAiLedger(ledgerValue) {
  const ledger = ledgerValue || aiLedger;
  if (!ledger || !ledger.key || !ledger.units.size) return aiLedgerWriteChain;
  if (ledger.timer) {
    clearTimeout(ledger.timer);
    ledger.timer = null;
  }
  const store = aiLedgerStore();
  if (!store) return aiLedgerWriteChain;
  const units = Array.from(ledger.units.values()).sort((a, b) => a[0] - b[0]);
  const record = { v: 1, groups: ledger.groups, units };
  const chars = JSON.stringify(record).length;
  const key = ledger.key;
  aiLedgerWriteChain = aiLedgerWriteChain.then(async () => {
    const got = await store.get({ [AI_LEDGER_INDEX_KEY]: {} });
    const index = got && got[AI_LEDGER_INDEX_KEY] && typeof got[AI_LEDGER_INDEX_KEY] === "object"
      ? got[AI_LEDGER_INDEX_KEY] : {};
    index[key] = { chars, at: Date.now() };
    // Evict least recently written ledgers beyond the count or size budget.
    const entries = Object.entries(index).sort((a, b) => Number(b[1].at) - Number(a[1].at));
    const evicted = [];
    let total = 0;
    entries.forEach(([entryKey, entry], position) => {
      total += Number(entry && entry.chars) || 0;
      if (entryKey !== key && (position >= AI_LEDGER_MAX_VIDEOS || total > AI_LEDGER_MAX_TOTAL_CHARS)) {
        evicted.push(entryKey);
        delete index[entryKey];
      }
    });
    if (evicted.length) await store.remove(evicted);
    await store.set({ [key]: record, [AI_LEDGER_INDEX_KEY]: index });
  }).catch(() => { /* quota or a closed context; the session cache still works */ });
  return aiLedgerWriteChain;
}

// Put stored units back into the session caches. Only whole units whose
// source text still matches and whose positions are all free are used, and a
// unit never crosses a hard-pause region.
function hydrateAiLedgerUnits(units) {
  const groups = captionSession.sentGroups || [];
  const groupToRegion = captionSession.semanticGroupToCommitRegion || [];
  const hydrated = [];
  const members = [];
  for (const record of Array.isArray(units) ? units : []) {
    if (!Array.isArray(record) || record.length < 4) continue;
    const [first, last, sourceHash, translation, chunks] = record;
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 ||
        last < first || last >= groups.length || typeof translation !== "string" || !translation ||
        groupToRegion[first] !== groupToRegion[last]) continue;
    let free = true;
    for (let id = first; id <= last; id++) {
      if (aiLedgerGroupCached(id)) { free = false; break; }
    }
    if (!free) continue;
    const ids = [];
    for (let id = first; id <= last; id++) ids.push(id);
    const source = mergeCueTexts(ids.map((id) => groups[id]));
    if (aiLedgerHash([source]) !== sourceHash) continue;
    const unitId = `semantic-${first}-${last}`;
    for (const id of ids) {
      const key = groupKey(id);
      captionSession.transCache.set(key, translation);
      captionSession.semanticUnitCache.set(key, unitId);
      captionSession.semanticSourceCache.set(key, source);
    }
    if (Array.isArray(chunks) && chunks.length) {
      captionSession.semanticAlignedChunksCache.set(unitId, chunks.map(([start, end, text, boundary]) => {
        const chunkIds = [];
        for (let id = start; id <= end; id++) chunkIds.push(String(id));
        return { ids: chunkIds, translation: String(text || ""), sentenceBoundaryAfter: boundary === 1 };
      }).filter((chunk) => chunk.ids.length && chunk.translation));
    }
    hydrated.push(record);
    members.push(...ids);
  }
  if (members.length) {
    cacheAiDisplayNeighborhood(members, false);
    for (const [regionIndex, state] of captionSession.semanticCommitStateByRegion) {
      aiSkipCommittedBlock(regionIndex, state);
    }
  }
  return hydrated;
}

// A commit lane whose cursor reaches an already committed block (from the
// ledger or an earlier seek) continues after the block instead of stopping
// there. The block's end is a proven unit boundary, so the next window may
// start right after it.
function aiSkipCommittedBlock(regionIndex, state) {
  const regions = captionSession.semanticCommitRegions;
  const region = regions ? regions[regionIndex] : null;
  if (!region || !state || state.cursor > region.end || !aiLedgerGroupCached(state.cursor)) {
    return state;
  }
  let cursor = state.cursor;
  while (cursor <= region.end && aiLedgerGroupCached(cursor)) cursor++;
  let limitEnd = region.end;
  for (let id = cursor; id <= region.end; id++) {
    if (aiLedgerGroupCached(id)) {
      limitEnd = id - 1;
      break;
    }
  }
  state.cursor = cursor;
  state.commitFloor = cursor;
  state.limitEnd = cursor > region.end ? region.end : limitEnd;
  emitDebug("semantic-committed-block-skipped", {
    regionIndex, cursor, limitEnd: state.limitEnd
  });
  return state;
}

// Open the current track's ledger. Requests wait until it has loaded (or a
// short timeout passed), then playback continues from whatever is missing.
function loadAiTranslationLedger() {
  if (aiLedger && aiLedger.timer) flushAiLedger(aiLedger);
  const key = aiLedgerStorageKey();
  const token = captureCaptionSession();
  const groups = captionSession.sentGroups ? captionSession.sentGroups.length : 0;
  const store = aiLedgerStore();
  aiLedger = { key, token, groups, units: new Map(), loading: !!(key && store), timer: null };
  if (!aiLedger.loading) return Promise.resolve(0);
  const ledger = aiLedger;
  const finish = (units) => {
    if (!ledger.loading) return 0;
    ledger.loading = false;
    if (!isCaptionSessionCurrent(token) || aiLedger !== ledger) return 0;
    const hydrated = Array.isArray(units) ? hydrateAiLedgerUnits(units) : [];
    for (const record of hydrated) ledger.units.set(record[0], record);
    emitDebug("semantic-ledger-loaded", { units: hydrated.length, stored: Array.isArray(units) ? units.length : 0 });
    // Requests were held while loading; resume them from the playhead.
    const active = captionSession.activeGroupIdx;
    if (settings.enabled && active >= 0) {
      aiRequestBatch(active, true, true);
      if (typeof prefetchAiBatches === "function") prefetchAiBatches(active, false);
    }
    return hydrated.length;
  };
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), AI_LEDGER_LOAD_TIMEOUT_MS));
  const read = Promise.resolve().then(() => store.get(key)).then((got) => {
    const record = got && got[key];
    return record && record.v === 1 && record.groups === groups && Array.isArray(record.units)
      ? record.units : [];
  }).catch(() => []);
  return Promise.race([read, timeout]).then(finish, () => finish([]));
}
