'use strict';

const { c, strip } = require('../../src/utils/colors');

describe('strip', () => {
  it('removes ANSI escape codes', () => {
    const colored = '\x1b[31mred\x1b[0m';
    expect(strip(colored)).toBe('red');
  });
  it('leaves plain text unchanged', () => {
    expect(strip('plain')).toBe('plain');
  });
  it('handles empty / nullish input', () => {
    expect(strip('')).toBe('');
  });
});

describe('color helpers', () => {
  it('preserve the underlying text (strip round-trips)', () => {
    for (const fn of ['red', 'green', 'yellow', 'blue', 'cyan', 'bold', 'dim']) {
      expect(strip(c[fn]('hello'))).toBe('hello');
    }
  });

  it('semantic helpers include their marker and text', () => {
    expect(strip(c.warn('careful'))).toContain('careful');
    expect(strip(c.error('boom'))).toContain('boom');
    expect(strip(c.success('done'))).toContain('done');
    expect(strip(c.info('note'))).toContain('note');
  });

  it('every helper returns a string', () => {
    for (const key of Object.keys(c)) {
      expect(typeof c[key]('x')).toBe('string');
    }
  });
});
