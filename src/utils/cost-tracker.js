/**
 * CostTracker — tracks Gemini API token usage and estimates cost.
 *
 * Pricing (Gemini 2.5 Flash, as of 2025):
 *   Input:    $0.15  per 1M tokens (≤200K), $0.35 per 1M (>200K)
 *   Output:   $0.60  per 1M tokens (≤200K), $1.50 per 1M (>200K)
 *   Thinking: $0.70  per 1M tokens
 *
 * Prices are updated via config if the model/pricing changes.
 */

'use strict';

// Default pricing per million tokens (Gemini 2.5 Flash)
const DEFAULT_PRICING = {
  inputPerM: 0.15,
  inputLongPerM: 0.35,    // >200K context
  outputPerM: 0.60,
  outputLongPerM: 1.50,   // >200K context
  thinkingPerM: 0.70,
  longContextThreshold: 200_000,
};

class CostTracker {
  /**
   * @param {object} [pricing] - Override default pricing
   */
  constructor(pricing = {}) {
    this.pricing = { ...DEFAULT_PRICING, ...pricing };
    this.segments = [];
    this.compilation = null;
  }

  /**
   * Record token usage for a segment analysis.
   * @param {string} segmentName - e.g. "segment_00.mp4"
   * @param {object} tokenUsage - { inputTokens, outputTokens, thoughtTokens, totalTokens }
   * @param {number} durationMs - Wall-clock time
   * @param {boolean} [cached=false] - Whether this was loaded from cache
   */
  addSegment(segmentName, tokenUsage, durationMs, cached = false) {
    if (!tokenUsage) return;
    this.segments.push({
      name: segmentName,
      input: tokenUsage.inputTokens || 0,
      output: tokenUsage.outputTokens || 0,
      thinking: tokenUsage.thoughtTokens || 0,
      total: tokenUsage.totalTokens || 0,
      durationMs: durationMs || 0,
      cached,
    });
  }

  /**
   * Record token usage for the final compilation step.
   * @param {object} tokenUsage
   * @param {number} durationMs
   */
  addCompilation(tokenUsage, durationMs) {
    if (!tokenUsage) return;
    this.compilation = {
      input: tokenUsage.inputTokens || 0,
      output: tokenUsage.outputTokens || 0,
      thinking: tokenUsage.thoughtTokens || 0,
      total: tokenUsage.totalTokens || 0,
      durationMs: durationMs || 0,
    };
  }

  /**
   * Calculate cost for a given token count and rate.
   * @param {number} tokens
   * @param {number} inputTokens - total input tokens (for long-context detection)
   * @param {'input'|'output'|'thinking'} type
   * @returns {number} Cost in USD
   */
  _calcCost(tokens, inputTokens, type) {
    if (tokens === 0) return 0;
    const p = this.pricing;
    const isLong = inputTokens > p.longContextThreshold;

    let ratePerM;
    switch (type) {
      case 'input':
        ratePerM = isLong ? p.inputLongPerM : p.inputPerM;
        break;
      case 'output':
        ratePerM = isLong ? p.outputLongPerM : p.outputPerM;
        break;
      case 'thinking':
        ratePerM = p.thinkingPerM;
        break;
      default:
        ratePerM = 0;
    }

    return (tokens / 1_000_000) * ratePerM;
  }

  /**
   * Get aggregated summary of all tracked usage.
   * @returns {object} Summary with token counts, costs, and per-segment breakdown.
   */
  getSummary() {
    const all = [...this.segments];
    if (this.compilation) all.push(this.compilation);

    const inputTokens = all.reduce((s, e) => s + e.input, 0);
    const outputTokens = all.reduce((s, e) => s + e.output, 0);
    const thinkingTokens = all.reduce((s, e) => s + e.thinking, 0);
    const totalTokens = all.reduce((s, e) => s + e.total, 0);
    const totalDurationMs = all.reduce((s, e) => s + e.durationMs, 0);

    // Cost calculation — segment-level (each segment has its own context size)
    let inputCost = 0;
    let outputCost = 0;
    let thinkingCost = 0;

    for (const entry of all) {
      inputCost += this._calcCost(entry.input, entry.input, 'input');
      outputCost += this._calcCost(entry.output, entry.input, 'output');
      thinkingCost += this._calcCost(entry.thinking, entry.input, 'thinking');
    }

    const totalCost = inputCost + outputCost + thinkingCost;

    const cachedSegments = this.segments.filter(s => s.cached).length;
    const freshSegments = this.segments.filter(s => !s.cached).length;

    return {
      inputTokens,
      outputTokens,
      thinkingTokens,
      totalTokens,
      totalDurationMs,
      inputCost,
      outputCost,
      thinkingCost,
      totalCost,
      segmentCount: this.segments.length,
      cachedSegments,
      freshSegments,
      hasCompilation: !!this.compilation,
      perSegment: this.segments.map(s => ({
        name: s.name,
        tokens: s.total,
        cost: this._calcCost(s.input, s.input, 'input')
          + this._calcCost(s.output, s.input, 'output')
          + this._calcCost(s.thinking, s.input, 'thinking'),
        durationMs: s.durationMs,
        cached: s.cached,
      })),
    };
  }
}

module.exports = CostTracker;
