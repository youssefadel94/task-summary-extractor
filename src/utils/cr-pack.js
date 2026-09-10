/**
 * Change-request packing — one CR per real change, ordered by priority.
 *
 * Change requests are the part of a call another team acts on, and they arrive
 * broken in two ways that a plain id-dedup does not fix:
 *
 *   1. The same change is emitted from several segments with DIFFERENT ids
 *      ("CR-01" in segment 2, "CR-07" in segment 5) because each segment only
 *      ever saw its own slice of the call. Rendering both hands the other team
 *      the same work twice.
 *   2. Each copy is partial — one has the file path, another the "why", a third
 *      the ticket link — so picking either one loses detail.
 *
 * So packing is merge-then-sort: collapse copies on a content signature, union
 * everything the copies knew, and order the survivors by priority so the top of
 * the list is the work that matters first.
 */

'use strict';

const { normalizeDesc } = require('../renderers/shared');

/** Sort order for priority — lower rank renders first. Unset sorts last. */
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/** Tie-break within a priority: what is stuck or ready before what is done. */
const STATUS_RANK = { blocked: 0, actionable: 1, open: 2, pending_decision: 3, completed: 4 };

/** Confidence order — used when two copies disagree. */
const CONF_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** Array fields that are unioned rather than overwritten when copies merge. */
const UNION_FIELDS = ['dependencies', 'related_tickets', 'tags'];

/** Free-text fields where the longer copy is the more useful one. */
const TEXT_FIELDS = ['title', 'what', 'how', 'why', 'confidence_reason', 'blocked_by', 'code_map_match'];

function rank(map, value, fallback) {
  const r = map[value];
  return r == null ? fallback : r;
}

/** Numeric priority rank — exported so callers can group without re-deriving it. */
function priorityRank(p) {
  return rank(PRIORITY_RANK, p, 4);
}

/**
 * Content signature for a change request.
 *
 * Two CRs are the same change when they describe the same work in the same
 * place. The id is deliberately NOT part of the signature — differing ids are
 * exactly the case this collapses.
 *
 * @param {object} cr
 * @returns {string} '' when there is not enough text to compare safely
 */
function crSignature(cr) {
  const text = crText(cr);
  if (!text) return '';
  return `${text}::${crPlace(cr)}`;
}

/** Normalized description text, or '' when it is too short to match on safely. */
function crText(cr) {
  if (!cr) return '';
  const text = normalizeDesc(cr.title || cr.what || '');
  return text.length < 8 ? '' : text;    // shorter collides on generic phrasing
}

/** Where the change lands: a file basename, else a component or module. */
function crPlace(cr) {
  if (!cr) return '';
  const rawPath = cr.where?.file_path || cr.code_map_match || '';
  if (rawPath) return rawPath.replace(/\\/g, '/').split('/').pop().toLowerCase();
  return normalizeDesc(cr.where?.component || cr.where?.module || '');
}

/** Pick the better of two enum values by rank (lower rank wins; unset loses). */
function bestBy(map, a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return rank(map, a, 99) <= rank(map, b, 99) ? a : b;
}

/** 'meeting.mp4 · Seg 3' — where this copy of the CR was heard. */
function sourceLabel(cr) {
  if (!cr) return '';
  if (cr.source_video && cr.source_segment) return `${cr.source_video} · Seg ${cr.source_segment}`;
  if (cr.source_segment) return `Seg ${cr.source_segment}`;
  return cr.source_video || '';
}

/**
 * Fold `incoming` into `target` in place. `target` keeps its id; the incoming id
 * is remembered in `merged_ids` so the other team can still trace a CR back to
 * the id it carried in the raw segment data or an earlier run.
 */
function mergeInto(target, incoming) {
  for (const f of UNION_FIELDS) {
    const combined = [...(target[f] || []), ...(incoming[f] || [])];
    if (combined.length) target[f] = [...new Set(combined.filter(Boolean))];
  }

  for (const f of TEXT_FIELDS) {
    const cur = target[f];
    const next = incoming[f];
    if (next && (!cur || String(next).length > String(cur).length)) target[f] = next;
  }

  // The most urgent copy wins — under-reporting priority is what gets work missed.
  target.priority = bestBy(PRIORITY_RANK, target.priority, incoming.priority);
  target.status = bestBy(STATUS_RANK, target.status, incoming.status);
  target.confidence = bestBy(CONF_RANK, target.confidence, incoming.confidence);

  if (incoming.where) {
    target.where = target.where?.file_path
      ? { ...incoming.where, ...target.where }
      : { ...(target.where || {}), ...incoming.where };
  }

  // Everything else: fill only the gaps, never overwrite what is already known.
  const handled = new Set([...UNION_FIELDS, ...TEXT_FIELDS,
    'where', 'merged_ids', 'sources', 'priority', 'status', 'confidence']);
  for (const [k, v] of Object.entries(incoming)) {
    if (v == null || handled.has(k)) continue;
    if (target[k] == null || target[k] === '') target[k] = v;
  }

  if (incoming.id && incoming.id !== target.id) {
    target.merged_ids = [...new Set([...(target.merged_ids || []), incoming.id])];
  }

  const src = sourceLabel(incoming);
  if (src) target.sources = [...new Set([...(target.sources || []), src])];
}

/**
 * Collapse duplicate change requests: first by id, then by content signature.
 *
 * @param {object[]} crs
 * @returns {object[]} Merged CRs, input order preserved
 */
function normalizeChangeRequests(crs) {
  const byId = new Map();
  const bySig = new Map();
  const byText = new Map();
  const out = [];

  for (const raw of (crs || [])) {
    if (!raw || typeof raw !== 'object') continue;
    const cr = { ...raw };
    const idKey = (cr.id || '').trim().toLowerCase();
    const sig = crSignature(cr);
    const text = crText(cr);
    const place = crPlace(cr);

    // Same words, and one of the two never said where. A segment that named the
    // file and one that did not are still describing a single change, so the
    // location-less copy folds into the located one instead of standing alone.
    const textTwin = text ? byText.get(text) : null;
    const twinMatches = textTwin && (!place || !crPlace(textTwin));

    const existing = (idKey && byId.get(idKey))
      || (sig && bySig.get(sig))
      || (twinMatches ? textTwin : null);

    if (existing) {
      mergeInto(existing, cr);
      // Re-key on the merged record: absorbing a located copy gives the survivor
      // a place, and later copies must match against that.
      const mergedSig = crSignature(existing);
      if (mergedSig) bySig.set(mergedSig, existing);
      if (sig && !bySig.has(sig)) bySig.set(sig, existing);
      if (text && !byText.has(text)) byText.set(text, existing);
      if (idKey && !byId.has(idKey)) byId.set(idKey, existing);
      continue;
    }

    const self = sourceLabel(cr);
    if (self) cr.sources = [...new Set([...(cr.sources || []), self])];
    if (idKey) byId.set(idKey, cr);
    if (sig) bySig.set(sig, cr);
    if (text && !byText.has(text)) byText.set(text, cr);
    out.push(cr);
  }

  return out;
}

/**
 * Order change requests for a reader: critical work first, then by how stuck it
 * is, then by id so repeated runs over the same data render identically.
 *
 * @param {object[]} crs
 * @returns {object[]} A new sorted array
 */
function sortChangeRequests(crs) {
  return [...(crs || [])].sort((a, b) => {
    const pd = priorityRank(a.priority) - priorityRank(b.priority);
    if (pd !== 0) return pd;
    const sd = rank(STATUS_RANK, a.status, 5) - rank(STATUS_RANK, b.status, 5);
    if (sd !== 0) return sd;
    const cd = rank(CONF_RANK, a.confidence, 3) - rank(CONF_RANK, b.confidence, 3);
    if (cd !== 0) return cd;
    return String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true });
  });
}

/**
 * The one call every renderer makes: deduplicated, merged, priority-ordered.
 *
 * @param {object[]} crs
 * @returns {object[]}
 */
function packChangeRequests(crs) {
  return sortChangeRequests(normalizeChangeRequests(crs));
}

/** Count CRs per priority bucket, for summary lines. */
function priorityCounts(crs) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unset: 0 };
  for (const cr of (crs || [])) {
    const p = cr.priority;
    if (p && counts[p] != null) counts[p]++;
    else counts.unset++;
  }
  return counts;
}

module.exports = {
  PRIORITY_RANK,
  STATUS_RANK,
  CONF_RANK,
  priorityRank,
  priorityCounts,
  crSignature,
  crText,
  crPlace,
  normalizeChangeRequests,
  sortChangeRequests,
  packChangeRequests,
  sourceLabel,
};
