'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderResultsPdf } = require('../../src/renderers/pdf');
const { renderResultsHtml } = require('../../src/renderers/html');

function loadCompiled() {
  return JSON.parse(JSON.stringify(require('../fixtures/sample-compilation.json')));
}

describe('renderResultsPdf (real puppeteer)', () => {
  let out;
  beforeEach(() => { out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-pdf-')), 'r.pdf'); });
  afterEach(() => { fs.rmSync(path.dirname(out), { recursive: true, force: true }); });

  it('renders a valid PDF and reports a non-zero page count', async () => {
    const html = renderResultsHtml({
      compiled: loadCompiled(),
      meta: { callName: 'Test', processedAt: '2026-07-21T10:00:00Z', geminiModel: 'gemini-3-flash-preview', userName: 'Y', segmentCount: 1 },
    });
    const info = await renderResultsPdf(html, out);

    expect(fs.existsSync(out)).toBe(true);
    const buf = fs.readFileSync(out);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    expect(info.bytes).toBeGreaterThan(1000);
    // Regression: page count was always 0 under puppeteer v24 (Uint8Array vs Buffer).
    expect(info.pages).toBeGreaterThanOrEqual(1);
  }, 60000);
}, 90000);
