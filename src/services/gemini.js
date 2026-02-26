/**
 * Gemini AI service — init, document preparation, segment analysis,
 * and final compilation of all segment outputs into one unified result.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GEMINI_CONTEXT_WINDOW,
  GEMINI_FILE_API_EXTS,
  INLINE_TEXT_EXTS,
  GEMINI_UNSUPPORTED,
  MIME_MAP,
  GEMINI_POLL_TIMEOUT_MS,
} = require('../config');
const { extractJson } = require('../utils/json-parser');
const {
  selectDocsByBudget,
  sliceVttForSegment,
  buildProgressiveContext,
  buildSegmentFocus,
  estimateTokens,
} = require('../utils/context-manager');
const { formatHMS } = require('../utils/format');
const { withRetry } = require('../utils/retry');

// ======================== INIT ========================

async function initGemini() {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  return ai;
}

// ======================== DOCUMENT PREPARATION ========================

/**
 * Prepare documents for Gemini context — inline text files, upload PDFs via File API, skip unsupported.
 * Accepts array of { absPath, relPath } from findDocsRecursive.
 */
async function prepareDocsForGemini(ai, docFileList) {
  if (docFileList.length === 0) return [];

  console.log(`  Found ${docFileList.length} document(s) to include as context:`);
  docFileList.forEach(f => console.log(`    - ${f.relPath}`));
  console.log('');

  const prepared = [];
  for (const { absPath: docPath, relPath } of docFileList) {
    const ext = path.extname(docPath).toLowerCase();
    const name = relPath;

    try {
      if (INLINE_TEXT_EXTS.includes(ext)) {
        console.log(`    Reading ${name} (inline text)...`);
        const content = fs.readFileSync(docPath, 'utf8');
        prepared.push({ type: 'inlineText', fileName: name, content });
        console.log(`    ✓ ${name} ready (${(content.length / 1024).toFixed(1)} KB)`);
      } else if (GEMINI_FILE_API_EXTS.includes(ext)) {
        const mime = MIME_MAP[ext] || 'application/octet-stream';
        console.log(`    Uploading ${name} to Gemini File API...`);
        let file = await withRetry(
          () => ai.files.upload({
            file: docPath,
            config: { mimeType: mime, displayName: name },
          }),
          { label: `Gemini doc upload (${name})`, maxRetries: 3 }
        );

        // Poll with timeout
        const pollStart = Date.now();
        while (file.state === 'PROCESSING') {
          if (Date.now() - pollStart > GEMINI_POLL_TIMEOUT_MS) {
            console.warn(`    ⚠ ${name} — polling timed out after ${(GEMINI_POLL_TIMEOUT_MS / 1000).toFixed(0)}s, skipping`);
            file = null;
            break;
          }
          await new Promise(r => setTimeout(r, 3000));
          file = await withRetry(
            () => ai.files.get({ name: file.name }),
            { label: `Gemini doc status (${name})`, maxRetries: 2, baseDelay: 1000 }
          );
        }

        if (!file || file.state === 'FAILED') {
          console.warn(`    ⚠ ${name} — Gemini processing failed, skipping`);
          continue;
        }

        prepared.push({
          type: 'fileData',
          fileName: name,
          mimeType: file.mimeType,
          fileUri: file.uri,
        });
        console.log(`    ✓ ${name} ready (File API)`);
      } else if (GEMINI_UNSUPPORTED.includes(ext)) {
        console.warn(`    ⚠ ${name} — format not supported by Gemini, will upload to Firebase only`);
      } else {
        console.warn(`    ⚠ ${name} — unknown doc type, skipping`);
      }
    } catch (err) {
      console.warn(`    ⚠ ${name} — failed: ${err.message}`);
    }
  }

  const inlineCount = prepared.filter(d => d.type === 'inlineText').length;
  const fileCount = prepared.filter(d => d.type === 'fileData').length;
  console.log(`  ${prepared.length} document(s) prepared (${inlineCount} inline, ${fileCount} File API)`);
  console.log('');
  return prepared;
}

// ======================== PROMPT LOADING ========================

/** Load prompt from prompt.json — builds a system message + structured extraction prompt */
function loadPrompt(scriptDir) {
  const promptPath = path.join(scriptDir, 'prompt.json');
  if (!fs.existsSync(promptPath)) {
    throw new Error(`prompt.json not found at "${promptPath}". Ensure it exists alongside the entry script.`);
  }
  const promptConfig = JSON.parse(fs.readFileSync(promptPath, 'utf8'));

  const instructions = promptConfig.instructions
    ? promptConfig.instructions.map(i => `- ${i}`).join('\n')
    : '';

  const outputExample = JSON.stringify(promptConfig.output_structure, null, 2);

  const text = [
    promptConfig.system,
    '',
    `Task: ${promptConfig.task}`,
    '',
    'Instructions:',
    instructions,
    '',
    'You MUST respond with ONLY valid JSON (no markdown fences, no extra text).',
    'Use this exact output structure:',
    outputExample,
  ].join('\n');

  return { systemInstruction: promptConfig.system, promptText: text };
}

// ======================== CONTEXT BUILDING HELPERS ========================

/** Build the bridge text that explains document tiers to Gemini */
function buildDocBridgeText(contextDocs) {
  if (contextDocs.length === 0) return null;

  const taskDocs = contextDocs.filter(d => d.fileName.includes('.tasks/'));
  const robotDocs = contextDocs.filter(d => d.fileName.includes('.robot/'));
  const archDocs = contextDocs.filter(d => d.fileName.includes('.docs/'));
  const otherDocs = contextDocs.filter(d =>
    !d.fileName.includes('.tasks/') &&
    !d.fileName.includes('.robot/') &&
    !d.fileName.includes('.docs/')
  );

  let bridgeText = `The above includes ${contextDocs.length} supporting document(s) organized in 3 tiers:\n`;

  // Tier 1 — Task execution documents
  if (taskDocs.length > 0) {
    bridgeText += `\n=== TIER 1: TASK EXECUTION DOCUMENTS (${taskDocs.length}) — SOURCE OF TRUTH FOR TICKET STATE ===`;
    bridgeText += `\nThese contain execution plans, implementation checklists with ✅/⬜/⏸️/🔲 status markers, code maps with exact file paths, sub-ticket breakdowns, business requirements, and PR templates.`;
    bridgeText += `\nFiles: ${taskDocs.map(d => d.fileName).join(', ')}`;

    // Pre-extract ticket state from execution plans
    const execPlanDocs = taskDocs.filter(d => d.type === 'inlineText' && (
      d.fileName.includes('execution-plan') ||
      d.fileName.includes('checklist') ||
      d.fileName.includes('REMAINING-WORK')
    ));
    if (execPlanDocs.length > 0) {
      bridgeText += `\n\nPRE-EXTRACTED TICKET STATE (from execution plans & checklists):`;
      for (const doc of execPlanDocs) {
        const statusMatch = doc.content.match(/\*\*Status\*\*:\s*(.+)/);
        const crMatch = doc.content.match(/\*\*CR\*\*:\s*#?(\d+)/);
        const ticketId = crMatch ? `CR${crMatch[1]}` : doc.fileName;
        const status = statusMatch ? statusMatch[1].trim() : 'unknown';

        const doneCount = (doc.content.match(/- \[x\]/gi) || []).length;
        const todoCount = (doc.content.match(/- \[ \]/g) || []).length;
        const deferredCount = (doc.content.match(/⏸️/g) || []).length;
        const blockedCount = (doc.content.match(/🔲/g) || []).length;

        const openQs = (doc.content.match(/\|\s*Q\d+\s*\|[^|]*\|[^|]*\|\s*(⬜|✅|⏸️)[^|]*\|/g) || []);
        const dbItems = (doc.content.match(/- \[[ x]\] \*\*DB-\d+\*\*.*/g) || []);

        bridgeText += `\n  ${ticketId} (${doc.fileName}):`;
        bridgeText += `\n    Plan status: ${status}`;
        bridgeText += `\n    Checklist: ${doneCount} done, ${todoCount} todo, ${deferredCount} deferred, ${blockedCount} blocked`;
        if (openQs.length > 0) bridgeText += `\n    Open questions: ${openQs.length} tracked`;
        if (dbItems.length > 0) bridgeText += `\n    DB prerequisites: ${dbItems.length} items`;
      }
    }

    bridgeText += `\n\nCRITICAL: Cross-reference these task documents with the video discussion. When the call mentions a file, class, procedure, module, CR number, or ticket — match it to the corresponding task document. Use exact file paths and component names from the code-map.md and execution-plan.md in your output. The task documents contain the ground truth for what was planned — the call reveals what was actually discussed, confirmed, or changed. Flag any discrepancies between documented state and discussed state.`;
  }

  // Tier 2 — Robot/AI knowledge base
  if (robotDocs.length > 0) {
    bridgeText += `\n\n=== TIER 2: CODEBASE KNOWLEDGE BASE (${robotDocs.length}) — FILE MAPS & PATTERNS ===`;
    bridgeText += `\nThese contain complete file maps for every app/service, backend API maps, database schemas, auth configs, coding patterns, and naming conventions.`;
    bridgeText += `\nUse these to RESOLVE exact file paths when the call mentions a class, component, service, or controller by name.`;
    bridgeText += `\nFiles: ${robotDocs.map(d => d.fileName).join(', ')}`;
  }

  // Tier 3 — Project documentation
  if (archDocs.length > 0) {
    bridgeText += `\n\n=== TIER 3: PROJECT DOCUMENTATION (${archDocs.length}) — ARCHITECTURE & REFERENCE ===`;
    bridgeText += `\nThese provide background on the solution architecture, tech stack, patterns, best practices, payment systems, evaluation system, i18n, and more.`;
    bridgeText += `\nUse for context when the call discusses system concepts, design decisions, or technical constraints.`;
    bridgeText += `\nFiles: ${archDocs.map(d => d.fileName).join(', ')}`;
  }

  // Other docs
  if (otherDocs.length > 0) {
    bridgeText += `\n\n=== CALL DOCUMENTS (${otherDocs.length}) — SUBTITLES, TRANSCRIPTS, NOTES ===`;
    bridgeText += `\nFiles: ${otherDocs.map(d => d.fileName).join(', ')}`;
  }

  return bridgeText;
}

// ======================== SEGMENT ANALYSIS ========================

/**
 * Process a single video segment with Gemini.
 * Returns a complete model run record (run, input, output).
 */
async function processWithGemini(ai, filePath, displayName, contextDocs = [], previousAnalyses = [], userName = '', scriptDir = __dirname, segmentOpts = {}) {
  // segmentOpts: { segmentIndex, totalSegments, segmentStartSec, segmentEndSec, thinkingBudget, boundaryContext, retryHints }
  const { segmentIndex = 0, totalSegments = 1, segmentStartSec, segmentEndSec, thinkingBudget = 24576,
          boundaryContext = null, retryHints = [] } = segmentOpts;

  // 1. Load structured prompt
  const { systemInstruction, promptText } = loadPrompt(scriptDir);

  // 2. Upload video to Gemini File API (with retry)
  console.log(`    Uploading to Gemini File API...`);
  let file = await withRetry(
    () => ai.files.upload({
      file: filePath,
      config: { mimeType: 'video/mp4', displayName },
    }),
    { label: `Gemini file upload (${displayName})`, maxRetries: 3 }
  );

  // 3. Wait for processing (with polling + retry on get + timeout)
  let waited = 0;
  const pollStart = Date.now();
  while (file.state === 'PROCESSING') {
    if (Date.now() - pollStart > GEMINI_POLL_TIMEOUT_MS) {
      throw new Error(`Gemini file processing timed out after ${(GEMINI_POLL_TIMEOUT_MS / 1000).toFixed(0)}s for ${displayName}. Try again or increase GEMINI_POLL_TIMEOUT_MS.`);
    }
    process.stdout.write(`    Processing${'.'.repeat((waited % 3) + 1)}   \r`);
    await new Promise(r => setTimeout(r, 5000));
    waited++;
    file = await withRetry(
      () => ai.files.get({ name: file.name }),
      { label: 'Gemini file status check', maxRetries: 2, baseDelay: 1000 }
    );
  }
  console.log('    Processing complete.        ');

  if (file.state === 'FAILED') {
    throw new Error(`Gemini file processing failed for ${displayName}`);
  }

  // 4. Build content parts with SMART CONTEXT MANAGEMENT
  console.log(`    Analyzing with ${GEMINI_MODEL} [segment ${segmentIndex + 1}/${totalSegments}]...`);

  const contentParts = [
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
  ];

  // --- Smart document selection by priority ---
  // Reserve tokens for: video (~250K), previous analyses, prompt, thinking
  const prevContextEstimate = estimateTokens(
    buildProgressiveContext(previousAnalyses, userName) || ''
  );
  const docBudget = Math.max(100000, GEMINI_CONTEXT_WINDOW - 350000 - prevContextEstimate);
  console.log(`    Context budget: ${(docBudget / 1000).toFixed(0)}K tokens for docs (${contextDocs.length} available)`);

  const { selected: selectedDocs, excluded, stats } = selectDocsByBudget(
    contextDocs, docBudget, { segmentIndex }
  );
  if (excluded.length > 0) {
    console.log(`    Context: ${stats.selectedDocs} docs included, ${stats.excludedDocs} lower-priority docs excluded`);
  }

  // Attach selected context documents with VTT time-slicing
  for (const doc of selectedDocs) {
    if (doc.type === 'inlineText') {
      let content = doc.content;
      // Slice VTT to segment time range if available
      const isVtt = doc.fileName.toLowerCase().endsWith('.vtt') || doc.fileName.toLowerCase().endsWith('.srt');
      if (isVtt && segmentStartSec != null && segmentEndSec != null) {
        content = sliceVttForSegment(content, segmentStartSec, segmentEndSec);
        console.log(`    VTT sliced to ${formatHMS(segmentStartSec)}–${formatHMS(segmentEndSec)} range`);
      }
      contentParts.push({ text: `=== Document: ${doc.fileName} ===\n${content}` });
    } else if (doc.type === 'fileData') {
      contentParts.push({ fileData: { mimeType: doc.mimeType, fileUri: doc.fileUri } });
    }
  }

  // Document tier bridge text (using selected docs, not all)
  const bridgeText = buildDocBridgeText(selectedDocs);
  if (bridgeText) contentParts.push({ text: bridgeText });

  // --- Progressive previous-segment context (compressed for older segments) ---
  const prevText = buildProgressiveContext(previousAnalyses, userName);
  if (prevText) contentParts.push({ text: prevText });

  // --- Segment focus instructions ---
  const focusText = buildSegmentFocus(segmentIndex, totalSegments, previousAnalyses, userName);
  contentParts.push({ text: focusText });

  // --- Smart boundary overlap context ---
  if (boundaryContext) {
    contentParts.push({ text: boundaryContext });
    console.log(`    Boundary context injected (mid-conversation detected)`);
  }

  // --- Retry hints (if this is a quality-gate retry) ---
  if (retryHints.length > 0) {
    const retryText = 'RETRY INSTRUCTIONS — Your previous attempt had quality issues. Address ALL of the following:\n' +
      retryHints.map((h, i) => `${i + 1}. ${h}`).join('\n');
    contentParts.push({ text: retryText });
    console.log(`    Retry hints injected (${retryHints.length} correction(s))`);
  }

  // User identity injection
  if (userName) {
    contentParts.push({
      text: `CURRENT USER: "${userName}". This is the person running this analysis. When extracting tasks, action items, change requests, and scope changes — clearly identify which ones are assigned to or owned by "${userName}" vs. others. In the output, populate the "your_tasks" section with a focused summary of everything ${userName} needs to do, decisions they are waiting on, and items they own. If the call mentions ${userName} (even by partial name, first name, or nickname), attribute those tasks to them.`
    });
  }

  contentParts.push({ text: promptText });

  // 5. Send request (configurable thinking budget for complex multi-ticket analysis)
  const requestPayload = {
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: contentParts }],
    config: {
      systemInstruction,
      maxOutputTokens: 65536,
      temperature: 0,
      thinkingConfig: { thinkingBudget },
    },
  };

  const t0 = Date.now();
  const response = await withRetry(
    () => ai.models.generateContent(requestPayload),
    { label: `Gemini segment analysis (${displayName})`, maxRetries: 2, baseDelay: 5000 }
  );
  const durationMs = Date.now() - t0;

  const rawText = response.text;

  // 6. Extract token usage
  const usage = response.usageMetadata || {};
  const tokenUsage = {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    thoughtTokens: usage.thoughtsTokenCount || 0,
  };
  const contextRemaining = GEMINI_CONTEXT_WINDOW - tokenUsage.inputTokens;
  const contextUsedPct = ((tokenUsage.inputTokens / GEMINI_CONTEXT_WINDOW) * 100).toFixed(1);
  tokenUsage.contextWindow = GEMINI_CONTEXT_WINDOW;
  tokenUsage.contextRemaining = contextRemaining;
  tokenUsage.contextUsedPct = parseFloat(contextUsedPct);

  console.log(`    Tokens — input: ${tokenUsage.inputTokens.toLocaleString()} | output: ${tokenUsage.outputTokens.toLocaleString()} | thinking: ${tokenUsage.thoughtTokens.toLocaleString()} | total: ${tokenUsage.totalTokens.toLocaleString()}`);
  console.log(`    Context — used: ${contextUsedPct}% | remaining: ${contextRemaining.toLocaleString()} / ${GEMINI_CONTEXT_WINDOW.toLocaleString()} tokens`);

  // 7. Parse JSON response
  const parsed = extractJson(rawText);

  // Build serialisable input summary
  const inputSummary = contentParts.map(part => {
    if (part.fileData) return { type: 'fileData', mimeType: part.fileData.mimeType, fileUri: part.fileData.fileUri };
    if (part.text) return { type: 'text', chars: part.text.length, preview: part.text.substring(0, 300) };
    return part;
  });

  return {
    run: {
      model: GEMINI_MODEL,
      displayName,
      userName,
      timestamp: new Date().toISOString(),
      durationMs,
      tokenUsage,
      systemInstruction,
    },
    input: {
      videoFile: { mimeType: file.mimeType, fileUri: file.uri, displayName },
      contextDocuments: contextDocs.map(d => ({ fileName: d.fileName, type: d.type })),
      previousSegmentCount: previousAnalyses.length,
      parts: inputSummary,
      promptText,
    },
    output: {
      raw: rawText,
      parsed,
      parseSuccess: parsed !== null,
    },
  };
}

// ======================== FINAL COMPILATION ========================

/**
 * Compile all segment analyses into a single unified result using Gemini.
 *
 * Instead of naive merging / flatMap across segments, this sends all segment
 * outputs to Gemini to produce one deduplicated, reconciled, coherent final
 * analysis — the "compiled" result.
 *
 * @param {object} ai - Gemini AI instance
 * @param {Array} allSegmentAnalyses - Array of parsed analysis objects from each segment
 * @param {string} userName - Current user's name
 * @param {string} callName - Name of the call
 * @param {string} scriptDir - Directory where prompt.json lives
 * @param {string} scriptDir - Directory where prompt.json lives
 * @param {object} [opts] - Options { thinkingBudget }
 * @returns {{ compiled: object, run: object }} - The compiled analysis + run metadata
 */
async function compileFinalResult(ai, allSegmentAnalyses, userName, callName, scriptDir, opts = {}) {
  const { thinkingBudget: compilationThinking = 10240 } = opts;
  const { systemInstruction } = loadPrompt(scriptDir);

  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  FINAL COMPILATION — AI merging all segments');
  console.log('══════════════════════════════════════════════');
  console.log('');

  // Build a detailed dump of all segment analyses
  const segmentDumps = allSegmentAnalyses.map((analysis, idx) => {
    // Strip internal metadata and bloated fields before sending to AI
    const clean = { ...analysis };
    delete clean._geminiMeta;
    delete clean.seg;
    // Remove full transcript/comments arrays — they bloat the compilation input
    // and cause the output to exceed token limits with malformed JSON
    if (clean.tickets) {
      clean.tickets = clean.tickets.map(t => {
        const tc = { ...t };
        // Keep max 5 key comments per ticket for context, drop the rest
        if (tc.comments && tc.comments.length > 5) {
          tc.comments = tc.comments.slice(0, 5);
          tc.comments.push({ note: `...${t.comments.length - 5} more comments omitted for brevity` });
        }
        return tc;
      });
    }
    // Remove any top-level conversation_transcript if the segment produced one
    delete clean.conversation_transcript;
    return `=== SEGMENT ${idx + 1} OF ${allSegmentAnalyses.length} ===\n${JSON.stringify(clean, null, 2)}`;
  }).join('\n\n');

  const compilationPrompt = `You are compiling the FINAL unified analysis from a multi-segment video call.

CONTEXT:
- Call name: "${callName}"
- Current user: "${userName}"
- Total segments analyzed: ${allSegmentAnalyses.length}

Below are the individual segment analyses. Each segment was analyzed independently but with cross-segment context. Your job is to produce ONE final, compiled, deduplicated result.

REQUIRED OUTPUT STRUCTURE:
Your JSON output MUST include ALL of these top-level fields (use empty arrays [] only when genuinely no items exist):
  "tickets": [...],           // All unique tickets discussed (deduplicated by ticket_id)
  "change_requests": [...],   // All unique CRs (deduplicated by id)
  "action_items": [...],      // All unique action items (deduplicated, re-numbered AI-1, AI-2, ...)
  "blockers": [...],          // All unique blockers (deduplicated, re-numbered BLK-1, ...)
  "scope_changes": [...],     // All unique scope changes (deduplicated, re-numbered SC-1, ...)
  "file_references": [...],   // All unique file references (deduplicated by resolved_path)
  "your_tasks": { ... },      // Unified task summary for "${userName}"
  "summary": "..."            // ONE coherent executive summary for the entire call (3-5 sentences)

OUTPUT FORMAT RULES:
- Respond with ONLY valid JSON. No markdown fences, no extra text before or after.
- Double-check your JSON syntax: no trailing commas, no doubled braces }}, no doubled commas ,,.
- Keep descriptions complete but compact — do not pad or elaborate beyond what the segments contain.
- DO NOT include "conversation_transcript" field.
- Keep only the 3-5 most decisive comments per ticket. Do not bulk-copy all comments from segments.

COMPILATION RULES:
1. STRICT DEDUP: Every ticket, CR, action item, blocker, scope change, and file reference MUST appear EXACTLY ONCE. Match by ID first, then by description similarity. NEVER repeat the same item.
2. NAME NORMALIZATION: Merge variant names for the same person:
   - Case differences ("Youssef Adel" / "youssef adel") → use proper case
   - Role suffixes ("Mohamed Elhadi" / "Mohamed Elhadi (Service Desk)") → use the base name only, drop role qualifiers
   - Nicknames or partial names referring to the same person → normalize to full proper name
   Ensure your_tasks.user_name uses the properly-cased version of "${userName}".
3. RECONCILE CONFLICTS: If two segments give different status for the same item, use the LATEST/most-specific state.
4. MERGE SUMMARIES: Write ONE coherent executive summary for the entire call (3-5 sentences max). Not per-segment.
5. UNIFIED your_tasks: Produce ONE your_tasks section for "${userName}" — deduplicated, final states only.
6. SEQUENTIAL IDs: Re-number action items (AI-1, AI-2, ...), scope changes (SC-1, SC-2, ...), blockers (BLK-1, ...) sequentially. Keep real CR/ticket numbers (e.g. CR31296872) unchanged.
7. FILE REFERENCES: Merge and deduplicate — keep the most specific resolved_path. Each file appears ONCE.
8. PRESERVE ALL DATA: Include every unique ticket, action item, blocker, etc. from the segments. Do NOT omit items for brevity. The goal is completeness with deduplication, not summarization.
9. PRESERVE source_segment: Every item in the input has a "source_segment" field (1-based integer) indicating which video segment it originated from. You MUST preserve this field on EVERY output item (action_items, change_requests, blockers, scope_changes, file_references, and inside tickets: comments, code_changes, video_segments). For your_tasks sub-arrays (tasks_todo, tasks_waiting_on_others, decisions_needed), also preserve source_segment. If an item appears in multiple segments, keep the source_segment of the FIRST (earliest) occurrence.

You MUST respond with ONLY valid JSON (no markdown fences, no extra text).
Use the same output structure as the individual segment analyses.

SEGMENT ANALYSES:
${segmentDumps}`;

  const contentParts = [{ text: compilationPrompt }];

  const requestPayload = {
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: contentParts }],
    config: {
      systemInstruction: `${systemInstruction}\n\nYou are now in COMPILATION MODE — your job is to merge multiple segment analyses into one final unified output. Deduplicate, reconcile conflicts, and produce the definitive analysis. Output valid JSON only — no markdown fences.`,
      maxOutputTokens: 65536,
      temperature: 0,
      // Thinking tokens share the maxOutputTokens pool in Gemini 2.5 Flash.
      // Default 10240 leaves ~55K for output — enough for full structured merge.
      // Too low (4096) → model hits ceiling and produces minimal output.
      // Too high (16384) → eats into output budget causing truncation.
      thinkingConfig: { thinkingBudget: compilationThinking },
    },
  };

  const t0 = Date.now();
  console.log(`  Compiling with ${GEMINI_MODEL}...`);
  const response = await withRetry(
    () => ai.models.generateContent(requestPayload),
    { label: 'Gemini final compilation', maxRetries: 2, baseDelay: 5000 }
  );
  const durationMs = Date.now() - t0;
  const rawText = response.text;

  // Token usage
  const usage = response.usageMetadata || {};
  const tokenUsage = {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    thoughtTokens: usage.thoughtsTokenCount || 0,
  };
  const contextUsedPct = ((tokenUsage.inputTokens / GEMINI_CONTEXT_WINDOW) * 100).toFixed(1);
  tokenUsage.contextWindow = GEMINI_CONTEXT_WINDOW;
  tokenUsage.contextRemaining = GEMINI_CONTEXT_WINDOW - tokenUsage.inputTokens;
  tokenUsage.contextUsedPct = parseFloat(contextUsedPct);

  console.log(`  Tokens — input: ${tokenUsage.inputTokens.toLocaleString()} | output: ${tokenUsage.outputTokens.toLocaleString()} | thinking: ${tokenUsage.thoughtTokens.toLocaleString()} | total: ${tokenUsage.totalTokens.toLocaleString()}`);
  console.log(`  Context — used: ${contextUsedPct}% | remaining: ${tokenUsage.contextRemaining.toLocaleString()} / ${GEMINI_CONTEXT_WINDOW.toLocaleString()} tokens`);
  console.log(`  Compilation duration: ${(durationMs / 1000).toFixed(1)}s`);

  // Parse compiled result
  const compiled = extractJson(rawText);

  if (!compiled) {
    console.warn('  ⚠ Failed to parse compiled result — falling back to raw segment merge');
  } else {
    console.log('  ✓ Final compilation complete');
  }

  return {
    compiled,
    raw: rawText,
    run: {
      model: GEMINI_MODEL,
      type: 'compilation',
      timestamp: new Date().toISOString(),
      durationMs,
      tokenUsage,
      segmentCount: allSegmentAnalyses.length,
      parseSuccess: compiled !== null,
    },
  };
}

// ======================== DYNAMIC MODE — VIDEO CONTEXT EXTRACTION ========================

/**
 * Analyze a video segment for dynamic mode — produces a comprehensive text summary
 * instead of structured JSON. Used as context for dynamic document generation.
 *
 * @param {object} ai - GoogleGenAI instance
 * @param {string} filePath - Path to video segment on disk
 * @param {string} displayName - Display name (e.g. "segment_00.mp4")
 * @param {object} [opts] - { thinkingBudget, segmentIndex, totalSegments }
 * @returns {Promise<{summary: string, durationMs: number, tokenUsage: object}>}
 */
async function analyzeVideoForContext(ai, filePath, displayName, opts = {}) {
  const { thinkingBudget = 8192, segmentIndex = 0, totalSegments = 1 } = opts;

  // 1. Upload video to Gemini File API
  console.log(`    Uploading ${displayName} to Gemini File API...`);
  let file = await withRetry(
    () => ai.files.upload({
      file: filePath,
      config: { mimeType: 'video/mp4', displayName },
    }),
    { label: `Gemini video upload (${displayName})`, maxRetries: 3 }
  );

  // 2. Poll until processing complete
  let waited = 0;
  const pollStart = Date.now();
  while (file.state === 'PROCESSING') {
    if (Date.now() - pollStart > GEMINI_POLL_TIMEOUT_MS) {
      throw new Error(`Gemini file processing timed out after ${(GEMINI_POLL_TIMEOUT_MS / 1000).toFixed(0)}s for ${displayName}`);
    }
    process.stdout.write(`    Processing${'.'.repeat((waited % 3) + 1)}   \r`);
    await new Promise(r => setTimeout(r, 5000));
    waited++;
    file = await withRetry(
      () => ai.files.get({ name: file.name }),
      { label: 'Gemini file status check', maxRetries: 2, baseDelay: 1000 }
    );
  }
  console.log('    Processing complete.        ');

  if (file.state === 'FAILED') {
    throw new Error(`Gemini file processing failed for ${displayName}`);
  }

  // 3. Build prompt for comprehensive summary
  const segmentLabel = totalSegments > 1
    ? `This is segment ${segmentIndex + 1} of ${totalSegments} from a longer video.`
    : 'This is the complete video.';

  const prompt = `You are an expert analyst. Watch this video carefully and produce a COMPREHENSIVE summary.

${segmentLabel}

Your summary must capture ALL of the following (where applicable):
1. **Transcript / Dialog**: Who said what — capture all speakers and their statements as accurately as possible. Use speaker names if visible/mentioned, otherwise "Speaker 1", "Speaker 2", etc.
2. **Topics Discussed**: Every topic, subject, or theme covered — with detail, not just labels.
3. **Decisions Made**: Any decisions, agreements, or conclusions reached.
4. **Action Items**: Any tasks assigned, commitments made, or next steps discussed.
5. **Technical Details**: Code, architecture, configurations, APIs, tools, or technologies mentioned.
6. **Problems / Blockers**: Issues raised, bugs discussed, challenges identified.
7. **Key Information**: Numbers, dates, names, URLs, file paths, or any specific data mentioned.
8. **Visual Content**: Screen shares, presentations, diagrams, code on screen — describe what is shown.
9. **Context & Background**: Any background information or context provided in the discussion.

FORMAT:
- Write in clear, detailed prose with section headers.
- Include direct quotes for important statements.
- Be thorough — capture everything, even seemingly minor details.
- This summary will be used as context for generating documents, so completeness is critical.
- Do NOT use JSON. Write natural language with Markdown formatting.`;

  const contentParts = [
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    { text: prompt },
  ];

  // 4. Send to Gemini
  console.log(`    Analyzing with ${GEMINI_MODEL} [segment ${segmentIndex + 1}/${totalSegments}]...`);
  const requestPayload = {
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: contentParts }],
    config: {
      systemInstruction: 'You are a meticulous video analyst. Produce comprehensive, detailed summaries that capture everything in the video. Write in clear Markdown prose.',
      maxOutputTokens: 32768,
      temperature: 0.1,
      thinkingConfig: { thinkingBudget },
    },
  };

  const t0 = Date.now();
  const response = await withRetry(
    () => ai.models.generateContent(requestPayload),
    { label: `Dynamic video analysis (${displayName})`, maxRetries: 2, baseDelay: 5000 }
  );
  const durationMs = Date.now() - t0;

  const summary = (response.text || '').trim();

  const usage = response.usageMetadata || {};
  const tokenUsage = {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    thoughtTokens: usage.thoughtsTokenCount || 0,
  };

  console.log(`    Tokens — input: ${tokenUsage.inputTokens.toLocaleString()} | output: ${tokenUsage.outputTokens.toLocaleString()} | thinking: ${tokenUsage.thoughtTokens.toLocaleString()}`);
  console.log(`    ✓ Summary: ${summary.length.toLocaleString()} chars in ${(durationMs / 1000).toFixed(1)}s`);

  return { summary, durationMs, tokenUsage };
}

module.exports = {
  initGemini,
  prepareDocsForGemini,
  loadPrompt,
  processWithGemini,
  compileFinalResult,
  buildDocBridgeText,
  analyzeVideoForContext,
};
