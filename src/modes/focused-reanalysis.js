/**
 * Focused Re-Analysis — performs targeted second-pass extraction
 * when the quality gate identifies specific weak dimensions.
 *
 * Instead of re-running the full analysis, this sends a focused prompt
 * to Gemini targeting ONLY the weak areas (e.g., missing blockers,
 * sparse action items, low confidence items).
 *
 * The results are then intelligently merged with the original analysis.
 */

'use strict';

const { extractJson } = require('../utils/json-parser');
const { withRetry } = require('../utils/retry');
const config = require('../config');
// Access config.GEMINI_MODEL / config.GEMINI_CONTEXT_WINDOW at call time for runtime model changes.

// ======================== WEAKNESS DETECTION ========================

/**
 * Analyze a quality report + analysis to identify specific extraction weaknesses.
 *
 * @param {object} qualityReport - From assessQuality()
 * @param {object} analysis - The parsed analysis
 * @returns {{ weakAreas: string[], focusPrompt: string|null, shouldReanalyze: boolean }}
 */
function identifyWeaknesses(qualityReport, analysis) {
  if (!qualityReport || !analysis) {
    return { weakAreas: [], focusPrompt: null, shouldReanalyze: false };
  }

  const weakAreas = [];
  const focusInstructions = [];

  // Check each dimension for specific weaknesses
  const dims = qualityReport.dimensions || {};

  // Low density score — dig into what's sparse
  if (dims.density && dims.density.score < 50) {
    const tickets = analysis.tickets || [];
    const actions = analysis.action_items || [];
    const crs = analysis.change_requests || [];
    const blockers = analysis.blockers || [];
    const scopes = analysis.scope_changes || [];

    if (tickets.length === 0) {
      weakAreas.push('tickets');
      focusInstructions.push(
        'FOCUS: TICKET EXTRACTION — Your previous analysis found no tickets. ' +
        'Re-examine the video carefully for any work items, bugs, features, tasks, ' +
        'or CR numbers discussed. Even brief mentions count. ' +
        'Extract at minimum: ticket_id, title, status, and a brief summary.'
      );
    }

    if (actions.length === 0) {
      weakAreas.push('action_items');
      focusInstructions.push(
        'FOCUS: ACTION ITEMS — Your previous analysis found no action items. ' +
        'Listen for any task assignments, next steps, follow-ups, or commitments made. ' +
        'Include who is responsible and what they need to do.'
      );
    }

    if (blockers.length === 0 && tickets.length > 0) {
      weakAreas.push('blockers');
      focusInstructions.push(
        'FOCUS: BLOCKERS — Tickets were found but no blockers. ' +
        'Re-examine: are there any pending decisions, DB prerequisites, ' +
        'external dependencies, or items waiting on someone? ' +
        'Even implicit blockers (waiting for a response, needing approval) should be captured.'
      );
    }

    if (scopes.length === 0 && tickets.length > 1) {
      weakAreas.push('scope_changes');
      focusInstructions.push(
        'FOCUS: SCOPE CHANGES — Multiple tickets were discussed but no scope changes detected. ' +
        'Check if anything was added, removed, deferred, or had its approach changed ' +
        'compared to what the context documents say.'
      );
    }

    // Check for sparse action items (present but no assignees)
    if (actions.length > 0) {
      const unassigned = actions.filter(a => !a.assigned_to);
      if (unassigned.length > actions.length * 0.5) {
        weakAreas.push('action_item_assignees');
        focusInstructions.push(
          `FOCUS: ACTION ITEM ASSIGNEES — ${unassigned.length}/${actions.length} action items have no assignee. ` +
          'Re-examine who was asked to do each task. Use speaker identification and context clues.'
        );
      }
    }
  }

  // Low confidence coverage
  const allItems = [
    ...(analysis.tickets || []),
    ...(analysis.action_items || []),
    ...(analysis.change_requests || []),
    ...(analysis.blockers || []),
    ...(analysis.scope_changes || []),
  ];
  const withConf = allItems.filter(i => i.confidence && ['HIGH', 'MEDIUM', 'LOW'].includes(i.confidence));
  if (allItems.length > 0 && withConf.length < allItems.length * 0.5) {
    weakAreas.push('confidence');
    focusInstructions.push(
      'FOCUS: CONFIDENCE SCORING — Most items are missing confidence fields. ' +
      'For every item, set confidence to HIGH (explicit + corroborated), ' +
      'MEDIUM (partial evidence), or LOW (inferred). Include confidence_reason.'
    );
  }

  // Check for low-confidence items that might benefit from re-examination
  const lowConfItems = allItems.filter(i => i.confidence === 'LOW');
  if (lowConfItems.length >= 3) {
    weakAreas.push('low_confidence_verification');
    focusInstructions.push(
      `FOCUS: LOW-CONFIDENCE VERIFICATION — ${lowConfItems.length} items were marked LOW confidence. ` +
      'Re-examine these specific items against the video and context documents. ' +
      'Either upgrade their confidence with supporting evidence, or remove them if truly unsupported: ' +
      lowConfItems.slice(0, 5).map(i => `"${i.id || i.ticket_id || i.description?.slice(0, 50)}"`).join(', ')
    );
  }

  // Cross-reference issues
  if (dims.crossRef && dims.crossRef.score < 70) {
    weakAreas.push('cross_references');
    focusInstructions.push(
      'FOCUS: CROSS-REFERENCES — There are consistency issues between items. ' +
      'Verify that all ticket IDs referenced in change_requests and action_items ' +
      'actually exist in the tickets array. Fix any orphaned references.'
    );
  }

  const shouldReanalyze = focusInstructions.length > 0 &&
    qualityReport.score < 60 &&       // Only re-analyze if quality is truly lacking
    weakAreas.length >= 2;            // At least 2 weak areas to justify the cost

  const focusPrompt = focusInstructions.length > 0
    ? focusInstructions.join('\n\n')
    : null;

  return { weakAreas, focusPrompt, shouldReanalyze };
}

// ======================== FOCUSED RE-ANALYSIS ========================

/**
 * Run a focused second pass on a segment, targeting specific weak areas.
 *
 * @param {object} ai - Gemini AI instance
 * @param {object} originalAnalysis - The first-pass analysis
 * @param {string} focusPrompt - Specific focus instructions
 * @param {object} segmentOpts - { videoUri, videoMime, segmentIndex, totalSegments, thinkingBudget }
 * @returns {object|null} Additional/corrected extraction, or null if failed
 */
async function runFocusedPass(ai, originalAnalysis, focusPrompt, segmentOpts = {}) {
  const {
    videoUri,
    videoMime = 'video/mp4',
    segmentIndex = 0,
    totalSegments = 1,
    thinkingBudget = 12288,
  } = segmentOpts;

  // Build the focused prompt
  const promptText = `You are performing a FOCUSED RE-ANALYSIS of a video segment.

A first-pass analysis was already done but had gaps. Your job is to fill ONLY the gaps — do NOT repeat items already extracted correctly.

FIRST-PASS RESULT (for reference — do not duplicate these):
${JSON.stringify(originalAnalysis, null, 2).slice(0, 8000)}

${focusPrompt}

INSTRUCTIONS:
- Output ONLY the items that are NEW or CORRECTED compared to the first pass.
- Use the same JSON structure as a normal analysis.
- For corrections to existing items, include the original item's ID with updated fields.
- For new items, use new sequential IDs that don't conflict with the first pass.
- Every item MUST have "confidence" (HIGH/MEDIUM/LOW) and "confidence_reason".
- Set "_focused_pass": true on every item you produce so the merger knows these are second-pass items.
- If you find NO new items after careful re-examination, return: {"_no_new_items": true}

Output ONLY valid JSON.`;

  const contentParts = [];

  // Include video reference if available
  if (videoUri) {
    contentParts.push({ fileData: { mimeType: videoMime, fileUri: videoUri } });
  }

  contentParts.push({ text: promptText });

  const requestPayload = {
    model: config.GEMINI_MODEL,
    contents: [{ role: 'user', parts: contentParts }],
    config: {
      systemInstruction: 'You are a focused re-extraction agent. Find ONLY missing or incorrect items from the first pass. Output valid JSON only.',
      maxOutputTokens: 32768,
      temperature: 0,
      thinkingConfig: { thinkingBudget },
    },
  };

  try {
    const response = await withRetry(
      () => ai.models.generateContent(requestPayload),
      { label: `Focused re-analysis (seg ${segmentIndex + 1}/${totalSegments})`, maxRetries: 1, baseDelay: 3000 }
    );

    const rawText = response.text;
    const parsed = extractJson(rawText);

    if (!parsed) return null;
    if (parsed._no_new_items) return null;

    // Extract token usage for cost tracking
    const usage = response.usageMetadata || {};
    parsed._focusedPassMeta = {
      inputTokens: usage.promptTokenCount || 0,
      outputTokens: usage.candidatesTokenCount || 0,
      totalTokens: usage.totalTokenCount || 0,
      thoughtTokens: usage.thoughtsTokenCount || 0,
    };

    return parsed;
  } catch (err) {
    console.warn(`    ⚠ Focused re-analysis failed: ${err.message}`);
    return null;
  }
}

// ======================== MERGE LOGIC ========================

/**
 * Merge focused pass results into the original analysis.
 * New items are appended; corrections update existing items.
 *
 * @param {object} original - First-pass analysis
 * @param {object} focused - Focused pass results
 * @returns {object} Merged analysis
 */
function mergeFocusedResults(original, focused) {
  if (!focused || focused._no_new_items) return original;

  const merged = JSON.parse(JSON.stringify(original)); // deep clone

  // Merge each array field
  const arrayFields = [
    { key: 'tickets', idField: 'ticket_id' },
    { key: 'action_items', idField: 'id' },
    { key: 'change_requests', idField: 'id' },
    { key: 'blockers', idField: 'id' },
    { key: 'scope_changes', idField: 'id' },
    { key: 'file_references', idField: 'resolved_path' },
  ];

  for (const { key, idField } of arrayFields) {
    const originalArr = merged[key] || [];
    const focusedArr = focused[key] || [];

    if (focusedArr.length === 0) continue;

    const existingIds = new Set(originalArr.map(item => item[idField]).filter(Boolean));

    for (const focusedItem of focusedArr) {
      const itemId = focusedItem[idField];

      if (itemId && existingIds.has(itemId)) {
        // Correction — update existing item
        const existingIdx = originalArr.findIndex(item => item[idField] === itemId);
        if (existingIdx !== -1) {
          // Merge fields: focused pass fields override if present
          for (const [field, val] of Object.entries(focusedItem)) {
            if (val !== null && val !== undefined && field !== '_focused_pass') {
              originalArr[existingIdx][field] = val;
            }
          }
          originalArr[existingIdx]._enhanced_by_focused_pass = true;
        }
      } else {
        // New item — append
        focusedItem._from_focused_pass = true;
        originalArr.push(focusedItem);
        if (itemId) existingIds.add(itemId);
      }
    }

    merged[key] = originalArr;
  }

  // Handle summary enhancement
  if (focused.summary && focused.summary.length > 20) {
    if (merged.summary) {
      merged.summary += '\n\n[Focused re-analysis addition]: ' + focused.summary;
    } else {
      merged.summary = focused.summary;
    }
  }

  // Mark as enhanced
  merged._focused_pass_applied = true;
  merged._focused_pass_meta = focused._focusedPassMeta || null;

  return merged;
}

module.exports = {
  identifyWeaknesses,
  runFocusedPass,
  mergeFocusedResults,
};
