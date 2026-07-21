'use strict';

/**
 * OPT-IN live smoke test — hits the real Gemini API.
 *
 * Runs ONLY when RUN_LIVE_TESTS=1 and a GEMINI_API_KEY is configured; otherwise
 * every case is skipped so the default `npm test` stays free, fast, and offline.
 *
 * Run it with:
 *   RUN_LIVE_TESTS=1 npx vitest run tests/live/dynamic.live.test.js
 *
 * It exercises the real Dynamic-flow AI calls end-to-end with a tiny request and
 * a small thinking budget to keep cost negligible.
 */

const config = require('../../src/config');
const { initGemini } = require('../../src/services/gemini');
const {
  planTopics, generateDynamicDocument, generateUnifiedDocument,
} = require('../../src/modes/dynamic-mode');

const LIVE = process.env.RUN_LIVE_TESTS === '1' && !!config.GEMINI_API_KEY;
const d = LIVE ? describe : describe.skip;

d('Dynamic flow — live Gemini smoke test', () => {
  let ai;
  beforeAll(async () => {
    // Respect GEMINI_MODEL if set; otherwise use a current, generally-available
    // model (the gemini-2.5-* line now 404s for newer API keys).
    const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
    if (config.GEMINI_MODELS[model]) config.setActiveModel(model);
    ai = await initGemini();
  });

  const docSnippets = ['[notes.md]\nWe are migrating the billing service from REST to gRPC next quarter. Key risks: auth, retries, streaming.'];

  it('plans topics from a real request', async () => {
    const res = await planTopics(ai, 'Create a short migration plan', docSnippets, {
      folderName: 'live-test', thinkingBudget: 2048,
    });
    expect(Array.isArray(res.topics)).toBe(true);
    expect(res.topics.length).toBeGreaterThan(0);
    expect(res.topics[0]).toHaveProperty('title');
    expect(res.tokenUsage.totalTokens).toBeGreaterThan(0);
  }, 90000);

  it('generates one document for a topic', async () => {
    const topic = { id: 'DM-01', title: 'Migration Overview', category: 'overview', description: 'High-level overview', estimated_length: 'short' };
    const res = await generateDynamicDocument(ai, topic, 'Create a short migration plan', docSnippets, { thinkingBudget: 2048 });
    expect(typeof res.markdown).toBe('string');
    expect(res.markdown.length).toBeGreaterThan(0);
    expect(res.markdown).not.toMatch(/^```/); // fences stripped
  }, 90000);

  it('generates a unified document', async () => {
    const res = await generateUnifiedDocument(ai, 'Summarize the migration in one page', docSnippets, {
      folderName: 'live-test', thinkingBudget: 2048,
    });
    expect(res.markdown.length).toBeGreaterThan(0);
  }, 120000);
});
