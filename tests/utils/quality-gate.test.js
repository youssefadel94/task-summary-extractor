const {
  assessQuality,
  formatQualityLine,
  getConfidenceStats,
  THRESHOLDS,
} = require('../../src/utils/quality-gate');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a rich analysis object (all required + optional fields, varied confidence). */
function makeRichAnalysis() {
  return {
    tickets: [
      {
        ticket_id: 'T-001',
        title: 'Migrate auth to OAuth2',
        status: 'in_progress',
        assignee: 'Alice',
        documented_state: 'Implementation started',
        discussed_state: 'In progress with PKCE flow',
        comments: ['Handle token expiry edge case'],
        code_changes: ['src/auth/oauth2-client.js'],
        confidence: 'HIGH',
        confidence_reason: 'Explicitly discussed',
      },
      {
        ticket_id: 'T-002',
        title: 'DB schema migration',
        status: 'blocked',
        assignee: 'Bob',
        documented_state: 'Schema design approved',
        discussed_state: 'Blocked on production freeze',
        comments: ['Rollback script tested locally'],
        code_changes: ['migrations/0042_add_tenant_id.sql'],
        confidence: 'MEDIUM',
        confidence_reason: 'Inferred from discussion',
      },
    ],
    action_items: [
      {
        id: 'AI-001',
        description: 'Update staging redirect URI whitelist',
        assigned_to: 'Alice',
        status: 'pending',
        confidence: 'HIGH',
        confidence_reason: 'Directly assigned',
      },
      {
        id: 'AI-002',
        description: 'Run migration rollback on staging',
        assigned_to: 'Bob',
        status: 'pending',
        confidence: 'MEDIUM',
        confidence_reason: 'Implied from blocker discussion',
      },
    ],
    change_requests: [
      {
        id: 'CR-001',
        title: 'Add rate limiting to public API',
        where: 'API gateway layer',
        what: 'Token-bucket rate limiting with configurable thresholds',
        how: 'express-rate-limit with Redis store',
        why: 'Security compliance',
        type: 'enhancement',
        priority: 'high',
        status: 'proposed',
        confidence: 'HIGH',
        confidence_reason: 'Proposed during call',
      },
    ],
    blockers: [
      {
        id: 'BLK-001',
        type: 'process',
        description: 'Production freeze until March 5',
        owner: 'Bob',
        confidence: 'HIGH',
        confidence_reason: 'Dates explicitly stated',
      },
    ],
    scope_changes: [
      {
        id: 'SC-001',
        type: 'expansion',
        original_scope: 'Web only',
        new_scope: 'Web + Mobile + CLI',
        reason: 'Unified auth experience',
        impact: '1.5 additional sprint points',
        confidence: 'LOW',
        confidence_reason: 'Verbal discussion only',
      },
    ],
    file_references: [
      { path: 'src/auth/oauth2-client.js', context: 'OAuth2 client', mentioned_at: '00:02:45' },
    ],
    your_tasks: {
      user_name: 'Bob',
      tasks_todo: ['Run rollback on staging', 'Document results'],
      tasks_waiting_on_others: ['Waiting on Alice for redirect URIs'],
      decisions_needed: ['Tenant isolation index timing'],
      completed_in_call: ['Approved schema design'],
      summary: 'Focus on unblocking migration after freeze lifts.',
    },
    summary:
      'Team discussed migration plan for OAuth2 authentication and multi-tenant database schema. ' +
      'OAuth2 in progress, DB migration blocked by production freeze until March 5.',
  };
}

function makeDefaultContext(overrides = {}) {
  return { parseSuccess: true, rawLength: 5000, ...overrides };
}

// ---------------------------------------------------------------------------
// THRESHOLDS
// ---------------------------------------------------------------------------

describe('quality-gate', () => {
  describe('THRESHOLDS', () => {
    it('exposes correct threshold values', () => {
      expect(THRESHOLDS.FAIL_BELOW).toBe(45);
      expect(THRESHOLDS.PASS_ABOVE).toBe(65);
      expect(THRESHOLDS.MAX_RETRIES).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // assessQuality
  // -------------------------------------------------------------------------

  describe('assessQuality', () => {
    it('returns PASS with a rich analysis', () => {
      const report = assessQuality(makeRichAnalysis(), makeDefaultContext());

      expect(report.grade).toBe('PASS');
      expect(report.score).toBeGreaterThanOrEqual(THRESHOLDS.PASS_ABOVE); // >= 65
      expect(report.shouldRetry).toBe(false);
      expect(report.retryHints).toHaveLength(0);
      // All dimension keys present
      expect(report.dimensions).toHaveProperty('structure');
      expect(report.dimensions).toHaveProperty('density');
      expect(report.dimensions).toHaveProperty('integrity');
      expect(report.dimensions).toHaveProperty('crossRef');
    });

    it('returns FAIL with an empty object', () => {
      // Structure: 0, Density: ~5, Integrity: 80, CrossRef: 100
      // Composite ≈ round(0*.25 + 5*.35 + 80*.25 + 100*.15) = 37
      const report = assessQuality({}, makeDefaultContext());

      expect(report.grade).toBe('FAIL');
      expect(report.score).toBeLessThan(THRESHOLDS.FAIL_BELOW);
      expect(report.shouldRetry).toBe(true);
      expect(report.retryHints.length).toBeGreaterThan(0);
    });

    it('returns FAIL with null analysis', () => {
      // Structure: 0, Density: 0, Integrity: 80, CrossRef: 50
      // Composite ≈ round(0 + 0 + 20 + 7.5) = 28
      const report = assessQuality(null, makeDefaultContext());

      expect(report.grade).toBe('FAIL');
      expect(report.score).toBeLessThan(THRESHOLDS.FAIL_BELOW);
      expect(report.shouldRetry).toBe(true);
    });

    it('produces a lower score when required fields are missing', () => {
      const partial = {
        tickets: [
          { ticket_id: 'T-1', discussed_state: 'In review', comments: ['Need update'] },
        ],
        // action_items, change_requests, summary are missing
      };
      const report = assessQuality(partial, makeDefaultContext());

      // Structure: only 1/4 required → baseScore=20
      expect(report.dimensions.structure.score).toBeLessThan(30);
      // Overall score should be significantly below a rich analysis
      expect(report.score).toBeLessThan(65);
    });

    it('sets integrity score to 0 when parseSuccess is false', () => {
      const report = assessQuality(makeRichAnalysis(), {
        parseSuccess: false,
        rawLength: 5000,
      });

      expect(report.dimensions.integrity.score).toBe(0);
      expect(report.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('JSON parse failed')]),
      );
    });

    it('applies integrity penalty when output is truncated', () => {
      // Base integrity 80, truncated → −30 = 50
      const report = assessQuality(makeRichAnalysis(), {
        parseSuccess: true,
        rawLength: 5000,
        truncated: true,
      });

      expect(report.dimensions.integrity.score).toBe(50);
      expect(report.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('truncated')]),
      );
    });

    it('applies integrity penalty for very short rawLength (< 500)', () => {
      // Base 80 − 20 = 60
      const report = assessQuality(makeRichAnalysis(), {
        parseSuccess: true,
        rawLength: 300,
      });

      expect(report.dimensions.integrity.score).toBe(60);
      expect(report.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('very short')]),
      );
    });

    it('applies smaller integrity penalty for moderately short rawLength (500-2000)', () => {
      // Base 80 − 10 = 70
      const report = assessQuality(makeRichAnalysis(), {
        parseSuccess: true,
        rawLength: 1000,
      });

      expect(report.dimensions.integrity.score).toBe(70);
      expect(report.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('short')]),
      );
    });

    it('stacks integrity penalties for truncated + very short rawLength', () => {
      // Base 80 − 30 (truncated) − 20 (rawLength<500) = 30
      const report = assessQuality(makeRichAnalysis(), {
        parseSuccess: true,
        rawLength: 100,
        truncated: true,
      });

      expect(report.dimensions.integrity.score).toBe(30);
    });

    it('penalises crossRef score for duplicate ticket IDs', () => {
      const analysis = makeRichAnalysis();
      // Introduce a duplicate ticket_id
      analysis.tickets.push({
        ...analysis.tickets[0],
        title: 'Duplicate ticket',
      });

      const report = assessQuality(analysis, makeDefaultContext());

      // 100 − 15 = 85
      expect(report.dimensions.crossRef.score).toBe(85);
      expect(report.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('Duplicate ticket IDs')]),
      );
    });

    it('penalises crossRef score for duplicate action item IDs', () => {
      const analysis = makeRichAnalysis();
      analysis.action_items.push({
        ...analysis.action_items[0],
        description: 'Duplicate action',
      });

      const report = assessQuality(analysis, makeDefaultContext());

      // 100 − 10 = 90
      expect(report.dimensions.crossRef.score).toBe(90);
      expect(report.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('Duplicate action item IDs')]),
      );
    });

    it('penalises crossRef when CR references an unknown ticket', () => {
      const analysis = makeRichAnalysis();
      analysis.change_requests[0].ticket_id = 'UNKNOWN-999';

      const report = assessQuality(analysis, makeDefaultContext());

      // 100 − 5 = 95
      expect(report.dimensions.crossRef.score).toBe(95);
      expect(report.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('references unknown ticket')]),
      );
    });

    it('does not flag uniformity issue with mixed confidence levels', () => {
      // Rich analysis already has HIGH, MEDIUM, LOW across items
      const report = assessQuality(makeRichAnalysis(), makeDefaultContext());

      const uniformityIssue = report.issues.find((i) => i.includes('suspicious uniformity'));
      expect(uniformityIssue).toBeUndefined();
    });

    it('flags suspicion issue when all items have uniform confidence', () => {
      const analysis = {
        tickets: [
          { ticket_id: 'T-1', discussed_state: 'ok', comments: ['c1'], confidence: 'HIGH' },
          { ticket_id: 'T-2', discussed_state: 'ok', comments: ['c2'], confidence: 'HIGH' },
        ],
        action_items: [
          { id: 'A-1', description: 'Do thing', assigned_to: 'X', confidence: 'HIGH' },
        ],
        change_requests: [],
        summary: 'A lengthy summary that is definitely longer than fifty characters for full score.',
      };

      const report = assessQuality(analysis, makeDefaultContext());

      expect(report.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('suspicious uniformity')]),
      );
    });

    it('includes correct dimension weights', () => {
      const report = assessQuality(makeRichAnalysis(), makeDefaultContext());

      expect(report.dimensions.structure.weight).toBe(0.25);
      expect(report.dimensions.density.weight).toBe(0.35);
      expect(report.dimensions.integrity.weight).toBe(0.25);
      expect(report.dimensions.crossRef.weight).toBe(0.15);
    });

    it('composite score equals weighted sum of dimensions', () => {
      const report = assessQuality(makeRichAnalysis(), makeDefaultContext());
      const d = report.dimensions;

      const expected = Math.round(
        d.structure.score * d.structure.weight +
        d.density.score * d.density.weight +
        d.integrity.score * d.integrity.weight +
        d.crossRef.score * d.crossRef.weight,
      );

      expect(report.score).toBe(expected);
    });

    it('shouldRetry is true only for FAIL grade', () => {
      const fail = assessQuality({}, makeDefaultContext());
      expect(fail.grade).toBe('FAIL');
      expect(fail.shouldRetry).toBe(true);

      const pass = assessQuality(makeRichAnalysis(), makeDefaultContext());
      expect(pass.grade).toBe('PASS');
      expect(pass.shouldRetry).toBe(false);
    });

    it('retryHints populated when grade is FAIL', () => {
      const report = assessQuality({}, makeDefaultContext());

      expect(report.grade).toBe('FAIL');
      expect(report.retryHints.length).toBeGreaterThan(0);
      // Should include hint about missing required fields
      expect(report.retryHints.join(' ')).toMatch(/required fields/i);
    });

    it('structure score is lower without valued optional fields', () => {
      const withOptional = makeRichAnalysis();
      const withoutOptional = {
        tickets: withOptional.tickets,
        action_items: withOptional.action_items,
        change_requests: withOptional.change_requests,
        summary: withOptional.summary,
        // no blockers, scope_changes, file_references, your_tasks
      };

      const rFull = assessQuality(withOptional, makeDefaultContext());
      const rMin = assessQuality(withoutOptional, makeDefaultContext());

      // All 4 required present → base 80, but no optional bonus → 80 vs 92
      expect(rMin.dimensions.structure.score).toBe(80);
      expect(rFull.dimensions.structure.score).toBeGreaterThan(rMin.dimensions.structure.score);
    });

    it('flags density issue when summary is very short', () => {
      const analysis = {
        tickets: [
          { ticket_id: 'T-1', discussed_state: 'x', comments: ['c'], confidence: 'HIGH' },
        ],
        action_items: [
          { id: 'A-1', description: 'Do x', assigned_to: 'Alice', confidence: 'MEDIUM' },
        ],
        change_requests: [
          { id: 'CR-1', where: 'here', what: 'that', confidence: 'LOW' },
        ],
        summary: 'Brief.',
      };

      const report = assessQuality(analysis, makeDefaultContext());

      expect(report.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('Summary is very short')]),
      );
    });
  });

  // -------------------------------------------------------------------------
  // formatQualityLine
  // -------------------------------------------------------------------------

  describe('formatQualityLine', () => {
    function makeReport(grade, score, dims) {
      return {
        grade,
        score,
        dimensions: {
          structure: { score: dims[0], weight: 0.25 },
          density: { score: dims[1], weight: 0.35 },
          integrity: { score: dims[2], weight: 0.25 },
          crossRef: { score: dims[3], weight: 0.15 },
        },
        issues: [],
        shouldRetry: false,
        retryHints: [],
      };
    }

    it('formats PASS grade with ✓ icon', () => {
      const line = formatQualityLine(makeReport('PASS', 75, [80, 70, 85, 90]), 'seg_00');

      expect(line).toContain('✓');
      expect(line).toContain('75/100');
      expect(line).toContain('(PASS)');
      expect(line).toContain('struct:80');
      expect(line).toContain('density:70');
      expect(line).toContain('integrity:85');
      expect(line).toContain('xref:90');
    });

    it('formats WARN grade with ⚠ icon', () => {
      const line = formatQualityLine(makeReport('WARN', 52, [60, 50, 55, 40]), 'seg_01');

      expect(line).toContain('⚠');
      expect(line).toContain('52/100');
      expect(line).toContain('(WARN)');
    });

    it('formats FAIL grade with ✗ icon', () => {
      const line = formatQualityLine(makeReport('FAIL', 20, [10, 15, 0, 50]), 'seg_02');

      expect(line).toContain('✗');
      expect(line).toContain('20/100');
      expect(line).toContain('(FAIL)');
    });
  });

  // -------------------------------------------------------------------------
  // getConfidenceStats
  // -------------------------------------------------------------------------

  describe('getConfidenceStats', () => {
    it('counts mixed confidence levels correctly', () => {
      const stats = getConfidenceStats(makeRichAnalysis());

      // 2 tickets + 2 actions + 1 CR + 1 blocker + 1 scope_change = 7
      expect(stats.total).toBe(7);
      // HIGH: T-001, AI-001, CR-001, BLK-001 = 4
      expect(stats.high).toBe(4);
      // MEDIUM: T-002, AI-002 = 2
      expect(stats.medium).toBe(2);
      // LOW: SC-001 = 1
      expect(stats.low).toBe(1);
      expect(stats.missing).toBe(0);
      expect(stats.coverage).toBe(100);
    });

    it('returns zeroes with coverage 0 for null analysis', () => {
      const stats = getConfidenceStats(null);

      expect(stats).toEqual({
        total: 0,
        high: 0,
        medium: 0,
        low: 0,
        missing: 0,
        coverage: 0,
      });
    });

    it('returns total 0 and coverage 1 when all arrays are empty', () => {
      const stats = getConfidenceStats({
        tickets: [],
        action_items: [],
        change_requests: [],
        blockers: [],
        scope_changes: [],
      });

      // Special case in source: total === 0 → coverage = 1
      expect(stats.total).toBe(0);
      expect(stats.coverage).toBe(1);
    });

    it('counts items without confidence field as missing', () => {
      const analysis = {
        tickets: [
          { ticket_id: 'T-1' },                            // missing
          { ticket_id: 'T-2', confidence: 'HIGH' },        // HIGH
        ],
        action_items: [
          { id: 'A-1', confidence: 'LOW' },                // LOW
        ],
        change_requests: [
          { id: 'CR-1', confidence: 'MEDIUM' },            // MEDIUM
          { id: 'CR-2' },                                   // missing
        ],
      };

      const stats = getConfidenceStats(analysis);

      expect(stats.total).toBe(5);
      expect(stats.high).toBe(1);
      expect(stats.medium).toBe(1);
      expect(stats.low).toBe(1);
      expect(stats.missing).toBe(2);
      // coverage = round(((5 - 2) / 5) * 100) = 60
      expect(stats.coverage).toBe(60);
    });
  });
});
