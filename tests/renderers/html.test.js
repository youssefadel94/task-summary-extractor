const { renderResultsHtml } = require('../../src/renderers/html');

// Deep-copy fixture to prevent cross-test mutation
function loadCompiled() {
  return JSON.parse(JSON.stringify(require('../fixtures/sample-compilation.json')));
}

function baseMeta(overrides = {}) {
  return {
    callName: 'Test Call',
    processedAt: '2026-03-01T10:00:00Z',
    geminiModel: 'gemini-2.0-flash',
    userName: 'Youssef',
    segmentCount: 3,
    ...overrides,
  };
}

// ─── renderResultsHtml ──────────────────────────────────────────────────────

describe('renderResultsHtml', () => {
  it('returns fallback HTML when compiled is null', () => {
    const html = renderResultsHtml({ compiled: null, meta: baseMeta() });
    expect(html).toContain('No compiled result available');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('returns a string starting with <!DOCTYPE html>', () => {
    const html = renderResultsHtml({ compiled: loadCompiled(), meta: baseMeta() });
    expect(html).toMatch(/^<!DOCTYPE html>/);
  });

  it('contains <html lang="en"> opening tag', () => {
    const html = renderResultsHtml({ compiled: loadCompiled(), meta: baseMeta() });
    expect(html).toContain('<html lang="en">');
  });

  it('contains a <title> with the call name', () => {
    const html = renderResultsHtml({ compiled: loadCompiled(), meta: baseMeta() });
    expect(html).toContain('<title>Call Analysis — Test Call</title>');
  });

  it('contains inline CSS styles (self-contained)', () => {
    const html = renderResultsHtml({ compiled: loadCompiled(), meta: baseMeta() });
    expect(html).toContain('<style>');
    expect(html).toContain('--bg:');
    expect(html).toContain('--accent:');
    expect(html).toContain('</style>');
  });

  it('contains metadata info (date, model, segments)', () => {
    const html = renderResultsHtml({ compiled: loadCompiled(), meta: baseMeta() });
    expect(html).toContain('2026-03-01');
    expect(html).toContain('gemini-2.0-flash');
    expect(html).toContain('<dt>Segments</dt><dd>3</dd>');
  });

  it('contains the executive summary text', () => {
    const compiled = loadCompiled();
    const html = renderResultsHtml({ compiled, meta: baseMeta() });
    expect(html).toContain('Executive Summary');
    expect(html).toContain('OAuth2 authentication');
  });

  it('contains ticket IDs from the fixture data', () => {
    const compiled = loadCompiled();
    const html = renderResultsHtml({ compiled, meta: baseMeta() });
    expect(html).toContain('CR31296872');
    expect(html).toContain('CR31298104');
    expect(html).toContain('CR31299450');
  });

  it('contains action item IDs and the action items section', () => {
    const compiled = loadCompiled();
    const html = renderResultsHtml({ compiled, meta: baseMeta() });
    expect(html).toContain('All Action Items');
    expect(html).toContain('AI-001');
    expect(html).toContain('AI-002');
    expect(html).toContain('AI-003');
  });

  it('handles empty arrays gracefully — no ticket/action/CR/scope sections', () => {
    const compiled = {
      tickets: [],
      change_requests: [],
      action_items: [],
      blockers: [],
      scope_changes: [],
      file_references: [],
      summary: 'Minimal summary',
    };
    const html = renderResultsHtml({ compiled, meta: baseMeta() });
    // Header and summary should still be present
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Minimal summary');
    // Sections that require items should be absent
    expect(html).not.toContain('Detailed Ticket Analysis');
    expect(html).not.toContain('All Action Items');
    expect(html).not.toContain('All Change Requests');
    expect(html).not.toContain('Scope Changes');
  });

  it('contains the theme toggle button and inline script', () => {
    const html = renderResultsHtml({ compiled: loadCompiled(), meta: baseMeta() });
    expect(html).toContain('theme-toggle');
    expect(html).toContain('<script>');
  });

  it('promotes current user section when userName matches an assignee', () => {
    const compiled = loadCompiled();
    const html = renderResultsHtml({ compiled, meta: baseMeta({ userName: 'Youssef' }) });
    // Youssef is assigned to CR31298104 and AI-002
    expect(html).toContain('Your Tasks');
    expect(html).toContain('Youssef');
  });

  it('uses "Unknown" as call name when meta.callName is undefined', () => {
    const compiled = loadCompiled();
    const html = renderResultsHtml({ compiled, meta: baseMeta({ callName: undefined }) });
    expect(html).toContain('Call Analysis — Unknown');
  });
});
