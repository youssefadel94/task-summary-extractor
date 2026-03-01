'use strict';

const fs = require('fs');
const path = require('path');

// --- Config ---
const config = require('../config');

// --- Services ---
const { uploadToStorage } = require('../services/firebase');

// --- Renderers ---
const { renderResultsMarkdown } = require('../renderers/markdown');
const { renderResultsHtml } = require('../renderers/html');

// --- Utils ---
const { loadPreviousCompilation, generateDiff, renderDiffMarkdown } = require('../utils/diff-engine');

// --- Shared state ---
const { getLog, phaseTimer, PROJECT_ROOT } = require('./_shared');

// ======================== PHASE: OUTPUT ========================

/**
 * Write results JSON, generate Markdown, upload final artifacts.
 * Returns { runDir, jsonPath, mdPath }.
 */
async function phaseOutput(ctx, results, compiledAnalysis, compilationRun, compilationPayload) {
  const log = getLog();
  const timer = phaseTimer('output');
  const { opts, targetDir, storage, firebaseReady, callName, progress, costTracker, userName } = ctx;

  progress.setPhase('output');

  // Determine output directory
  const runTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = opts.outputDir
    ? path.resolve(opts.outputDir)
    : path.join(targetDir, 'runs', runTs);
  fs.mkdirSync(runDir, { recursive: true });
  log.step(`Run folder created → ${runDir}`);

  // Copy compilation JSON into run folder
  if (compilationPayload) {
    const runCompFile = path.join(runDir, 'compilation.json');
    fs.writeFileSync(runCompFile, JSON.stringify(compilationPayload, null, 2), 'utf8');
  }

  // Attach cost summary to results
  results.costSummary = costTracker.getSummary();

  // Write results JSON
  const jsonPath = path.join(runDir, 'results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');
  log.step(`Results JSON saved → ${jsonPath}`);

  // Generate Markdown
  const mdPath = path.join(runDir, 'results.md');
  const totalSegs = results.files.reduce((s, f) => s + f.segmentCount, 0);

  if (compiledAnalysis && !compiledAnalysis._incomplete) {
    const mdContent = renderResultsMarkdown({
      compiled: compiledAnalysis,
      meta: {
        callName: results.callName,
        processedAt: results.processedAt,
        geminiModel: config.GEMINI_MODEL,
        userName,
        segmentCount: totalSegs,
        compilation: compilationRun || null,
        costSummary: results.costSummary,
        segments: results.files.flatMap(f => {
          const speed = results.settings?.speed || 1;
          let cum = 0;
          return (f.segments || []).map(s => {
            const startSec = cum;
            cum += (s.durationSeconds || 0) * speed;
            return {
              file: s.segmentFile,
              duration: s.duration,
              durationSeconds: s.durationSeconds,
              sizeMB: s.fileSizeMB,
              video: f.originalFile,
              startTimeSec: startSec,
              endTimeSec: cum,
              segmentNumber: (s.segmentIndex || 0) + 1,
            };
          });
        }),
        settings: results.settings,
      },
    });
    fs.writeFileSync(mdPath, mdContent, 'utf8');
    log.step(`Results MD saved (compiled) → ${mdPath}`);
    console.log(`  ✓ Markdown report (AI-compiled) → ${path.basename(mdPath)}`);

    // Generate HTML report (same data, interactive format)
    if (!opts.noHtml) {
      const htmlPath = path.join(runDir, 'results.html');
      const htmlContent = renderResultsHtml({
        compiled: compiledAnalysis,
        meta: {
          callName: results.callName,
          processedAt: results.processedAt,
          geminiModel: config.GEMINI_MODEL,
          userName,
          segmentCount: totalSegs,
          compilation: compilationRun || null,
          costSummary: results.costSummary,
          segments: results.files.flatMap(f => {
            const speed = results.settings?.speed || 1;
            let cum = 0;
            return (f.segments || []).map(s => {
              const startSec = cum;
              cum += (s.durationSeconds || 0) * speed;
              return {
                file: s.segmentFile,
                duration: s.duration,
                durationSeconds: s.durationSeconds,
                sizeMB: s.fileSizeMB,
              };
            });
          }),
          settings: results.settings,
        },
      });
      fs.writeFileSync(htmlPath, htmlContent, 'utf8');
      log.step(`Results HTML saved → ${htmlPath}`);
      console.log(`  ✓ HTML report → ${path.basename(htmlPath)}`);
    }
  } else {
    const { renderResultsMarkdownLegacy } = require('../renderers/markdown');
    const mdContent = renderResultsMarkdownLegacy(results);
    fs.writeFileSync(mdPath, mdContent, 'utf8');
    log.step(`Results MD saved (legacy merge) → ${mdPath}`);
    console.log(`  ✓ Markdown report (legacy merge) → ${path.basename(mdPath)}`);
  }

  // === DIFF ENGINE (v6) ===
  let diffResult = null;
  if (!opts.disableDiff && compiledAnalysis) {
    try {
      const prevComp = loadPreviousCompilation(targetDir, runTs);
      if (prevComp && prevComp.compiled) {
        diffResult = generateDiff(compiledAnalysis, prevComp.compiled);
        // Inject the previous run timestamp into the diff
        if (diffResult.hasDiff) {
          diffResult.previousTimestamp = prevComp.timestamp;
          const diffMd = renderDiffMarkdown(diffResult);
          fs.appendFileSync(mdPath, '\n\n' + diffMd, 'utf8');
          fs.writeFileSync(path.join(runDir, 'diff.json'), JSON.stringify(diffResult, null, 2), 'utf8');
          log.step(`Diff report: ${diffResult.totals.newItems} new, ${diffResult.totals.removedItems} removed, ${diffResult.totals.changedItems} changed`);
          console.log(`  ✓ Diff report appended (vs ${prevComp.timestamp})`);
        } else {
          console.log(`  ℹ No differences vs previous run (${prevComp.timestamp})`);
        }
      } else {
        console.log(`  ℹ No previous compilation found for diff comparison`);
      }
    } catch (diffErr) {
      console.warn(`  ⚠ Diff generation failed: ${diffErr.message}`);
      log.warn(`Diff generation error: ${diffErr.message}`);
    }
  }

  // Upload results to Firebase
  if (firebaseReady && !opts.skipUpload && !opts.dryRun) {
    try {
      const resultsStoragePath = `calls/${callName}/runs/${runTs}/results.json`;
      // Results always upload fresh (never skip-existing) — they change every run
      const url = await uploadToStorage(storage, jsonPath, resultsStoragePath);
      results.storageUrl = url;
      fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');
      console.log(`  ✓ Results JSON uploaded → ${resultsStoragePath}`);

      const mdStoragePath = `calls/${callName}/runs/${runTs}/results.md`;
      await uploadToStorage(storage, mdPath, mdStoragePath);
      console.log(`  ✓ Results MD uploaded → ${mdStoragePath}`);
    } catch (err) {
      console.warn(`  ⚠ Results upload failed: ${err.message}`);
    }
  } else if (opts.skipUpload) {
    console.log('  ⚠ Skipping results upload (--skip-upload)');
  } else {
    console.log('  ⚠ Skipping results upload (Firebase auth not configured)');
  }

  timer.end();
  return { runDir, jsonPath, mdPath, runTs };
}

module.exports = phaseOutput;
