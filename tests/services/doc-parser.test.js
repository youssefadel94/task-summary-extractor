'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseDocument, canParse, stripHtml, PARSER_MAP } = require('../../src/services/doc-parser');

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-doc-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return { p, dir };
}

// ---------------------------------------------------------------------------
// canParse
// ---------------------------------------------------------------------------

describe('canParse', () => {
  it('recognises known extensions (case-insensitive)', () => {
    expect(canParse('.pdf')).toBe(true);
    expect(canParse('.docx')).toBe(true);
    expect(canParse('.JSON')).toBe(true);
    expect(canParse('.html')).toBe(true);
  });
  it('rejects extensions this module does not handle', () => {
    // Plain-text formats (.txt/.md/.csv/.vtt) are inlined elsewhere, not via doc-parser.
    expect(canParse('.txt')).toBe(false);
    expect(canParse('.md')).toBe(false);
    expect(canParse('.xyz')).toBe(false);
    expect(canParse('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------

describe('stripHtml', () => {
  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
    expect(stripHtml(null)).toBe('');
  });
  it('strips tags and decodes entities', () => {
    const out = stripHtml('<p>Hello &amp; <b>world</b> &lt;3</p>');
    expect(out).toContain('Hello & world <3');
    expect(out).not.toContain('<b>');
  });
  it('converts headings and list items to markdown-ish text', () => {
    const out = stripHtml('<h1>Title</h1><ul><li>a</li><li>b</li></ul>');
    expect(out).toContain('# Title');
    expect(out).toContain('- a');
    expect(out).toContain('- b');
  });
});

// ---------------------------------------------------------------------------
// parseDocument — text-based files
// ---------------------------------------------------------------------------

describe('parseDocument (text formats)', () => {
  it('parses a .json file as raw text and strips a BOM', async () => {
    const { p, dir } = tmpFile('data.json', '﻿{"a":1}');
    try {
      const res = await parseDocument(p, { silent: true });
      expect(res.success).toBe(true);
      expect(res.parser).toBe('builtin-text');
      expect(res.text).toBe('{"a":1}');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('parses an .xml file as raw text', async () => {
    const { p, dir } = tmpFile('data.xml', '<root><a>1</a></root>');
    try {
      const res = await parseDocument(p, { silent: true });
      expect(res.success).toBe(true);
      expect(res.text).toContain('<a>1</a>');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('parses an .html file to stripped text', async () => {
    const { p, dir } = tmpFile('page.html', '<html><body><p>Body text</p></body></html>');
    try {
      const res = await parseDocument(p, { silent: true });
      expect(res.success).toBe(true);
      expect(res.text).toContain('Body text');
      expect(res.text).not.toContain('<p>');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('truncates when maxLength is set and notes it in warnings', async () => {
    const { p, dir } = tmpFile('big.xml', 'x'.repeat(500));
    try {
      const res = await parseDocument(p, { silent: true, maxLength: 100 });
      expect(res.text.length).toBeLessThan(500);
      expect(res.text).toContain('truncated');
      expect(res.warnings.some(w => /truncated/i.test(w))).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns success:false with a warning for unsupported extensions', async () => {
    const { p, dir } = tmpFile('thing.xyz', 'whatever');
    try {
      const res = await parseDocument(p, { silent: true });
      expect(res.success).toBe(false);
      expect(res.parser).toBe('none');
      expect(res.warnings.length).toBeGreaterThan(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns success:false (not a throw) when the file does not exist', async () => {
    const res = await parseDocument(path.join(os.tmpdir(), 'nope-does-not-exist.txt'), { silent: true });
    expect(res.success).toBe(false);
  });
});

describe('PARSER_MAP', () => {
  it('routes common formats to the expected parser', () => {
    expect(PARSER_MAP['.pdf']).toBe('pdf');
    expect(PARSER_MAP['.docx']).toBe('mammoth');
    expect(PARSER_MAP['.xlsx']).toBe('xlsx');
    expect(PARSER_MAP['.json']).toBe('builtin-text');
    expect(PARSER_MAP['.html']).toBe('html');
  });
});
