'use strict';

const path = require('path');

// --- Modes ---
const { discoverTopics, generateAllDocuments, writeDeepDiveOutput } = require('../modes/deep-dive');

// --- Utils ---
const { c } = require('../utils/colors');

// --- Shared state ---
const { getLog, phaseTimer, PROJECT_ROOT } = require('./_shared');

// ======================== PHASE: DEEP DIVE ========================

/**
 * Generate explanatory documents for topics discussed in the meeting.
 * Two-phase: discover topics → generate documents in parallel.
 */
async function phaseDeepDive(ctx, compiledAnalysis, runDir) {
  const log = getLog();
  const timer = phaseTimer('deep_dive');
  const { ai, callName, userName, costTracker, opts, contextDocs } = ctx;

  console.log('');
  console.log(c.cyan('══════════════════════════════════════════════'));
  console.log(c.heading('  DEEP DIVE — Generating Explanatory Documents'));
  console.log(c.cyan('══════════════════════════════════════════════'));
  console.log('');

  const thinkingBudget = opts.thinkingBudget ||
    require('../config').DEEP_DIVE_THINKING_BUDGET;

  // Gather context snippets from inline text docs (for richer AI context)
  const contextSnippets = [];
  for (const doc of (contextDocs || [])) {
    if (doc.type === 'inlineText' && doc.content) {
      const snippet = doc.content.length > 3000
        ? doc.content.slice(0, 3000) + '\n... (truncated)'
        : doc.content;
      contextSnippets.push(`[${doc.fileName}]\n${snippet}`);
    } else if (doc.type === 'inlineData') {
      // Image docs — note their presence so AI knows visual context exists
      // (actual image data is already in the compiled analysis via upstream batch analysis)
      contextSnippets.push(`[Image: ${doc.fileName}]`);
    }
  }

  // Phase 1: Discover topics
  console.log(`  ${c.dim('Phase 1:')} Discovering topics...`);
  let topicResult;
  try {
    topicResult = await discoverTopics(ai, compiledAnalysis, {
      callName, userName, thinkingBudget, contextSnippets,
    });
  } catch (err) {
    console.error(`  ${c.error(`Topic discovery failed: ${err.message}`)}`);
    log.error(`Deep dive topic discovery failed: ${err.message}`);
    timer.end();
    return;
  }

  const topics = topicResult.topics;
  if (!topics || topics.length === 0) {
    console.log(`  ${c.info('No topics identified for deep dive')}`);
    log.step('Deep dive: no topics discovered');
    timer.end();
    return;
  }

  console.log(`  ${c.success(`Found ${c.highlight(topics.length)} topic(s):`)}`);
  topics.forEach(t => console.log(`    ${c.cyan(t.id)} ${c.dim(`[${t.category}]`)} ${t.title}`));
  console.log('');

  if (topicResult.tokenUsage) {
    costTracker.addSegment('deep-dive-discovery', topicResult.tokenUsage, topicResult.durationMs, false);
  }
  log.step(`Deep dive: ${topics.length} topics discovered in ${(topicResult.durationMs / 1000).toFixed(1)}s`);

  // Phase 2: Generate documents
  console.log(`  ${c.dim('Phase 2:')} Generating ${c.highlight(topics.length)} document(s)...`);
  const documents = await generateAllDocuments(ai, topics, compiledAnalysis, {
    callName,
    userName,
    thinkingBudget,
    contextSnippets,
    concurrency: Math.min(opts.parallelAnalysis || 2, 3), // match pipeline parallelism
    onProgress: (done, total, topic) => {
      console.log(`    ${c.dim(`[${done}/${total}]`)} ${c.success(topic.title)}`);
    },
  });

  // Track cost
  for (const doc of documents) {
    if (doc.tokenUsage && doc.tokenUsage.totalTokens > 0) {
      costTracker.addSegment(`deep-dive-${doc.topic.id}`, doc.tokenUsage, doc.durationMs, false);
    }
  }

  // Phase 3: Write output
  const deepDiveDir = path.join(runDir, 'deep-dive');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const { indexPath, stats } = writeDeepDiveOutput(deepDiveDir, documents, {
    callName,
    timestamp: ts,
  });

  console.log('');
  console.log(`  ${c.success(`Deep dive complete: ${c.highlight(stats.successful + '/' + stats.total)} documents generated`)}`);
  console.log(`    Output: ${c.cyan(path.relative(PROJECT_ROOT, deepDiveDir) + '/')}`);
  console.log(`    Index:  ${c.cyan(path.relative(PROJECT_ROOT, indexPath))}`);
  if (stats.failed > 0) {
    console.log(`    ${c.warn(`${stats.failed} document(s) failed`)}`);
  }
  console.log(`    Tokens: ${c.yellow(stats.totalTokens.toLocaleString())} | Time: ${c.yellow((stats.totalDurationMs / 1000).toFixed(1) + 's')}`);
  console.log('');

  log.step(`Deep dive complete: ${stats.successful} docs, ${stats.totalTokens} tokens, ${(stats.totalDurationMs / 1000).toFixed(1)}s`);
  timer.end();
}

module.exports = phaseDeepDive;
