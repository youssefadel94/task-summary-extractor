/**
 * Compilation backfill — guarantee no extracted item is silently lost.
 *
 * Compilation asks the model to merge every segment analysis into one
 * deduplicated result. Dedup is the point (the same ticket recurs in every
 * segment), but the model also drops items it considers minor: a real run
 * turned 8 distinct action items into 3 and 7 distinct blockers into 3, so
 * work discussed in the call never reached the report.
 *
 * The prompt already says "PRESERVE ALL DATA". Prompts are not guarantees, so
 * this re-checks the compiled output against the segments afterwards and
 * appends anything missing. Recovered entries are marked `_recovered: true`.
 */

'use strict';

const { normalizeDesc, normalizeTaskDesc } = require('../renderers/shared');

/**
 * Fields to reconcile, with the key used to decide "is this the same item".
 * Keys are deliberately loose — a false match drops a duplicate, a false miss
 * adds a near-duplicate. Both are better than losing the item entirely.
 */
const RECONCILED_FIELDS = [
  { field: 'tickets', key: ticketKey, idPrefix: null, fuzzy: false },
  { field: 'action_items', key: item => normalizeTaskDesc(item.description), idPrefix: 'AI', fuzzy: true },
  { field: 'blockers', key: item => normalizeDesc(item.description), idPrefix: 'BLK', fuzzy: true },
  { field: 'change_requests', key: item => (item.id || '').toLowerCase() || normalizeDesc(item.description || item.what), idPrefix: 'CR', fuzzy: true },
  { field: 'scope_changes', key: item => normalizeDesc(item.description), idPrefix: 'SC', fuzzy: true },
  { field: 'file_references', key: item => (item.resolved_path || item.path || '').toLowerCase(), idPrefix: null, fuzzy: false },
];

/**
 * Word overlap threshold above which two descriptions are the same item.
 *
 * Segments phrase one blocker several ways — "All database objects are missing"
 * vs "All database objects — nothing exists yet" — and exact key matching
 * restores both, cluttering the report. Containment (shared words over the
 * shorter description) catches re-phrasings while leaving genuinely different
 * work distinct.
 */
const NEAR_DUPLICATE_CONTAINMENT = 0.7;

/** Minimum words before fuzzy matching applies — short phrases collide too easily. */
const MIN_FUZZY_WORDS = 4;

function wordSet(key) {
  return new Set(String(key).split(/\s+/).filter(w => w.length > 2));
}

/** True when `candidate` restates something already in `existing`. */
function isNearDuplicate(candidate, existingSets) {
  const words = wordSet(candidate);
  if (words.size < MIN_FUZZY_WORDS) return false;

  for (const other of existingSets) {
    if (other.size < MIN_FUZZY_WORDS) continue;
    let shared = 0;
    for (const w of words) if (other.has(w)) shared++;
    if (shared / Math.min(words.size, other.size) >= NEAR_DUPLICATE_CONTAINMENT) return true;
  }
  return false;
}

/**
 * Ticket identity: compare on the numeric part so "PBI-20392" and a segment's
 * bare "20392" resolve to the same ticket instead of both being kept.
 */
function ticketKey(ticket) {
  const id = String(ticket.ticket_id || '').trim();
  const digits = id.match(/\d{3,}/);
  if (digits) return digits[0];
  return normalizeDesc(id || ticket.title);
}

/** Highest numeric suffix already used for a prefixed ID (AI-3 → 3). */
function maxIdNumber(items, prefix) {
  let max = 0;
  for (const item of items) {
    const m = String(item?.id || '').match(new RegExp(`^${prefix}-(\\d+)$`, 'i'));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

/**
 * Append every distinct segment item missing from the compiled result.
 *
 * @param {object} compiled - Parsed compilation output (mutated in place)
 * @param {Array<object>} segmentAnalyses - Per-segment analyses
 * @returns {{ recovered: object, totalRecovered: number }} counts per field
 */
function backfillCompiledItems(compiled, segmentAnalyses = []) {
  const recovered = {};
  let totalRecovered = 0;

  if (!compiled || typeof compiled !== 'object') {
    return { recovered, totalRecovered };
  }

  for (const { field, key, idPrefix, fuzzy } of RECONCILED_FIELDS) {
    const compiledItems = Array.isArray(compiled[field]) ? compiled[field] : [];
    const present = new Set(compiledItems.map(key).filter(Boolean));
    const presentSets = fuzzy ? [...present].map(wordSet) : [];

    // Collect distinct items across all segments, first occurrence wins.
    const missing = new Map();
    for (const analysis of segmentAnalyses) {
      const items = Array.isArray(analysis?.[field]) ? analysis[field] : [];
      for (const item of items) {
        const k = key(item);
        if (!k || present.has(k) || missing.has(k)) continue;
        if (fuzzy && isNearDuplicate(k, presentSets)) continue;
        missing.set(k, item);
        if (fuzzy) presentSets.push(wordSet(k)); // also dedupe within the recovered set
      }
    }

    if (missing.size === 0) continue;

    let nextId = idPrefix ? maxIdNumber(compiledItems, idPrefix) : 0;
    for (const item of missing.values()) {
      const entry = { ...item, _recovered: true };
      if (idPrefix) entry.id = `${idPrefix}-${++nextId}`;
      compiledItems.push(entry);
    }

    compiled[field] = compiledItems;
    recovered[field] = missing.size;
    totalRecovered += missing.size;
  }

  return { recovered, totalRecovered };
}

module.exports = {
  backfillCompiledItems,
  ticketKey,
  isNearDuplicate,
  wordSet,
  RECONCILED_FIELDS,
  NEAR_DUPLICATE_CONTAINMENT,
};
