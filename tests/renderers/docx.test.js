'use strict';

const { renderResultsDocx } = require('../../src/renderers/docx');

function loadCompiled() {
  return JSON.parse(JSON.stringify(require('../fixtures/sample-compilation.json')));
}
const meta = {
  callName: 'Test Call',
  processedAt: '2026-07-21T10:00:00Z',
  geminiModel: 'gemini-3-flash-preview',
  userName: 'Youssef',
  segmentCount: 3,
};

// A .docx is a ZIP; its first bytes are the local file header "PK\x03\x04".
function isZip(buf) {
  return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

describe('renderResultsDocx', () => {
  it('produces a valid non-empty .docx buffer from a full analysis', async () => {
    const buf = await renderResultsDocx({ compiled: loadCompiled(), meta });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    expect(isZip(buf)).toBe(true);
  });

  it('handles a null / empty compiled analysis without throwing', async () => {
    const buf = await renderResultsDocx({ compiled: null, meta });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(isZip(buf)).toBe(true);
  });

  it('handles an analysis with missing optional sections', async () => {
    const buf = await renderResultsDocx({
      compiled: { summary: 'Only a summary, nothing else.' },
      meta,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
  });
});
