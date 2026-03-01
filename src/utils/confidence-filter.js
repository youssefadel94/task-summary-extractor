/**
 * Confidence Filter — filters extracted items below a confidence threshold.
 *
 * Confidence hierarchy: HIGH (3) > MEDIUM (2) > LOW (1).
 *
 * Usage:
 *   const { filterByConfidence } = require('./utils/confidence-filter');
 *   const filtered = filterByConfidence(compiledAnalysis, 'MEDIUM');
 *   // → keeps only HIGH + MEDIUM items; LOW items removed
 *
 * @module confidence-filter
 */

'use strict';

// ======================== CONSTANTS ========================

const LEVELS = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const VALID_LEVELS = new Set(['HIGH', 'MEDIUM', 'LOW']);

// ======================== HELPERS ========================

/**
 * Count items across all filterable arrays.
 * @param {object} data - compiled analysis object
 * @returns {{ tickets: number, action_items: number, change_requests: number, blockers: number, scope_changes: number, your_tasks: number, total: number }}
 */
function countItems(data) {
  const tickets = (data.tickets || []).length;
  const action_items = (data.action_items || []).length;
  const change_requests = (data.change_requests || []).length;
  const blockers = (data.blockers || []).length;
  const scope_changes = (data.scope_changes || []).length;

  let your_tasks = 0;
  if (data.your_tasks) {
    your_tasks += (data.your_tasks.tasks_todo || []).length;
    your_tasks += (data.your_tasks.tasks_waiting_on_others || []).length;
    your_tasks += (data.your_tasks.decisions_needed || []).length;
    your_tasks += (data.your_tasks.completed_in_call || []).length;
  }

  return {
    tickets,
    action_items,
    change_requests,
    blockers,
    scope_changes,
    your_tasks,
    total: tickets + action_items + change_requests + blockers + scope_changes + your_tasks,
  };
}

// ======================== MAIN FILTER ========================

/**
 * Filter a compiled analysis, removing items below the confidence threshold.
 *
 * Items without a `confidence` field are treated as LOW.
 * Non-array fields (summary, file_references, etc.) are passed through untouched.
 *
 * @param {object} compiled     - Compiled analysis object
 * @param {string} [minLevel='LOW'] - Minimum confidence: 'HIGH', 'MEDIUM', or 'LOW'
 * @returns {object} Filtered copy with _filterMeta attached
 */
function filterByConfidence(compiled, minLevel = 'LOW') {
  if (!compiled || typeof compiled !== 'object') return compiled;

  const normalised = (minLevel || 'LOW').toUpperCase();
  const threshold = LEVELS[normalised] || 1;

  // If threshold is LOW (1), everything passes — return with meta only
  const originalCounts = countItems(compiled);

  if (threshold <= 1) {
    return {
      ...compiled,
      _filterMeta: {
        minConfidence: normalised,
        originalCounts,
        filteredCounts: { ...originalCounts },
        removed: 0,
      },
    };
  }

  const filterArr = (items) =>
    (items || []).filter(item => (LEVELS[item.confidence] || 1) >= threshold);

  const filtered = {
    ...compiled,
    tickets: filterArr(compiled.tickets),
    action_items: filterArr(compiled.action_items),
    change_requests: filterArr(compiled.change_requests),
    blockers: filterArr(compiled.blockers),
    scope_changes: filterArr(compiled.scope_changes),
  };

  // Filter your_tasks sub-arrays if present
  if (compiled.your_tasks && typeof compiled.your_tasks === 'object') {
    filtered.your_tasks = {
      ...compiled.your_tasks,
      tasks_todo: filterArr(compiled.your_tasks.tasks_todo),
      tasks_waiting_on_others: filterArr(compiled.your_tasks.tasks_waiting_on_others),
      decisions_needed: filterArr(compiled.your_tasks.decisions_needed),
      // completed_in_call items are plain strings (no confidence field) — preserve unconditionally
      completed_in_call: compiled.your_tasks.completed_in_call || [],
    };
  }

  const filteredCounts = countItems(filtered);

  filtered._filterMeta = {
    minConfidence: normalised,
    originalCounts,
    filteredCounts,
    removed: originalCounts.total - filteredCounts.total,
  };

  return filtered;
}

/**
 * Validate a min-confidence level string.
 * @param {string} level
 * @returns {{ valid: boolean, normalised: string|null, error: string|null }}
 */
function validateConfidenceLevel(level) {
  if (!level || typeof level !== 'string') {
    return { valid: false, normalised: null, error: 'Confidence level must be a string: high, medium, or low' };
  }
  const normalised = level.toUpperCase();
  if (!VALID_LEVELS.has(normalised)) {
    return { valid: false, normalised: null, error: `Invalid confidence level "${level}". Must be: high, medium, or low` };
  }
  return { valid: true, normalised, error: null };
}

module.exports = { filterByConfidence, validateConfidenceLevel, countItems, LEVELS };
