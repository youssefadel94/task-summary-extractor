/**
 * Quality Gate — validates AI analysis output quality and determines
 * whether a segment needs re-analysis.
 *
 * Scoring dimensions:
 *  - Structural completeness (required fields present)
 *  - Content density (meaningful data extracted)
 *  - Parse integrity (JSON parsed successfully, no truncation)
 *  - Cross-reference consistency (IDs, timestamps, references make sense)
 *
 * Returns a quality report with a numeric score (0-100) and actionable
 * diagnostics for retry decisions.
 */

'use strict';

const { c } = require('./colors');

// ======================== QUALITY THRESHOLDS ========================

const THRESHOLDS = {
  /** Minimum score to avoid FAIL. Below this → FAIL + retry (0-100) */
  FAIL_BELOW: 45,
  /** Minimum score for a clean PASS. Between FAIL_BELOW and PASS_ABOVE → WARN (45-65 is typical) */
  PASS_ABOVE: 65,
  /** Maximum retries per segment */
  MAX_RETRIES: 1,
};

// Required top-level fields in a valid analysis
const REQUIRED_FIELDS = [
  'summary',
];

// Optional but valuable fields (boost score when present)
// tickets, action_items, change_requests are here because a segment may
// legitimately contain none of these (e.g. a segment that is only chit-chat).
const VALUED_FIELDS = [
  'tickets',
  'action_items',
  'change_requests',
  'blockers',
  'scope_changes',
  'file_references',
  'your_tasks',
];

// ======================== SCORING FUNCTIONS ========================

/**
 * Score structural completeness: are the required fields present and non-empty?
 * @param {object} analysis - Parsed analysis
 * @returns {{ score: number, issues: string[] }} - 0-100 score + issues
 */
function scoreStructure(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    return { score: 0, issues: ['Analysis is null or not an object'] };
  }

  const issues = [];
  let present = 0;

  for (const field of REQUIRED_FIELDS) {
    if (analysis[field] === undefined || analysis[field] === null) {
      issues.push(`Missing required field: "${field}"`);
    } else {
      present++;
    }
  }

  // Bonus for valued optional fields
  let bonus = 0;
  for (const field of VALUED_FIELDS) {
    if (analysis[field] !== undefined && analysis[field] !== null) {
      bonus += 2; // up to 14 bonus points (7 valued fields)
    }
  }

  const baseScore = (present / REQUIRED_FIELDS.length) * 70;
  return { score: Math.min(100, baseScore + bonus), issues };
}

/**
 * Score content density: how much meaningful data was extracted?
 * Empty arrays are valid but sparse; we want to reward rich extraction.
 * Also scores confidence field coverage.
 * @param {object} analysis
 * @returns {{ score: number, issues: string[] }}
 */
function scoreDensity(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    return { score: 0, issues: ['No analysis to score'] };
  }

  const issues = [];
  let points = 0;
  let maxPoints = 0;

  // Tickets
  maxPoints += 25;
  const tickets = analysis.tickets || [];
  if (tickets.length > 0) {
    points += 12;
    const richTickets = tickets.filter(t =>
      t.ticket_id && t.discussed_state && (t.comments?.length > 0 || t.code_changes?.length > 0)
    );
    points += Math.min(13, (richTickets.length / Math.max(tickets.length, 1)) * 13);
  } else {
    issues.push('No tickets extracted — verify if segment discusses tickets');
  }

  // Action items
  maxPoints += 17;
  const actions = analysis.action_items || [];
  if (actions.length > 0) {
    points += 8;
    const richActions = actions.filter(a => a.assigned_to && a.description);
    points += Math.min(9, (richActions.length / Math.max(actions.length, 1)) * 9);
  }

  // Change requests
  maxPoints += 17;
  const crs = analysis.change_requests || [];
  if (crs.length > 0) {
    points += 8;
    const richCrs = crs.filter(cr => cr.where && cr.what);
    points += Math.min(9, (richCrs.length / Math.max(crs.length, 1)) * 9);
  }

  // Summary
  maxPoints += 13;
  const summary = analysis.summary || '';
  if (summary.length > 50) {
    points += 13;
  } else if (summary.length > 0) {
    points += 6;
    issues.push('Summary is very short (< 50 chars)');
  } else {
    issues.push('No summary extracted');
  }

  // your_tasks
  maxPoints += 13;
  const tasks = analysis.your_tasks;
  if (tasks) {
    const taskCount =
      (tasks.tasks_todo?.length || 0) +
      (tasks.tasks_waiting_on_others?.length || 0) +
      (tasks.decisions_needed?.length || 0) +
      (tasks.completed_in_call?.length || 0);
    if (taskCount > 0) {
      points += 13;
    } else {
      points += 4;
    }
  }

  // Confidence coverage — reward items that have confidence fields
  maxPoints += 15;
  const allItems = [
    ...tickets,
    ...actions,
    ...crs,
    ...(analysis.blockers || []),
    ...(analysis.scope_changes || []),
  ];
  if (allItems.length > 0) {
    const withConfidence = allItems.filter(item =>
      item.confidence && ['HIGH', 'MEDIUM', 'LOW'].includes(item.confidence)
    );
    const coverageRatio = withConfidence.length / allItems.length;
    points += Math.round(coverageRatio * 15);

    if (coverageRatio < 0.5) {
      issues.push(`Low confidence coverage: only ${withConfidence.length}/${allItems.length} items have confidence fields`);
    }

    // Bonus check: confidence distribution shouldn't be all the same
    if (withConfidence.length >= 3) {
      const levels = new Set(withConfidence.map(i => i.confidence));
      if (levels.size === 1) {
        issues.push(`All items have same confidence (${[...levels][0]}) — suspicious uniformity`);
      }
    }
  } else {
    points += 5; // No items to score — neutral
  }

  const score = Math.round((points / maxPoints) * 100);
  return { score, issues };
}

/**
 * Score parse integrity: did the JSON parse cleanly?
 * @param {object} parseContext - { parseSuccess, rawLength, parsedKeys }
 * @returns {{ score: number, issues: string[] }}
 */
function scoreIntegrity(parseContext) {
  const { parseSuccess, rawLength = 0, truncated = false } = parseContext;
  const issues = [];

  if (!parseSuccess) {
    issues.push('JSON parse failed — output could not be parsed');
    return { score: 0, issues };
  }

  let score = 80;

  if (truncated) {
    issues.push('Output was truncated — data may be incomplete');
    score -= 30;
  }

  // Very short raw output suggests the model didn't produce enough
  if (rawLength < 500) {
    issues.push(`Raw output very short (${rawLength} chars) — may be minimal`);
    score -= 20;
  } else if (rawLength < 2000) {
    issues.push(`Raw output is short (${rawLength} chars)`);
    score -= 10;
  }

  return { score: Math.max(0, score), issues };
}

/**
 * Score cross-reference consistency within the analysis.
 * @param {object} analysis
 * @returns {{ score: number, issues: string[] }}
 */
function scoreCrossReferences(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    return { score: 50, issues: [] }; // neutral if no analysis
  }

  const issues = [];
  let score = 100;

  // Check: ticket IDs should be unique
  const tickets = analysis.tickets || [];
  const ticketIds = tickets.map(t => t.ticket_id).filter(Boolean);
  const uniqueIds = new Set(ticketIds);
  if (ticketIds.length > 0 && uniqueIds.size < ticketIds.length) {
    issues.push(`Duplicate ticket IDs found: ${ticketIds.length - uniqueIds.size} duplicate(s)`);
    score -= 15;
  }

  // Check: action item IDs should be sequential and unique
  const actions = analysis.action_items || [];
  const actionIds = actions.map(a => a.id).filter(Boolean);
  const uniqueActionIds = new Set(actionIds);
  if (actionIds.length > 0 && uniqueActionIds.size < actionIds.length) {
    issues.push(`Duplicate action item IDs: ${actionIds.length - uniqueActionIds.size} duplicate(s)`);
    score -= 10;
  }

  // Check: change request IDs should reference real tickets
  const crs = analysis.change_requests || [];
  for (const cr of crs) {
    if (cr.ticket_id && !uniqueIds.has(cr.ticket_id) && tickets.length > 0) {
      issues.push(`CR "${cr.id}" references unknown ticket "${cr.ticket_id}"`);
      score -= 5;
    }
  }

  return { score: Math.max(0, score), issues };
}

// ======================== MAIN QUALITY GATE ========================

/**
 * Run the full quality gate on a segment analysis.
 *
 * @param {object} analysis - The parsed analysis object
 * @param {object} context - Additional context for scoring
 * @param {boolean} context.parseSuccess - Whether JSON parsing succeeded
 * @param {number} context.rawLength - Length of raw AI output
 * @param {boolean} [context.truncated] - Whether output was truncated during repair
 * @param {number} [context.segmentIndex] - Which segment (0-based)
 * @param {number} [context.totalSegments] - Total segments
 * @returns {QualityReport}
 */
function assessQuality(analysis, context = {}) {
  const structure = scoreStructure(analysis);
  const density = scoreDensity(analysis);
  const integrity = scoreIntegrity(context);
  const crossRef = scoreCrossReferences(analysis);

  // Weighted composite score
  const weights = { structure: 0.25, density: 0.35, integrity: 0.25, crossRef: 0.15 };
  const compositeScore = Math.round(
    structure.score * weights.structure +
    density.score * weights.density +
    integrity.score * weights.integrity +
    crossRef.score * weights.crossRef
  );

  const allIssues = [
    ...structure.issues.map(i => `[structure] ${i}`),
    ...density.issues.map(i => `[density] ${i}`),
    ...integrity.issues.map(i => `[integrity] ${i}`),
    ...crossRef.issues.map(i => `[consistency] ${i}`),
  ];

  let grade;
  if (compositeScore >= THRESHOLDS.PASS_ABOVE) {
    grade = 'PASS';
  } else if (compositeScore >= THRESHOLDS.FAIL_BELOW) {
    grade = 'WARN';
  } else {
    grade = 'FAIL';
  }

  return {
    grade,
    score: compositeScore,
    dimensions: {
      structure: { score: structure.score, weight: weights.structure },
      density: { score: density.score, weight: weights.density },
      integrity: { score: integrity.score, weight: weights.integrity },
      crossRef: { score: crossRef.score, weight: weights.crossRef },
    },
    issues: allIssues,
    shouldRetry: grade === 'FAIL',
    retryHints: grade === 'FAIL' ? buildRetryHints(analysis, allIssues) : [],
  };
}

/**
 * Build retry hints — specific instructions to inject into the retry prompt
 * to address the quality issues found.
 * @param {object} analysis
 * @param {string[]} issues
 * @returns {string[]}
 */
function buildRetryHints(analysis, issues) {
  const hints = [];

  if (issues.some(i => i.includes('Missing required field'))) {
    hints.push('CRITICAL: Your previous response was missing the required "summary" field. You MUST include a "summary" string. Include tickets, action_items, and change_requests arrays if relevant — omit them or use empty arrays [] if none exist in this segment.');
  }

  if (issues.some(i => i.includes('JSON parse failed'))) {
    hints.push('CRITICAL: Your previous response could not be parsed as JSON. Respond with ONLY valid JSON — no markdown fences, no extra text before or after the JSON object. Start with { and end with }.');
  }

  if (issues.some(i => i.includes('truncated'))) {
    hints.push('Your previous response was truncated. Be more concise — use shorter descriptions, fewer comments per ticket (max 3), and compact formatting to fit within the output limit.');
  }

  if (issues.some(i => i.includes('No tickets extracted'))) {
    hints.push('Your previous response contained no tickets. Listen carefully to the video — if specific work items, bugs, features, or tasks are discussed, extract them as tickets with IDs.');
  }

  if (issues.some(i => i.includes('No summary'))) {
    hints.push('Your previous response was missing a summary. Include a 2-4 sentence executive summary of what was discussed in this segment.');
  }

  if (issues.some(i => i.includes('very short'))) {
    hints.push('Your previous response was too brief. Analyze the video more thoroughly — extract ALL tickets, action items, changes discussed, and blockers mentioned.');
  }

  if (issues.some(i => i.includes('confidence coverage'))) {
    hints.push('Your previous response was missing confidence fields. Every ticket, action_item, change_request, blocker, and scope_change MUST have "confidence": "HIGH|MEDIUM|LOW" and "confidence_reason" explaining why.');
  }

  if (issues.some(i => i.includes('suspicious uniformity'))) {
    hints.push('Your previous response had all items at the same confidence level. Differentiate: use HIGH for items explicitly discussed + corroborated by docs, MEDIUM for partial evidence, LOW for inferred items.');
  }

  return hints;
}

/**
 * Generate a human-readable quality summary line.
 * @param {QualityReport} report
 * @param {string} segmentName
 * @returns {string}
 */
function formatQualityLine(report, segmentName) {
  const icon = report.grade === 'PASS' ? c.success : report.grade === 'WARN' ? c.warn : c.error;
  const dims = report.dimensions;
  return `    ${icon(`Quality: ${report.score}/100 (${report.grade})`)} — ` +
    `struct:${dims.structure.score} density:${dims.density.score} ` +
    `integrity:${dims.integrity.score} xref:${dims.crossRef.score}`;
}

/**
 * Extract confidence distribution statistics from an analysis.
 * @param {object} analysis
 * @returns {{ total: number, high: number, medium: number, low: number, missing: number, coverage: number }}
 */
function getConfidenceStats(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    return { total: 0, high: 0, medium: 0, low: 0, missing: 0, coverage: 0 };
  }

  const allItems = [
    ...(analysis.tickets || []),
    ...(analysis.action_items || []),
    ...(analysis.change_requests || []),
    ...(analysis.blockers || []),
    ...(analysis.scope_changes || []),
  ];

  const total = allItems.length;
  if (total === 0) return { total: 0, high: 0, medium: 0, low: 0, missing: 0, coverage: 1 };

  let high = 0, medium = 0, low = 0, missing = 0;
  for (const item of allItems) {
    switch (item.confidence) {
      case 'HIGH': high++; break;
      case 'MEDIUM': medium++; break;
      case 'LOW': low++; break;
      default: missing++; break;
    }
  }

  return { total, high, medium, low, missing, coverage: Math.round(((total - missing) / total) * 100) };
}

module.exports = {
  assessQuality,
  formatQualityLine,
  getConfidenceStats,
  THRESHOLDS,
};
