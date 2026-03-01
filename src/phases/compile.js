'use strict';

const fs = require('fs');
const path = require('path');

// --- Services ---
const { compileFinalResult } = require('../services/gemini');

// --- Utils ---
const { calculateCompilationBudget } = require('../utils/adaptive-budget');
const { validateAnalysis, formatSchemaLine, normalizeAnalysis } = require('../utils/schema-validator');
const { c } = require('../utils/colors');

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
      if (compiledAnalysis) {
        // Schema validation
        const compSchemaReport = validateAnalysis(compiledAnalysis, 'compiled');
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
