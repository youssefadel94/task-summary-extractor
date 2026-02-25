/**
 * Progress Updater — AI-powered progress assessment using change detection data.
 *
 * Two assessment modes:
 *   1. Local (deterministic) — works without Gemini, uses correlation scores
 *   2. AI-enhanced — sends items + changes to Gemini for smart assessment
 *
 * Also provides:
 *   - Markdown rendering of progress reports
 *   - Merge helpers to annotate analysis items with progress data
 */

'use strict';

const { extractJson } = require('./json-parser');
const { GEMINI_MODEL } = require('../config');

// ======================== STATUS CONSTANTS ========================

const STATUS = {
  DONE: 'DONE',
  IN_PROGRESS: 'IN_PROGRESS',
  NOT_STARTED: 'NOT_STARTED',
  SUPERSEDED: 'SUPERSEDED',
};

const STATUS_ICONS = {
  DONE: '✅',
  IN_PROGRESS: '🔄',
  NOT_STARTED: '⏳',
  SUPERSEDED: '🔀',
};

// ======================== LOCAL ASSESSMENT ========================

/**
 * Deterministic progress assessment based purely on correlation scores.
 * No API calls — works offline.
 *
 * @param {Array} items - From extractTrackableItems()
 * @param {Map} correlations - From correlateItemsWithChanges()
 * @returns {Array<{item_id, item_type, status, confidence, evidence[], notes}>}
 */
function assessProgressLocal(items, correlations) {
  return items.map(item => {
    const corr = correlations.get(item.id);

    if (!corr || corr.score === 0) {
      return {
        item_id: item.id,
        item_type: item.type,
        title: item.title,
        status: STATUS.NOT_STARTED,
        confidence: 'LOW',
        evidence: [],
        notes: 'No matching changes detected in git history or documents.',
      };
    }

    return {
      item_id: item.id,
      item_type: item.type,
      title: item.title,
      status: corr.localAssessment,
      confidence: corr.localConfidence,
      evidence: corr.evidence,
      notes: `Local correlation score: ${corr.score.toFixed(2)}`,
    };
  });
}

// ======================== AI ASSESSMENT ========================

/**
 * Build a focused Gemini prompt for progress assessment.
 *
 * @param {Array} items - Trackable items
 * @param {object} changeReport - From detectAllChanges()
 * @param {Array} localAssessments - From assessProgressLocal()
 * @returns {string}
 */
function buildProgressPrompt(items, changeReport, localAssessments) {
  const lines = [];

  lines.push('# Progress Assessment Task');
  lines.push('');
  lines.push('You are analyzing whether work items from a meeting/call have been completed.');
  lines.push('Based on the git changes and document updates below, assess each item\'s progress.');
  lines.push('');

  // Items section
  lines.push('## Items To Assess');
  lines.push('');
  for (const item of items) {
    lines.push(`### [${item.type}] ${item.id}: ${item.title}`);
    if (item.description && item.description !== item.title) {
      lines.push(`  Description: ${item.description}`);
    }
    if (item.fileRefs.length > 0) {
      lines.push(`  Referenced files: ${item.fileRefs.join(', ')}`);
    }
    if (item.assignee) {
      lines.push(`  Assigned to: ${item.assignee}`);
    }
    lines.push('');
  }

  // Git changes section
  if (changeReport.git.available) {
    lines.push('## Git Changes Since Last Analysis');
    lines.push(`Branch: ${changeReport.git.branch || 'unknown'}`);
    lines.push(`Commits: ${changeReport.git.commits.length}`);
    lines.push(`Files changed: ${changeReport.git.changedFiles.length}`);
    lines.push('');

    if (changeReport.git.commits.length > 0) {
      lines.push('### Recent Commits');
      for (const c of changeReport.git.commits.slice(0, 50)) {
        lines.push(`- **${c.hash}** (${c.date}): ${c.message}`);
        if (c.files && c.files.length > 0) {
          for (const f of c.files.slice(0, 10)) {
            lines.push(`  - ${f}`);
          }
          if (c.files.length > 10) lines.push(`  - ... and ${c.files.length - 10} more`);
        }
      }
      lines.push('');
    }

    if (changeReport.git.changedFiles.length > 0) {
      lines.push('### Changed Files');
      for (const f of changeReport.git.changedFiles.slice(0, 100)) {
        lines.push(`- [${f.status}] ${f.path} (${f.changes} change(s))`);
      }
      lines.push('');
    }
  }

  // Document changes
  if (changeReport.documents.changes.length > 0) {
    lines.push('## Document Updates (in call folder)');
    for (const d of changeReport.documents.changes) {
      lines.push(`- ${d.relPath} (modified: ${d.modified})`);
    }
    lines.push('');
  }

  // Local correlations as hints
  lines.push('## Pre-Computed Correlations (hints — verify and improve)');
  for (const la of localAssessments) {
    lines.push(`- ${la.item_id} (${la.item_type}): local says ${la.status} (${la.confidence})`);
    if (la.evidence.length > 0) {
      for (const e of la.evidence.slice(0, 5)) {
        lines.push(`  • [${e.type}] ${e.detail}`);
      }
    }
  }
  lines.push('');

  // Instructions
  lines.push('## Instructions');
  lines.push('');
  lines.push('For EACH item, provide a JSON response with this structure:');
  lines.push('```json');
  lines.push('{');
  lines.push('  "assessments": [');
  lines.push('    {');
  lines.push('      "item_id": "string — the exact item ID",');
  lines.push('      "item_type": "string — ticket/change_request/action_item/blocker/scope_change",');
  lines.push('      "status": "DONE | IN_PROGRESS | NOT_STARTED | SUPERSEDED",');
  lines.push('      "confidence": "HIGH | MEDIUM | LOW",');
  lines.push('      "evidence": ["array of specific evidence strings"],');
  lines.push('      "notes": "string — brief explanation of your assessment"');
  lines.push('    }');
  lines.push('  ],');
  lines.push('  "overall_summary": "Brief summary of overall project progress",');
  lines.push('  "recommendations": ["Array of actionable recommendations"]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('Assessment rules:');
  lines.push('- DONE = Clear evidence that the item\'s requirements are fully addressed');
  lines.push('- IN_PROGRESS = Partial changes exist that relate to this item');
  lines.push('- NOT_STARTED = No relevant changes found');
  lines.push('- SUPERSEDED = Item is no longer relevant (replaced/cancelled by later changes)');
  lines.push('- Be conservative — prefer IN_PROGRESS over DONE unless evidence is strong');
  lines.push('- Use commit messages, file changes, and file names as evidence');
  lines.push('- If a commit message explicitly references an item ID, that\'s strong evidence');

  return lines.join('\n');
}

/**
 * Run AI-powered progress assessment via Gemini.
 *
 * @param {object} ai - Initialized Gemini AI instance
 * @param {Array} items - Trackable items
 * @param {object} changeReport - From detectAllChanges()
 * @param {Array} localAssessments - From assessProgressLocal()
 * @param {object} [opts] - { thinkingBudget }
 * @returns {object} { assessments[], overall_summary, recommendations[], model, tokenUsage }
 */
async function assessProgressWithAI(ai, items, changeReport, localAssessments, opts = {}) {
  const prompt = buildProgressPrompt(items, changeReport, localAssessments);
  const thinkingBudget = opts.thinkingBudget || 16384;

  const result = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      temperature: 0,
      thinkingConfig: { thinkingBudget },
    },
  });

  const rawText = result.text || '';
  const tokenUsage = result.usageMetadata || {};

  const parsed = extractJson(rawText);
  if (!parsed) {
    throw new Error('Failed to parse AI progress assessment response as JSON');
  }

  return {
    assessments: parsed.assessments || [],
    overall_summary: parsed.overall_summary || 'No summary provided',
    recommendations: parsed.recommendations || [],
    model: GEMINI_MODEL,
    tokenUsage,
  };
}

// ======================== MERGE & SUMMARY ========================

/**
 * Merge AI or local assessments back into the analysis items,
 * adding a `_progress` annotation to each matched item.
 *
 * @param {object} analysis - The compiled analysis object
 * @param {Array} assessments - Array of assessment objects
 * @returns {object} The annotated analysis (mutated)
 */
function mergeProgressIntoAnalysis(analysis, assessments) {
  if (!analysis || !assessments) return analysis;

  const assessMap = new Map();
  for (const a of assessments) {
    assessMap.set(a.item_id, a);
  }

  const sections = [
    { key: 'tickets', idField: 'ticket_id' },
    { key: 'change_requests', idField: 'id' },
    { key: 'action_items', idField: 'id' },
    { key: 'blockers', idField: 'id' },
    { key: 'scope_changes', idField: 'id' },
  ];

  for (const { key, idField } of sections) {
    for (const item of (analysis[key] || [])) {
      const itemId = item[idField];
      const assessment = assessMap.get(itemId);
      if (assessment) {
        item._progress = {
          status: assessment.status,
          confidence: assessment.confidence,
          evidence: assessment.evidence,
          notes: assessment.notes,
          assessedAt: new Date().toISOString(),
        };
      }
    }
  }

  return analysis;
}

/**
 * Build summary counts from assessments.
 *
 * @param {Array} assessments
 * @returns {object} { done, inProgress, notStarted, superseded, total }
 */
function buildProgressSummary(assessments) {
  const summary = { done: 0, inProgress: 0, notStarted: 0, superseded: 0, total: assessments.length };
  for (const a of assessments) {
    switch (a.status) {
      case STATUS.DONE: summary.done++; break;
      case STATUS.IN_PROGRESS: summary.inProgress++; break;
      case STATUS.NOT_STARTED: summary.notStarted++; break;
      case STATUS.SUPERSEDED: summary.superseded++; break;
    }
  }
  return summary;
}

// ======================== MARKDOWN RENDERING ========================

/**
 * Render a full progress report as Markdown.
 *
 * @param {object} params
 * @param {Array} params.assessments - Per-item assessments
 * @param {object} params.changeReport - From detectAllChanges()
 * @param {string} [params.overallSummary] - AI-generated summary
 * @param {string[]} [params.recommendations] - AI-generated recommendations
 * @param {object} [params.meta] - { callName, timestamp, mode }
 * @returns {string} Markdown content
 */
function renderProgressMarkdown({ assessments, changeReport, overallSummary, recommendations, meta = {} }) {
  const lines = [];
  const summary = buildProgressSummary(assessments);
  const ts = meta.timestamp || new Date().toISOString();

  lines.push(`# Progress Report${meta.callName ? ` — ${meta.callName}` : ''}`);
  lines.push('');
  lines.push(`> Generated: ${ts}`);
  lines.push(`> Mode: ${meta.mode || 'local'}`);
  if (changeReport.git.available) {
    lines.push(`> Branch: ${changeReport.git.branch || 'unknown'}`);
    lines.push(`> Commits since last analysis: ${changeReport.totals.commits}`);
    lines.push(`> Files changed: ${changeReport.totals.filesChanged}`);
  }
  lines.push(`> Documents updated: ${changeReport.totals.docsChanged}`);
  lines.push('');

  // Overview bar
  lines.push('## Overview');
  lines.push('');
  lines.push(`| Status | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| ${STATUS_ICONS.DONE} Completed | ${summary.done} |`);
  lines.push(`| ${STATUS_ICONS.IN_PROGRESS} In Progress | ${summary.inProgress} |`);
  lines.push(`| ${STATUS_ICONS.NOT_STARTED} Not Started | ${summary.notStarted} |`);
  lines.push(`| ${STATUS_ICONS.SUPERSEDED} Superseded | ${summary.superseded} |`);
  lines.push(`| **Total** | **${summary.total}** |`);
  lines.push('');

  // Progress percentage
  const pct = summary.total > 0 ? ((summary.done / summary.total) * 100).toFixed(0) : 0;
  lines.push(`**Overall completion: ${pct}%** (${summary.done}/${summary.total} items done)`);
  lines.push('');

  // Overall summary
  if (overallSummary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(overallSummary);
    lines.push('');
  }

  // Per-status sections
  const statusOrder = [STATUS.DONE, STATUS.IN_PROGRESS, STATUS.NOT_STARTED, STATUS.SUPERSEDED];
  const statusLabels = {
    DONE: 'Completed Items',
    IN_PROGRESS: 'In Progress',
    NOT_STARTED: 'Not Started',
    SUPERSEDED: 'Superseded',
  };

  for (const status of statusOrder) {
    const items = assessments.filter(a => a.status === status);
    if (items.length === 0) continue;

    lines.push(`## ${STATUS_ICONS[status]} ${statusLabels[status]}`);
    lines.push('');

    for (const item of items) {
      lines.push(`### ${item.item_id} (${item.item_type})`);
      if (item.title) lines.push(`**${item.title}**`);
      lines.push('');
      lines.push(`- **Confidence:** ${item.confidence}`);
      if (item.notes) lines.push(`- **Notes:** ${item.notes}`);
      if (item.evidence && item.evidence.length > 0) {
        lines.push('- **Evidence:**');
        for (const e of item.evidence) {
          if (typeof e === 'string') {
            lines.push(`  - ${e}`);
          } else {
            lines.push(`  - [${e.type}] ${e.detail}`);
          }
        }
      }
      lines.push('');
    }
  }

  // Recommendations
  if (recommendations && recommendations.length > 0) {
    lines.push('## Recommendations');
    lines.push('');
    for (const r of recommendations) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }

  // Git details
  if (changeReport.git.available && changeReport.git.commits.length > 0) {
    lines.push('## Git Activity Summary');
    lines.push('');
    lines.push(`- **${changeReport.git.commits.length}** commit(s) since last analysis`);
    lines.push(`- **${changeReport.git.changedFiles.length}** file(s) changed`);
    if (changeReport.git.summary) {
      lines.push(`- Diff summary: ${changeReport.git.summary}`);
    }
    lines.push('');

    // Top changed files
    const topFiles = changeReport.git.changedFiles
      .sort((a, b) => b.changes - a.changes)
      .slice(0, 15);
    if (topFiles.length > 0) {
      lines.push('### Top Changed Files');
      lines.push('');
      lines.push('| File | Status | Changes |');
      lines.push('|------|--------|---------|');
      for (const f of topFiles) {
        lines.push(`| ${f.path} | ${f.status} | ${f.changes} |`);
      }
      lines.push('');
    }
  }

  // Document changes
  if (changeReport.documents.changes.length > 0) {
    lines.push('## Updated Documents');
    lines.push('');
    for (const d of changeReport.documents.changes) {
      lines.push(`- ${d.relPath} (updated: ${d.modified})`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Generated by Smart Change Detection (v6.1)*');

  return lines.join('\n');
}

module.exports = {
  STATUS,
  STATUS_ICONS,
  assessProgressLocal,
  assessProgressWithAI,
  buildProgressPrompt,
  mergeProgressIntoAnalysis,
  buildProgressSummary,
  renderProgressMarkdown,
};
