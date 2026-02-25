/**
 * Dynamic Mode — AI-powered document generation from context documents + user request.
 *
 * This mode does NOT require video. The user provides:
 *  - A folder with context documents (specs, notes, code maps, etc.)
 *  - A request/goal describing what they want generated
 *
 * The pipeline then:
 *  1. Discovers and loads all documents
 *  2. Sends docs + request to Gemini for topic planning
 *  3. Generates a set of Markdown documents — one per topic
 *
 * Use cases:
 *  - "Plan migration from PostgreSQL to MongoDB" → migration guide, risk analysis, timeline
 *  - "Explain this codebase for onboarding" → architecture docs, component guides
 *  - "Create learning materials for React hooks" → concept explanations, examples, exercises
 *  - "Break down this requirement into tasks" → task breakdown, dependencies, estimates
 *  - "Analyze these meeting notes" → summaries, action items, decision records
 *
 * Fully backward-compatible — the existing video pipeline is untouched.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { GEMINI_MODEL } = require('../config');
const { extractJson } = require('../utils/json-parser');
const { withRetry } = require('../utils/retry');

// ======================== TOPIC PLANNING ========================

/**
 * Ask Gemini to plan a set of documents based on context docs and user request.
 *
 * @param {object} ai - GoogleGenAI instance
 * @param {string} userRequest - What the user wants generated
 * @param {string[]} docSnippets - Content from context documents
 * @param {object} options
 * @param {string} [options.folderName] - Name of the source folder
 * @param {string} [options.userName] - User's name
 * @param {number} [options.thinkingBudget] - Thinking tokens
 * @returns {Promise<{topics: Array, raw: string, durationMs: number, tokenUsage: object}>}
 */
async function planTopics(ai, userRequest, docSnippets, options = {}) {
  const { folderName = 'project', userName = '', thinkingBudget = 16384 } = options;

  const docsSection = docSnippets.length > 0
    ? `\n\nCONTEXT DOCUMENTS PROVIDED:\n${docSnippets.join('\n\n---\n\n')}`
    : '\n\n(No context documents provided — generate based on the request alone)';

  const prompt = `You are an expert knowledge architect and technical writer. A user has a request and optionally provided context documents. Your job is to plan a set of Markdown documents that fully address their request.

USER REQUEST:
"${userRequest}"

SOURCE FOLDER: "${folderName}"
${userName ? `USER: "${userName}"` : ''}
${docsSection}

YOUR TASK:
Plan 3-15 standalone Markdown documents that together comprehensively address the user's request. Each document should focus on ONE aspect/topic.

DOCUMENT CATEGORIES (use these exact names):
- "overview" — High-level summaries, executive briefs, introductions
- "guide" — How-to guides, step-by-step instructions, tutorials
- "analysis" — Analysis documents, comparisons, evaluations, assessments
- "plan" — Plans, roadmaps, timelines, strategies, proposals
- "reference" — Reference material, specifications, API docs, schemas
- "concept" — Concept explanations, definitions, theory, background
- "decision" — Decision records, options analysis, trade-off evaluations
- "checklist" — Checklists, verification lists, audit documents
- "template" — Templates, scaffolds, reusable patterns
- "report" — Status reports, summaries, findings

RULES:
1. Plan 3-15 documents. More for complex requests, fewer for simple ones.
2. Each document should be substantial (200-1000+ words depending on complexity).
3. Documents should be self-contained but reference each other where relevant.
4. First document should always be an overview/index of the entire set.
5. Order by logical reading sequence — overview first, then foundational, then detailed.
6. Each topic should have clear value — don't pad with trivial docs.
7. Use the context documents to ground your planning in reality.
8. If the request is about learning/teaching, include progressive complexity.
9. If the request is about planning/migration, include risk analysis and timelines.
10. Be creative but practical — generate what would actually help someone.

RESPOND WITH ONLY VALID JSON — no markdown fences, no extra text:

{
  "topics": [
    {
      "id": "DM-01",
      "title": "Clear document title",
      "category": "overview|guide|analysis|plan|reference|concept|decision|checklist|template|report",
      "description": "2-3 sentence description of what this document covers",
      "target_audience": "Who this document is for",
      "estimated_length": "short|medium|long",
      "depends_on": []
    }
  ],
  "project_summary": "One-line summary of the document set's purpose"
}`;

  const requestPayload = {
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: 'You are a knowledge architect. Plan a comprehensive set of documents based on the user\'s request and provided context. Respond with valid JSON only.',
      maxOutputTokens: 16384,
      temperature: 0.3,
      thinkingConfig: { thinkingBudget },
    },
  };

  const t0 = Date.now();
  const response = await withRetry(
    () => ai.models.generateContent(requestPayload),
    { label: 'Dynamic mode topic planning', maxRetries: 2, baseDelay: 3000 }
  );
  const durationMs = Date.now() - t0;
  const rawText = response.text;

  const parsed = extractJson(rawText);
  const topics = parsed?.topics || [];
  const projectSummary = parsed?.project_summary || '';

  const usage = response.usageMetadata || {};
  const tokenUsage = {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    thoughtTokens: usage.thoughtsTokenCount || 0,
  };

  return { topics, projectSummary, raw: rawText, durationMs, tokenUsage };
}

// ======================== DOCUMENT GENERATION ========================

/**
 * Generate a single document for a planned topic.
 *
 * @param {object} ai - GoogleGenAI instance
 * @param {object} topic - Topic from planTopics
 * @param {string} userRequest - Original user request
 * @param {string[]} docSnippets - Context document content
 * @param {object} options
 * @returns {Promise<{markdown: string, raw: string, durationMs: number, tokenUsage: object}>}
 */
async function generateDynamicDocument(ai, topic, userRequest, docSnippets, options = {}) {
  const { folderName = 'project', userName = '', thinkingBudget = 16384, allTopics = [] } = options;

  // Build the list of related documents for cross-references
  const otherDocs = allTopics
    .filter(t => t.id !== topic.id)
    .map(t => `- ${t.id}: ${t.title} (${t.category})`)
    .join('\n');

  const contextSection = docSnippets.length > 0
    ? `\nCONTEXT DOCUMENTS:\n${docSnippets.slice(0, 5).join('\n---\n')}`
    : '';

  const categoryGuidance = getDynamicCategoryGuidance(topic.category);

  // Adaptive max tokens based on estimated length
  const maxOutputTokens = topic.estimated_length === 'long' ? 16384
    : topic.estimated_length === 'medium' ? 8192
    : 4096;

  const prompt = `You are an expert technical writer creating a document as part of a comprehensive document set.

USER'S ORIGINAL REQUEST:
"${userRequest}"

DOCUMENT TO WRITE:
- ID: ${topic.id}
- Title: "${topic.title}"
- Category: ${topic.category}
- Description: ${topic.description}
- Target Audience: ${topic.target_audience || 'General'}

OTHER DOCUMENTS IN THE SET (for cross-references):
${otherDocs || '(This is the only document)'}
${contextSection}

${categoryGuidance}

WRITING RULES:
1. Write in clear, professional Markdown.
2. Use headers (##, ###), bullet points, tables, code blocks, and diagrams where helpful.
3. Target ${topic.estimated_length === 'long' ? '800-1500' : topic.estimated_length === 'medium' ? '400-800' : '200-400'} words.
4. Write for the specified target audience — adjust technical depth accordingly.
5. Reference other documents in the set using their titles where relevant (e.g., "See [Document Title]").
6. Ground content in the provided context documents when available.
7. Be practical and actionable — include concrete examples, steps, or recommendations.
8. DO NOT include YAML frontmatter or metadata blocks.
9. Start with a level-1 heading (# Title) followed by a brief introduction.
10. Include a "Summary" or "Key Takeaways" section at the end for longer docs.

START YOUR RESPONSE DIRECTLY WITH THE MARKDOWN CONTENT (no fences, no preamble):`;

  const requestPayload = {
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: 'You are a technical writer creating comprehensive documentation. Write clear, well-structured Markdown that directly addresses the request. Start directly with the content.',
      maxOutputTokens,
      temperature: 0.4,
      thinkingConfig: { thinkingBudget },
    },
  };

  const t0 = Date.now();
  const response = await withRetry(
    () => ai.models.generateContent(requestPayload),
    { label: `Dynamic doc: ${topic.title}`, maxRetries: 2, baseDelay: 3000 }
  );
  const durationMs = Date.now() - t0;
  const rawText = response.text;

  // Clean up markdown fences if model wrapped output
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
 * Generate all planned documents in parallel batches.
 */
async function generateAllDynamicDocuments(ai, topics, userRequest, docSnippets, options = {}) {
  const { concurrency = 2, onProgress, ...docOptions } = options;

  const results = [];
  const queue = [...topics];
  let completed = 0;

  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(topic =>
        generateDynamicDocument(ai, topic, userRequest, docSnippets, { ...docOptions, allTopics: topics })
          .then(result => {
            completed++;
            if (onProgress) onProgress(completed, topics.length, topic);
            return { topic, ...result };
          })
      )
    );

    for (let i = 0; i < batchResults.length; i++) {
      const r = batchResults[i];
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        completed++;
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
 * Write all dynamic documents to disk with an index.
 *
 * @param {string} outputDir - Directory to write to
 * @param {Array} documents - Results from generateAllDynamicDocuments
 * @param {object} meta - Metadata
 * @returns {{ indexPath: string, docPaths: string[], stats: object }}
 */
function writeDynamicOutput(outputDir, documents, meta = {}) {
  fs.mkdirSync(outputDir, { recursive: true });

  const docPaths = [];
  const successful = documents.filter(d => d.markdown);
  const failed = documents.filter(d => !d.markdown);

  // Write individual documents
  for (const doc of successful) {
    const slug = slugify(doc.topic.title);
    const fileName = `${doc.topic.id.toLowerCase()}-${slug}.md`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, doc.markdown, 'utf8');
    docPaths.push(filePath);
    doc._fileName = fileName;
  }

  // Build index
  const indexLines = [
    `# ${meta.projectSummary || meta.userRequest || 'Generated Documents'}`,
    '',
    `> Generated from: **${meta.folderName || 'project'}**`,
    `> Request: *"${meta.userRequest || ''}"*`,
    `> Date: ${meta.timestamp || new Date().toISOString()}`,
    `> Documents: ${successful.length}`,
    '',
    '---',
    '',
    '## Document Index',
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
    'overview': 'Overview',
    'guide': 'Guides & How-To',
    'analysis': 'Analysis & Evaluation',
    'plan': 'Plans & Strategy',
    'reference': 'Reference Material',
    'concept': 'Concepts & Theory',
    'decision': 'Decisions & Trade-offs',
    'checklist': 'Checklists & Verification',
    'template': 'Templates & Patterns',
    'report': 'Reports & Findings',
  };

  for (const [cat, docs] of Object.entries(categories)) {
    indexLines.push(`### ${categoryLabels[cat] || cat}`);
    indexLines.push('');
    for (const doc of docs) {
      const audience = doc.topic.target_audience ? ` *(${doc.topic.target_audience})*` : '';
      indexLines.push(`- **[${doc.topic.title}](${doc._fileName})**${audience}`);
      indexLines.push(`  ${doc.topic.description}`);
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

  const indexPath = path.join(outputDir, 'INDEX.md');
  fs.writeFileSync(indexPath, indexLines.join('\n'), 'utf8');
  docPaths.unshift(indexPath);

  // Write metadata JSON
  const metaPath = path.join(outputDir, 'dynamic-run.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    timestamp: meta.timestamp,
    folderName: meta.folderName,
    userRequest: meta.userRequest,
    projectSummary: meta.projectSummary,
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
 * Get category-specific writing guidance for dynamic mode.
 */
function getDynamicCategoryGuidance(category) {
  const guides = {
    'overview': `CATEGORY GUIDANCE — OVERVIEW:
Write a high-level overview that serves as an introduction and navigation aid.
- Summarize the entire scope of the document set
- Explain the "why" — why this document set exists
- Provide a reading order recommendation
- Keep it concise but comprehensive`,

    'guide': `CATEGORY GUIDANCE — GUIDE:
Write a practical, hands-on guide with clear steps.
- Use numbered steps for sequential processes
- Include prerequisites at the top
- Add code examples, commands, or configuration snippets
- Include "common pitfalls" or "troubleshooting" sections
- Make steps testable/verifiable`,

    'analysis': `CATEGORY GUIDANCE — ANALYSIS:
Write an analytical document with evidence-based reasoning.
- Use comparison tables for alternatives
- Include pros/cons or SWOT where relevant
- Support claims with data from context docs
- Include risk assessments where appropriate
- End with clear conclusions or recommendations`,

    'plan': `CATEGORY GUIDANCE — PLAN:
Write an actionable plan with clear milestones.
- Include timeline or phases
- Define owners/responsibilities where possible
- List dependencies between steps
- Include risk mitigation strategies
- Add success criteria or KPIs`,

    'reference': `CATEGORY GUIDANCE — REFERENCE:
Write clear, well-structured reference material.
- Use tables extensively for structured data
- Include examples for each concept
- Organize alphabetically or by logical grouping
- Make it scannable with clear headings
- Include cross-references to related docs`,

    'concept': `CATEGORY GUIDANCE — CONCEPT EXPLANATION:
Write a clear educational explanation.
- Start with "what it is" for newcomers
- Explain "why it matters" in context
- Use analogies to make complex ideas accessible
- Include diagrams (as described text) if helpful
- Progress from simple to advanced`,

    'decision': `CATEGORY GUIDANCE — DECISION RECORD:
Write an Architecture/Engineering Decision Record.
- "Context" — what situation requires a decision
- "Options" — what alternatives exist (with pros/cons)
- "Decision" — what was chosen and why
- "Consequences" — what this means going forward
- "Review Date" — when to reassess (if applicable)`,

    'checklist': `CATEGORY GUIDANCE — CHECKLIST:
Write an actionable checklist with clear verification criteria.
- Use checkbox syntax (- [ ]) for items
- Group items by phase or category
- Include "done when" criteria for each item
- Add notes for non-obvious items
- Keep items concise and actionable`,

    'template': `CATEGORY GUIDANCE — TEMPLATE:
Create a reusable template with clear structure.
- Include placeholder text showing expected content
- Add instructions/comments explaining each section
- Make it copy-paste ready
- Include examples of filled-out sections
- Keep it flexible but structured`,

    'report': `CATEGORY GUIDANCE — REPORT:
Write a clear findings/status report.
- Start with executive summary
- Use data and metrics where available
- Include visualizations as text tables
- Separate observations from recommendations
- End with clear next steps`,
  };

  return guides[category] || 'Write a clear, well-structured, professional document.';
}

/**
 * Convert title to URL-safe slug.
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

module.exports = {
  planTopics,
  generateDynamicDocument,
  generateAllDynamicDocuments,
  writeDynamicOutput,
};
