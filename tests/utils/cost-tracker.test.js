'use strict';

const CostTracker = require('../../src/utils/cost-tracker');

const usage = (i, o, t) => ({ inputTokens: i, outputTokens: o, thoughtTokens: t, totalTokens: i + o + t });

describe('CostTracker', () => {
  it('starts empty', () => {
    const ct = new CostTracker();
    const s = ct.getSummary();
    expect(s.totalTokens).toBe(0);
    expect(s.totalCost).toBe(0);
    expect(s.segmentCount).toBe(0);
    expect(s.hasCompilation).toBe(false);
  });

  it('ignores null token usage', () => {
    const ct = new CostTracker();
    ct.addSegment('a', null, 10);
    ct.addCompilation(null, 10);
    expect(ct.getSummary().segmentCount).toBe(0);
  });

  it('aggregates tokens across segments + compilation', () => {
    const ct = new CostTracker();
    ct.addSegment('s1', usage(1000, 500, 200), 1000);
    ct.addSegment('s2', usage(2000, 800, 300), 1500);
    ct.addCompilation(usage(500, 400, 100), 800);
    const s = ct.getSummary();
    expect(s.inputTokens).toBe(3500);
    expect(s.outputTokens).toBe(1700);
    expect(s.thinkingTokens).toBe(600);
    expect(s.totalTokens).toBe(1700 + 3500 + 600);
    expect(s.totalDurationMs).toBe(3300);
    expect(s.segmentCount).toBe(2);
    expect(s.hasCompilation).toBe(true);
  });

  it('computes cost with default pricing', () => {
    const ct = new CostTracker(); // input 0.30/M, output 2.50/M, thinking 2.50/M
    ct.addSegment('s1', usage(1000, 500, 200), 0);
    const s = ct.getSummary();
    expect(s.inputCost).toBeCloseTo(1000 / 1e6 * 0.30, 10);
    expect(s.outputCost).toBeCloseTo(500 / 1e6 * 2.50, 10);
    expect(s.thinkingCost).toBeCloseTo(200 / 1e6 * 2.50, 10);
    expect(s.totalCost).toBeCloseTo(s.inputCost + s.outputCost + s.thinkingCost, 10);
  });

  it('applies long-context rates when input exceeds the threshold', () => {
    const ct = new CostTracker({
      inputPerM: 1, inputLongPerM: 2,
      outputPerM: 10, outputLongPerM: 20,
      thinkingPerM: 10, longContextThreshold: 200000,
    });
    ct.addSegment('long', usage(250000, 1000, 0), 0); // input > threshold
    const s = ct.getSummary();
    // long input rate = 2/M
    expect(s.inputCost).toBeCloseTo(250000 / 1e6 * 2, 6);
    // long output rate = 20/M
    expect(s.outputCost).toBeCloseTo(1000 / 1e6 * 20, 6);
  });

  it('counts cached vs fresh segments', () => {
    const ct = new CostTracker();
    ct.addSegment('a', usage(10, 10, 0), 0, true);
    ct.addSegment('b', usage(10, 10, 0), 0, false);
    ct.addSegment('c', usage(10, 10, 0), 0, true);
    const s = ct.getSummary();
    expect(s.cachedSegments).toBe(2);
    expect(s.freshSegments).toBe(1);
  });

  it('exposes a per-segment breakdown', () => {
    const ct = new CostTracker();
    ct.addSegment('seg_00', usage(100, 50, 10), 1234);
    const s = ct.getSummary();
    expect(s.perSegment).toHaveLength(1);
    expect(s.perSegment[0].name).toBe('seg_00');
    expect(s.perSegment[0].durationMs).toBe(1234);
    expect(s.perSegment[0].cost).toBeGreaterThan(0);
  });
});
