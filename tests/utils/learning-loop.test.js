'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadHistory, saveHistory, buildHistoryEntry, analyzeHistory,
} = require('../../src/utils/learning-loop');

function qualityRun(avgScore) {
  return { quality: { avgScore }, retry: {}, cost: {}, compilation: null };
}

describe('history I/O', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-ll-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('loadHistory returns [] when no history file exists', () => {
    expect(loadHistory(root)).toEqual([]);
  });

  it('saveHistory then loadHistory round-trips entries', () => {
    saveHistory(root, { callName: 'a', quality: { avgScore: 70 } });
    saveHistory(root, { callName: 'b', quality: { avgScore: 80 } });
    const hist = loadHistory(root);
    expect(hist).toHaveLength(2);
    expect(hist[0].callName).toBe('a');
    expect(hist[1].callName).toBe('b');
  });

  it('loadHistory returns [] on corrupt JSON (no throw)', () => {
    fs.writeFileSync(path.join(root, '.taskex-history.json'), '{not json');
    expect(loadHistory(root)).toEqual([]);
  });
});

describe('buildHistoryEntry', () => {
  it('maps a health report into a compact entry with defaults', () => {
    const entry = buildHistoryEntry({
      callName: 'call-1',
      healthReport: {
        summary: { avgQualityScore: 75, minQualityScore: 60, maxQualityScore: 90, parseSuccessRate: 100, grades: { PASS: 2 } },
        extraction: { totalItems: 10, totalTickets: 4, totalActionItems: 3 },
        retry: { segmentsRetried: 1, retriesImproved: 1 },
        efficiency: { tokensPerExtractedItem: 500 },
      },
      costSummary: { totalTokens: 5000, totalCost: 0.1 },
      segmentCount: 2,
      baseBudget: 24576,
    });
    expect(entry.callName).toBe('call-1');
    expect(entry.quality.avgScore).toBe(75);
    expect(entry.extraction.totalItems).toBe(10);
    expect(entry.cost.totalTokens).toBe(5000);
    expect(entry.budgets.baseBudget).toBe(24576);
    expect(entry.segmentCount).toBe(2);
  });

  it('tolerates a missing health report', () => {
    const entry = buildHistoryEntry({ callName: 'x' });
    expect(entry.quality.avgScore).toBe(0);
    expect(entry.extraction.totalItems).toBe(0);
    expect(entry.compilation).toBeNull();
  });
});

describe('analyzeHistory', () => {
  it('reports no data for empty history', () => {
    const r = analyzeHistory([]);
    expect(r.hasData).toBe(false);
    expect(r.budgetAdjustment).toBe(0);
  });

  it('boosts budget when average quality is consistently low', () => {
    const r = analyzeHistory([qualityRun(40), qualityRun(42), qualityRun(38)]);
    expect(r.budgetAdjustment).toBe(4096);
    expect(r.recommendations.join(' ')).toMatch(/[Ll]ow average quality/);
  });

  it('reduces budget when quality is consistently high', () => {
    const r = analyzeHistory([qualityRun(85), qualityRun(88), qualityRun(90)]);
    expect(r.budgetAdjustment).toBe(-2048);
  });

  it('detects an improving trend', () => {
    const r = analyzeHistory([qualityRun(50), qualityRun(55), qualityRun(75), qualityRun(80)]);
    expect(r.trend).toBe('improving');
  });

  it('boosts compilation budget when compilation quality is low', () => {
    const runs = [
      { quality: { avgScore: 70 }, retry: {}, cost: {}, compilation: { score: 40 } },
      { quality: { avgScore: 70 }, retry: {}, cost: {}, compilation: { score: 45 } },
    ];
    const r = analyzeHistory(runs);
    expect(r.compilationBudgetAdjustment).toBe(4096);
  });
});
