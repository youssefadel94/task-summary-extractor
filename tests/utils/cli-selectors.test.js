'use strict';

/**
 * Exercises the interactive Custom-flow selectors end-to-end through their
 * non-TTY fallbacks by driving a real stdin stream. This covers both the cli.js
 * selector wrappers AND the interactive.js readline fallbacks.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';

const {
  selectFormats, selectConfidence, selectRunMode, selectFeatureFlags,
} = require('../../src/utils/cli');

// Temporarily replace process.stdin with a controllable non-TTY stream, run fn,
// then feed it `input` (so readline is already listening), and restore.
function withStdin(input, fn) {
  const orig = Object.getOwnPropertyDescriptor(process, 'stdin');
  const mock = new PassThrough();
  mock.isTTY = false;
  Object.defineProperty(process, 'stdin', { value: mock, configurable: true });
  const p = Promise.resolve().then(fn);
  setImmediate(() => mock.write(input));
  return p.finally(() => Object.defineProperty(process, 'stdin', orig));
}

// ---------------------------------------------------------------------------
// selectFormats (selectMany fallback) — ALL_FORMATS order: md, html, pdf, docx, json
// ---------------------------------------------------------------------------

describe('selectFormats (non-TTY)', () => {
  it('parses a comma list into a format set', async () => {
    const set = await withStdin('1,2\n', () => selectFormats());
    expect([...set].sort()).toEqual(['html', 'md']);
  }, 8000);

  it('empty input selects all formats', async () => {
    const set = await withStdin('\n', () => selectFormats());
    expect([...set].sort()).toEqual(['docx', 'html', 'json', 'md', 'pdf']);
  }, 8000);

  it('"a" selects all formats', async () => {
    const set = await withStdin('a\n', () => selectFormats());
    expect(set.size).toBe(5);
  }, 8000);
});

// ---------------------------------------------------------------------------
// selectConfidence (selectOne fallback) — [All(null), Low+, Medium+, High]
// ---------------------------------------------------------------------------

describe('selectConfidence (non-TTY)', () => {
  it('choice 4 → high', async () => {
    expect(await withStdin('4\n', () => selectConfidence())).toBe('high');
  }, 8000);

  it('choice 1 → null (All)', async () => {
    expect(await withStdin('1\n', () => selectConfidence())).toBeNull();
  }, 8000);

  it('choice 3 → medium', async () => {
    expect(await withStdin('3\n', () => selectConfidence())).toBe('medium');
  }, 8000);
});

// ---------------------------------------------------------------------------
// selectRunMode (selectOne fallback) — [fast, balanced, detailed, custom, dynamic]
// ---------------------------------------------------------------------------

describe('selectRunMode (non-TTY)', () => {
  it('choice 4 → custom', async () => {
    expect(await withStdin('4\n', () => selectRunMode())).toBe('custom');
  }, 8000);

  it('choice 5 → dynamic', async () => {
    expect(await withStdin('5\n', () => selectRunMode())).toBe('dynamic');
  }, 8000);

  it('empty input → balanced (default)', async () => {
    expect(await withStdin('\n', () => selectRunMode())).toBe('balanced');
  }, 8000);
});

// ---------------------------------------------------------------------------
// selectFeatureFlags (selectMany fallback) — inversion mapping through real stdin
// ordered: [deepSummary, deepDive, disableFocusedPass, disableLearning,
//           disableDiff, disableProgress, noBatch]
// ---------------------------------------------------------------------------

describe('selectFeatureFlags (non-TTY) — inversion mapping', () => {
  it('selecting only Deep Dive (2) turns it on and disables every inverted feature', async () => {
    const result = await withStdin('2\n', () => selectFeatureFlags({}));
    expect(result.deepDive).toBe(true);
    expect(result.deepSummary).toBe(false);
    // inverted features not selected → disabled = true
    expect(result.disableFocusedPass).toBe(true);
    expect(result.disableLearning).toBe(true);
    expect(result.disableDiff).toBe(true);
    expect(result.disableProgress).toBe(true);
    expect(result.noBatch).toBe(true);
  }, 8000);

  it('selecting Focused Pass (3) keeps that feature ON (disable=false)', async () => {
    const result = await withStdin('3\n', () => selectFeatureFlags({}));
    expect(result.disableFocusedPass).toBe(false); // feature ON → not disabled
    expect(result.disableLearning).toBe(true);      // not selected → disabled
    expect(result.deepDive).toBe(false);
  }, 8000);

  it('empty input selects all → all features ON (no inverted feature disabled)', async () => {
    const result = await withStdin('\n', () => selectFeatureFlags({}));
    expect(result.deepSummary).toBe(true);
    expect(result.deepDive).toBe(true);
    expect(result.disableFocusedPass).toBe(false);
    expect(result.disableLearning).toBe(false);
    expect(result.disableDiff).toBe(false);
    expect(result.disableProgress).toBe(false);
    expect(result.noBatch).toBe(false);
  }, 8000);
});
