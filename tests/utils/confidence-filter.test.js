/**
 * Tests for src/utils/confidence-filter.js
 */

import { describe, it, expect } from 'vitest';
import { filterByConfidence, validateConfidenceLevel, countItems, LEVELS } from '../../src/utils/confidence-filter.js';

// ======================== FIXTURES ========================

function makeCompiled() {
  return {
    summary: 'Test summary',
    tickets: [
      { ticket_id: 'T-1', title: 'A', confidence: 'HIGH' },
      { ticket_id: 'T-2', title: 'B', confidence: 'MEDIUM' },
      { ticket_id: 'T-3', title: 'C', confidence: 'LOW' },
    ],
    action_items: [
      { id: 'AI-1', description: 'Do X', assigned_to: 'Alice', confidence: 'HIGH' },
      { id: 'AI-2', description: 'Do Y', assigned_to: 'Bob', confidence: 'LOW' },
    ],
    change_requests: [
      { id: 'CR-1', what: 'Fix API', confidence: 'MEDIUM' },
    ],
    blockers: [
      { id: 'B-1', type: 'dependency', description: 'Blocked by team X', confidence: 'HIGH' },
      { id: 'B-2', type: 'technical', description: 'Slow DB', confidence: 'LOW' },
    ],
    scope_changes: [
      { id: 'SC-1', type: 'added', confidence: 'MEDIUM' },
    ],
    your_tasks: {
      tasks_todo: [
        { id: 'YT-1', description: 'Review PR', confidence: 'HIGH' },
        { id: 'YT-2', description: 'Check docs', confidence: 'LOW' },
      ],
      tasks_waiting_on_others: [
        { id: 'YW-1', description: 'Waiting', confidence: 'MEDIUM' },
      ],
      decisions_needed: [],
      completed_in_call: [
        { id: 'YC-1', description: 'Approved design', confidence: 'HIGH' },
      ],
    },
    file_references: [
      { file_name: 'main.js' },
    ],
  };
}

// ======================== LEVELS ========================

describe('LEVELS', () => {
  it('defines correct hierarchy', () => {
    expect(LEVELS.HIGH).toBe(3);
    expect(LEVELS.MEDIUM).toBe(2);
    expect(LEVELS.LOW).toBe(1);
    expect(LEVELS.HIGH).toBeGreaterThan(LEVELS.MEDIUM);
    expect(LEVELS.MEDIUM).toBeGreaterThan(LEVELS.LOW);
  });
});

// ======================== countItems ========================

describe('countItems', () => {
  it('counts all items in a full compiled object', () => {
    const data = makeCompiled();
    const counts = countItems(data);
    expect(counts.tickets).toBe(3);
    expect(counts.action_items).toBe(2);
    expect(counts.change_requests).toBe(1);
    expect(counts.blockers).toBe(2);
    expect(counts.scope_changes).toBe(1);
    expect(counts.your_tasks).toBe(4); // 2 + 1 + 0 + 1
    expect(counts.total).toBe(13);
  });

  it('handles empty/missing arrays', () => {
    const counts = countItems({ summary: 'empty' });
    expect(counts.total).toBe(0);
  });

  it('handles missing your_tasks', () => {
    const data = { tickets: [{ ticket_id: 'T-1', confidence: 'HIGH' }] };
    const counts = countItems(data);
    expect(counts.tickets).toBe(1);
    expect(counts.your_tasks).toBe(0);
    expect(counts.total).toBe(1);
  });
});

// ======================== filterByConfidence ========================

describe('filterByConfidence', () => {
  it('returns all items when minLevel is LOW', () => {
    const data = makeCompiled();
    const result = filterByConfidence(data, 'LOW');
    expect(result.tickets).toHaveLength(3);
    expect(result.action_items).toHaveLength(2);
    expect(result._filterMeta.removed).toBe(0);
    expect(result._filterMeta.minConfidence).toBe('LOW');
  });

  it('returns all items when minLevel is not provided', () => {
    const result = filterByConfidence(makeCompiled());
    expect(result._filterMeta.removed).toBe(0);
  });

  it('filters LOW items when minLevel is MEDIUM', () => {
    const result = filterByConfidence(makeCompiled(), 'MEDIUM');
    // Tickets: HIGH + MEDIUM kept, LOW removed → 2
    expect(result.tickets).toHaveLength(2);
    expect(result.tickets.every(t => t.confidence !== 'LOW')).toBe(true);
    // Action items: HIGH kept, LOW removed → 1
    expect(result.action_items).toHaveLength(1);
    expect(result.action_items[0].confidence).toBe('HIGH');
    // Change requests: MEDIUM kept → 1
    expect(result.change_requests).toHaveLength(1);
    // Blockers: HIGH kept, LOW removed → 1
    expect(result.blockers).toHaveLength(1);
    // Scope changes: MEDIUM kept → 1
    expect(result.scope_changes).toHaveLength(1);
  });

  it('keeps only HIGH when minLevel is HIGH', () => {
    const result = filterByConfidence(makeCompiled(), 'HIGH');
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0].ticket_id).toBe('T-1');
    expect(result.action_items).toHaveLength(1);
    expect(result.change_requests).toHaveLength(0);
    expect(result.blockers).toHaveLength(1);
    expect(result.scope_changes).toHaveLength(0);
  });

  it('filters your_tasks sub-arrays', () => {
    const result = filterByConfidence(makeCompiled(), 'HIGH');
    expect(result.your_tasks.tasks_todo).toHaveLength(1);
    expect(result.your_tasks.tasks_todo[0].id).toBe('YT-1');
    expect(result.your_tasks.tasks_waiting_on_others).toHaveLength(0);
    expect(result.your_tasks.completed_in_call).toHaveLength(1);
  });

  it('preserves summary and file_references', () => {
    const result = filterByConfidence(makeCompiled(), 'HIGH');
    expect(result.summary).toBe('Test summary');
    expect(result.file_references).toHaveLength(1);
  });

  it('handles case-insensitive level', () => {
    const result = filterByConfidence(makeCompiled(), 'medium');
    expect(result._filterMeta.minConfidence).toBe('MEDIUM');
    expect(result.tickets).toHaveLength(2);
  });

  it('attaches _filterMeta with counts', () => {
    const result = filterByConfidence(makeCompiled(), 'MEDIUM');
    const meta = result._filterMeta;
    expect(meta.minConfidence).toBe('MEDIUM');
    expect(meta.originalCounts.total).toBe(13);
    expect(meta.filteredCounts.total).toBeLessThan(13);
    expect(meta.removed).toBe(meta.originalCounts.total - meta.filteredCounts.total);
    expect(meta.removed).toBeGreaterThan(0);
  });

  it('treats items without confidence as LOW', () => {
    const data = {
      tickets: [
        { ticket_id: 'T-1', title: 'No conf' },
        { ticket_id: 'T-2', title: 'Has conf', confidence: 'HIGH' },
      ],
    };
    const result = filterByConfidence(data, 'MEDIUM');
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0].ticket_id).toBe('T-2');
  });

  it('returns input unchanged for null/undefined', () => {
    expect(filterByConfidence(null)).toBeNull();
    expect(filterByConfidence(undefined)).toBeUndefined();
  });

  it('returns input unchanged for non-object', () => {
    expect(filterByConfidence('string')).toBe('string');
  });

  it('handles empty arrays gracefully', () => {
    const data = { summary: 'empty', tickets: [], action_items: [] };
    const result = filterByConfidence(data, 'HIGH');
    expect(result.tickets).toHaveLength(0);
    expect(result._filterMeta.removed).toBe(0);
  });

  it('handles missing your_tasks gracefully', () => {
    const data = { tickets: [{ ticket_id: 'T-1', confidence: 'HIGH' }] };
    const result = filterByConfidence(data, 'HIGH');
    expect(result.your_tasks).toBeUndefined();
    expect(result.tickets).toHaveLength(1);
  });
});

// ======================== validateConfidenceLevel ========================

describe('validateConfidenceLevel', () => {
  it('accepts HIGH', () => {
    const r = validateConfidenceLevel('HIGH');
    expect(r.valid).toBe(true);
    expect(r.normalised).toBe('HIGH');
    expect(r.error).toBeNull();
  });

  it('accepts medium (case-insensitive)', () => {
    const r = validateConfidenceLevel('medium');
    expect(r.valid).toBe(true);
    expect(r.normalised).toBe('MEDIUM');
  });

  it('accepts Low', () => {
    const r = validateConfidenceLevel('Low');
    expect(r.valid).toBe(true);
    expect(r.normalised).toBe('LOW');
  });

  it('rejects invalid level', () => {
    const r = validateConfidenceLevel('SUPER');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('Invalid confidence level');
    expect(r.error).toContain('SUPER');
  });

  it('rejects null', () => {
    const r = validateConfidenceLevel(null);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('must be a string');
  });

  it('rejects empty string', () => {
    const r = validateConfidenceLevel('');
    expect(r.valid).toBe(false);
  });

  it('rejects number', () => {
    const r = validateConfidenceLevel(42);
    expect(r.valid).toBe(false);
  });
});
