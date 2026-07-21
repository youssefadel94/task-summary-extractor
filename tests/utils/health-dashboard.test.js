'use strict';

const { buildHealthReport } = require('../../src/utils/health-dashboard');

function segReport(over = {}) {
  return {
    segmentName: over.segmentName || 'seg',
    qualityReport: { grade: over.grade || 'PASS', score: over.score ?? 80, issues: over.issues || [] },
    retried: over.retried || false,
    retryImproved: over.retryImproved || false,
  };
}

describe('buildHealthReport', () => {
  it('handles empty inputs without dividing by zero', () => {
    const r = buildHealthReport({});
    expect(r.summary.totalSegments).toBe(0);
    expect(r.summary.parseSuccessRate).toBe(0);
    expect(r.summary.avgQualityScore).toBe(0);
    expect(r.extraction.totalItems).toBe(0);
    expect(r.efficiency.tokensPerExtractedItem).toBe(0);
  });

  it('computes parse rate, score stats, and grade distribution', () => {
    const report = buildHealthReport({
      segmentReports: [
        segReport({ grade: 'PASS', score: 90 }),
        segReport({ grade: 'WARN', score: 60 }),
        segReport({ grade: 'FAIL', score: 30 }),
      ],
    });
    // 2 of 3 not FAIL -> 66.7%
    expect(report.summary.parseSuccessRate).toBeCloseTo(66.7, 1);
    expect(report.summary.avgQualityScore).toBeCloseTo(60, 1);
    expect(report.summary.minQualityScore).toBe(30);
    expect(report.summary.maxQualityScore).toBe(90);
    expect(report.summary.grades).toEqual({ PASS: 1, WARN: 1, FAIL: 1 });
  });

  it('aggregates extraction density across segment analyses', () => {
    const report = buildHealthReport({
      allSegmentAnalyses: [
        { tickets: [{}, {}], action_items: [{}], blockers: [{}] },
        { tickets: [{}], change_requests: [{}], scope_changes: [{}, {}] },
      ],
    });
    expect(report.extraction.totalTickets).toBe(3);
    expect(report.extraction.totalActionItems).toBe(1);
    expect(report.extraction.totalChangeRequests).toBe(1);
    expect(report.extraction.totalBlockers).toBe(1);
    expect(report.extraction.totalScopeChanges).toBe(2);
    expect(report.extraction.totalItems).toBe(8);
    expect(report.extraction.perSegment).toHaveLength(2);
  });

  it('computes token efficiency and carries cost through', () => {
    const report = buildHealthReport({
      allSegmentAnalyses: [{ tickets: [{}, {}], action_items: [{}, {}] }], // 4 items
      costSummary: { totalTokens: 4000, totalCost: 0.12, totalDurationMs: 5000 },
    });
    expect(report.efficiency.tokensPerExtractedItem).toBe(1000);
    expect(report.efficiency.totalCost).toBe(0.12);
    expect(report.efficiency.totalTokens).toBe(4000);
  });

  it('counts retries and collects issues', () => {
    const report = buildHealthReport({
      segmentReports: [
        segReport({ segmentName: 's1', retried: true, retryImproved: true, issues: ['low density'] }),
        segReport({ segmentName: 's2', retried: true, retryImproved: false }),
      ],
    });
    expect(report.retry.segmentsRetried).toBe(2);
    expect(report.retry.retriesImproved).toBe(1);
    expect(report.issues).toEqual([{ segment: 's1', issue: 'low density' }]);
  });

  it('includes compilation quality when provided', () => {
    const report = buildHealthReport({
      compilationQuality: { score: 88, grade: 'PASS', issues: [] },
    });
    expect(report.compilation).toEqual({ score: 88, grade: 'PASS', issues: [] });
  });
});
