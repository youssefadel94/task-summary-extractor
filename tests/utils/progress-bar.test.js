/**
 * Tests for src/utils/progress-bar.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProgressBar, createProgressBar, PHASES, PHASE_MAP } from '../../src/utils/progress-bar.js';

// Helper: create a mock writable stream that captures output
function mockStream(isTTY = true) {
  const chunks = [];
  return {
    isTTY,
    write: vi.fn((data) => { chunks.push(data); return true; }),
    chunks,
  };
}

describe('PHASES constant', () => {
  it('has 11 phase definitions', () => {
    expect(PHASES).toHaveLength(11);
  });

  it('each phase has key, label, index', () => {
    for (const phase of PHASES) {
      expect(phase).toHaveProperty('key');
      expect(phase).toHaveProperty('label');
      expect(phase).toHaveProperty('index');
      expect(typeof phase.key).toBe('string');
      expect(typeof phase.label).toBe('string');
      expect(typeof phase.index).toBe('number');
    }
  });

  it('indexes are sequential 1 through 11', () => {
    const indexes = PHASES.map(p => p.index);
    expect(indexes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

describe('PHASE_MAP', () => {
  it('maps keys to phase objects', () => {
    expect(PHASE_MAP.init.label).toBe('Init');
    expect(PHASE_MAP.analyze.index).toBe(7);
    expect(PHASE_MAP['deep-dive'].label).toBe('Deep Dive');
  });

  it('has entries for all PHASES', () => {
    for (const phase of PHASES) {
      expect(PHASE_MAP[phase.key]).toBe(phase);
    }
  });
});

describe('ProgressBar constructor', () => {
  it('creates with defaults', () => {
    const stream = mockStream();
    const bar = new ProgressBar({ stream });
    expect(bar.width).toBe(40);
    expect(bar.enabled).toBe(true);
    expect(bar.phaseKey).toBe('init');
    expect(bar.phaseIndex).toBe(1);
    expect(bar.total).toBe(0);
    expect(bar.current).toBe(0);
  });

  it('respects custom width', () => {
    const bar = new ProgressBar({ stream: mockStream(), width: 20 });
    expect(bar.width).toBe(20);
  });

  it('disables on non-TTY stream', () => {
    const bar = new ProgressBar({ stream: mockStream(false) });
    expect(bar.enabled).toBe(false);
  });

  it('force enable overrides TTY detection', () => {
    const bar = new ProgressBar({ stream: mockStream(false), enabled: true });
    expect(bar.enabled).toBe(true);
  });

  it('stores callName and costTracker', () => {
    const tracker = { getSummary: () => ({}) };
    const bar = new ProgressBar({ stream: mockStream(), callName: 'test', costTracker: tracker });
    expect(bar.callName).toBe('test');
    expect(bar.costTracker).toBe(tracker);
  });
});

describe('setPhase()', () => {
  let bar, stream;

  beforeEach(() => {
    stream = mockStream();
    bar = new ProgressBar({ stream });
  });

  it('updates phase key and label for known phase', () => {
    bar.setPhase('analyze');
    expect(bar.phaseKey).toBe('analyze');
    expect(bar.phaseLabel).toBe('Analyze');
    expect(bar.phaseIndex).toBe(7);
  });

  it('handles unknown phase key gracefully', () => {
    bar.setPhase('custom-phase');
    expect(bar.phaseKey).toBe('custom-phase');
    expect(bar.phaseLabel).toBe('custom-phase');
  });

  it('resets current, total, and labels', () => {
    bar.current = 5;
    bar.total = 10;
    bar.itemLabel = 'old';
    bar.subStatus = 'old status';
    bar.setPhase('compile', 3);
    expect(bar.current).toBe(0);
    expect(bar.total).toBe(3);
    expect(bar.itemLabel).toBe('');
    expect(bar.subStatus).toBe('');
  });

  it('renders on TTY', () => {
    bar.setPhase('services');
    // Should have written to stream (clear line + render)
    expect(stream.write).toHaveBeenCalled();
  });

  it('logs event on non-TTY', () => {
    const ntStream = mockStream(false);
    const ntBar = new ProgressBar({ stream: ntStream });
    ntBar.setPhase('compile', 5);
    expect(ntStream.write).toHaveBeenCalled();
    const output = ntStream.chunks.join('');
    expect(output).toContain('Compile');
  });
});

describe('setTotal()', () => {
  it('updates total and triggers render', () => {
    const stream = mockStream();
    const bar = new ProgressBar({ stream });
    bar.setTotal(10);
    expect(bar.total).toBe(10);
    expect(stream.write).toHaveBeenCalled();
  });
});

describe('tick()', () => {
  let bar, stream;

  beforeEach(() => {
    stream = mockStream();
    bar = new ProgressBar({ stream });
    bar.setPhase('analyze', 5);
  });

  it('increments current by 1', () => {
    bar.tick();
    expect(bar.current).toBe(1);
    bar.tick();
    expect(bar.current).toBe(2);
  });

  it('updates item label', () => {
    bar.tick('segment_01.mp4');
    expect(bar.itemLabel).toBe('segment_01.mp4');
  });

  it('clears subStatus on tick', () => {
    bar.subStatus = 'uploading...';
    bar.tick('done');
    expect(bar.subStatus).toBe('');
  });

  it('does not decrement current below total', () => {
    bar.setPhase('analyze', 3);
    bar.tick(); bar.tick(); bar.tick();
    expect(bar.current).toBe(3);
    bar.tick(); // should increment beyond total
    expect(bar.current).toBe(4);
  });

  it('logs on non-TTY with label', () => {
    const ntStream = mockStream(false);
    const ntBar = new ProgressBar({ stream: ntStream });
    ntBar.setPhase('analyze', 3);
    ntBar.tick('file.mp4');
    const output = ntStream.chunks.join('');
    expect(output).toContain('file.mp4');
  });
});

describe('status()', () => {
  it('updates subStatus and renders', () => {
    const stream = mockStream();
    const bar = new ProgressBar({ stream });
    bar.status('Uploading to Storage...');
    expect(bar.subStatus).toBe('Uploading to Storage...');
    expect(stream.write).toHaveBeenCalled();
  });
});

describe('render()', () => {
  it('produces a bar string with phase info', () => {
    const stream = mockStream();
    const bar = new ProgressBar({ stream, width: 10 });
    bar.setPhase('analyze', 10);
    bar.tick('seg1');
    bar.tick('seg2');

    const output = stream.chunks.join('');
    expect(output).toContain('Analyze');
    expect(output).toContain('2/10');
    expect(output).toContain('%');
  });

  it('does not render when disabled', () => {
    const stream = mockStream(false);
    const bar = new ProgressBar({ stream, enabled: false });
    stream.write.mockClear();
    bar.render();
    expect(stream.write).not.toHaveBeenCalled();
  });

  it('shows cost from costTracker', () => {
    const stream = mockStream();
    const tracker = {
      getSummary: () => ({ totalCost: 0.1234 }),
    };
    const bar = new ProgressBar({ stream, width: 10, costTracker: tracker });
    bar.setPhase('compile', 1);
    bar.tick('done');

    const output = stream.chunks.join('');
    expect(output).toContain('$0.1234');
  });

  it('handles costTracker errors gracefully', () => {
    const stream = mockStream();
    const tracker = {
      getSummary: () => { throw new Error('not ready'); },
    };
    const bar = new ProgressBar({ stream, width: 10, costTracker: tracker });
    // Should not throw
    bar.setPhase('compile', 1);
    bar.tick('done');
    expect(stream.write).toHaveBeenCalled();
  });
});

describe('finish()', () => {
  it('prints final line with elapsed time', () => {
    const stream = mockStream();
    const bar = new ProgressBar({ stream, width: 10 });
    bar.setPhase('analyze', 2);
    bar.tick();
    bar.tick();
    bar.finish();

    const output = stream.chunks.join('');
    expect(output).toContain('Done in');
  });

  it('does not print if never rendered', () => {
    const stream = mockStream();
    const bar = new ProgressBar({ stream, enabled: false });
    bar.finish();
    // Should not have written anything
    expect(stream.write).not.toHaveBeenCalled();
  });
});

describe('cleanup()', () => {
  it('clears the line if rendered', () => {
    const stream = mockStream();
    const bar = new ProgressBar({ stream, width: 10 });
    bar.setPhase('init');
    bar.render();
    const callCountBefore = stream.write.mock.calls.length;
    bar.cleanup();
    expect(stream.write.mock.calls.length).toBeGreaterThan(callCountBefore);
  });

  it('does nothing if never rendered', () => {
    const stream = mockStream();
    const bar = new ProgressBar({ stream, enabled: false });
    bar.cleanup();
    expect(stream.write).not.toHaveBeenCalled();
  });
});

describe('ETA calculation', () => {
  it('returns null when total is 0', () => {
    const bar = new ProgressBar({ stream: mockStream() });
    expect(bar._eta()).toBeNull();
  });

  it('returns null when current is 0', () => {
    const bar = new ProgressBar({ stream: mockStream() });
    bar.total = 5;
    expect(bar._eta()).toBeNull();
  });

  it('returns null within first 2 seconds', () => {
    const bar = new ProgressBar({ stream: mockStream() });
    bar.total = 10;
    bar.current = 1;
    bar.phaseStartTime = Date.now(); // just started
    expect(bar._eta()).toBeNull();
  });

  it('returns a string when enough time has passed', () => {
    const bar = new ProgressBar({ stream: mockStream() });
    bar.total = 10;
    bar.current = 2;
    bar.phaseStartTime = Date.now() - 10000; // 10 seconds ago
    const eta = bar._eta();
    expect(typeof eta).toBe('string');
    expect(eta.length).toBeGreaterThan(0);
  });
});

describe('createProgressBar factory', () => {
  it('returns a ProgressBar instance', () => {
    const bar = createProgressBar({ stream: mockStream() });
    expect(bar).toBeInstanceOf(ProgressBar);
  });

  it('passes options through', () => {
    const bar = createProgressBar({ stream: mockStream(), width: 50, callName: 'test' });
    expect(bar.width).toBe(50);
    expect(bar.callName).toBe('test');
  });
});
