'use strict';

const { computeWindow } = require('../../src/utils/interactive');

describe('computeWindow', () => {
  it('returns full range when items fit in viewport', () => {
    const { start, end } = computeWindow(0, 5, 20, 0);
    expect(start).toBe(0);
    expect(end).toBe(5);
  });

  it('returns full range regardless of cursor when items fit', () => {
    const { start, end } = computeWindow(4, 5, 20, 0);
    expect(start).toBe(0);
    expect(end).toBe(5);
  });

  it('scrolls down when cursor moves below viewport', () => {
    // 40 items, viewport = 10, cursor at 15, previous offset 0
    const { start, end } = computeWindow(15, 40, 10, 0);
    expect(start).toBe(6);
    expect(end).toBe(16);
    expect(end - start).toBe(10);
  });

  it('scrolls up when cursor moves above viewport', () => {
    // 40 items, viewport = 10, cursor at 2, previous offset 10
    const { start, end } = computeWindow(2, 40, 10, 10);
    expect(start).toBe(2);
    expect(end).toBe(12);
  });

  it('keeps viewport stable when cursor is within range', () => {
    // 40 items, viewport = 10, cursor at 5, previous offset 0
    const { start, end } = computeWindow(5, 40, 10, 0);
    expect(start).toBe(0);
    expect(end).toBe(10);
  });

  it('clamps at the end of the list', () => {
    // 40 items, viewport = 10, cursor at 39 (last item)
    const { start, end } = computeWindow(39, 40, 10, 0);
    expect(end).toBe(40);
    expect(start).toBe(30);
    expect(end - start).toBe(10);
  });

  it('clamps at start of the list', () => {
    const { start, end } = computeWindow(0, 40, 10, 5);
    expect(start).toBe(0);
    expect(end).toBe(10);
  });

  it('handles single item', () => {
    const { start, end } = computeWindow(0, 1, 10, 0);
    expect(start).toBe(0);
    expect(end).toBe(1);
  });

  it('handles viewport exactly equal to total items', () => {
    const { start, end } = computeWindow(5, 10, 10, 0);
    expect(start).toBe(0);
    expect(end).toBe(10);
  });

  it('maintains viewport size as cursor scrolls forward', () => {
    let offset = 0;
    for (let cursor = 0; cursor < 40; cursor++) {
      const { start, end } = computeWindow(cursor, 40, 10, offset);
      expect(end - start).toBe(10);
      expect(cursor).toBeGreaterThanOrEqual(start);
      expect(cursor).toBeLessThan(end);
      offset = start;
    }
  });

  it('maintains viewport size as cursor scrolls backward', () => {
    let offset = 30;
    for (let cursor = 39; cursor >= 0; cursor--) {
      const { start, end } = computeWindow(cursor, 40, 10, offset);
      expect(end - start).toBe(10);
      expect(cursor).toBeGreaterThanOrEqual(start);
      expect(cursor).toBeLessThan(end);
      offset = start;
    }
  });
});
