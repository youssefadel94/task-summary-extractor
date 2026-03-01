const { extractJson } = require('../../src/utils/json-parser');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress console.warn output from truncation / doubled-closer repairs. */
let warnSpy;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

/** A realistic analysis-like JSON object used across tests. */
function sampleObject() {
  return {
    tickets: [
      {
        ticket_id: 'T-101',
        title: 'Implement OAuth2 login flow',
        status: 'in_progress',
        assignee: 'Alice',
        confidence: 'HIGH',
      },
      {
        ticket_id: 'T-102',
        title: 'Fix database connection pooling',
        status: 'blocked',
        assignee: 'Bob',
        confidence: 'MEDIUM',
      },
    ],
    summary: 'Sprint review: OAuth2 implementation on track, DB pooling blocked.',
    action_items: ['Review PR #42', 'Schedule follow-up meeting'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractJson', () => {
  // 1. Clean JSON string
  it('parses a clean JSON string directly', () => {
    const input = JSON.stringify(sampleObject());
    const result = extractJson(input);
    expect(result).toEqual(sampleObject());
  });

  // 2. JSON wrapped in ```json fences
  it('strips ```json markdown fences and parses', () => {
    const obj = { tickets: [{ ticket_id: 'T-1', title: 'Test' }], summary: 'ok' };
    const input = '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
    const result = extractJson(input);
    expect(result).toEqual(obj);
  });

  // 3. JSON wrapped in ``` (no json tag)
  it('strips plain ``` markdown fences and parses', () => {
    const obj = { summary: 'Sprint complete', action_items: [] };
    const input = '```\n' + JSON.stringify(obj) + '\n```';
    const result = extractJson(input);
    expect(result).toEqual(obj);
  });

  // 4. Text before the first {
  it('extracts JSON when preceded by arbitrary text', () => {
    const obj = { tickets: [{ ticket_id: 'T-5', title: 'Deploy hotfix' }] };
    const input = 'Here is the analysis result:\n\n' + JSON.stringify(obj);
    const result = extractJson(input);
    expect(result).toEqual(obj);
  });

  // 5. Text after the closing }
  it('extracts JSON when followed by trailing text', () => {
    const obj = { summary: 'All tasks done', action_items: ['Ship it'] };
    const input = JSON.stringify(obj) + '\n\nLet me know if you need more details.';
    const result = extractJson(input);
    expect(result).toEqual(obj);
  });

  // 6. Doubled closing braces }}
  it('handles doubled closing braces', () => {
    // Brace-matching (Strategy 2) finds balanced object at the correct first }
    const input = '{"summary": "done", "count": 3}}';
    const result = extractJson(input);
    expect(result).toEqual({ summary: 'done', count: 3 });
  });

  // 7. Doubled commas ,,
  it('repairs doubled commas in JSON', () => {
    const input = '{"ticket_id": "T-1",, "title": "Fix bug"}';
    const result = extractJson(input);
    expect(result).toEqual({ ticket_id: 'T-1', title: 'Fix bug' });
  });

  // 8. Trailing comma before }
  it('repairs trailing comma before closing brace', () => {
    const input = '{"summary": "Sprint done", "count": 5,}';
    const result = extractJson(input);
    expect(result).toEqual({ summary: 'Sprint done', count: 5 });
  });

  // 9. Trailing comma before ]
  it('repairs trailing comma before closing bracket', () => {
    const input = '{"action_items": ["Review PR", "Deploy",]}';
    const result = extractJson(input);
    expect(result).toEqual({ action_items: ['Review PR', 'Deploy'] });
  });

  // 10. Invalid escape sequences \d \s \w
  it('repairs invalid JSON escape sequences like \\d \\s \\w', () => {
    const input = '{"pattern": "match \\d+ digits and \\s whitespace and \\w words"}';
    const result = extractJson(input);
    expect(result).toEqual({ pattern: 'match \\d+ digits and \\s whitespace and \\w words' });
  });

  // 11. Truncated JSON — cut mid-string
  it('recovers truncated JSON cut mid-string value', () => {
    const input = '{"tickets": [{"ticket_id": "T-1", "title": "Implement the new authenti';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(result.tickets).toBeInstanceOf(Array);
    expect(result.tickets.length).toBe(1);
    expect(result.tickets[0].ticket_id).toBe('T-1');
    // The truncated title is replaced with null during repair
    expect(result.tickets[0].title).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  // 12. Truncated JSON — cut mid-array
  it('recovers truncated JSON cut mid-array', () => {
    const input = '{"action_items": ["Review PR #42", "Schedule meeting", "Update docs';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(result.action_items).toBeInstanceOf(Array);
    // The third truncated string is replaced/recovered; first two survive
    expect(result.action_items.length).toBeGreaterThanOrEqual(2);
    expect(result.action_items[0]).toBe('Review PR #42');
    expect(result.action_items[1]).toBe('Schedule meeting');
    expect(console.warn).toHaveBeenCalled();
  });

  // 13. Truncated JSON — cut mid-object
  it('recovers truncated JSON cut mid-nested-object', () => {
    const input = '{"summary": "Sprint review", "meta": {"team": "backend", "sprint": 14';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(result.summary).toBe('Sprint review');
    expect(result.meta).toBeDefined();
    expect(result.meta.team).toBe('backend');
    expect(result.meta.sprint).toBe(14);
    expect(console.warn).toHaveBeenCalled();
  });

  // 14. Completely invalid text
  it('returns null for completely invalid text', () => {
    const result = extractJson('This is not JSON at all, just plain text.');
    expect(result).toBeNull();
  });

  // 15. Empty string
  it('returns null for empty string', () => {
    const result = extractJson('');
    expect(result).toBeNull();
  });

  // 16. Nested JSON — clean parse
  it('parses deeply nested JSON correctly', () => {
    const obj = {
      project: {
        sprints: [
          {
            id: 1,
            tickets: [
              { ticket_id: 'T-1', details: { priority: 'high', labels: ['bug', 'urgent'] } },
            ],
          },
        ],
        meta: { version: '2.0', active: true },
      },
    };
    const input = JSON.stringify(obj);
    const result = extractJson(input);
    expect(result).toEqual(obj);
  });

  // 17. Unicode characters
  it('preserves Unicode characters in JSON', () => {
    const obj = {
      assignee: 'José García',
      summary: '東京オフィスのレビュー',
      emoji: '✅ Done 🚀',
    };
    const input = JSON.stringify(obj);
    const result = extractJson(input);
    expect(result).toEqual(obj);
  });

  // 18. Empty arrays and objects
  it('parses JSON with empty arrays and objects', () => {
    const obj = {
      tickets: [],
      action_items: [],
      meta: {},
      summary: '',
    };
    const input = JSON.stringify(obj);
    const result = extractJson(input);
    expect(result).toEqual(obj);
  });

  // 19. Multiple JSON objects in text — returns first one
  it('returns the first JSON object when multiple are present', () => {
    const first = { ticket_id: 'T-1', title: 'First task' };
    const second = { ticket_id: 'T-2', title: 'Second task' };
    const input = 'Result 1: ' + JSON.stringify(first) + '\nResult 2: ' + JSON.stringify(second);
    const result = extractJson(input);
    expect(result).toEqual(first);
  });

  // 20. String values containing braces
  it('handles string values that contain braces without confusion', () => {
    const obj = {
      code_snippet: 'if (x) { return y; }',
      template: 'Hello {{name}}, welcome to {{place}}',
      count: 1,
    };
    const input = JSON.stringify(obj);
    const result = extractJson(input);
    expect(result).toEqual(obj);
  });

  // 21. JSON with leading whitespace and newlines
  it('handles JSON with leading/trailing whitespace', () => {
    const obj = { summary: 'Trimmed', tickets: [] };
    const input = '   \n\n  ' + JSON.stringify(obj) + '  \n\n  ';
    const result = extractJson(input);
    expect(result).toEqual(obj);
  });

  // 22. Lone comma after opening brace/bracket
  it('repairs lone comma after opening brace', () => {
    const input = '{, "summary": "fixed", "count": 1}';
    const result = extractJson(input);
    expect(result).toEqual({ summary: 'fixed', count: 1 });
  });

  // 23. Combined malformations — doubled commas + trailing comma
  it('repairs multiple malformations simultaneously', () => {
    const input = '{"a": 1,, "b": 2, "c": 3,}';
    const result = extractJson(input);
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });

  // 24. JSON in fences with surrounding AI commentary
  it('extracts JSON from fences surrounded by AI commentary', () => {
    const obj = { tickets: [{ ticket_id: 'T-1' }], summary: 'All clear' };
    const input =
      'Here is the structured analysis:\n\n' +
      '```json\n' +
      JSON.stringify(obj, null, 2) +
      '\n```\n\n' +
      'Let me know if you need any changes!';
    const result = extractJson(input);
    expect(result).toEqual(obj);
  });

  // 25. Truncated JSON with trailing comma before cut-off
  it('recovers truncated JSON that ends with a trailing comma', () => {
    const input = '{"tickets": [{"ticket_id": "T-1", "title": "Auth"}, {"ticket_id": "T-2",';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(result.tickets).toBeInstanceOf(Array);
    expect(result.tickets.length).toBeGreaterThanOrEqual(1);
    expect(result.tickets[0].ticket_id).toBe('T-1');
    expect(console.warn).toHaveBeenCalled();
  });
});
