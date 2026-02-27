/**
 * Learning Loop — stores pipeline execution history and uses it to
 * auto-adjust quality thresholds, thinking budgets, and extraction strategies.
 *
 * After each run, the health report + key metrics are appended to history.json.
 * Before each run, historical data is analyzed to produce recommendations
 * for the current execution.
 *
 * This creates a feedback loop: each run gets smarter based on past performance.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = 'history.json';
const MAX_HISTORY_ENTRIES = 50; // Keep last 50 runs

// ======================== HISTORY I/O ========================

/**
 * Load run history from disk.
 *
 * @param {string} projectRoot - Project root directory
 * @returns {Array} Array of historical run entries
 */
function loadHistory(projectRoot) {
  const historyPath = path.join(projectRoot, HISTORY_FILE);
  try {
    if (fs.existsSync(historyPath)) {
      const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (err) {
    console.warn(`  ⚠ Could not load history: ${err.message}`);
  }
  return [];
}

/**
 * Save a new run entry to history.
 *
 * @param {string} projectRoot - Project root directory
 * @param {object} entry - Run entry to append
 */
function saveHistory(projectRoot, entry) {
  const historyPath = path.join(projectRoot, HISTORY_FILE);
  try {
    const history = loadHistory(projectRoot);
    history.push(entry);

    // Trim to max entries
    const trimmed = history.slice(-MAX_HISTORY_ENTRIES);
    fs.writeFileSync(historyPath, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (err) {
    console.warn(`  ⚠ Could not save history: ${err.message}`);
  }
}

// ======================== RUN ENTRY BUILDER ========================

/**
 * Build a compact history entry from pipeline execution data.
 *
 * @param {object} params
 * @param {string} params.callName - Name of the call
 * @param {object} params.healthReport - From health-dashboard.js
 * @param {object} params.costSummary - From CostTracker
 * @param {number} params.segmentCount - Number of segments
 * @param {object} [params.compilationQuality] - Quality report for compilation
 * @param {number} [params.baseBudget] - Thinking budget used
 * @param {number} [params.compilationBudget] - Compilation budget used
 * @param {boolean} [params.hadFocusedPasses] - Whether focused re-analysis was used
 * @returns {object} Compact history entry
 */
function buildHistoryEntry(params) {
  const {
    callName,
    healthReport,
    costSummary = {},
    segmentCount = 0,
    compilationQuality = null,
    baseBudget = 0,
    compilationBudget = 0,
    hadFocusedPasses = false,
  } = params;

  const hr = healthReport || {};
  const summary = hr.summary || {};
  const extraction = hr.extraction || {};
  const retry = hr.retry || {};
  const efficiency = hr.efficiency || {};

  return {
    timestamp: new Date().toISOString(),
    callName,
    segmentCount,
    quality: {
      avgScore: summary.avgQualityScore || 0,
      minScore: summary.minQualityScore || 0,
      maxScore: summary.maxQualityScore || 0,
      grades: summary.grades || {},
      parseSuccessRate: summary.parseSuccessRate || 0,
    },
    extraction: {
      totalItems: extraction.totalItems || 0,
      tickets: extraction.totalTickets || 0,
      crs: extraction.totalChangeRequests || 0,
      actions: extraction.totalActionItems || 0,
      blockers: extraction.totalBlockers || 0,
      scopes: extraction.totalScopeChanges || 0,
    },
    cost: {
      totalTokens: costSummary.totalTokens || 0,
      totalCost: costSummary.totalCost || 0,
      tokensPerItem: efficiency.tokensPerExtractedItem || 0,
    },
    retry: {
      segmentsRetried: retry.segmentsRetried || 0,
      retriesImproved: retry.retriesImproved || 0,
    },
    budgets: {
      baseBudget,
      compilationBudget,
    },
    compilation: compilationQuality ? {
      score: compilationQuality.score,
      grade: compilationQuality.grade,
    } : null,
    focusedPasses: hadFocusedPasses,
  };
}

// ======================== TREND ANALYSIS ========================

/**
 * Analyze historical trends and produce recommendations for the next run.
 *
 * @param {Array} history - Array of historical run entries
 * @returns {object} Recommendations
 */
function analyzeHistory(history) {
  if (!history || history.length === 0) {
    return {
      hasData: false,
      recommendations: [],
      budgetAdjustment: 0,
      compilationBudgetAdjustment: 0,
      qualityThresholdAdjustment: 0,
      avgQuality: 0,
      trend: 'none',
      runCount: 0,
    };
  }

  const recent = history.slice(-10); // Last 10 runs
  const recommendations = [];

  // Quality trend
  const qualities = recent.map(r => r.quality?.avgScore || 0).filter(q => q > 0);
  const avgQuality = qualities.length > 0
    ? qualities.reduce((a, b) => a + b, 0) / qualities.length
    : 0;

  // Determine trend direction
  let trend = 'stable';
  if (qualities.length >= 3) {
    const firstHalf = qualities.slice(0, Math.floor(qualities.length / 2));
    const secondHalf = qualities.slice(Math.floor(qualities.length / 2));
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    if (secondAvg > firstAvg + 5) trend = 'improving';
    else if (secondAvg < firstAvg - 5) trend = 'declining';
  }

  // Budget adjustment — if quality is consistently low, boost budget
  let budgetAdjustment = 0;
  let compilationBudgetAdjustment = 0;
  let qualityThresholdAdjustment = 0;

  if (avgQuality < 45 && qualities.length >= 3) {
    budgetAdjustment = 4096; // +4K tokens
    recommendations.push(
      `Low average quality (${avgQuality.toFixed(0)}/100) across ${qualities.length} runs — boosting thinking budget by +4096 tokens`
    );
  } else if (avgQuality > 80 && qualities.length >= 3) {
    budgetAdjustment = -2048; // Save tokens if quality is great
    recommendations.push(
      `High average quality (${avgQuality.toFixed(0)}/100) — reducing thinking budget by 2048 tokens to save cost`
    );
  }

  // Retry effectiveness
  const retryRuns = recent.filter(r => r.retry?.segmentsRetried > 0);
  if (retryRuns.length > 0) {
    const totalRetried = retryRuns.reduce((s, r) => s + (r.retry?.segmentsRetried || 0), 0);
    const totalImproved = retryRuns.reduce((s, r) => s + (r.retry?.retriesImproved || 0), 0);
    const retrySuccessRate = totalRetried > 0 ? (totalImproved / totalRetried * 100).toFixed(0) : 0;

    if (retrySuccessRate < 30 && totalRetried >= 3) {
      recommendations.push(
        `Retry success rate is low (${retrySuccessRate}% of ${totalRetried} retries improved) — consider increasing base thinking budget instead of relying on retries`
      );
      budgetAdjustment = Math.max(budgetAdjustment, 2048);
    }
  }

  // Cost efficiency
  const costs = recent.map(r => r.cost?.tokensPerItem || 0).filter(c => c > 0);
  if (costs.length >= 3) {
    const avgCostPerItem = costs.reduce((a, b) => a + b, 0) / costs.length;
    if (avgCostPerItem > 50000) {
      recommendations.push(
        `High token usage per item (${avgCostPerItem.toFixed(0)} tokens/item) — extraction may be inefficient`
      );
    }
  }

  // Compilation quality
  const compilationScores = recent.map(r => r.compilation?.score || 0).filter(s => s > 0);
  if (compilationScores.length >= 2) {
    const avgCompScore = compilationScores.reduce((a, b) => a + b, 0) / compilationScores.length;
    if (avgCompScore < 50) {
      compilationBudgetAdjustment = 4096;
      recommendations.push(
        `Low compilation quality (avg ${avgCompScore.toFixed(0)}/100) — boosting compilation budget by +4096`
      );
    }
  }

  // Focused pass effectiveness
  const focusedRuns = recent.filter(r => r.focusedPasses);
  if (focusedRuns.length > 0 && focusedRuns.length < recent.length * 0.3) {
    recommendations.push(
      `Focused re-analysis was used in ${focusedRuns.length}/${recent.length} runs — system is self-correcting effectively`
    );
  }

  // Quality threshold — if everything consistently passes, tighten threshold
  const failRuns = recent.filter(r => r.quality?.grades?.FAIL > 0);
  if (failRuns.length === 0 && recent.length >= 5 && avgQuality > 70) {
    qualityThresholdAdjustment = 5; // Raise PASS threshold by 5
    recommendations.push(
      `No quality failures in last ${recent.length} runs (avg ${avgQuality.toFixed(0)}) — consider raising quality threshold`
    );
  }

  return {
    hasData: true,
    recommendations,
    budgetAdjustment,
    compilationBudgetAdjustment,
    qualityThresholdAdjustment,
    avgQuality,
    trend,
    runCount: history.length,
  };
}

// ======================== PRINT INSIGHTS ========================

/**
 * Print learning insights to the console.
 *
 * @param {object} insights - From analyzeHistory()
 */
function printLearningInsights(insights) {
  if (!insights.hasData) return;

  console.log('');
  console.log('  📈 Learning Insights:');
  console.log(`    Historical runs : ${insights.runCount}`);
  console.log(`    Quality trend   : ${insights.trend} (avg: ${insights.avgQuality.toFixed(0)}/100)`);

  if (insights.budgetAdjustment !== 0) {
    const dir = insights.budgetAdjustment > 0 ? '+' : '';
    console.log(`    Budget adjust   : ${dir}${insights.budgetAdjustment} tokens (analysis)`);
  }
  if (insights.compilationBudgetAdjustment !== 0) {
    const dir = insights.compilationBudgetAdjustment > 0 ? '+' : '';
    console.log(`    Budget adjust   : ${dir}${insights.compilationBudgetAdjustment} tokens (compilation)`);
  }

  if (insights.recommendations.length > 0) {
    console.log('    Recommendations :');
    for (const rec of insights.recommendations) {
      console.log(`      • ${rec}`);
    }
  }
  console.log('');
}

module.exports = {
  loadHistory,
  saveHistory,
  buildHistoryEntry,
  analyzeHistory,
  printLearningInsights,
};
