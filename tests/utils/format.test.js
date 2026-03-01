const { fmtDuration, formatHMS, fmtBytes } = require('../../src/utils/format');

describe('fmtDuration', () => {
  it('formats 0 seconds as "0:00"', () => {
    expect(fmtDuration(0)).toBe('0:00');
  });

  it('formats 65 seconds as "1:05"', () => {
    expect(fmtDuration(65)).toBe('1:05');
  });

  it('formats 3661 seconds as "61:01"', () => {
    expect(fmtDuration(3661)).toBe('61:01');
  });

  it('returns "unknown" for null', () => {
    expect(fmtDuration(null)).toBe('unknown');
  });

  it('returns "unknown" for undefined', () => {
    expect(fmtDuration(undefined)).toBe('unknown');
  });
});

describe('formatHMS', () => {
  it('formats 0 seconds as "00:00:00"', () => {
    expect(formatHMS(0)).toBe('00:00:00');
  });

  it('formats 3661 seconds as "01:01:01"', () => {
    expect(formatHMS(3661)).toBe('01:01:01');
  });

  it('returns "??:??:??" for null', () => {
    expect(formatHMS(null)).toBe('??:??:??');
  });

  it('formats 86399 seconds as "23:59:59"', () => {
    expect(formatHMS(86399)).toBe('23:59:59');
  });
});

describe('fmtBytes', () => {
  it('formats bytes below 1024 as "N B"', () => {
    expect(fmtBytes(500)).toBe('500 B');
  });

  it('formats kilobytes with 1 decimal as "N.N KB"', () => {
    expect(fmtBytes(1536)).toBe('1.5 KB');
  });

  it('formats megabytes with 2 decimals as "N.NN MB"', () => {
    expect(fmtBytes(10485760)).toBe('10.00 MB');
  });

  it('formats gigabytes with 2 decimals as "N.NN GB"', () => {
    expect(fmtBytes(1073741824)).toBe('1.00 GB');
  });
});
