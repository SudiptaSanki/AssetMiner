import { describe, expect, it } from 'vitest';
import { mergeRanges, diffAgainstStored, type ExistingRange, type IncomingRange } from '../src/core/capture/ContentMerger';

function ex(rangeId: string, startLine: number, lines: string[]): ExistingRange {
  return { rangeId, startLine, endLine: startLine + lines.length - 1, lines, basis: 'dom-visible', capturedAt: 1 };
}
function inc(startLine: number, lines: string[], capturedAt = 2): IncomingRange {
  return { startLine, endLine: startLine + lines.length - 1, lines, basis: 'dom-visible', capturedAt };
}

describe('mergeRanges', () => {
  it('accepts a fully new range', () => {
    const r = mergeRanges([], [inc(10, ['a', 'b', 'c'])]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]).toMatchObject({ startLine: 10, endLine: 12 });
    expect(r.conflicts).toHaveLength(0);
    expect(r.reobserved).toHaveLength(0);
  });

  it('clips incoming ranges to the not-yet-stored part', () => {
    const r = mergeRanges([ex('a', 1, ['one', 'two', 'three'])], [inc(1, ['one', 'two', 'three', 'four'])]);
    expect(r.accepted).toEqual([expect.objectContaining({ startLine: 4, endLine: 4, lines: ['four'] })]);
    expect(r.reobserved).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  it('marks identical re-observation as evidence, storing nothing', () => {
    const stored = [ex('a', 1, ['x', 'y'])];
    const r = mergeRanges(stored, [inc(1, ['x', 'y'])]);
    expect(r.accepted).toHaveLength(0);
    expect(r.reobserved).toEqual([{ startLine: 1, endLine: 2 }]);
    expect(r.conflicts).toHaveLength(0);
  });

  it('reports conflicts for disagreeing content and never overwrites', () => {
    const stored = [ex('a', 1, ['x', 'y', 'z'])];
    const r = mergeRanges(stored, [inc(1, ['x', 'CHANGED', 'z'])]);
    expect(r.accepted).toHaveLength(0);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({
      startLine: 1,
      endLine: 3,
      differingLines: [2],
    });
    // Original stored content untouched.
    expect(stored[0]!.lines).toEqual(['x', 'y', 'z']);
  });

  it('merges overlapping incoming ranges among themselves (scroll up/down loops)', () => {
    const r = mergeRanges([], [inc(1, ['a', 'b', 'c', 'd']), inc(3, ['c', 'd', 'e']), inc(3, ['c', 'd', 'e'])]);
    // Overlapping + adjacent fragments coalesce into ONE stored range.
    expect(r.accepted).toEqual([
      expect.objectContaining({ startLine: 1, endLine: 5, lines: ['a', 'b', 'c', 'd', 'e'] }),
    ]);
  });

  it('splits acceptance around a stored island', () => {
    const stored = [ex('a', 3, ['c3', 'c4'])];
    const r = mergeRanges(stored, [inc(1, ['a1', 'a2', 'c3', 'c4', 'a5'])]);
    expect(r.accepted).toEqual([
      expect.objectContaining({ startLine: 1, endLine: 2 }),
      expect.objectContaining({ startLine: 5, endLine: 5 }),
    ]);
    expect(r.reobserved).toEqual([{ startLine: 3, endLine: 4 }]);
  });

  it('ignores malformed incoming ranges', () => {
    const bad: IncomingRange = { startLine: 5, endLine: 8, lines: ['only-one'], basis: 'dom-visible', capturedAt: 1 };
    const r = mergeRanges([], [bad]);
    expect(r.accepted).toHaveLength(0);
  });

  it('conflict on one incoming range does not block other new lines', () => {
    const stored = [ex('a', 1, ['x', 'y'])];
    const r = mergeRanges(stored, [inc(1, ['WRONG', 'y']), inc(10, ['fresh'])]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.accepted).toEqual([expect.objectContaining({ startLine: 10, endLine: 10 })]);
  });
});

describe('diffAgainstStored', () => {
  it('finds no differences for identical documents', () => {
    const stored = [ex('a', 1, ['l1', 'l2', 'l3'])];
    const d = diffAgainstStored(stored, ['l1', 'l2', 'l3']);
    expect(d.differingLines).toEqual([]);
    expect(d.missingLines).toEqual([]);
  });

  it('finds differing and missing lines', () => {
    const stored = [ex('a', 1, ['l1', 'OLD', 'l3'])];
    const d = diffAgainstStored(stored, ['l1', 'NEW', 'l3', 'l4']);
    expect(d.differingLines).toEqual([2]);
    expect(d.missingLines).toEqual([4]);
  });

  it('treats lines beyond stored coverage as missing', () => {
    const stored = [ex('a', 1, ['l1'])];
    const d = diffAgainstStored(stored, ['l1', 'l2', 'l3', 'l4', 'l5']);
    expect(d.missingLines).toEqual([2, 3, 4, 5]);
  });
});
