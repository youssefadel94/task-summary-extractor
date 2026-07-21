'use strict';

/**
 * Test helper: a fake GoogleGenAI client compatible with how the codebase
 * calls it — `ai.models.generateContent(payload)` returning an object with a
 * `.text` string and a `.usageMetadata` object.
 *
 * Usage:
 *   const ai = makeMockAI(['{"topics":[...]}', '# Doc markdown']);   // queue
 *   const ai = makeMockAI((payload) => ({ text: '...', usageMetadata: {...} }));
 *
 * Each queued entry may be:
 *   - a string            → becomes response.text
 *   - an object {text, usageMetadata}  → used verbatim (defaults filled in)
 *   - an Error            → the generateContent call rejects with it
 */
function makeMockAI(responses) {
  const calls = [];
  let idx = 0;

  const defaultUsage = {
    promptTokenCount: 120,
    candidatesTokenCount: 60,
    totalTokenCount: 180,
    thoughtsTokenCount: 12,
  };

  const resolveResponse = (payload) => {
    let entry;
    if (typeof responses === 'function') {
      entry = responses(payload, idx);
    } else if (Array.isArray(responses)) {
      // Repeat the last entry once the queue is exhausted (robust to extra calls).
      entry = idx < responses.length ? responses[idx] : responses[responses.length - 1];
    } else {
      entry = responses;
    }
    idx++;
    return entry;
  };

  return {
    // Expose captured calls for assertions.
    _calls: calls,
    get callCount() { return calls.length; },
    models: {
      generateContent: async (payload) => {
        calls.push(payload);
        const entry = resolveResponse(payload);
        if (entry instanceof Error) throw entry;
        if (typeof entry === 'string') {
          return { text: entry, usageMetadata: { ...defaultUsage } };
        }
        if (entry && typeof entry === 'object') {
          return {
            text: entry.text != null ? entry.text : '',
            usageMetadata: entry.usageMetadata || { ...defaultUsage },
          };
        }
        return { text: '', usageMetadata: { ...defaultUsage } };
      },
    },
  };
}

module.exports = { makeMockAI };
