const { renderResultsMarkdown } = require('../../src/renderers/markdown');

// Load fixture with deep-copy helper to avoid cross-test mutation
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

// ─── renderResultsMarkdown ───────────────────────────────────────────────────

describe('renderResultsMarkdown', () => {
  it('returns fallback message when compiled is null', () => {
    const md = renderResultsMarkdown({ compiled: null, meta: baseMeta() });
    expect(md).toContain('No compiled result available');
  });

  it('starts with the expected heading pattern including call name', () => {
    const md = renderResultsMarkdown({ compiled: loadCompiled(), meta: baseMeta() });
    expect(md).toMatch(/^# 📋 Call Analysis — Test Call/);
  });

  it('includes processedAt date in the header', () => {
    const md = renderResultsMarkdown({ compiled: loadCompiled(), meta: baseMeta() });
    expect(md).toContain('**Date**: 2026-03-01');
  });

  it('includes model name in the header', () => {
    const md = renderResultsMarkdown({ compiled: loadCompiled(), meta: baseMeta() });
    expect(md).toContain('**Model**: gemini-2.0-flash');
  });

  it('includes segment count in the header', () => {
    const md = renderResultsMarkdown({ compiled: loadCompiled(), meta: baseMeta() });
    expect(md).toContain('**Segments analyzed**: 3');
  });

  it('renders the Executive Summary section with summary text', () => {
    const compiled = loadCompiled();
    const md = renderResultsMarkdown({ compiled, meta: baseMeta() });
    expect(md).toContain('## 📝 Executive Summary');
    expect(md).toContain('OAuth2 authentication');
  });

  it('renders Detailed Ticket Analysis section with ticket IDs', () => {
    const compiled = loadCompiled();
    const md = renderResultsMarkdown({ compiled, meta: baseMeta() });
    expect(md).toContain('## 🎫 Detailed Ticket Analysis');
    expect(md).toContain('CR31296872');
    expect(md).toContain('CR31298104');
    expect(md).toContain('CR31299450');
  });

  it('renders All Action Items section with action IDs', () => {
    const compiled = loadCompiled();
    const md = renderResultsMarkdown({ compiled, meta: baseMeta() });
    expect(md).toContain('## 📋 All Action Items');
    expect(md).toContain('AI-001');
    expect(md).toContain('AI-002');
    expect(md).toContain('AI-003');
  });

  it('renders All Change Requests section', () => {
    const compiled = loadCompiled();
    const md = renderResultsMarkdown({ compiled, meta: baseMeta() });
    expect(md).toContain('## 🔧 All Change Requests');
    expect(md).toContain('CR-REQ-001');
    expect(md).toContain('CR-REQ-002');
  });

  it('renders Scope Changes section with scope change IDs', () => {
    const compiled = loadCompiled();
    const md = renderResultsMarkdown({ compiled, meta: baseMeta() });
    expect(md).toContain('## 🔀 Scope Changes');
    expect(md).toContain('SC-001');
    expect(md).toContain('SC-002');
  });

  it('renders blocker information for tickets that are blocked', () => {
    const compiled = loadCompiled();
    const md = renderResultsMarkdown({ compiled, meta: baseMeta() });
    // BLK-001 blocks CR31298104 — should appear in the blocker section for that ticket
    expect(md).toContain('BLK-001');
    expect(md).toContain('Production deployment freeze');
  });

  it('renders confidence distribution section', () => {
    const compiled = loadCompiled();
    const md = renderResultsMarkdown({ compiled, meta: baseMeta() });
    expect(md).toContain('### 📊 Confidence Distribution');
    expect(md).toContain('HIGH');
    expect(md).toContain('MEDIUM');
  });

  it('handles empty arrays gracefully producing no empty sections', () => {
    const compiled = {
      tickets: [],
      change_requests: [],
      action_items: [],
      blockers: [],
      scope_changes: [],
      file_references: [],
      summary: 'Minimal summary',
    };
    const md = renderResultsMarkdown({ compiled, meta: baseMeta() });
    // Should still contain header and summary
    expect(md).toContain('# 📋 Call Analysis');
    expect(md).toContain('Minimal summary');
    // Should NOT contain sections that require items
    expect(md).not.toContain('## 🎫 Detailed Ticket Analysis');
    expect(md).not.toContain('## 📋 All Action Items');
    expect(md).not.toContain('## 🔧 All Change Requests');
    expect(md).not.toContain('## 🔀 Scope Changes');
  });

  it('includes footer with item count statistics', () => {
    const compiled = loadCompiled();
    const md = renderResultsMarkdown({ compiled, meta: baseMeta() });
    // Footer has format: "N tickets · N change requests · ..."
    expect(md).toContain('3 tickets');
    expect(md).toContain('2 change requests');
    expect(md).toContain('3 action items');
    expect(md).toContain('2 blockers');
    expect(md).toContain('2 scope changes');
  });

  it('promotes the current user section when userName matches an assignee', () => {
    const compiled = loadCompiled();
    // Youssef is assigned to CR31298104 and AI-002
    const md = renderResultsMarkdown({ compiled, meta: baseMeta({ userName: 'Youssef' }) });
    expect(md).toContain('⭐ Your Tasks');
    expect(md).toContain('Youssef');
  });

  it('includes callName "Unknown" when meta.callName is not provided', () => {
    const compiled = loadCompiled();
    const md = renderResultsMarkdown({ compiled, meta: baseMeta({ callName: undefined }) });
    expect(md).toContain('# 📋 Call Analysis — Unknown');
  });
});
