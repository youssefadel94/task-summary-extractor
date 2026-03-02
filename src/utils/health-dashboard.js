/**
 * Pipeline Health Dashboard — generates a comprehensive quality report
 * after all processing is complete.
 *
 * Reports on:
 *  - Parse success rates
 *  - Quality scores per segment
 *  - Extraction density (items per segment)
 *  - Data coverage analysis
 *  - Retry statistics
 *  - Token efficiency metrics
 */

'use strict';

const { c } = require('./colors');

// ======================== HEALTH REPORT ========================

/**
 * Build a comprehensive health report from pipeline execution data.
 *
 * @param {object} params
 * @param {Array} params.segmentReports - Array of { segmentName, qualityReport, retried, retryImproved }
 * @param {Array} params.allSegmentAnalyses - All final segment analyses
 * @param {object} params.costSummary - From CostTracker.getSummary()
 * @param {object} [params.compilationQuality] - Quality report for the compilation step
 * @param {number} params.totalDurationMs - Wall-clock duration of pipeline
 * @returns {object} Health report
 */
function buildHealthReport(params) {
  const {
    segmentReports = [],
    allSegmentAnalyses = [],
    costSummary = {},
    compilationQuality = null,
    totalDurationMs = 0,
    integrityWarnings = null,
  } = params;

  // Parse success rate
  const totalSegments = segmentReports.length;
  const parsed = segmentReports.filter(r => r.qualityReport?.grade !== 'FAIL').length;
  const parseRate = totalSegments > 0 ? (parsed / totalSegments * 100).toFixed(1) : 0;

  // Quality score distribution
  const scores = segmentReports.map(r => r.qualityReport?.score || 0);
  const avgScore = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : 0;
  const minScore = scores.length > 0 ? Math.min(...scores) : 0;
  const maxScore = scores.length > 0 ? Math.max(...scores) : 0;

  // Grade distribution
  const grades = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const r of segmentReports) {
    const g = r.qualityReport?.grade || 'FAIL';
    grades[g] = (grades[g] || 0) + 1;
  }

  // Extraction density
  let totalTickets = 0, totalCrs = 0, totalActions = 0, totalBlockers = 0, totalScopes = 0;
  const perSegment = [];

  for (const analysis of allSegmentAnalyses) {
    const tickets = analysis.tickets?.length || 0;
    const crs = analysis.change_requests?.length || 0;
    const actions = analysis.action_items?.length || 0;
    const blockers = analysis.blockers?.length || 0;
    const scopes = analysis.scope_changes?.length || 0;

    totalTickets += tickets;
    totalCrs += crs;
    totalActions += actions;
    totalBlockers += blockers;
    totalScopes += scopes;

    perSegment.push({ tickets, crs, actions, blockers, scopes });
  }

  // Retry stats
  const retriedCount = segmentReports.filter(r => r.retried).length;
  const retryImprovedCount = segmentReports.filter(r => r.retryImproved).length;

  // Token efficiency
  const tokensPerItem = costSummary.totalTokens && (totalTickets + totalCrs + totalActions) > 0
    ? Math.round(costSummary.totalTokens / (totalTickets + totalCrs + totalActions))
    : 0;

  // All issues across segments
  const allIssues = [];
  for (const r of segmentReports) {
    for (const issue of (r.qualityReport?.issues || [])) {
      allIssues.push({ segment: r.segmentName, issue });
    }
  }

  return {
    summary: {
      totalSegments,
      parseSuccessRate: parseFloat(parseRate),
      avgQualityScore: parseFloat(avgScore),
      minQualityScore: minScore,
      maxQualityScore: maxScore,
      grades,
    },
    extraction: {
      totalTickets,
      totalChangeRequests: totalCrs,
      totalActionItems: totalActions,
      totalBlockers,
      totalScopeChanges: totalScopes,
      totalItems: totalTickets + totalCrs + totalActions + totalBlockers + totalScopes,
      perSegment,
    },
    retry: {
      segmentsRetried: retriedCount,
      retriesImproved: retryImprovedCount,
    },
    efficiency: {
      tokensPerExtractedItem: tokensPerItem,
      totalTokens: costSummary.totalTokens || 0,
      totalCost: costSummary.totalCost || 0,
      aiTimeMs: costSummary.totalDurationMs || 0,
      wallClockMs: totalDurationMs,
    },
    compilation: compilationQuality ? {
      score: compilationQuality.score,
      grade: compilationQuality.grade,
      issues: compilationQuality.issues,
    } : null,
    integrityWarnings: integrityWarnings || null,
    issues: allIssues,
  };
}

/**
 * Print the health dashboard to console.
 * @param {object} report - From buildHealthReport
 */
function printHealthDashboard(report) {
  const { summary: s, extraction: e, retry: r, efficiency: eff, compilation: comp } = report;

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║         PIPELINE HEALTH DASHBOARD            ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // Quality overview
  console.log('  Quality Scores:');
  console.log(`    Average : ${s.avgQualityScore}/100`);
  console.log(`    Range   : ${s.minQualityScore}–${s.maxQualityScore}`);
  console.log(`    Grades  : ${c.success(`${s.grades.PASS} PASS`)} | ${c.warn(`${s.grades.WARN} WARN`)} | ${c.error(`${s.grades.FAIL} FAIL`)}`);
  console.log(`    Parse   : ${s.parseSuccessRate}% success rate`);
  console.log('');

  // Extraction density
  console.log('  Extraction Summary:');
  console.log(`    Tickets         : ${e.totalTickets}`);
  console.log(`    Change Requests : ${e.totalChangeRequests}`);
  console.log(`    Action Items    : ${e.totalActionItems}`);
  console.log(`    Blockers        : ${e.totalBlockers}`);
  console.log(`    Scope Changes   : ${e.totalScopeChanges}`);
  console.log(`    Total items     : ${e.totalItems} across ${s.totalSegments} segment(s)`);
  console.log('');

  // Per-segment density bars
  if (e.perSegment.length > 0) {
    console.log('  Per-Segment Density:');
    e.perSegment.forEach((seg, i) => {
      const total = seg.tickets + seg.crs + seg.actions + seg.blockers + seg.scopes;
      const bar = '█'.repeat(Math.min(total, 30)) + (total > 30 ? '…' : '');
      console.log(`    Seg ${i + 1}: ${bar} (${total} items)`);
    });
    console.log('');
  }

  // Retry stats
  if (r.segmentsRetried > 0) {
    console.log('  Retry Statistics:');
    console.log(`    Segments retried : ${r.segmentsRetried}`);
    console.log(`    Retries improved : ${r.retriesImproved}`);
    console.log('');
  }

  // Efficiency
  console.log('  Efficiency:');
  console.log(`    Tokens/item : ${eff.tokensPerExtractedItem.toLocaleString()}`);
  console.log(`    AI time     : ${(eff.aiTimeMs / 1000).toFixed(1)}s`);
  console.log(`    Wall clock  : ${(eff.wallClockMs / 1000).toFixed(1)}s`);
  console.log(`    Cost        : $${eff.totalCost.toFixed(4)}`);

  // Compilation quality
  if (comp) {
    console.log('');
    console.log('  Compilation:');
    console.log(`    Score : ${comp.score}/100 (${comp.grade})`);
    if (comp.issues.length > 0) {
      console.log(`    Issues: ${comp.issues.length}`);
      comp.issues.slice(0, 3).forEach(issue => console.log(`      • ${issue}`));
      if (comp.issues.length > 3) console.log(`      ... +${comp.issues.length - 3} more`);
    }
  }

  // Top issues
  const criticalIssues = report.issues.filter(i =>
    i.issue.includes('FAIL') || i.issue.includes('Missing required') || i.issue.includes('parse failed')
  );
  if (criticalIssues.length > 0) {
    console.log('');
    console.log(`  ${c.warn('Critical Issues:')}`);
    criticalIssues.slice(0, 5).forEach(i => console.log(`    ${i.segment}: ${i.issue}`));
  }

  // File integrity warnings
  if (report.integrityWarnings && report.integrityWarnings.length > 0) {
    console.log('');
    console.log(`  ${c.warn('⚠ File Integrity Warnings')} (${report.integrityWarnings.length}):`);
    for (const w of report.integrityWarnings) {
      const icon = w.severity === 'error' ? c.error('✗')
        : w.severity === 'warning' ? c.warn('⚠')
        : c.dim('ℹ');
      console.log(`    ${icon} ${w.file}: ${w.message}`);
    }
  }

  console.log('');
}

module.exports = {
  buildHealthReport,
  printHealthDashboard,
};
