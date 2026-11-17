import { describe, expect, it } from 'vitest';
import { RangeSet, overlapOf, subtractCoverage } from '../src/core/ranges/RangeSet';

describe('RangeSet', () => {
  it('adds and sorts intervals', () => {
    const s = new RangeSet();
    s.add(10, 12);
    s.add(1, 3);
    expect(s.ranges()).toEqual([
      { startLine: 1, endLine: 3 },
      { startLine: 10, endLine: 12 },
    ]);
    expect(s.coveredCount()).toBe(6);
  });

  it('merges adjacent and overlapping intervals', () => {
    const s = new RangeSet();
    s.add(1, 5);
    s.add(6, 10); // adjacent
    s.add(20, 25);
    s.add(22, 30); // overlap
    expect(s.ranges()).toEqual([
      { startLine: 1, endLine: 10 },
      { startLine: 20, endLine: 30 },
    ]);
    expect(s.coveredCount()).toBe(21);
  });

  it('absorbs contained intervals without duplicating coverage', () => {
    const s = new RangeSet();
    s.add(1, 100);
    s.add(40, 60);
    expect(s.ranges()).toEqual([{ startLine: 1, endLine: 100 }]);
    expect(s.coveredCount()).toBe(100);
  });

  it('computes gaps within a known total', () => {
    const s = new RangeSet();
    s.add(1, 200);
    s.add(401, 600);
    s.add(601, 723);
    expect(s.gapsWithin(723)).toEqual([{ startLine: 201, endLine: 400 }]);
    expect(s.coveredWithin(723)).toBe(523);
    expect(s.coversAll(723)).toBe(false);
  });

  it('coversAll requires exact coverage from line 1', () => {
    const s = new RangeSet();
    s.add(2, 10);
    expect(s.coversAll(10)).toBe(false);
    s.add(1, 1);
    expect(s.coversAll(10)).toBe(true);
  });

  it('ignores invalid spans', () => {
    const s = new RangeSet();
    s.add(5, 2);
    s.add(0, -1);
    expect(s.isEmpty()).toBe(true);
  });

  it('detects intersections', () => {
    const s = new RangeSet();
    s.add(5, 8);
    expect(s.intersects(8, 20)).toBe(true);
    expect(s.intersects(9, 20)).toBe(false);
  });
});

describe('overlapOf / subtractCoverage', () => {
  it('finds overlap spans', () => {
    expect(overlapOf(1, 10, 5, 20)).toEqual({ startLine: 5, endLine: 10 });
    expect(overlapOf(1, 4, 5, 9)).toBeNull();
  });

  it('returns only the not-yet-covered part of incoming spans', () => {
    const coverage = new RangeSet();
    coverage.add(1, 5);
    coverage.add(8, 9);
    expect(subtractCoverage(1, 10, coverage)).toEqual([
      { startLine: 6, endLine: 7 },
      { startLine: 10, endLine: 10 },
    ]);
  });

  it('returns the whole span when nothing is covered', () => {
    const coverage = new RangeSet();
    expect(subtractCoverage(3, 7, coverage)).toEqual([{ startLine: 3, endLine: 7 }]);
  });
});
