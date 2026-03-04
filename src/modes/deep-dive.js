/**
 * Deep Dive — AI-powered explanatory document generation.
 *
 * After the normal extraction pipeline, this module takes the compiled analysis
 * and asks Gemini to identify topics that warrant deeper explanation, then
 * generates a set of standalone Markdown documents — one per topic.
 *
 * Use cases:
 *  - Technical concepts discussed in a dev call → architecture docs
 *  - Client requirements → detailed requirement breakdowns
 *  - Decisions made → decision records with rationale
 *  - Processes discussed → step-by-step guides
 *  - Any complex topic → accessible explanations
 *
 * Two-phase approach:
 *  Phase 1: Topic Discovery — AI identifies what can be explained
 *  Phase 2: Document Generation — AI writes each document in parallel batches
 */

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
// Access config.GEMINI_MODEL / config.GEMINI_CONTEXT_WINDOW at call time for runtime model changes.
const { extractJson } = require('../utils/json-parser');
const { withRetry } = require('../utils/retry');

// ======================== TOPIC DISCOVERY ========================

/**
 * Ask Gemini to identify topics from the compiled analysis that can be
 * expanded into standalone explanatory documents.
 *
 * @param {object} ai - GoogleGenAI instance
 * @param {object} compiledAnalysis - The compiled analysis from the pipeline
 * @param {object} options
 * @param {string} options.callName - Name of the call/meeting
 * @param {string} options.userName - Current user's name
 * @param {number} options.thinkingBudget - Thinking tokens
 * @param {string[]} [options.contextSnippets] - Optional raw document snippets for richer context
 * @returns {Promise<{topics: Array<{id: string, title: string, category: string, description: string, relevance: string, source_items: string[]}>, raw: string}>}
 */
async function discoverTopics(ai, compiledAnalysis, options = {}) {
  const { callName = 'meeting', userName = '', thinkingBudget = 16384, contextSnippets = [] } = options;

  const analysisStr = JSON.stringify(compiledAnalysis, null, 2);

  let contextSection = '';
  if (contextSnippets.length > 0) {
    contextSection = `\n\nADDITIONAL CONTEXT FROM MEETING DOCUMENTS:\n${contextSnippets.join('\n---\n')}`;
  }

  const prompt = `You are an expert technical writer and knowledge analyst. You have the complete analysis of a recorded meeting/call.

MEETING: "${callName}"
USER: "${userName}"

COMPILED ANALYSIS:
${analysisStr}${contextSection}

YOUR TASK:
Identify topics, concepts, decisions, processes, or systems discussed in this meeting that would benefit from a deeper explanatory document. Think about what a team member who wasn't on the call would need to understand.

TOPIC CATEGORIES (use these exact category names):
- "concept" — Technical concepts, patterns, or architectures discussed
- "decision" — Key decisions made with rationale (ADR-style)
- "process" — Workflows, procedures, or step-by-step processes discussed
- "system" — Systems, services, or components explained or referenced
- "requirement" — Requirements, specs, or acceptance criteria discussed
- "guide" — How-to guides or implementation approaches covered
- "context" — Background context, history, or domain knowledge shared
- "action-plan" — Detailed expansion of complex action items or ticket work

RULES:
1. Identify 3-10 topics depending on meeting complexity. More topics for richer meetings.
2. Each topic should be substantial enough for a standalone 200-500 word document.
3. Don't create topics for trivial items or simple status updates.
4. DO create topics for anything that needed explanation during the call.
5. Focus on what was DISCUSSED and EXPLAINED, not just mentioned in passing.
6. Link each topic back to the specific tickets, CRs, action items, or discussion points that inspired it.
7. Order by relevance — most important topics first.

RESPOND WITH ONLY VALID JSON — no markdown fences, no extra text:

{
  "topics": [
    {
      "id": "DD-01",
      "title": "Clear, descriptive title for the document",
      "category": "concept|decision|process|system|requirement|guide|context|action-plan",
      "description": "2-3 sentence description of what this document should cover",
      "relevance": "Why this topic needs a deeper explanation",
      "source_items": ["TICKET-123", "CR-45", "AI-3"]
    }
  ]
}`;

  const requestPayload = {
    model: config.GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: 'You are a knowledge analyst. Identify topics from meeting analysis that warrant deeper explanatory documentation. Respond with valid JSON only.',
      maxOutputTokens: 16384,
      temperature: 0.3,
      thinkingConfig: { thinkingBudget },
    },
  };

  const t0 = Date.now();
  const response = await withRetry(
    () => ai.models.generateContent(requestPayload),
    { label: 'Deep dive topic discovery', maxRetries: 2, baseDelay: 3000 }
  );
  const durationMs = Date.now() - t0;
  let rawText;
  try { rawText = response.text; } catch { rawText = ''; }

  const parsed = extractJson(rawText);
  const topics = parsed?.topics || [];

  const usage = response.usageMetadata || {};
  const tokenUsage = {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    thoughtTokens: usage.thoughtsTokenCount || 0,
  };

  return { topics, raw: rawText, durationMs, tokenUsage };
}

// ======================== DOCUMENT GENERATION ========================

/**
 * Generate a single deep-dive Markdown document for a given topic.
 *
 * @param {object} ai - GoogleGenAI instance
 * @param {object} topic - Topic object from discoverTopics
 * @param {object} compiledAnalysis - Full compiled analysis for context
 * @param {object} options
 * @returns {Promise<{markdown: string, raw: string, durationMs: number, tokenUsage: object}>}
 */
async function generateDocument(ai, topic, compiledAnalysis, options = {}) {
  const { callName = 'meeting', userName = '', thinkingBudget = 16384, contextSnippets = [] } = options;

  // Extract relevant items from analysis based on source_items
  const relevantContext = extractRelevantItems(compiledAnalysis, topic.source_items);

  let contextSection = '';
  if (contextSnippets.length > 0) {
    contextSection = `\n\nRELEVANT MEETING DOCUMENTS:\n${contextSnippets.slice(0, 3).join('\n---\n')}`;
  }

  const categoryGuidance = getCategoryGuidance(topic.category);

  const prompt = `You are an expert technical writer creating a deep-dive explanatory document based on a meeting discussion.

MEETING: "${callName}"
DOCUMENT TO WRITE: "${topic.title}"
CATEGORY: ${topic.category}
DESCRIPTION: ${topic.description}

RELEVANT ITEMS FROM THE MEETING ANALYSIS:
${JSON.stringify(relevantContext, null, 2)}${contextSection}

${categoryGuidance}

WRITING RULES:
1. Write in clear, professional Markdown.
2. Target 300-800 words depending on complexity.
3. Use headers (##, ###), bullet points, tables, and code blocks where appropriate.
4. Include a "Background" section explaining context from the meeting.
5. Include a "Details" section with the deep explanation.
6. Include a "Next Steps" or "Implications" section where relevant.
7. Reference specific items (tickets, CRs, action items) from the meeting using their IDs.
8. Write for someone who WASN'T on the call — they should understand the topic fully.
9. Be factual — only include information that was discussed or can be inferred from the analysis.
10. DO NOT include YAML frontmatter or metadata blocks — start directly with the title.

START YOUR RESPONSE DIRECTLY WITH THE MARKDOWN CONTENT (no fences, no preamble):`;

  const requestPayload = {
    model: config.GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: 'You are a technical writer creating explanatory documentation from meeting analysis. Write clear, well-structured Markdown. Start directly with the content.',
      maxOutputTokens: 8192,
      temperature: 0.4,
      thinkingConfig: { thinkingBudget },
    },
  };

  const t0 = Date.now();
  const response = await withRetry(
    () => ai.models.generateContent(requestPayload),
    { label: `Deep dive doc: ${topic.title}`, maxRetries: 2, baseDelay: 3000 }
  );
  const durationMs = Date.now() - t0;
  let rawText;
  try { rawText = response.text; } catch { rawText = ''; }

  // Clean up — strip markdown fences if the model wrapped it
  let markdown = rawText.trim();
  if (markdown.startsWith('```markdown')) {
    markdown = markdown.replace(/^```markdown\s*\n?/, '').replace(/\n?```\s*$/, '');
  } else if (markdown.startsWith('```md')) {
    markdown = markdown.replace(/^```md\s*\n?/, '').replace(/\n?```\s*$/, '');
  } else if (markdown.startsWith('```')) {
    markdown = markdown.replace(/^```\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  const usage = response.usageMetadata || {};
  const tokenUsage = {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    thoughtTokens: usage.thoughtsTokenCount || 0,
  };

  return { markdown, raw: rawText, durationMs, tokenUsage };
}

// ======================== BATCH GENERATION ========================

/**
 * Generate all deep-dive documents in parallel batches.
 *
 * @param {object} ai - GoogleGenAI instance
 * @param {Array} topics - Topics from discoverTopics
 * @param {object} compiledAnalysis - Full compiled analysis
 * @param {object} options
 * @param {number} [options.concurrency=2] - Max parallel document generations
 * @param {Function} [options.onProgress] - Callback(completed, total, topic) for progress
 * @returns {Promise<Array<{topic: object, markdown: string, durationMs: number, tokenUsage: object, error?: string}>>}
 */
async function generateAllDocuments(ai, topics, compiledAnalysis, options = {}) {
  const { concurrency = 2, onProgress, ...docOptions } = options;

  const results = [];
  const queue = [...topics];
  let completed = 0;

  // Process in batches
  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(topic =>
        generateDocument(ai, topic, compiledAnalysis, docOptions)
          .then(result => {
            return { topic, ...result };
          })
      )
    );

    for (let i = 0; i < batchResults.length; i++) {
      const r = batchResults[i];
      completed++;
      if (r.status === 'fulfilled') {
        if (onProgress) onProgress(completed, topics.length, batch[i]);
        results.push(r.value);
      } else {
        if (onProgress) onProgress(completed, topics.length, batch[i]);
        results.push({
          topic: batch[i],
          markdown: null,
          raw: null,
          durationMs: 0,
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, thoughtTokens: 0 },
          error: r.reason?.message || 'Unknown error',
        });
      }
    }
  }

  return results;
}

// ======================== OUTPUT ========================

/**
 * Write all generated documents to disk and create an index.
 *
 * @param {string} deepDiveDir - Output directory for deep-dive docs
 * @param {Array} documents - Results from generateAllDocuments
 * @param {object} meta - Metadata for the index
 * @returns {{ indexPath: string, docPaths: string[], stats: object }}
 */
function writeDeepDiveOutput(deepDiveDir, documents, meta = {}) {
  fs.mkdirSync(deepDiveDir, { recursive: true });

  const docPaths = [];
  const successful = documents.filter(d => d.markdown);
  const failed = documents.filter(d => !d.markdown);

  // Write individual documents
  for (const doc of successful) {
    const slug = slugify(doc.topic.title);
    const fileName = `${doc.topic.id.toLowerCase()}-${slug}.md`;
    const filePath = path.join(deepDiveDir, fileName);
    fs.writeFileSync(filePath, doc.markdown, 'utf8');
    docPaths.push(filePath);
    doc._fileName = fileName;
  }

  // Build index
  const indexLines = [
    `# Deep Dive — ${meta.callName || 'Meeting Analysis'}`,
    '',
    `> Generated ${successful.length} explanatory document(s) from the meeting discussion.`,
    `> Run: ${meta.timestamp || new Date().toISOString()}`,
    '',
  ];

  // Group by category
  const categories = {};
  for (const doc of successful) {
    const cat = doc.topic.category || 'other';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(doc);
  }

  const categoryLabels = {
    'concept': 'Concepts & Architecture',
    'decision': 'Decisions',
    'process': 'Processes & Workflows',
    'system': 'Systems & Components',
    'requirement': 'Requirements',
    'guide': 'Guides & How-To',
    'context': 'Background & Context',
    'action-plan': 'Action Plans',
  };

  for (const [cat, docs] of Object.entries(categories)) {
    indexLines.push(`## ${categoryLabels[cat] || cat}`);
    indexLines.push('');
    for (const doc of docs) {
      indexLines.push(`- **[${doc.topic.title}](${doc._fileName})** — ${doc.topic.description}`);
    }
    indexLines.push('');
  }

  // Stats
  const totalTokens = documents.reduce((s, d) => s + (d.tokenUsage?.totalTokens || 0), 0);
  const totalDuration = documents.reduce((s, d) => s + (d.durationMs || 0), 0);

  indexLines.push('---');
  indexLines.push('');
  indexLines.push(`*${successful.length} documents generated | ${totalTokens.toLocaleString()} tokens | ${(totalDuration / 1000).toFixed(1)}s*`);

  if (failed.length > 0) {
    indexLines.push('');
    indexLines.push(`> ⚠ ${failed.length} document(s) failed to generate:`);
    for (const doc of failed) {
      indexLines.push(`> - ${doc.topic.title}: ${doc.error}`);
    }
  }

  const indexPath = path.join(deepDiveDir, 'INDEX.md');
  fs.writeFileSync(indexPath, indexLines.join('\n'), 'utf8');
  docPaths.unshift(indexPath);

  // Write metadata JSON
  const metaPath = path.join(deepDiveDir, 'deep-dive.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    timestamp: meta.timestamp,
    callName: meta.callName,
    topicCount: successful.length,
    failedCount: failed.length,
    totalTokens,
    totalDurationMs: totalDuration,
    topics: documents.map(d => ({
      id: d.topic.id,
      title: d.topic.title,
      category: d.topic.category,
      fileName: d._fileName || null,
      success: !!d.markdown,
      error: d.error || null,
      tokens: d.tokenUsage?.totalTokens || 0,
      durationMs: d.durationMs,
    })),
  }, null, 2), 'utf8');
  docPaths.push(metaPath);

  return {
    indexPath,
    docPaths,
    stats: {
      total: documents.length,
      successful: successful.length,
      failed: failed.length,
      totalTokens,
      totalDurationMs: totalDuration,
    },
  };
}

// ======================== HELPERS ========================

/**
 * Extract items from compiled analysis that match the given source_items IDs.
 */
function extractRelevantItems(analysis, sourceItems = []) {
  if (!sourceItems || sourceItems.length === 0) return analysis;

  const ids = new Set(sourceItems.map(id => id.toLowerCase()));
  const relevant = {};

  // Tickets
  if (analysis.tickets) {
    const matched = analysis.tickets.filter(t =>
      ids.has((t.ticket_id || '').toLowerCase()) ||
      ids.has((t.id || '').toLowerCase())
    );
    if (matched.length > 0) relevant.tickets = matched;
  }

  // Change requests
  if (analysis.change_requests) {
    const matched = analysis.change_requests.filter(cr =>
      ids.has((cr.id || '').toLowerCase()) ||
      sourceItems.some(si => (cr.what || cr.WHAT || '').toLowerCase().includes(si.toLowerCase()))
    );
    if (matched.length > 0) relevant.change_requests = matched;
  }

  // Action items
  if (analysis.action_items) {
    const matched = analysis.action_items.filter(ai =>
      ids.has((ai.id || '').toLowerCase()) ||
      ids.has((ai.action_id || '').toLowerCase())
    );
    if (matched.length > 0) relevant.action_items = matched;
  }

  // Blockers
  if (analysis.blockers) {
    const matched = analysis.blockers.filter(b =>
      ids.has((b.id || '').toLowerCase()) ||
      ids.has((b.blocker_id || '').toLowerCase())
    );
    if (matched.length > 0) relevant.blockers = matched;
  }

  // Scope changes
  if (analysis.scope_changes) {
    const matched = analysis.scope_changes.filter(sc =>
      ids.has((sc.id || '').toLowerCase())
    );
    if (matched.length > 0) relevant.scope_changes = matched;
  }

  // Include summary for context
  if (analysis.summary) relevant.summary = analysis.summary;
  if (analysis.your_tasks) relevant.your_tasks = analysis.your_tasks;

  // If nothing matched specifically, return the full analysis as context
  const hasMatches = Object.keys(relevant).some(k => k !== 'summary' && k !== 'your_tasks');
  return hasMatches ? relevant : analysis;
}

/**
 * Get category-specific writing guidance for the AI.
 */
function getCategoryGuidance(category) {
  const guides = {
    'concept': `CATEGORY GUIDANCE — CONCEPT DOCUMENT:
Write an explanatory document about this technical concept or pattern.
- Start with a "What Is It?" section for someone unfamiliar
- Explain HOW it works and WHY it's used in this context
- Include diagrams (as text descriptions) if helpful
- Connect it to the specific implementation discussed in the meeting`,

    'decision': `CATEGORY GUIDANCE — DECISION RECORD:
Write this as an Architecture Decision Record (ADR) style document.
- "Context" — what situation led to this decision
- "Decision" — what was decided and by whom
- "Rationale" — why this option was chosen over alternatives
- "Consequences" — what this means going forward
- "Alternatives Considered" if they were discussed`,

    'process': `CATEGORY GUIDANCE — PROCESS DOCUMENT:
Write a clear step-by-step process or workflow guide.
- Use numbered steps for sequential processes
- Include who is responsible for each step
- Note any prerequisites or dependencies
- Highlight decision points or branching paths
- Include any tools or systems involved`,

    'system': `CATEGORY GUIDANCE — SYSTEM OVERVIEW:
Write an overview of this system, service, or component.
- What it does and its role in the larger architecture
- Key interfaces or integration points
- Configuration or setup considerations
- Known limitations or technical debt discussed
- How it relates to other systems mentioned`,

    'requirement': `CATEGORY GUIDANCE — REQUIREMENT BREAKDOWN:
Write a detailed requirement specification.
- Clear statement of what is needed
- Acceptance criteria if discussed
- Technical constraints or dependencies
- Scope boundaries — what's in and what's out
- Priority and timeline if mentioned`,

    'guide': `CATEGORY GUIDANCE — HOW-TO GUIDE:
Write a practical implementation guide.
- Prerequisites and setup
- Step-by-step instructions
- Code snippets or configuration examples if relevant
- Common pitfalls or gotchas mentioned
- Testing or verification steps`,

    'context': `CATEGORY GUIDANCE — BACKGROUND CONTEXT:
Write a context document for team knowledge sharing.
- Historical context — how we got here
- Current state of affairs
- Key stakeholders and their perspectives
- Relevant constraints or dependencies
- Why this context matters for current work`,

    'action-plan': `CATEGORY GUIDANCE — ACTION PLAN:
Write a detailed action plan expanding on the discussed items.
- Break down complex action items into sub-tasks
- Identify dependencies between tasks
- Suggest implementation order
- Highlight risks or blockers for each step
- Include rough estimates if discussed`,
  };

  return guides[category] || `CATEGORY GUIDANCE: Write a clear, well-structured explanatory document about this topic.`;
}

/**
 * Convert a title to a URL-safe slug.
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

module.exports = {
  discoverTopics,
  generateDocument,
  generateAllDocuments,
  writeDeepDiveOutput,
};
