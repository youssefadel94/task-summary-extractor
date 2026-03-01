/**
 * Deep Summary — pre-summarizes context documents before segment analysis
 * to dramatically reduce input tokens per segment.
 *
 * Instead of sending full document content (potentially 500K+ tokens) to
 * every segment, this module:
 *  1. Groups documents by priority tier
 *  2. Sends each group to Gemini for intelligent condensation
 *  3. Replaces full content with condensed summaries
 *  4. Preserves "excluded" docs at full fidelity (user-chosen focus docs)
 *  5. Ensures summaries capture all ticket IDs, action items, statuses
 *
 * The user can pick specific docs to EXCLUDE from summarization — these stay
 * full. The summary pass receives extra instructions to focus on extracting
 * information related to these excluded docs' topics.
 *
 * Token savings: typically 60-80% reduction in per-segment context tokens.
 */

'use strict';

const { extractJson } = require('../utils/json-parser');
const { withRetry } = require('../utils/retry');
const { estimateTokens } = require('../utils/context-manager');
const { c } = require('../utils/colors');
const config = require('../config');

// ======================== CONSTANTS ========================

/** Max tokens for a single summarization call output */
const SUMMARY_MAX_OUTPUT = 16384;

/** Max input chars to send in one summarization batch (~200K tokens @ 0.3 tok/char) */
const BATCH_MAX_CHARS = 600000;

/** Minimum content length (chars) to bother summarizing — below this, keep full */
const MIN_SUMMARIZE_LENGTH = 500;

// ======================== BATCH BUILDER ========================

/**
 * Group documents into batches that fit within the batch char limit.
 * Each batch will be summarized in a single Gemini call.
 *
 * @param {Array} docs - Context docs to batch [{type, fileName, content}]
 * @param {number} [maxChars=BATCH_MAX_CHARS] - Max chars per batch
 * @returns {Array<Array>} Batches of docs
 */
function buildBatches(docs, maxChars = BATCH_MAX_CHARS) {
  const batches = [];
  let currentBatch = [];
  let currentChars = 0;

  for (const doc of docs) {
    const docChars = doc.content ? doc.content.length : 0;

    // If this single doc exceeds the batch limit, it gets its own batch
    if (docChars > maxChars) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
      }
      batches.push([doc]);
      continue;
    }

    if (currentChars + docChars > maxChars && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(doc);
    currentChars += docChars;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

// ======================== SUMMARIZE ONE BATCH ========================

/**
 * Summarize a batch of documents into a condensed representation.
 *
 * @param {object} ai - Gemini AI instance
 * @param {Array} docs - Documents in this batch
 * @param {object} [opts]
 * @param {string[]} [opts.focusTopics=[]] - Topics to focus on (from excluded docs)
 * @param {number} [opts.thinkingBudget=8192] - Thinking token budget
 * @param {number} [opts.batchIndex=0] - Batch number for logging
 * @param {number} [opts.totalBatches=1] - Total batches for logging
 * @returns {Promise<{summaries: Map<string, string>, tokenUsage: object}|null>}
 */
async function summarizeBatch(ai, docs, opts = {}) {
  const {
    focusTopics = [],
    thinkingBudget = 8192,
    batchIndex = 0,
    totalBatches = 1,
  } = opts;

  const docEntries = docs
    .filter(d => d.type === 'inlineText' && d.content)
    .map(d => `=== DOCUMENT: ${d.fileName} ===\n${d.content}`);

  if (docEntries.length === 0) return null;

  const focusSection = focusTopics.length > 0
    ? `\n\nFOCUS AREAS — The user has selected certain documents to keep at full fidelity. ` +
      `Your summaries must be especially thorough about information related to these topics:\n` +
      focusTopics.map((t, i) => `  ${i + 1}. ${t}`).join('\n') +
      `\n\nFor every ticket ID, action item, blocker, or status mentioned in relation to these ` +
      `focus areas, include them verbatim in the summary. Do NOT omit any IDs or assignments.`
    : '';

  const promptText = `You are a precision document summarizer for a meeting analysis pipeline.

Your job: read ALL documents below and produce a CONDENSED version of each that preserves:
- Every ticket ID, task ID, CR number, or reference number (verbatim)
- All assignees, reviewers, and responsible parties
- All statuses (open, closed, in_progress, blocked, etc.)
- All action items and their owners
- All blockers, dependencies, and deadlines
- Key decisions and their rationale
- File paths and code references
- Numerical data (percentages, counts, dates, versions)

What to remove:
- Verbose explanations of well-known concepts
- Redundant phrasing and filler text
- Formatting-only content (decorative headers, dividers)
- Boilerplate/template text that adds no information
${focusSection}

OUTPUT FORMAT:
Return valid JSON with this structure:
{
  "summaries": {
    "<fileName>": "<condensed text — plain text, preserving all key info>",
    ...
  },
  "metadata": {
    "originalTokensEstimate": <number>,
    "summaryTokensEstimate": <number>,
    "compressionRatio": <number between 0 and 1>
  }
}

Aim for 70-80% size reduction while preserving ALL actionable information.
Every ID, every name, every status must survive the summarization.

DOCUMENTS TO SUMMARIZE (${docEntries.length} documents):

${docEntries.join('\n\n')}`;

  const requestPayload = {
    model: config.GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    config: {
      systemInstruction: 'You are a lossless information compressor. Preserve every ID, name, status, assignment, and actionable detail. Output valid JSON only.',
      maxOutputTokens: SUMMARY_MAX_OUTPUT,
      temperature: 0,
      thinkingConfig: { thinkingBudget },
    },
  };

  try {
    const label = totalBatches > 1
      ? `Deep summary batch ${batchIndex + 1}/${totalBatches}`
      : 'Deep summary';

    const response = await withRetry(
      () => ai.models.generateContent(requestPayload),
      { label, maxRetries: 2, baseDelay: 3000 }
    );

    const rawText = response.text;
    const parsed = extractJson(rawText);

    if (!parsed || !parsed.summaries) return null;

    const usage = response.usageMetadata || {};
    const tokenUsage = {
      inputTokens: usage.promptTokenCount || 0,
      outputTokens: usage.candidatesTokenCount || 0,
      totalTokens: usage.totalTokenCount || 0,
      thoughtTokens: usage.thoughtsTokenCount || 0,
    };

    return { summaries: parsed.summaries, metadata: parsed.metadata || {}, tokenUsage };
  } catch (err) {
    console.warn(`    ${c.warn(`Deep summary batch ${batchIndex + 1} failed: ${err.message}`)}`);
    return null;
  }
}

// ======================== MAIN ENTRY POINT ========================

/**
 * Run deep summarization on context documents.
 *
 * @param {object} ai - Gemini AI instance
 * @param {Array} contextDocs - All prepared context docs
 * @param {object} [opts]
 * @param {string[]} [opts.excludeFileNames=[]] - Doc fileNames to keep at full fidelity
 * @param {number} [opts.thinkingBudget=8192] - Thinking budget per batch
 * @param {number} [opts.concurrency=1] - Parallel batch limit
 * @param {Function} [opts.onProgress] - Callback(done, total) for progress
 * @returns {Promise<{docs: Array, stats: object}>}
 */
async function deepSummarize(ai, contextDocs, opts = {}) {
  const {
    excludeFileNames = [],
    thinkingBudget = 8192,
    concurrency = 1,
    onProgress = null,
  } = opts;

  const excludeSet = new Set(excludeFileNames.map(n => n.toLowerCase()));

  // Partition: docs to summarize vs docs to keep full
  const toSummarize = [];
  const keepFull = [];

  for (const doc of contextDocs) {
    // Keep non-text docs (fileData = PDF etc.) as-is
    if (doc.type !== 'inlineText') {
      keepFull.push(doc);
      continue;
    }

    // Keep excluded docs at full fidelity
    if (excludeSet.has(doc.fileName.toLowerCase())) {
      keepFull.push(doc);
      continue;
    }

    // Skip tiny docs — not worth summarizing
    if (!doc.content || doc.content.length < MIN_SUMMARIZE_LENGTH) {
      keepFull.push(doc);
      continue;
    }

    toSummarize.push(doc);
  }

  if (toSummarize.length === 0) {
    return {
      docs: contextDocs,
      stats: {
        summarized: 0,
        keptFull: keepFull.length,
        originalTokens: 0,
        summaryTokens: 0,
        savedTokens: 0,
        savingsPercent: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
    };
  }

  // Build focus topics from excluded docs (tell summarizer what to prioritize)
  const focusTopics = keepFull
    .filter(d => d.type === 'inlineText' && excludeSet.has(d.fileName.toLowerCase()))
    .map(d => d.fileName);

  // Batch documents
  const batches = buildBatches(toSummarize);

  console.log(`    Batched ${c.highlight(toSummarize.length)} doc(s) into ${c.highlight(batches.length)} summarization batch(es)`);
  if (focusTopics.length > 0) {
    console.log(`    Focus topics from ${c.highlight(focusTopics.length)} excluded doc(s):`);
    focusTopics.forEach(t => console.log(`      ${c.dim('•')} ${c.cyan(t)}`));
  }

  // Process batches (sequential for now; can add parallelization later)
  const allSummaries = new Map();
  let totalInput = 0;
  let totalOutput = 0;
  let batchesDone = 0;

  for (let i = 0; i < batches.length; i++) {
    const result = await summarizeBatch(ai, batches[i], {
      focusTopics,
      thinkingBudget,
      batchIndex: i,
      totalBatches: batches.length,
    });

    batchesDone++;
    if (onProgress) onProgress(batchesDone, batches.length);

    if (result && result.summaries) {
      for (const [fileName, summary] of Object.entries(result.summaries)) {
        allSummaries.set(fileName.toLowerCase(), summary);
      }
      totalInput += result.tokenUsage.inputTokens;
      totalOutput += result.tokenUsage.outputTokens;
    }
  }

  // Replace doc content with summaries
  let originalTokens = 0;
  let summaryTokens = 0;
  const resultDocs = [];

  for (const doc of contextDocs) {
    if (doc.type !== 'inlineText') {
      resultDocs.push(doc);
      continue;
    }

    // Check if this doc was excluded (kept full)
    if (excludeSet.has(doc.fileName.toLowerCase())) {
      resultDocs.push(doc);
      continue;
    }

    // Check if we have a summary for this doc
    const summaryKey = doc.fileName.toLowerCase();
    const summary = allSummaries.get(summaryKey);

    if (summary && summary.length > 0) {
      const origTokens = estimateTokens(doc.content);
      const sumTokens = estimateTokens(summary);
      originalTokens += origTokens;
      summaryTokens += sumTokens;

      resultDocs.push({
        ...doc,
        content: `[Deep Summary — original: ~${origTokens.toLocaleString()} tokens → condensed: ~${sumTokens.toLocaleString()} tokens]\n\n${summary}`,
        _originalLength: doc.content.length,
        _summaryLength: summary.length,
        _deepSummarized: true,
      });
    } else {
      // No summary returned — keep original
      resultDocs.push(doc);
    }
  }

  const savedTokens = originalTokens - summaryTokens;
  const savingsPercent = originalTokens > 0
    ? ((savedTokens / originalTokens) * 100).toFixed(1)
    : 0;

  return {
    docs: resultDocs,
    stats: {
      summarized: allSummaries.size,
      keptFull: keepFull.length,
      originalTokens,
      summaryTokens,
      savedTokens,
      savingsPercent: parseFloat(savingsPercent),
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
    },
  };
}

// ======================== EXPORTS ========================

module.exports = {
  deepSummarize,
  summarizeBatch,
  buildBatches,
  SUMMARY_MAX_OUTPUT,
  BATCH_MAX_CHARS,
  MIN_SUMMARIZE_LENGTH,
};
