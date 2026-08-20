'use strict';

/**
 * Recordings that were already sped up when captured.
 *
 * The invariant under test: the capture speed and the encode speed must never
 * compound. Whatever the source plays at, the finished segments land on the
 * requested speed *relative to the original meeting*, because every timestamp
 * the model reports is anchored to that clock.
 */

const { resolveSpeeds, SPEED } = require('../../src/config');
const { buildAtempoChain } = require('../../src/services/video');

/** Multiply out an -af chain so the product can be checked against the request. */
function atempoProduct(chain) {
  return chain.split(',').reduce((p, f) => p * parseFloat(f.replace('atempo=', '')), 1);
}

describe('resolveSpeeds', () => {
  it('leaves a real-time recording exactly as it behaved before', () => {
    const s = resolveSpeeds({});
    expect(s.sourceSpeed).toBe(1);
    expect(s.encodeSpeed).toBe(SPEED);
    expect(s.timelineSpeed).toBe(SPEED);
    expect(s.clamped).toBe(false);
  });

  it('subtracts the capture speed instead of compounding it', () => {
    // A 2x capture encoded at the usual 1.6x would land at 3.2x of the meeting.
    const s = resolveSpeeds({ sourceSpeed: 2 });
    expect(s.encodeSpeed).toBe(0.8);
    expect(s.timelineSpeed).toBe(1.6);
  });

  it('handles a fractional capture speed without float noise', () => {
    // 1.6 / 1.25 is 1.2800000000000002 in binary floating point.
    const s = resolveSpeeds({ sourceSpeed: 1.25 });
    expect(s.encodeSpeed).toBe(1.28);
    expect(s.timelineSpeed).toBe(1.6);
  });

  it('honours an explicit target above the capture speed', () => {
    const s = resolveSpeeds({ sourceSpeed: 1.5, speed: 3 });
    expect(s.encodeSpeed).toBe(2);
    expect(s.timelineSpeed).toBe(3);
  });

  it('reports the capture speed as the timeline under --no-compress', () => {
    // Nothing is re-encoded, so the segments still play at the capture speed —
    // and that is what maps their timestamps back onto the meeting clock.
    const s = resolveSpeeds({ sourceSpeed: 2, speed: 1.6, noCompress: true });
    expect(s.encodeSpeed).toBe(1);
    expect(s.timelineSpeed).toBe(2);
  });

  it('clamps an unreachable multiplier and says the timeline moved with it', () => {
    const s = resolveSpeeds({ sourceSpeed: 10, speed: 0.5 });
    expect(s.clamped).toBe(true);
    expect(s.encodeSpeed).toBe(0.1);
    // Timeline follows the file that was actually produced, not the request.
    expect(s.timelineSpeed).toBe(1);
  });

  it('falls back to the defaults for junk input', () => {
    expect(resolveSpeeds({ sourceSpeed: 0 }).sourceSpeed).toBe(1);
    expect(resolveSpeeds({ sourceSpeed: -2 }).sourceSpeed).toBe(1);
    expect(resolveSpeeds({ speed: 0 }).encodeSpeed).toBe(SPEED);
    expect(resolveSpeeds().timelineSpeed).toBe(SPEED);
  });
});

describe('buildAtempoChain', () => {
  it('passes an in-range factor through as a single filter', () => {
    expect(buildAtempoChain(1.6)).toBe('atempo=1.6');
    expect(buildAtempoChain(0.8)).toBe('atempo=0.8');
  });

  it('splits a slow-down below atempo\'s 0.5 floor into in-range steps', () => {
    // 1.6x target from a 4x capture — the encode speed ffmpeg would reject.
    const chain = buildAtempoChain(0.4);
    expect(chain).toBe('atempo=0.5,atempo=0.8');
    expect(atempoProduct(chain)).toBeCloseTo(0.4, 6);
  });

  it('splits a speed-up above atempo\'s 2.0 ceiling into in-range steps', () => {
    const chain = buildAtempoChain(5);
    expect(chain.split(',').every(f => {
      const v = parseFloat(f.replace('atempo=', ''));
      return v >= 0.5 && v <= 2.0;
    })).toBe(true);
    expect(atempoProduct(chain)).toBeCloseTo(5, 6);
  });

  it('keeps every step in range across the whole supported span', () => {
    for (const speed of [0.1, 0.25, 0.4, 0.5, 1, 1.28, 2, 2.5, 4, 10]) {
      const chain = buildAtempoChain(speed);
      for (const f of chain.split(',')) {
        const v = parseFloat(f.replace('atempo=', ''));
        expect(v).toBeGreaterThanOrEqual(0.5);
        expect(v).toBeLessThanOrEqual(2.0);
      }
      expect(atempoProduct(chain)).toBeCloseTo(speed, 6);
    }
  });
});
