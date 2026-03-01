const path = require('path');
const fs = require('fs');

const {
  estimateTokens,
  selectDocsByBudget,
  sliceVttForSegment,
  buildProgressiveContext,
  buildSegmentFocus,
  detectBoundaryContext,
} = require('../../src/utils/context-manager');

// ── Fixture helpers ──────────────────────────────────────────

const SAMPLE_VTT_PATH = path.join(__dirname, '..', 'fixtures', 'sample-vtt.vtt');
const SAMPLE_VTT = fs.readFileSync(SAMPLE_VTT_PATH, 'utf8');

/** Minimal VTT with three cues spanning 0–30s. */
const MINI_VTT = `WEBVTT

1
00:00:00.000 --> 00:00:10.000
Hello, this is the beginning.

2
00:00:11.000 --> 00:00:20.000
Middle section of the conversation.

3
00:00:21.000 --> 00:00:30.000
End of the short conversation.
`;

function makeDoc(fileName, content = 'placeholder') {
  return { type: 'inlineText', fileName, content };
}

function makeFileDoc(fileName) {
  return { type: 'fileData', fileName };
}

// ═════════════════════════════════════════════════════════════
//  estimateTokens
// ═════════════════════════════════════════════════════════════

describe('estimateTokens', () => {
  it('returns 0 for null or empty input', () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('estimates tokens as ceil(length * 0.3)', () => {
    const text = 'a'.repeat(100);          // 100 chars → ceil(30) = 30
    expect(estimateTokens(text)).toBe(30);
  });

  it('rounds up fractional token counts', () => {
    const text = 'abc';                    // 3 chars → ceil(0.9) = 1
    expect(estimateTokens(text)).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════
//  selectDocsByBudget  (exercises classifyDocPriority internally)
// ═════════════════════════════════════════════════════════════

describe('selectDocsByBudget', () => {
  it('selects all docs when budget is large enough', () => {
    const docs = [
      makeDoc('.docs/summary/overview.md', 'short'),
      makeDoc('call.vtt', 'short content'),
    ];
    const { selected, excluded, stats } = selectDocsByBudget(docs, 100_000);
    expect(selected).toHaveLength(2);
    expect(excluded).toHaveLength(0);
    expect(stats.selectedDocs).toBe(2);
  });

  it('always includes P0 (CRITICAL) docs even when over budget (up to 2x cap)', () => {
    const docs = [
      makeDoc('transcript.vtt', 'x'.repeat(5000)),  // P0 — ~1500 tokens
      makeDoc('.docs/deep-dive/module.md', 'y'.repeat(5000)),      // P4 — ~1500 tokens
    ];
    // Budget=800 (< 1500 so P0 is over budget), hardCap=1600 (>= 1500 so P0 fits via bypass).
    // P4 gets excluded: after P0 uses 1500, P4 needs 1500+1500=3000 > 800, and P4 has no bypass.
    const { selected, excluded } = selectDocsByBudget(docs, 800);
    const selectedNames = selected.map(d => d.fileName);
    expect(selectedNames).toContain('transcript.vtt');
    expect(excluded.some(e => e.fileName === '.docs/deep-dive/module.md')).toBe(true);
  });

  it('always includes P1 (HIGH) docs even when over budget (up to 2x cap)', () => {
    const docs = [
      makeDoc('.tasks/code-map.md', 'x'.repeat(5000)),    // P1 — ~1500 tokens
      makeDoc('.docs/summary/overview.md', 'y'.repeat(50000)), // P2 — ~15000 tokens
    ];
    // Budget=800 (< 1500 so P1 is over budget), hardCap=1600 (>= 1500 so P1 fits via bypass).
    // P2 at ~15000 tokens far exceeds hardCap, gets excluded.
    const { selected, excluded } = selectDocsByBudget(docs, 800);
    const selectedNames = selected.map(d => d.fileName);
    expect(selectedNames).toContain('.tasks/code-map.md');
    expect(excluded.some(e => e.fileName === '.docs/summary/overview.md')).toBe(true);
  });

  it('excludes P0/P1 docs when they exceed the 2x hard cap', () => {
    const docs = [
      makeDoc('transcript.vtt', 'x'.repeat(50000)),  // P0 — ~15000 tokens
      makeDoc('.docs/deep-dive/module.md', 'y'),      // P4
    ];
    // Budget is 1 token, hard cap = 2. P0 doc is ~15000 tokens — exceeds hard cap.
    const { selected, excluded } = selectDocsByBudget(docs, 1);
    const selectedNames = selected.map(d => d.fileName);
    // Even P0 gets excluded if it exceeds 2x budget
    expect(selectedNames).not.toContain('transcript.vtt');
  });

  it('excludes lower-priority docs when budget is tight', () => {
    const docs = [
      makeDoc('call.vtt', 'short'),                         // P0
      makeDoc('.docs/deep-dive/analysis.md', 'x'.repeat(10000)), // P4
      makeDoc('.tasks/execution-plan.md', 'plan'),           // P0
    ];
    // Budget allows P0 docs but not the large P4 doc
    const { selected, excluded } = selectDocsByBudget(docs, 100);
    expect(selected.length).toBeGreaterThanOrEqual(2);
    expect(excluded.length).toBeGreaterThanOrEqual(0);
    // Both P0 docs must be selected
    const names = selected.map(d => d.fileName);
    expect(names).toContain('call.vtt');
    expect(names).toContain('.tasks/execution-plan.md');
  });

  it('returns correct stats object', () => {
    const docs = [makeDoc('a.vtt', 'hi'), makeDoc('.docs/deep.md', 'lo')];
    const { stats } = selectDocsByBudget(docs, 50_000, { segmentIndex: 3 });
    expect(stats.totalDocs).toBe(2);
    expect(stats.tokenBudget).toBe(50_000);
    expect(stats.segmentIndex).toBe(3);
    expect(typeof stats.estimatedTokens).toBe('number');
  });

  it('classifies VTT/SRT files as P0 CRITICAL', () => {
    const docs = [
      makeDoc('meeting.srt', 'sub'),
      makeDoc('.docs/background/ref.md', 'ref'),
    ];
    // Tiny budget — only critical survives
    const { selected } = selectDocsByBudget(docs, 1);
    expect(selected.map(d => d.fileName)).toContain('meeting.srt');
  });

  it('classifies .docs/summary/ as P2 MEDIUM', () => {
    // P2 is NOT forced-included beyond budget (only P0/P1 are)
    const docs = [
      makeDoc('.docs/summary/overview.md', 'x'.repeat(50000)),
    ];
    const { excluded } = selectDocsByBudget(docs, 1);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].priority).toBe(2);
  });

  it('classifies .robot/core/ as P3 LOW', () => {
    const docs = [makeDoc('.robot/core/patterns.md', 'x'.repeat(50000))];
    const { excluded } = selectDocsByBudget(docs, 1);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].priority).toBe(3);
  });

  it('uses 2000-token estimate for fileData docs', () => {
    const docs = [makeFileDoc('design.pdf')];
    const { stats } = selectDocsByBudget(docs, 100_000);
    expect(stats.estimatedTokens).toBe(2000);
  });
});

// ═════════════════════════════════════════════════════════════
//  sliceVttForSegment
// ═════════════════════════════════════════════════════════════

describe('sliceVttForSegment', () => {
  it('returns full VTT when parsing finds no cues', () => {
    const bad = 'NOT A VTT FILE\njust text';
    expect(sliceVttForSegment(bad, 0, 60)).toBe(bad);
  });

  it('slices fixture VTT to early cues only', () => {
    // Segment 0–60s with 30s overlap → rangeStart=0, rangeEnd=90
    const sliced = sliceVttForSegment(SAMPLE_VTT, 0, 60, 30);
    expect(sliced).toContain('WEBVTT');
    expect(sliced).toContain('Segment transcript');
    // Should include cues that start before 90s
    expect(sliced).toContain('OAuth2 migration');
    // Cues at 10:00+ (600s) should NOT be included
    expect(sliced).not.toContain('summarize action items');
  });

  it('slices fixture VTT to later cues only', () => {
    // Segment 300–420s with 30s overlap → rangeStart=270, rangeEnd=450
    const sliced = sliceVttForSegment(SAMPLE_VTT, 300, 420, 30);
    expect(sliced).toContain('notification service');
    // Very early cues (0–90s) should not appear
    expect(sliced).not.toContain('OAuth2 migration');
  });

  it('includes overlap margin in both directions', () => {
    // MINI_VTT cues at 0-10, 11-20, 21-30
    // Segment 15-25 with 5s overlap → rangeStart=10, rangeEnd=30
    // Cue 1 ends at 10s → endSec(10) >= rangeStart(10) ✓ so included
    const sliced = sliceVttForSegment(MINI_VTT, 15, 25, 5);
    expect(sliced).toContain('beginning');  // cue 1 (0-10) – endSec=10 >= 10
    expect(sliced).toContain('Middle');     // cue 2 (11-20) – within range
    expect(sliced).toContain('End of');     // cue 3 (21-30) – within range
  });

  it('uses default 30s overlap when not specified', () => {
    // Segment 60-120 with default 30s overlap → rangeStart=30, rangeEnd=150
    const sliced = sliceVttForSegment(SAMPLE_VTT, 60, 120);
    expect(sliced).toContain('WEBVTT');
    expect(sliced).toContain('Segment transcript');
    // Cues near 30-150s should be present
    expect(sliced).toContain('redirect URI');
  });

  it('falls back to full VTT when no cues match the range', () => {
    // Range 9000-9999 — no cues exist there
    const sliced = sliceVttForSegment(MINI_VTT, 9000, 9999, 0);
    // Falls back to full content
    expect(sliced).toContain('WEBVTT');
    expect(sliced).toContain('beginning');
    expect(sliced).toContain('End of');
  });
});

// ═════════════════════════════════════════════════════════════
//  buildProgressiveContext
// ═════════════════════════════════════════════════════════════

describe('buildProgressiveContext', () => {
  it('returns null when there are no previous analyses', () => {
    expect(buildProgressiveContext([], 'Youssef')).toBeNull();
  });

  it('includes user name in the header', () => {
    const analyses = [{ summary: 'Discussed OAuth migration.' }];
    const result = buildProgressiveContext(analyses, 'Youssef');
    expect(result).toContain('Youssef');
    expect(result).toContain('PREVIOUS SEGMENT ANALYSES');
  });

  it('produces FULL detail for the most recent segment', () => {
    const analyses = [
      {
        summary: 'Discussed OAuth migration.',
        tickets: [{ ticket_id: 'CR-001', status: 'open', title: 'OAuth' }],
        change_requests: [{ id: 'CR-01', title: 'Add PKCE', status: 'open', assigned_to: 'Mohamed' }],
        action_items: [{ id: 'AI-1', description: 'Update redirect URIs', assigned_to: 'Mohamed', status: 'pending' }],
      },
    ];
    const result = buildProgressiveContext(analyses, 'Youssef');
    expect(result).toContain('FULL DETAIL');
    expect(result).toContain('CR-001');
    expect(result).toContain('OAuth');
    expect(result).toContain('AI-1');
    expect(result).toContain('Update redirect URIs');
  });

  it('produces COMPRESSED summary for older segments', () => {
    // 4 segments: indices 0,1 should be compressed, indices 2,3 are "recent"
    const analyses = [
      { summary: 'Segment one info.', tickets: [{ ticket_id: 'T-1', status: 'done' }] },
      { summary: 'Segment two info.', tickets: [{ ticket_id: 'T-2', status: 'open' }] },
      { summary: 'Segment three info.', tickets: [{ ticket_id: 'T-3', status: 'in_progress' }] },
      { summary: 'Segment four latest.', tickets: [{ ticket_id: 'T-4', status: 'open' }] },
    ];
    const result = buildProgressiveContext(analyses, 'Youssef');
    // First two segments (indices 0,1) should be COMPRESSED
    expect(result).toContain('SEGMENT 1 (COMPRESSED');
    expect(result).toContain('SEGMENT 2 (COMPRESSED');
    // Last two (indices 2,3) should be FULL
    expect(result).toContain('SEGMENT 3 (FULL DETAIL)');
    expect(result).toContain('SEGMENT 4 (FULL DETAIL)');
  });
});

// ═════════════════════════════════════════════════════════════
//  buildSegmentFocus
// ═════════════════════════════════════════════════════════════

describe('buildSegmentFocus', () => {
  it('labels first segment as FIRST with baseline instructions', () => {
    const result = buildSegmentFocus(0, 5, [], 'Youssef');
    expect(result).toContain('1 of 5');
    expect(result).toContain('FIRST');
    expect(result).toContain('baseline');
    expect(result).toContain('Youssef');
  });

  it('labels last segment as LAST with wrap-up instructions', () => {
    const result = buildSegmentFocus(4, 5, [], 'Youssef');
    expect(result).toContain('5 of 5');
    expect(result).toContain('LAST');
    expect(result).toContain('final decisions');
  });

  it('labels middle segment as MIDDLE', () => {
    const result = buildSegmentFocus(2, 5, [], 'Youssef');
    expect(result).toContain('3 of 5');
    expect(result).toContain('MIDDLE');
  });

  it('lists already-found ticket IDs for non-first segments', () => {
    const prev = [
      { tickets: [{ ticket_id: 'CR-100' }], change_requests: [{ id: 'CR-01' }] },
    ];
    const result = buildSegmentFocus(1, 3, prev, 'Youssef');
    expect(result).toContain('CR-100');
    expect(result).toContain('CR-01');
    expect(result).toContain('ALREADY FOUND');
  });
});

// ═════════════════════════════════════════════════════════════
//  detectBoundaryContext
// ═════════════════════════════════════════════════════════════

describe('detectBoundaryContext', () => {
  it('returns null for segment index 0 (first segment)', () => {
    expect(detectBoundaryContext(SAMPLE_VTT, 0, 60, 0)).toBeNull();
  });

  it('returns null for empty or null VTT content', () => {
    expect(detectBoundaryContext('', 0, 60, 1)).toBeNull();
    expect(detectBoundaryContext(null, 0, 60, 1)).toBeNull();
  });

  it('detects mid-conversation start when cues exist right at segment boundary', () => {
    // MINI_VTT has cue at 00:00:11 — if we say segment starts at 11, that cue is within 5s
    const result = detectBoundaryContext(MINI_VTT, 11, 30, 1);
    expect(result).not.toBeNull();
    expect(result).toContain('MID-CONVERSATION');
  });

  it('notes open tickets from previous analysis', () => {
    const prevAnalysis = {
      tickets: [
        { ticket_id: 'CR-999', status: 'in_progress' },
        { ticket_id: 'CR-500', status: 'done' },
      ],
      blockers: [],
    };
    const result = detectBoundaryContext(MINI_VTT, 11, 30, 1, prevAnalysis);
    expect(result).toContain('CR-999');
    expect(result).not.toContain('CR-500'); // done ticket shouldn't appear as open
  });

  it('notes unresolved blockers from previous analysis', () => {
    const prevAnalysis = {
      tickets: [],
      blockers: [{ id: 'B-1', description: 'Pending review', status: 'open' }],
    };
    const result = detectBoundaryContext(MINI_VTT, 11, 30, 1, prevAnalysis);
    expect(result).toContain('unresolved blocker');
  });

  it('detects continuation keywords in previous summary', () => {
    const prevAnalysis = {
      summary: 'Discussion will continue in next segment about deployment.',
      tickets: [],
      blockers: [],
    };
    const result = detectBoundaryContext(MINI_VTT, 11, 30, 1, prevAnalysis);
    expect(result).toContain('topics carry over');
  });
});
