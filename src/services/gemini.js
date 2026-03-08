/**
 * Gemini AI service — init, document preparation, segment analysis,
 * and final compilation of all segment outputs into one unified result.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const {
  GEMINI_API_KEY,
  GEMINI_FILE_API_EXTS,
  INLINE_TEXT_EXTS,
  DOC_PARSER_EXTS,
  IMAGE_EXTS,
  GEMINI_UNSUPPORTED,
  MIME_MAP,
  GEMINI_POLL_TIMEOUT_MS,
} = config;
// Access config.GEMINI_MODEL and config.GEMINI_CONTEXT_WINDOW at call time
// (not destructured) so runtime model changes via setActiveModel() are visible.
const { extractJson } = require('../utils/json-parser');

// Max image size for inline data (20 MB — Gemini API limit)
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
const { parseDocument, canParse } = require('./doc-parser');
const {
  selectDocsByBudget,
  sliceVttForSegment,
  buildProgressiveContext,
  buildSegmentFocus,
  buildBatchSegmentFocus,
  estimateTokens,
  estimateDocTokens,
} = require('../utils/context-manager');
const { formatHMS } = require('../utils/format');
const { withRetry, parallelMap } = require('../utils/retry');
const { c } = require('../utils/colors');
const { isShuttingDown } = require('../phases/_shared');

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

  console.log(`  Preparing ${docFileList.length} context document(s)...`);

  const prepared = [];
  let totalBytes = 0;
  let inlineRead = 0;
  let parsed = 0;
  let fileApiUploaded = 0;
  const warnings = [];

  for (const { absPath: docPath, relPath } of docFileList) {
    const ext = path.extname(docPath).toLowerCase();
    const name = relPath;

    try {
      if (INLINE_TEXT_EXTS.includes(ext)) {
        const content = (await fs.promises.readFile(docPath, 'utf8')).replace(/^\uFEFF/, '');
        prepared.push({ type: 'inlineText', fileName: name, content });
        totalBytes += content.length;
        inlineRead++;
      } else if (DOC_PARSER_EXTS.includes(ext)) {
        const result = await parseDocument(docPath, { silent: true });
        if (result.success && result.text) {
          prepared.push({ type: 'inlineText', fileName: name, content: result.text });
          totalBytes += result.text.length;
          parsed++;
        } else {
          const reason = result.warnings.length > 0 ? result.warnings[0] : 'empty output';
          warnings.push(`${name}: parse failed (${reason})`);
        }
      } else if (GEMINI_FILE_API_EXTS.includes(ext)) {
        const mime = MIME_MAP[ext] || 'application/octet-stream';

        // Also extract text for deep-summary support (PDF text extraction)
        let extractedText = null;
        if (canParse(ext)) {
          try {
            const parseResult = await parseDocument(docPath, { silent: true });
            if (parseResult.success && parseResult.text) {
              extractedText = parseResult.text;
            }
          } catch { /* text extraction is best-effort */ }
        }

        console.log(`    ${c.dim('Uploading')} ${name} ${c.dim('to File API...')}`);
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
            warnings.push(`${name}: still processing after ${(GEMINI_POLL_TIMEOUT_MS / 1000).toFixed(0)}s, skipped`);
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
          warnings.push(`${name}: Gemini processing failed, skipped`);
          continue;
        }

        const fileDoc = {
          type: 'fileData',
          fileName: name,
          mimeType: file.mimeType,
          fileUri: file.uri,
          geminiFileName: file.name,
        };
        if (extractedText) {
          fileDoc.content = extractedText;
          totalBytes += extractedText.length;
        }
        prepared.push(fileDoc);
        fileApiUploaded++;
      } else if (IMAGE_EXTS.includes(ext)) {
        // Images → read as base64 and send as inlineData for Gemini Vision
        const mime = MIME_MAP[ext] || 'application/octet-stream';
        const stat = await fs.promises.stat(docPath);
        if (stat.size > MAX_IMAGE_SIZE_BYTES) {
          warnings.push(`${name}: image too large (${(stat.size / (1024 * 1024)).toFixed(1)} MB > 20 MB limit), skipped`);
          continue;
        }
        const buffer = await fs.promises.readFile(docPath);
        const base64Data = buffer.toString('base64');
        prepared.push({ type: 'inlineData', fileName: name, mimeType: mime, data: base64Data });
        totalBytes += stat.size;
        inlineRead++;
      } else if (GEMINI_UNSUPPORTED.includes(ext)) {
        warnings.push(`${name}: unsupported format, Firebase only`);
      } else {
        warnings.push(`${name}: unknown type, skipped`);
      }
    } catch (err) {
      warnings.push(`${name}: ${err.message}`);
    }
  }

  // --- Compact summary ---
  const sizeMB = (totalBytes / (1024 * 1024)).toFixed(1);
  const sizeKB = (totalBytes / 1024).toFixed(0);
  const sizeStr = totalBytes >= 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;
  const parts = [];
  if (inlineRead > 0) parts.push(`${inlineRead} inline`);
  if (parsed > 0) parts.push(`${parsed} parsed`);
  if (fileApiUploaded > 0) parts.push(`${fileApiUploaded} File API`);
  console.log(`  ${c.success(`${prepared.length} doc(s) ready`)} ${c.dim(`(${parts.join(', ')}) — ${sizeStr}`)}`);

  for (const w of warnings) {
    console.warn(`    ${c.warn(w)}`);
  }

  return prepared;
}

// ======================== IMAGE BATCH ANALYSIS ========================

/**
 * Analyze a batch of images with Gemini Vision and return text descriptions.
 * Used for folders with many images that can't all fit in one context window.
 *
 * @param {object} ai - Gemini AI instance
 * @param {Array} imageDocs - Array of { type: 'inlineData', fileName, mimeType, data }
 * @param {object} [opts] - Options
 * @param {string} [opts.userRequest] - User's request for context-aware analysis
 * @param {number} [opts.thinkingBudget=8192] - Thinking tokens per batch
 * @param {number} [opts.batchSize=15] - Images per batch (Gemini handles ~20 well)
 * @param {Function} [opts.onBatchDone] - Callback (batchIdx, totalBatches, description)
 * @returns {Promise<Array<{batchIndex: number, images: string[], description: string, tokenUsage: object}>>}
 */
async function analyzeImageBatches(ai, imageDocs, opts = {}) {
  const {
    userRequest = 'Describe the content of these images in detail',
    thinkingBudget = 8192,
    batchSize = 15,
    onBatchDone = null,
  } = opts;

  if (imageDocs.length === 0) return [];

  // Split into batches
  const batches = [];
  for (let i = 0; i < imageDocs.length; i += batchSize) {
    batches.push(imageDocs.slice(i, i + batchSize));
  }

  console.log(`  Analyzing ${imageDocs.length} image(s) in ${batches.length} batch(es) (${batchSize}/batch)...`);

  const results = [];
  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    if (isShuttingDown()) break;

    const batch = batches[bIdx];
    const batchLabel = `batch ${bIdx + 1}/${batches.length}`;
    console.log(`    ${c.dim(`[${batchLabel}]`)} Analyzing ${batch.length} image(s)...`);

    const contentParts = [];
    contentParts.push({
      text: `You are analyzing a batch of ${batch.length} images (batch ${bIdx + 1} of ${batches.length}, images ${bIdx * batchSize + 1}-${bIdx * batchSize + batch.length} of ${imageDocs.length} total).

USER REQUEST CONTEXT: "${userRequest}"

For EACH image, provide:
1. A clear description of what the image shows
2. Any visible text (OCR — transcribe ALL visible text exactly as shown)
3. Key visual elements (people, UI elements, screenshots, diagrams, etc.)
4. Contextual relevance to the user's request

Format your response as a structured analysis with clear separation between images.
Use the image filenames as headers. Be thorough — extract ALL visible text content.`,
    });

    // Add each image with its filename
    for (const img of batch) {
      contentParts.push({ text: `\n--- Image: ${img.fileName} ---` });
      contentParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }

    const requestPayload = {
      model: config.GEMINI_MODEL,
      contents: [{ role: 'user', parts: contentParts }],
      config: {
        systemInstruction: 'You are an expert image analyst. Analyze each image thoroughly, extracting ALL visible text, describing visual content, and identifying contextual meaning. Be comprehensive and precise.',
        maxOutputTokens: 32768,
        temperature: 0,
        thinkingConfig: { thinkingBudget },
      },
    };

    const t0 = Date.now();
    try {
      const response = await withRetry(
        () => ai.models.generateContent(requestPayload),
        { label: `Image batch analysis (${batchLabel})`, maxRetries: 2, baseDelay: 5000 }
      );
      const durationMs = Date.now() - t0;
      let rawText;
      try { rawText = response.text; } catch { rawText = ''; }

      const usage = response.usageMetadata || {};
      const tokenUsage = {
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0,
        totalTokens: usage.totalTokenCount || 0,
        thoughtTokens: usage.thoughtsTokenCount || 0,
      };

      const result = {
        batchIndex: bIdx,
        images: batch.map(img => img.fileName),
        description: rawText,
        durationMs,
        tokenUsage,
      };
      results.push(result);

      console.log(`    ${c.success(`[${batchLabel}]`)} ${c.dim(`${(durationMs / 1000).toFixed(1)}s · ${tokenUsage.totalTokens.toLocaleString()} tokens`)}`);
      if (onBatchDone) onBatchDone(bIdx, batches.length, rawText);
    } catch (err) {
      console.warn(`    ${c.warn(`[${batchLabel}] Failed: ${err.message}`)}`);
      results.push({
        batchIndex: bIdx,
        images: batch.map(img => img.fileName),
        description: `[Analysis failed for batch ${bIdx + 1}: ${err.message}]`,
        durationMs: Date.now() - t0,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, thoughtTokens: 0 },
      });
    }
  }

  return results;
}

// ======================== PROMPT LOADING ========================

/** Load prompt from prompt.json — builds a system message + structured extraction prompt */
function loadPrompt(scriptDir) {
  const promptPath = path.join(scriptDir, 'prompt.json');
  if (!fs.existsSync(promptPath)) {
    throw new Error(`prompt.json not found at "${promptPath}". Ensure it exists alongside the entry script.`);
  }
  let promptConfig;
  try {
    promptConfig = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse prompt.json at "${promptPath}": ${err.message}`);
  }

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

    bridgeText += `\n\nCRITICAL: Cross-reference these task documents with the content being analyzed. When the content mentions a file, class, procedure, module, CR number, or ticket — match it to the corresponding task document. Use exact file paths and component names from the code-map.md and execution-plan.md in your output. The task documents contain the ground truth for what was planned — the content reveals what was actually discussed, confirmed, or changed. Flag any discrepancies between documented state and observed state.`;
  }

  // Tier 2 — Robot/AI knowledge base
  if (robotDocs.length > 0) {
    bridgeText += `\n\n=== TIER 2: CODEBASE KNOWLEDGE BASE (${robotDocs.length}) — FILE MAPS & PATTERNS ===`;
    bridgeText += `\nThese contain complete file maps for every app/service, backend API maps, database schemas, auth configs, coding patterns, and naming conventions.`;
    bridgeText += `\nUse these to RESOLVE exact file paths when the content mentions a class, component, service, or controller by name.`;
    bridgeText += `\nFiles: ${robotDocs.map(d => d.fileName).join(', ')}`;
  }

  // Tier 3 — Project documentation
  if (archDocs.length > 0) {
    bridgeText += `\n\n=== TIER 3: PROJECT DOCUMENTATION (${archDocs.length}) — ARCHITECTURE & REFERENCE ===`;
    bridgeText += `\nThese provide background on the solution architecture, tech stack, patterns, best practices, payment systems, evaluation system, i18n, and more.`;
    bridgeText += `\nUse for context when the content discusses system concepts, design decisions, or technical constraints.`;
    bridgeText += `\nFiles: ${archDocs.map(d => d.fileName).join(', ')}`;
  }

  // Other docs
  if (otherDocs.length > 0) {
    bridgeText += `\n\n=== SUPPORTING DOCUMENTS (${otherDocs.length}) — SUBTITLES, TRANSCRIPTS, NOTES, OTHER ===`;
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
  // segmentOpts: { segmentIndex, totalSegments, segmentStartSec, segmentEndSec, thinkingBudget, boundaryContext, retryHints, existingFileUri, existingFileMime, existingGeminiFileName, storageDownloadUrl }
  const { segmentIndex = 0, totalSegments = 1, segmentStartSec, segmentEndSec, thinkingBudget = 24576,
          boundaryContext = null, retryHints = [],
          existingFileUri = null, existingFileMime = 'video/mp4', existingGeminiFileName = null,
          storageDownloadUrl = null } = segmentOpts;

  // 1. Load structured prompt
  const { systemInstruction, promptText } = loadPrompt(scriptDir);

  // 2. Resolve video file reference (3 strategies, in priority order):
  //    a) Reuse existing Gemini File API URI (retry / focused pass)
  //    b) Use Firebase Storage download URL as External URL (skip Gemini upload)
  //    c) Upload to Gemini File API as fallback
  let file;
  let usedExternalUrl = false;

  // Helper: upload via Gemini File API with polling (Strategy C)
  async function uploadViaFileApi() {
    console.log(`    Uploading to Gemini File API...`);
    let uploaded = await withRetry(
      () => ai.files.upload({
        file: filePath,
        config: { mimeType: 'video/mp4', displayName },
      }),
      { label: `Gemini file upload (${displayName})`, maxRetries: 3 }
    );

    let waited = 0;
    const pollStart = Date.now();
    while (uploaded.state === 'PROCESSING') {
      if (isShuttingDown()) throw new Error('Upload polling aborted: process shutting down');
      if (Date.now() - pollStart > GEMINI_POLL_TIMEOUT_MS) {
        throw new Error(`File "${displayName}" is still processing after ${(GEMINI_POLL_TIMEOUT_MS / 1000).toFixed(0)}s. Try again or increase the wait time by setting GEMINI_POLL_TIMEOUT_MS in your .env file.`);
      }
      process.stdout.write(`    Processing${'.'.repeat((waited % 3) + 1)}   \r`);
      await new Promise(r => setTimeout(r, 5000));
      waited++;
      uploaded = await withRetry(
        () => ai.files.get({ name: uploaded.name }),
        { label: 'Gemini file status check', maxRetries: 2, baseDelay: 1000 }
      );
    }
    console.log('    Processing complete.        ');

    if (uploaded.state === 'FAILED') {
      throw new Error(`Gemini file processing failed for ${displayName}. The file may be corrupt or in an unsupported format — try re-compressing or converting to MP4.`);
    }
    return uploaded;
  }

  const EXTERNAL_URL_MAX_BYTES = 20 * 1024 * 1024; // 20 MB — Gemini rejects HTTPS URLs for larger files

  if (existingFileUri) {
    // Strategy A: Reuse Gemini File API URI from a previous pass
    file = { uri: existingFileUri, mimeType: existingFileMime, name: existingGeminiFileName, state: 'ACTIVE' };
    console.log(`    Reusing Gemini File API URI (skip upload)`);
  } else if (storageDownloadUrl) {
    // Strategy B: Use Firebase Storage download URL as Gemini External URL
    // Supported for models >= 2.5; Gemini rejects external HTTPS URLs for files > ~20 MB.
    const fileSizeBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (fileSizeBytes > EXTERNAL_URL_MAX_BYTES) {
      console.log(`    Segment too large for external URL (${(fileSizeBytes / 1048576).toFixed(1)} MB > 20 MB) — using File API upload`);
      // file stays null → falls through to Strategy C below
    } else {
      file = { uri: storageDownloadUrl, mimeType: 'video/mp4', name: null, state: 'ACTIVE' };
      usedExternalUrl = true;
      console.log(`    Using Firebase Storage URL as external reference (skip Gemini upload)`);
    }
  }

  if (!file) {
    // Strategy C: Upload to Gemini File API (default fallback, or after B was skipped for large files)
    file = await uploadViaFileApi();
  }

  // 4. Build content parts with SMART CONTEXT MANAGEMENT
  console.log(`    Analyzing with ${config.GEMINI_MODEL} [segment ${segmentIndex + 1}/${totalSegments}]...`);

  const contentParts = [
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
  ];

  // --- Smart document selection by priority ---
  // Reserve tokens for: video (~250K), previous analyses, prompt, thinking
  const prevContextEstimate = estimateTokens(
    buildProgressiveContext(previousAnalyses, userName) || ''
  );
  const docBudget = Math.max(100000, config.GEMINI_CONTEXT_WINDOW - 350000 - prevContextEstimate);
  console.log(`    Reference docs budget: ${(docBudget / 1000).toFixed(0)}K (${contextDocs.length} doc${contextDocs.length !== 1 ? 's' : ''} available)`);

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
    } else if (doc.type === 'inlineData') {
      contentParts.push({ text: `=== Image: ${doc.fileName} ===` });
      contentParts.push({ inlineData: { mimeType: doc.mimeType, data: doc.data } });
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

  // 5. Send request with thinking budget
  const requestPayload = {
    model: config.GEMINI_MODEL,
    contents: [{ role: 'user', parts: contentParts }],
    config: {
      systemInstruction,
      maxOutputTokens: 65536,
      temperature: 0,
      thinkingConfig: { thinkingBudget },
    },
  };

  const t0 = Date.now();
  let response;
  try {
    response = await withRetry(
      () => ai.models.generateContent(requestPayload),
      { label: `Gemini segment analysis (${displayName})`, maxRetries: 2, baseDelay: 5000 }
    );
  } catch (apiErr) {
    const errMsg = apiErr.message || '';

    // Automatic fallback: if external URL was rejected, retry via Gemini File API upload
    if (usedExternalUrl && errMsg.includes('INVALID_ARGUMENT')) {
      console.log(`    ${c.warn('External URL rejected by Gemini — falling back to File API upload...')}`);
      try {
        file = await uploadViaFileApi();
        usedExternalUrl = false;
        // Replace the video reference in contentParts[0]
        contentParts[0] = { fileData: { mimeType: file.mimeType, fileUri: file.uri } };
        requestPayload.contents[0].parts = contentParts;
        response = await withRetry(
          () => ai.models.generateContent(requestPayload),
          { label: `Gemini segment analysis — File API retry (${displayName})`, maxRetries: 2, baseDelay: 5000 }
        );
        console.log(`    ${c.success('File API fallback succeeded')}`);
      } catch (fallbackErr) {
        console.error(`    ${c.error(`File API fallback also failed: ${fallbackErr.message}`)}`);
        throw fallbackErr;
      }
    } else if (!usedExternalUrl && errMsg.includes('INVALID_ARGUMENT')) {
      // File API upload was used but still got INVALID_ARGUMENT — re-upload fresh and retry once
      console.log(`    ${c.warn('INVALID_ARGUMENT with File API — re-uploading and retrying...')}`);
      try {
        file = await uploadViaFileApi();
        contentParts[0] = { fileData: { mimeType: file.mimeType, fileUri: file.uri } };
        requestPayload.contents[0].parts = contentParts;
        response = await withRetry(
          () => ai.models.generateContent(requestPayload),
          { label: `Gemini segment analysis — re-upload retry (${displayName})`, maxRetries: 1, baseDelay: 5000 }
        );
        console.log(`    ${c.success('Re-upload retry succeeded')}`);
      } catch (reuploadErr) {
        console.error(`    ${c.error(`Re-upload retry also failed: ${reuploadErr.message}`)}`);
        throw reuploadErr;
      }
    } else {
      // Handle RESOURCE_EXHAUSTED specifically — shed lower-priority docs and retry
      if (errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('429') || errMsg.includes('quota')) {
        console.warn(`    ${c.warn('Context window or quota exceeded — shedding docs and retrying after 30s...')}`);
        await new Promise(r => setTimeout(r, 30000));
        // Rebuild with half the doc budget
        const reducedBudget = Math.floor(docBudget * 0.5);
        const { selected: reducedDocs } = selectDocsByBudget(contextDocs, reducedBudget, { segmentIndex });
        const reducedParts = [contentParts[0]]; // keep video
        for (const doc of reducedDocs) {
          if (doc.type === 'inlineText') {
            let content = doc.content;
            const isVtt = doc.fileName.toLowerCase().endsWith('.vtt') || doc.fileName.toLowerCase().endsWith('.srt');
            if (isVtt && segmentStartSec != null && segmentEndSec != null) {
              content = sliceVttForSegment(content, segmentStartSec, segmentEndSec);
            }
            reducedParts.push({ text: `=== Document: ${doc.fileName} ===\n${content}` });
          } else if (doc.type === 'fileData') {
            reducedParts.push({ fileData: { mimeType: doc.mimeType, fileUri: doc.fileUri } });
          } else if (doc.type === 'inlineData') {
            reducedParts.push({ text: `=== Image: ${doc.fileName} ===` });
            reducedParts.push({ inlineData: { mimeType: doc.mimeType, data: doc.data } });
          }
        }
        // Re-add prompt/context parts (last 3-5 parts are prompt, focus, etc.)
        const nonDocParts = contentParts.slice(1 + selectedDocs.length);
        reducedParts.push(...nonDocParts);
        requestPayload.contents[0].parts = reducedParts;
        console.log(`    Reduced to ${reducedDocs.length} docs (budget: ${(reducedBudget / 1000).toFixed(0)}K tokens)`);
        try {
          response = await withRetry(
            () => ai.models.generateContent(requestPayload),
            { label: `Gemini segment analysis — reduced docs (${displayName})`, maxRetries: 1, baseDelay: 5000 }
          );
          console.log(`    ${c.success('Reduced-context retry succeeded')}`);
        } catch (reduceErr) {
          console.error(`    ${c.error(`Reduced-context retry also failed: ${reduceErr.message}`)}`);
          throw reduceErr;
        }
      } else {
        // Log request diagnostics for other errors to aid debugging
        const partSummary = contentParts.map((p, i) => {
          if (p.fileData) return `  [${i}] fileData: ${p.fileData.mimeType} → ${(p.fileData.fileUri || '').substring(0, 120)}`;
          if (p.text) return `  [${i}] text: ${p.text.length} chars → ${p.text.substring(0, 80).replace(/\n/g, ' ')}...`;
          return `  [${i}] unknown part`;
        });
        console.error(`    ${c.error('Request diagnostics:')}`);
        console.error(`    Model: ${config.GEMINI_MODEL} | Parts: ${contentParts.length} | maxOutput: 65536`);
        partSummary.forEach(s => console.error(`    ${s}`));
        throw apiErr;
      }
    }
  }
  const durationMs = Date.now() - t0;

  let rawText = response.text;

  // 6. Extract token usage
  const usage = response.usageMetadata || {};
  const tokenUsage = {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    thoughtTokens: usage.thoughtsTokenCount || 0,
  };
  const contextRemaining = config.GEMINI_CONTEXT_WINDOW - tokenUsage.inputTokens;
  const contextUsedPct = ((tokenUsage.inputTokens / config.GEMINI_CONTEXT_WINDOW) * 100).toFixed(1);
  tokenUsage.contextWindow = config.GEMINI_CONTEXT_WINDOW;
  tokenUsage.contextRemaining = contextRemaining;
  tokenUsage.contextUsedPct = parseFloat(contextUsedPct);

  console.log(`    Tokens — input: ${tokenUsage.inputTokens.toLocaleString()} | output: ${tokenUsage.outputTokens.toLocaleString()} | thinking: ${tokenUsage.thoughtTokens.toLocaleString()} | total: ${tokenUsage.totalTokens.toLocaleString()}`);
  console.log(`    Context — used: ${contextUsedPct}% | remaining: ${contextRemaining.toLocaleString()} / ${config.GEMINI_CONTEXT_WINDOW.toLocaleString()} tokens`);

  // Detect output truncation
  const MAX_OUTPUT_SINGLE = 65536;
  const outputTruncated = tokenUsage.outputTokens >= Math.floor(MAX_OUTPUT_SINGLE * 0.98);
  if (outputTruncated) {
    console.warn(`    ⚠ Output likely truncated — ${tokenUsage.outputTokens.toLocaleString()} tokens used (max: ${MAX_OUTPUT_SINGLE.toLocaleString()}). JSON may be incomplete.`);
  }

  // Detect thinking budget drain — model used all tokens for thinking, 0 for output
  if (tokenUsage.outputTokens === 0 && tokenUsage.thoughtTokens > 0) {
    console.warn(`    ⚠ Thinking budget drain — ${tokenUsage.thoughtTokens.toLocaleString()} thinking tokens consumed entire output budget (0 output tokens)`);
    console.log(`    ↻ Retrying with reduced thinking budget to force output...`);
    const reducedThinking = Math.min(Math.floor(thinkingBudget * 0.25), 4096);
    requestPayload.config.thinkingConfig = { thinkingBudget: reducedThinking };
    try {
      const retryResponse = await withRetry(
        () => ai.models.generateContent(requestPayload),
        { label: `Gemini segment analysis — reduced thinking (${displayName})`, maxRetries: 1, baseDelay: 5000 }
      );
      const retryUsage = retryResponse.usageMetadata || {};
      const retryOutput = retryUsage.candidatesTokenCount || 0;
      console.log(`    ✓ Reduced-thinking retry: ${retryOutput.toLocaleString()} output tokens (thinking: ${(retryUsage.thoughtsTokenCount || 0).toLocaleString()})`);
      if (retryOutput > 0) {
        // Use retry result
        response = retryResponse;
        rawText = retryResponse.text;
        tokenUsage.outputTokens = retryOutput;
        tokenUsage.thoughtTokens = retryUsage.thoughtsTokenCount || 0;
        tokenUsage.totalTokens = retryUsage.totalTokenCount || 0;
        tokenUsage.inputTokens = retryUsage.promptTokenCount || tokenUsage.inputTokens;
      }
    } catch (retryErr) {
      console.warn(`    ⚠ Reduced-thinking retry failed: ${retryErr.message}`);
    }
  }

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
      model: config.GEMINI_MODEL,
      displayName,
      userName,
      timestamp: new Date().toISOString(),
      durationMs,
      tokenUsage,
      systemInstruction,
    },
    input: {
      videoFile: { mimeType: file.mimeType, fileUri: file.uri, displayName, geminiFileName: file.name, usedExternalUrl },
      contextDocuments: contextDocs.map(d => ({ fileName: d.fileName, type: d.type })),
      previousSegmentCount: previousAnalyses.length,
      parts: inputSummary,
      promptText,
    },
    output: {
      raw: rawText,
      parsed,
      parseSuccess: parsed !== null,
      outputTruncated,
    },
  };
}

// ======================== MULTI-SEGMENT BATCH ANALYSIS ========================

/**
 * Process multiple consecutive video segments in a single Gemini call.
 * This takes advantage of unused context-window headroom (especially after
 * deep summary) to reduce the number of API calls and give the model a
 * more holistic view of the meeting.
 *
 * @param {object}  ai           – Gemini AI instance
 * @param {Array<{ segPath: string, segName: string, durSec: number, storageUrl?: string }>} batchSegments
 * @param {string}  displayName  – label for logging (e.g. "call1_video_batch0-2")
 * @param {Array}   contextDocs  – prepared context docs
 * @param {Array}   previousAnalyses – analyses from earlier batches
 * @param {string}  userName
 * @param {string}  scriptDir    – where prompt.json lives
 * @param {object}  batchOpts
 * @param {number[]} batchOpts.segmentIndices      – 0-based global indices of the segments
 * @param {number}   batchOpts.totalSegments       – total segment count for the whole file
 * @param {Array<{startTimeSec: number, endTimeSec: number}>} batchOpts.segmentTimes
 * @param {number}  [batchOpts.thinkingBudget=24576]
 * @param {boolean} [batchOpts.noStorageUrl=false]
 * @returns {Promise<object>} Run record (same shape as processWithGemini)
 */
async function processSegmentBatch(ai, batchSegments, displayName, contextDocs, previousAnalyses, userName, scriptDir, batchOpts = {}) {
  const {
    segmentIndices = batchSegments.map((_, i) => i),
    totalSegments = batchSegments.length,
    segmentTimes = [],
    thinkingBudget = 24576,
    noStorageUrl = false,
  } = batchOpts;

  const { systemInstruction, promptText } = loadPrompt(scriptDir);

  const EXTERNAL_URL_MAX_BYTES = 20 * 1024 * 1024;

  // ── Upload / reference all video files ─────────────────────────────────────

  // Helper: upload a single segment to Gemini File API and poll until ready
  const uploadAndPoll = async (seg) => {
    console.log(`    ${seg.segName}: uploading to Gemini File API...`);
    let uploaded = await withRetry(
      () => ai.files.upload({
        file: seg.segPath,
        config: { mimeType: 'video/mp4', displayName: `${displayName}_${seg.segName}` },
      }),
      { label: `Gemini upload (${seg.segName})`, maxRetries: 3 }
    );

    let waited = 0;
    const pollStart = Date.now();
    while (uploaded.state === 'PROCESSING') {
      if (isShuttingDown()) throw new Error('Upload polling aborted: process shutting down');
      if (Date.now() - pollStart > GEMINI_POLL_TIMEOUT_MS) {
        throw new Error(`File "${seg.segName}" still processing after ${(GEMINI_POLL_TIMEOUT_MS / 1000).toFixed(0)}s`);
      }
      process.stdout.write(`    Processing ${seg.segName}${'.'.repeat((waited % 3) + 1)}   \r`);
      await new Promise(r => setTimeout(r, 5000));
      waited++;
      uploaded = await withRetry(
        () => ai.files.get({ name: uploaded.name }),
        { label: 'Gemini file status', maxRetries: 2, baseDelay: 1000 }
      );
    }
    if (uploaded.state === 'FAILED') {
      throw new Error(`Gemini processing failed for ${seg.segName}`);
    }
    console.log(`    ${seg.segName}: upload complete`);
    return { uri: uploaded.uri, mimeType: uploaded.mimeType || 'video/mp4', name: uploaded.name, usedExternalUrl: false };
  };

  // Separate segments: those using Storage URLs (instant) vs File API uploads (parallel)
  const segRefs = new Array(batchSegments.length); // preserve order
  const uploadQueue = [];

  for (let i = 0; i < batchSegments.length; i++) {
    const seg = batchSegments[i];
    const fileSizeBytes = fs.existsSync(seg.segPath) ? fs.statSync(seg.segPath).size : 0;

    if (!noStorageUrl && seg.storageUrl && fileSizeBytes <= EXTERNAL_URL_MAX_BYTES) {
      segRefs[i] = { uri: seg.storageUrl, mimeType: 'video/mp4', name: null, usedExternalUrl: true };
      console.log(`    ${seg.segName}: using Storage URL`);
    } else {
      uploadQueue.push({ index: i, seg });
    }
  }

  // Upload pending segments in parallel (concurrency 3)
  if (uploadQueue.length > 0) {
    console.log(`    Uploading ${uploadQueue.length} segment(s) via File API (parallel)...`);
    await parallelMap(uploadQueue, async ({ index, seg }) => {
      segRefs[index] = await uploadAndPoll(seg);
    }, 3);
  }

  const fileRefs = segRefs;

  // ── Build content parts ────────────────────────────────────────────────────
  const contentParts = [];

  // Video files — one fileData part per segment, in order
  for (let i = 0; i < fileRefs.length; i++) {
    const ref = fileRefs[i];
    const segIdx = segmentIndices[i];
    contentParts.push({ text: `=== VIDEO SEGMENT ${segIdx + 1} of ${totalSegments} ===` });
    contentParts.push({ fileData: { mimeType: ref.mimeType, fileUri: ref.uri } });
  }

  // Context docs — same budget logic as single-segment but account for multiple videos
  const videoTokenEstimate = batchSegments.reduce((sum, s) => sum + Math.ceil((s.durSec || 280) * 300), 0);
  const prevContextEstimate = estimateTokens(buildProgressiveContext(previousAnalyses, userName) || '');
  const docBudget = Math.max(50000, config.GEMINI_CONTEXT_WINDOW - videoTokenEstimate - 120000 - prevContextEstimate);
  console.log(`    Doc budget: ${(docBudget / 1000).toFixed(0)}K tokens for ${contextDocs.length} doc(s)`);

  const { selected: selectedDocs, excluded } = selectDocsByBudget(contextDocs, docBudget, { segmentIndex: segmentIndices[0] });
  if (excluded.length > 0) {
    console.log(`    Context: ${selectedDocs.length} docs included, ${excluded.length} excluded`);
  }

  // Attach selected docs with VTT time-slicing across the batch range
  const batchStartSec = segmentTimes.length > 0 ? segmentTimes[0].startTimeSec : null;
  const batchEndSec = segmentTimes.length > 0 ? segmentTimes[segmentTimes.length - 1].endTimeSec : null;

  for (const doc of selectedDocs) {
    if (doc.type === 'inlineText') {
      let content = doc.content;
      const isVtt = doc.fileName.toLowerCase().endsWith('.vtt') || doc.fileName.toLowerCase().endsWith('.srt');
      if (isVtt && batchStartSec != null && batchEndSec != null) {
        content = sliceVttForSegment(content, batchStartSec, batchEndSec);
        console.log(`    VTT sliced to ${formatHMS(batchStartSec)}–${formatHMS(batchEndSec)} range`);
      }
      contentParts.push({ text: `=== Document: ${doc.fileName} ===\n${content}` });
    } else if (doc.type === 'fileData') {
      contentParts.push({ fileData: { mimeType: doc.mimeType, fileUri: doc.fileUri } });
    } else if (doc.type === 'inlineData') {
      contentParts.push({ text: `=== Image: ${doc.fileName} ===` });
      contentParts.push({ inlineData: { mimeType: doc.mimeType, data: doc.data } });
    }
  }

  // Bridge text
  const bridgeText = buildDocBridgeText(selectedDocs);
  if (bridgeText) contentParts.push({ text: bridgeText });

  // Progressive context from previous batches
  const prevText = buildProgressiveContext(previousAnalyses, userName);
  if (prevText) contentParts.push({ text: prevText });

  // Multi-segment focus instructions
  const focusText = buildBatchSegmentFocus(segmentIndices, totalSegments, previousAnalyses, userName);
  contentParts.push({ text: focusText });

  // User identity
  if (userName) {
    contentParts.push({
      text: `CURRENT USER: "${userName}". Tag tasks assigned to or owned by "${userName}". Populate the "your_tasks" section.`
    });
  }

  contentParts.push({ text: promptText });

  // ── Send request ──────────────────────────────────────────────────────────
  console.log(`    Analyzing batch [segments ${segmentIndices[0] + 1}–${segmentIndices[segmentIndices.length - 1] + 1}] with ${config.GEMINI_MODEL}...`);

  const requestPayload = {
    model: config.GEMINI_MODEL,
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
    { label: `Gemini batch analysis (${displayName})`, maxRetries: 2, baseDelay: 5000 }
  );
  const durationMs = Date.now() - t0;

  let rawText = response.text;

  // Token usage
  const usage = response.usageMetadata || {};
  const tokenUsage = {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    thoughtTokens: usage.thoughtsTokenCount || 0,
  };
  const contextRemaining = config.GEMINI_CONTEXT_WINDOW - tokenUsage.inputTokens;
  const contextUsedPct = ((tokenUsage.inputTokens / config.GEMINI_CONTEXT_WINDOW) * 100).toFixed(1);
  tokenUsage.contextWindow = config.GEMINI_CONTEXT_WINDOW;
  tokenUsage.contextRemaining = contextRemaining;
  tokenUsage.contextUsedPct = parseFloat(contextUsedPct);

  console.log(`    Tokens — input: ${tokenUsage.inputTokens.toLocaleString()} | output: ${tokenUsage.outputTokens.toLocaleString()} | thinking: ${tokenUsage.thoughtTokens.toLocaleString()}`);
  console.log(`    Context — used: ${contextUsedPct}% | remaining: ${contextRemaining.toLocaleString()} tokens`);

  // Detect output truncation — if output tokens hit ≥98% of maxOutputTokens, the response was likely truncated
  const MAX_OUTPUT = 65536;
  const outputTruncated = tokenUsage.outputTokens >= Math.floor(MAX_OUTPUT * 0.98);
  if (outputTruncated) {
    console.warn(`    ⚠ Output likely truncated — ${tokenUsage.outputTokens.toLocaleString()} tokens used (max: ${MAX_OUTPUT.toLocaleString()}). JSON may be incomplete.`);
  }

  // Detect thinking budget drain — model used all tokens for thinking, 0 for output
  if (tokenUsage.outputTokens === 0 && tokenUsage.thoughtTokens > 0) {
    console.warn(`    ⚠ Thinking budget drain — ${tokenUsage.thoughtTokens.toLocaleString()} thinking tokens consumed entire output budget (0 output tokens)`);
    console.log(`    ↻ Retrying batch with reduced thinking budget...`);
    const reducedThinking = Math.min(Math.floor(thinkingBudget * 0.25), 4096);
    requestPayload.config.thinkingConfig = { thinkingBudget: reducedThinking };
    try {
      const retryResponse = await withRetry(
        () => ai.models.generateContent(requestPayload),
        { label: `Gemini batch analysis — reduced thinking (${displayName})`, maxRetries: 1, baseDelay: 5000 }
      );
      const retryUsage = retryResponse.usageMetadata || {};
      const retryOutput = retryUsage.candidatesTokenCount || 0;
      console.log(`    ✓ Reduced-thinking retry: ${retryOutput.toLocaleString()} output tokens (thinking: ${(retryUsage.thoughtsTokenCount || 0).toLocaleString()})`);
      if (retryOutput > 0) {
        rawText = retryResponse.text;
        tokenUsage.outputTokens = retryOutput;
        tokenUsage.thoughtTokens = retryUsage.thoughtsTokenCount || 0;
        tokenUsage.totalTokens = retryUsage.totalTokenCount || 0;
        tokenUsage.inputTokens = retryUsage.promptTokenCount || tokenUsage.inputTokens;
      }
    } catch (retryErr) {
      console.warn(`    ⚠ Reduced-thinking retry failed: ${retryErr.message}`);
    }
  }

  // Parse
  const parsed = extractJson(rawText);

  // Input summary
  const inputSummary = contentParts.map(part => {
    if (part.fileData) return { type: 'fileData', mimeType: part.fileData.mimeType, fileUri: part.fileData.fileUri };
    if (part.text) return { type: 'text', chars: part.text.length, preview: part.text.substring(0, 300) };
    return part;
  });

  // ── Cleanup Gemini File API uploads ────────────────────────────────────────
  const geminiFileNames = fileRefs.filter(r => r.name && !r.usedExternalUrl).map(r => r.name);

  return {
    run: {
      model: config.GEMINI_MODEL,
      displayName,
      userName,
      timestamp: new Date().toISOString(),
      durationMs,
      tokenUsage,
      systemInstruction,
      batchMode: true,
      segmentIndices,
    },
    input: {
      videoFiles: fileRefs.map((ref, i) => ({
        mimeType: ref.mimeType,
        fileUri: ref.uri,
        segmentName: batchSegments[i].segName,
        usedExternalUrl: ref.usedExternalUrl,
      })),
      contextDocuments: contextDocs.map(d => ({ fileName: d.fileName, type: d.type })),
      previousSegmentCount: previousAnalyses.length,
      parts: inputSummary,
      promptText,
    },
    output: {
      raw: rawText,
      parsed,
      parseSuccess: parsed !== null,
      outputTruncated,
    },
    _geminiFileNames: geminiFileNames,
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
 * @param {object} [opts] - Options { thinkingBudget }
 * @returns {{ compiled: object, run: object }} - The compiled analysis + run metadata
 */
async function compileFinalResult(ai, allSegmentAnalyses, userName, callName, scriptDir, opts = {}) {
  const { thinkingBudget: compilationThinking = 10240, contextDocs = [], docOnlyMode = false } = opts;
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
- Call name: "${callName}"${userName ? `\n- Current user: "${userName}"` : ''}
- Total segments analyzed: ${allSegmentAnalyses.length}

Below are the individual segment analyses. Each segment was analyzed independently but with cross-segment context. Your job is to produce ONE final, compiled, deduplicated result.

REQUIRED OUTPUT STRUCTURE:
Your JSON output MUST include ALL of these top-level fields (use empty arrays [] only when genuinely no items exist):
  "tickets": [...],           // All unique tickets discussed (deduplicated by ticket_id)
  "change_requests": [...],   // All unique CRs (deduplicated by id)
  "action_items": [...],      // All unique action items (deduplicated, re-numbered AI-1, AI-2, ...)
  "blockers": [...],          // All unique blockers (deduplicated, re-numbered BLK-1, ...)
  "scope_changes": [...],     // All unique scope changes (deduplicated, re-numbered SC-1, ...)
  "file_references": [...],   // All unique file references (deduplicated by resolved_path)${userName ? `\n  "your_tasks": { ... },      // Unified task summary for "${userName}"` : ''}
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
   - Nicknames or partial names referring to the same person → normalize to full proper name${userName ? `
   Ensure your_tasks.user_name uses the properly-cased version of "${userName}".` : ''}
3. RECONCILE CONFLICTS: If two segments give different status for the same item, use the LATEST/most-specific state.
4. MERGE SUMMARIES: Write ONE coherent executive summary for the entire call (3-5 sentences max). Not per-segment.${userName ? `
5. UNIFIED your_tasks: Produce ONE your_tasks section for "${userName}" — deduplicated, final states only.` : ''}
6. SEQUENTIAL IDs: Re-number action items (AI-1, AI-2, ...), scope changes (SC-1, SC-2, ...), blockers (BLK-1, ...) sequentially. Keep real CR/ticket numbers (e.g. CR31296872) unchanged.
7. FILE REFERENCES: Merge and deduplicate — keep the most specific resolved_path. Each file appears ONCE.
8. PRESERVE ALL DATA: Include every unique ticket, action item, blocker, etc. from the segments. Do NOT omit items for brevity. The goal is completeness with deduplication, not summarization.
9. PRESERVE source_segment AND source_video: Every item in the input has a "source_segment" field (1-based integer per video) and a "source_video" field (video filename string) indicating which video segment it originated from. You MUST preserve BOTH fields on EVERY output item (action_items, change_requests, blockers, scope_changes, file_references, and inside tickets: comments, code_changes, video_segments). For your_tasks sub-arrays (tasks_todo, tasks_waiting_on_others, decisions_needed), also preserve both fields. If an item appears in multiple segments, keep the source_segment and source_video of the FIRST (earliest) occurrence.

You MUST respond with ONLY valid JSON (no markdown fences, no extra text).
Use the same output structure as the individual segment analyses.

SEGMENT ANALYSES:
${segmentDumps}`;

  const contentParts = [{ text: compilationPrompt }];

  // ------- Attach context documents (critical for doc-only mode) -------
  if (contextDocs.length > 0) {
    for (const doc of contextDocs) {
      if (doc.type === 'inlineText') {
        contentParts.push({ text: `=== Document: ${doc.fileName} ===\n${doc.content}` });
      } else if (doc.type === 'fileData') {
        contentParts.push({ fileData: { mimeType: doc.mimeType, fileUri: doc.fileUri } });
      } else if (doc.type === 'inlineData') {
        contentParts.push({ text: `=== Image: ${doc.fileName} ===` });
        contentParts.push({ inlineData: { mimeType: doc.mimeType, data: doc.data } });
      }
    }
    console.log(`  Context docs attached: ${contextDocs.length}`);
  }

  // ------- Pre-flight context window check -------
  const estimatedInputTokens = estimateTokens(compilationPrompt);
  const safeLimit = Math.floor(config.GEMINI_CONTEXT_WINDOW * 0.80); // 80% of context window
  if (estimatedInputTokens > safeLimit) {
    console.warn(`  ${c.warn(`Compilation input (~${(estimatedInputTokens / 1000).toFixed(0)}K tokens) exceeds 80% of context window (${(safeLimit / 1000).toFixed(0)}K). Trimming older segment detail...`)}`);
    // Re-build segment dumps with aggressive compression: keep only first & last 2 segments
    // at full detail, compress the middle ones to IDs + statuses only.
    const trimmedDumps = allSegmentAnalyses.map((analysis, idx) => {
      const clean = { ...analysis };
      delete clean._geminiMeta;
      delete clean.seg;
      delete clean.conversation_transcript;
      const isEdge = idx < 2 || idx >= allSegmentAnalyses.length - 2;
      if (!isEdge) {
        // Aggressive compression for middle segments
        if (clean.tickets) {
          clean.tickets = clean.tickets.map(t => ({
            ticket_id: t.ticket_id, status: t.status, title: t.title,
            assignee: t.assignee, source_segment: t.source_segment, source_video: t.source_video,
          }));
        }
        if (clean.change_requests) {
          clean.change_requests = clean.change_requests.map(cr => ({
            id: cr.id, status: cr.status, title: cr.title,
            assigned_to: cr.assigned_to, source_segment: cr.source_segment, source_video: cr.source_video,
          }));
        }
        if (clean.action_items) {
          clean.action_items = clean.action_items.map(ai => ({
            id: ai.id, description: ai.description, assigned_to: ai.assigned_to,
            status: ai.status, source_segment: ai.source_segment, source_video: ai.source_video,
          }));
        }
        delete clean.file_references;
        clean.summary = (clean.summary || '').substring(0, 200);
      } else {
        if (clean.tickets) {
          clean.tickets = clean.tickets.map(t => {
            const tc = { ...t };
            if (tc.comments && tc.comments.length > 5) {
              tc.comments = tc.comments.slice(0, 5);
              tc.comments.push({ note: `...${t.comments.length - 5} more comments omitted` });
            }
            return tc;
          });
        }
      }
      return `=== SEGMENT ${idx + 1} OF ${allSegmentAnalyses.length} ===\n${JSON.stringify(clean, null, 2)}`;
    }).join('\n\n');
    contentParts[0] = { text: compilationPrompt.replace(segmentDumps, trimmedDumps) };
    const newEstimate = estimateTokens(contentParts[0].text);
    console.log(`  Trimmed compilation input to ~${(newEstimate / 1000).toFixed(0)}K tokens`);
  }

  const docOnlySystemSuffix = docOnlyMode
    ? '\n\nYou are in DOCUMENT ANALYSIS MODE — analyze ALL provided documents and images thoroughly. Extract every piece of meaningful content, structure it, and produce a comprehensive analysis. If images are provided, describe their visual content in detail. Output valid JSON only — no markdown fences.'
    : '\n\nYou are now in COMPILATION MODE — your job is to merge multiple segment analyses into one final unified output. Deduplicate, reconcile conflicts, and produce the definitive analysis. Output valid JSON only — no markdown fences.';

  const requestPayload = {
    model: config.GEMINI_MODEL,
    contents: [{ role: 'user', parts: contentParts }],
    config: {
      systemInstruction: `${systemInstruction}${docOnlySystemSuffix}`,
      maxOutputTokens: 65536,
      temperature: 0,
      thinkingConfig: { thinkingBudget: compilationThinking },
    },
  };

  const t0 = Date.now();
  console.log(`  Compiling with ${config.GEMINI_MODEL}...`);
  let response;
  try {
    response = await withRetry(
      () => ai.models.generateContent(requestPayload),
      { label: 'Gemini final compilation', maxRetries: 2, baseDelay: 5000 }
    );
  } catch (compileErr) {
    const errMsg = compileErr.message || '';
    if (errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('429') || errMsg.includes('quota')) {
      console.warn(`  ${c.warn('Context window or quota exceeded during compilation — waiting 30s and retrying with reduced input...')}`);
      await new Promise(r => setTimeout(r, 30000));
      // Halve the compilation prompt by keeping only edge segments
      const miniDumps = allSegmentAnalyses.map((analysis, idx) => {
        const clean = { tickets: (analysis.tickets || []).map(t => ({ ticket_id: t.ticket_id, status: t.status, title: t.title, assignee: t.assignee })),
          change_requests: (analysis.change_requests || []).map(cr => ({ id: cr.id, status: cr.status, title: cr.title })),
          action_items: (analysis.action_items || []).map(ai => ({ id: ai.id, description: ai.description, assigned_to: ai.assigned_to, status: ai.status })),
          blockers: (analysis.blockers || []).map(b => ({ id: b.id, description: b.description, status: b.status })),
          scope_changes: analysis.scope_changes || [],
          your_tasks: analysis.your_tasks || {},
          summary: (analysis.summary || '').substring(0, 300),
        };
        return `=== SEGMENT ${idx + 1} OF ${allSegmentAnalyses.length} ===\n${JSON.stringify(clean, null, 2)}`;
      }).join('\n\n');
      requestPayload.contents[0].parts = [{ text: compilationPrompt.replace(/SEGMENT ANALYSES:\n[\s\S]*$/, `SEGMENT ANALYSES:\n${miniDumps}`) }];
      try {
        response = await withRetry(
          () => ai.models.generateContent(requestPayload),
          { label: 'Gemini compilation (reduced)', maxRetries: 1, baseDelay: 5000 }
        );
        console.log(`  ${c.success('Reduced compilation succeeded')}`);
      } catch (reduceErr) {
        console.error(`  ${c.error(`Reduced compilation also failed: ${reduceErr.message}`)}`);
        throw reduceErr;
      }
    } else {
      throw compileErr;
    }
  }
  const durationMs = Date.now() - t0;
  let rawText = response.text;

  // Token usage
  const usage = response.usageMetadata || {};
  const tokenUsage = {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    thoughtTokens: usage.thoughtsTokenCount || 0,
  };
  const contextUsedPct = ((tokenUsage.inputTokens / config.GEMINI_CONTEXT_WINDOW) * 100).toFixed(1);
  tokenUsage.contextWindow = config.GEMINI_CONTEXT_WINDOW;
  tokenUsage.contextRemaining = config.GEMINI_CONTEXT_WINDOW - tokenUsage.inputTokens;
  tokenUsage.contextUsedPct = parseFloat(contextUsedPct);

  console.log(`  Tokens — input: ${tokenUsage.inputTokens.toLocaleString()} | output: ${tokenUsage.outputTokens.toLocaleString()} | thinking: ${tokenUsage.thoughtTokens.toLocaleString()} | total: ${tokenUsage.totalTokens.toLocaleString()}`);
  console.log(`  Context — used: ${contextUsedPct}% | remaining: ${tokenUsage.contextRemaining.toLocaleString()} / ${config.GEMINI_CONTEXT_WINDOW.toLocaleString()} tokens`);
  console.log(`  Compilation duration: ${(durationMs / 1000).toFixed(1)}s`);

  // Detect thinking budget drain — model used all tokens for thinking, 0 for output
  if (tokenUsage.outputTokens === 0 && tokenUsage.thoughtTokens > 0) {
    console.warn(`  ⚠ Thinking budget drain — ${tokenUsage.thoughtTokens.toLocaleString()} thinking tokens consumed entire output budget (0 output tokens)`);
    console.log(`  ↻ Retrying compilation with reduced thinking budget...`);
    const reducedThinking = Math.min(Math.floor(compilationThinking * 0.25), 4096);
    requestPayload.config.thinkingConfig = { thinkingBudget: reducedThinking };
    try {
      const retryResponse = await withRetry(
        () => ai.models.generateContent(requestPayload),
        { label: 'Gemini compilation — reduced thinking', maxRetries: 1, baseDelay: 5000 }
      );
      const retryUsage = retryResponse.usageMetadata || {};
      const retryOutput = retryUsage.candidatesTokenCount || 0;
      console.log(`  ✓ Reduced-thinking retry: ${retryOutput.toLocaleString()} output tokens (thinking: ${(retryUsage.thoughtsTokenCount || 0).toLocaleString()})`);
      if (retryOutput > 0) {
        response = retryResponse;
        rawText = retryResponse.text;
        tokenUsage.outputTokens = retryOutput;
        tokenUsage.thoughtTokens = retryUsage.thoughtsTokenCount || 0;
        tokenUsage.totalTokens = retryUsage.totalTokenCount || 0;
        tokenUsage.inputTokens = retryUsage.promptTokenCount || tokenUsage.inputTokens;
      }
    } catch (retryErr) {
      console.warn(`  ⚠ Reduced-thinking retry failed: ${retryErr.message}`);
    }
  }

  // Parse compiled result
  const compiled = extractJson(rawText);

  if (!compiled) {
    console.warn(`  ${c.warn('Failed to parse compiled result — falling back to raw segment merge')}`);
  } else {
    console.log(`  ${c.success('Final compilation complete')}`);
  }

  return {
    compiled,
    raw: rawText,
    run: {
      model: config.GEMINI_MODEL,
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
    throw new Error(`Gemini file processing failed for ${displayName}. The file may be corrupt or in an unsupported format — try re-compressing or using a different segment.`);
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
  console.log(`    Analyzing with ${config.GEMINI_MODEL} [segment ${segmentIndex + 1}/${totalSegments}]...`);
  const requestPayload = {
    model: config.GEMINI_MODEL,
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

  // Cleanup: delete uploaded file from Gemini File API
  try {
    await ai.files.delete({ name: file.name });
  } catch (cleanupErr) {
    console.warn(`    ${c.warn(`Gemini file cleanup failed: ${cleanupErr.message}`)}`);
  }

  const usage = response.usageMetadata || {};
  const tokenUsage = {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    thoughtTokens: usage.thoughtsTokenCount || 0,
  };

  console.log(`    Tokens — input: ${tokenUsage.inputTokens.toLocaleString()} | output: ${tokenUsage.outputTokens.toLocaleString()} | thinking: ${tokenUsage.thoughtTokens.toLocaleString()}`);
console.log(`    ${c.success(`Summary: ${summary.length.toLocaleString()} chars in ${(durationMs / 1000).toFixed(1)}s`)}`);

  return { summary, durationMs, tokenUsage };
}

// ======================== CLEANUP ========================

/**
 * Delete uploaded files from Gemini File API.
 * Call after all analysis (including focused passes) is complete.
 *
 * @param {object} ai - GoogleGenAI instance
 * @param {string|null} geminiFileName - The Gemini file resource name (from file.name)
 * @param {Array} [contextDocs] - Prepared context docs (may contain File API uploads)
 */
async function cleanupGeminiFiles(ai, geminiFileName, contextDocs = []) {
  const toDelete = [];
  // Accept a single name string or an array of names
  if (Array.isArray(geminiFileName)) {
    toDelete.push(...geminiFileName.filter(Boolean));
  } else if (geminiFileName) {
    toDelete.push(geminiFileName);
  }
  for (const doc of contextDocs) {
    if (doc.type === 'fileData' && doc.geminiFileName) {
      toDelete.push(doc.geminiFileName);
    }
  }
  if (toDelete.length === 0) return;

  let cleaned = 0;
  for (const name of toDelete) {
    try {
      await ai.files.delete({ name });
      cleaned++;
    } catch { /* ignore — files may already be expired */ }
  }
  if (cleaned > 0) {
    console.log(`    🧹 Cleaned up ${cleaned} Gemini File API upload(s)`);
  }
}

module.exports = {
  initGemini,
  prepareDocsForGemini,
  analyzeImageBatches,
  loadPrompt,
  processWithGemini,
  processSegmentBatch,
  compileFinalResult,
  buildDocBridgeText,
  analyzeVideoForContext,
  cleanupGeminiFiles,
};
