'use strict';

const fs = require('fs');
const path = require('path');

// --- Services ---
const { compileFinalResult } = require('../services/gemini');

// --- Utils ---
const { calculateCompilationBudget } = require('../utils/adaptive-budget');
const { assessQuality, THRESHOLDS } = require('../utils/quality-gate');
const { validateAnalysis, formatSchemaLine, normalizeAnalysis } = require('../utils/schema-validator');
const { c } = require('../utils/colors');
const config = require('../config');

// --- Shared state ---
const { getLog, isShuttingDown, PKG_ROOT, PROJECT_ROOT, phaseTimer } = require('./_shared');

// ======================== PHASE: COMPILE ========================

/**
 * Send all segment analyses to Gemini for final compilation.
 * Returns { compiledAnalysis, compilationRun }.
 */
async function phaseCompile(ctx, allSegmentAnalyses) {
  const log = getLog();
  const timer = phaseTimer('compile');
  const { opts, ai, userName, callName, costTracker, progress } = ctx;

  progress.setPhase('compile');

  let compiledAnalysis = null;
  let compilationRun = null;

  if (allSegmentAnalyses.length > 0 && !opts.skipGemini && !opts.dryRun && !isShuttingDown()) {
    try {
      // Adaptive compilation budget
      const compBudget = calculateCompilationBudget(allSegmentAnalyses, opts.compilationThinkingBudget);
      console.log(`  Compilation thinking budget: ${c.yellow(compBudget.budget.toLocaleString())} tokens ${c.dim(`(${compBudget.reason})`)}`);

      const compilationResult = await compileFinalResult(
        ai, allSegmentAnalyses, userName, callName, PKG_ROOT,
        { thinkingBudget: compBudget.budget }
      );

      compiledAnalysis = normalizeAnalysis(compilationResult.compiled);
      compilationRun = compilationResult.run;

      // Track compilation cost
      if (compilationRun?.tokenUsage) {
        costTracker.addCompilation(compilationRun.tokenUsage, compilationRun.durationMs);
      }

      // Validate compilation output
      let compSchemaReport = null;
      if (compiledAnalysis) {
        // Schema validation
        compSchemaReport = validateAnalysis(compiledAnalysis, 'compiled');
        console.log(formatSchemaLine(compSchemaReport));
        if (!compSchemaReport.valid && compSchemaReport.errorCount > 0) {
          log.warn(`Compilation schema: ${compSchemaReport.summary}`);
        }

        const hasTickets = Array.isArray(compiledAnalysis.tickets) && compiledAnalysis.tickets.length > 0;
        const hasActions = Array.isArray(compiledAnalysis.action_items) && compiledAnalysis.action_items.length > 0;
        const hasBlockers = Array.isArray(compiledAnalysis.blockers) && compiledAnalysis.blockers.length > 0;
        const hasCRs = Array.isArray(compiledAnalysis.change_requests) && compiledAnalysis.change_requests.length > 0;

        if (!hasTickets && !hasActions && !hasBlockers && !hasCRs) {
          console.warn(`  ${c.warn('Compilation parsed OK but is missing structured data (no tickets, actions, blockers, or CRs)')}`);
          console.warn(`  ${c.dim('→ Falling back to raw segment merge for full data')}`);
          log.warn('Compilation incomplete — missing all structured fields, using segment merge fallback');
          compiledAnalysis._incomplete = true;
        }
      }

      // === COMPILATION AUTO-RETRY on parse failure or quality FAIL ===
      const shouldRetryCompilation = !compiledAnalysis || compiledAnalysis._incomplete || (() => {
        if (!compiledAnalysis) return true;
        const cq = assessQuality(compiledAnalysis, {
          parseSuccess: compilationRun?.parseSuccess ?? false,
          rawLength: (compilationResult.raw || '').length,
        });
        return cq.shouldRetry;
      })();

      if (shouldRetryCompilation && !isShuttingDown()) {
        const reason = !compiledAnalysis
          ? `parse failed (${compilationRun?.tokenUsage?.outputTokens || 0} output tokens)`
          : 'quality FAIL / incomplete';
        console.log(`  ${c.warn(`↻ Compilation ${reason} — retrying with boosted budget...`)}`);
        log.step(`Compilation retry: ${reason}`);

        const retryBudget = Math.min(config.getMaxThinkingBudget(), Math.round(compBudget.budget * 1.5));
        try {
          const retryResult = await compileFinalResult(
            ai, allSegmentAnalyses, userName, callName, PKG_ROOT,
            { thinkingBudget: retryBudget }
          );

          const retryAnalysis = normalizeAnalysis(retryResult.compiled);
          const retryRun = retryResult.run;

          if (retryRun?.tokenUsage) {
            costTracker.addCompilation(retryRun.tokenUsage, retryRun.durationMs);
          }

          if (retryAnalysis) {
            const retrySchema = validateAnalysis(retryAnalysis, 'compiled');
            console.log(formatSchemaLine(retrySchema));

            const retryHasData = (
              (Array.isArray(retryAnalysis.tickets) && retryAnalysis.tickets.length > 0) ||
              (Array.isArray(retryAnalysis.action_items) && retryAnalysis.action_items.length > 0) ||
              (Array.isArray(retryAnalysis.blockers) && retryAnalysis.blockers.length > 0) ||
              (Array.isArray(retryAnalysis.change_requests) && retryAnalysis.change_requests.length > 0)
            );

            // Accept retry if it produced parseable data (better than null or _incomplete)
            if (retryHasData || !compiledAnalysis) {
              console.log(`  ${c.success('Compilation retry succeeded — using retry result')}`);
              compiledAnalysis = retryAnalysis;
              compilationRun = retryRun;
              compSchemaReport = retrySchema;
              log.step('Compilation retry accepted');
            } else {
              console.log(`  ${c.warn('Retry also incomplete — keeping original')}`);
            }
          } else {
            console.log(`  ${c.warn('Retry also failed to parse — keeping original')}`);
          }
        } catch (retryErr) {
          console.warn(`  ${c.warn(`Compilation retry failed: ${retryErr.message} — keeping ${compiledAnalysis ? 'original' : 'segment merge fallback'}`)}`);
        }
      }

      // Save compilation run
      const compilationDir = path.join(PROJECT_ROOT, 'gemini_runs', callName);
      fs.mkdirSync(compilationDir, { recursive: true });
      const compTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const compilationFile = path.join(compilationDir, `compilation_${compTs}.json`);
      const compilationPayload = {
        run: compilationRun,
        output: { raw: compilationResult.raw, parsed: compiledAnalysis, parseSuccess: compiledAnalysis !== null },
      };
      fs.writeFileSync(compilationFile, JSON.stringify(compilationPayload, null, 2), 'utf8');
      log.step(`Compilation run saved → ${compilationFile}`);
      log.metric('compilation', {
        durationMs: compilationRun.durationMs,
        tokens: compilationRun.tokenUsage || {},
        schemaValid: compiledAnalysis && !compiledAnalysis._incomplete,
        segmentsCompiled: allSegmentAnalyses.length,
        thinkingBudget: compBudget.budget,
      });

      progress.markCompilationDone();

      timer.end();
      return { compiledAnalysis, compilationRun, compilationPayload, compilationFile };
    } catch (err) {
      console.error(`  ${c.error(`Final compilation failed: ${err.message}`)}`);
      log.error(`Compilation FAIL — ${err.message}`);
      console.warn(`  ${c.dim('→ Falling back to raw segment merge for MD')}`);
    }
  }

  timer.end();
  return { compiledAnalysis, compilationRun, compilationPayload: null, compilationFile: null };
}

module.exports = phaseCompile;
