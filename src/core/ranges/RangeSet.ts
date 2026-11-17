/**
 * RangeSet — ordered, merged 1-based inclusive line intervals.
 *
 * The heart of progressive capture coverage math (spec Part 5): captured
 * ranges merge, overlaps collapse, gaps become visible, and completeness is
 * only ever claimed from actual interval coverage — never scroll position.
 */
import type { LineRange } from '../../shared/types';

export class RangeSet {
  private intervals: LineRange[] = []; // sorted, non-overlapping, non-adjacent-merged

  constructor(initial?: LineRange[]) {
    if (initial) for (const r of initial) this.add(r.startLine, r.endLine);
  }

  /** Add [start, end] (inclusive, 1-based). Invalid spans are ignored. */
  add(startLine: number, endLine: number): void {
    if (!(startLine <= endLine)) return;
    const next: LineRange[] = [];
    let mergedStart = startLine;
    let mergedEnd = endLine;
    let placed = false;
    for (const iv of this.intervals) {
      // Adjacent (touching) intervals merge: [1,5] + [6,10] -> [1,10].
      if (iv.endLine + 1 < mergedStart) {
        next.push(iv);
      } else if (mergedEnd + 1 < iv.startLine) {
        if (!placed) {
          next.push({ startLine: mergedStart, endLine: mergedEnd });
          placed = true;
        }
        next.push(iv);
      } else {
        mergedStart = Math.min(mergedStart, iv.startLine);
        mergedEnd = Math.max(mergedEnd, iv.endLine);
      }
    }
    if (!placed) next.push({ startLine: mergedStart, endLine: mergedEnd });
    this.intervals = next;
  }

  /** All intervals as a sorted copy. */
  ranges(): LineRange[] {
    return this.intervals.map((r) => ({ ...r }));
  }

  /** Total number of covered lines. */
  coveredCount(): number {
    let n = 0;
    for (const iv of this.intervals) n += iv.endLine - iv.startLine + 1;
    return n;
  }

  /** True when every line in [1, total] is covered. */
  coversAll(total: number): boolean {
    if (total <= 0) return false;
    return this.intervals.length === 1 && this.intervals[0]!.startLine === 1 && this.intervals[0]!.endLine >= total;
  }

  /** Missing intervals within [1, total]; empty when complete. */
  gapsWithin(total: number): LineRange[] {
    if (total <= 0) return [];
    const gaps: LineRange[] = [];
    let cursor = 1;
    for (const iv of this.intervals) {
      if (iv.startLine > cursor) gaps.push({ startLine: cursor, endLine: Math.min(iv.startLine - 1, total) });
      cursor = Math.max(cursor, iv.endLine + 1);
      if (cursor > total) break;
    }
    if (cursor <= total) gaps.push({ startLine: cursor, endLine: total });
    return gaps;
  }

  /** Lines covered within [1, total] only (clipped). */
  coveredWithin(total: number): number {
    let n = 0;
    for (const iv of this.intervals) {
      const s = Math.max(1, iv.startLine);
      const e = Math.min(total, iv.endLine);
      if (s <= e) n += e - s + 1;
    }
    return n;
  }

  /** True when any line of [start, end] is covered. */
  intersects(startLine: number, endLine: number): boolean {
    for (const iv of this.intervals) {
      if (iv.startLine > endLine) break;
      if (iv.endLine >= startLine) return true;
    }
    return false;
  }

  isEmpty(): boolean {
    return this.intervals.length === 0;
  }
}

/**
 * Pure helper: does [start,end] overlap any existing interval, and where?
 * Returns the overlap span or null.
 */
export function overlapOf(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): LineRange | null {
  const s = Math.max(aStart, bStart);
  const e = Math.min(aEnd, bEnd);
  return s <= e ? { startLine: s, endLine: e } : null;
}

/**
 * Subtract existing coverage from an incoming span; returns the parts of the
 * incoming span that contain lines not yet captured.
 */
export function subtractCoverage(
  startLine: number,
  endLine: number,
  coverage: RangeSet,
): LineRange[] {
  const remainder: LineRange[] = [];
  let cursor = startLine;
  for (const iv of coverage.ranges()) {
    if (iv.endLine < cursor) continue;
    if (iv.startLine > endLine) break;
    if (iv.startLine > cursor) {
      remainder.push({ startLine: cursor, endLine: Math.min(iv.startLine - 1, endLine) });
    }
    cursor = Math.max(cursor, iv.endLine + 1);
    if (cursor > endLine) break;
  }
  if (cursor <= endLine) remainder.push({ startLine: cursor, endLine: endLine });
  return remainder.filter((r) => r.startLine <= r.endLine);
}
