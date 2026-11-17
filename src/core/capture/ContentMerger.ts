/**
 * ContentMerger — safe merging of progressively captured source ranges
 * (spec Part 5.4/6.3, addendum #3).
 *
 * Pure, synchronous, storage-agnostic. The CaptureController feeds it the
 * already-stored ranges of the current revision plus freshly observed ranges;
 * it classifies every incoming range as:
 *
 *   accepted        — contains lines never captured before → store (clipped)
 *   reobserved      — overlaps only already-stored lines with IDENTICAL
 *                     content → no write, but counts as consistency evidence
 *   conflict        — overlaps stored lines with DIFFERENT content → never
 *                     overwrite; report for re-inspection / authoritative refresh
 *
 * Never concatenates blindly; never mixes revisions; never silently discards.
 */
import type { ContentBasis, LineRange } from '../../shared/types';
import { RangeSet, overlapOf, subtractCoverage } from '../ranges/RangeSet';

export interface ExistingRange {
  rangeId: string;
  startLine: number;
  endLine: number;
  /** Exact line texts for [startLine..endLine]. */
  lines: string[];
  basis: ContentBasis;
  capturedAt: number;
}

export interface IncomingRange {
  startLine: number;
  endLine: number;
  lines: string[];
  basis: ContentBasis;
  capturedAt: number;
}

export interface ConflictDraft {
  startLine: number;
  endLine: number;
  differingLines: number[];
  existingLines: string[];
  incomingLines: string[];
}

export interface MergeResult {
  /** Ranges (possibly clipped) whose lines are all new — safe to store. */
  accepted: IncomingRange[];
  /** Spans whose overlap matched stored content exactly — consistency evidence. */
  reobserved: LineRange[];
  /** Disagreements — the controller decides (policy: authoritative doc → new
   *  revision; ambiguous DOM read → flag for re-inspection). */
  conflicts: ConflictDraft[];
}

function validateIncoming(r: IncomingRange): boolean {
  return (
    Number.isInteger(r.startLine) &&
    Number.isInteger(r.endLine) &&
    r.startLine >= 1 &&
    r.startLine <= r.endLine &&
    Array.isArray(r.lines) &&
    r.lines.length === r.endLine - r.startLine + 1
  );
}

export function mergeRanges(existing: ExistingRange[], incoming: IncomingRange[]): MergeResult {
  const result: MergeResult = { accepted: [], reobserved: [], conflicts: [] };
  // Virtual coverage = stored ranges + accepted-so-far, so multiple incoming
  // ranges that overlap each other are deduplicated among themselves too.
  const coverage = new RangeSet();
  const virtualExisting: ExistingRange[] = [...existing];
  for (const e of existing) coverage.add(e.startLine, e.endLine);

  const sorted = [...incoming].sort((a, b) => a.startLine - b.startLine);

  for (const inc of sorted) {
    if (!validateIncoming(inc)) continue; // malformed observation — ignore, never corrupt

    let conflictFound = false;

    for (const ex of virtualExisting) {
      const ov = overlapOf(inc.startLine, inc.endLine, ex.startLine, ex.endLine);
      if (!ov) continue;
      // Compare line-by-line across the overlap.
      const differing: number[] = [];
      for (let n = ov.startLine; n <= ov.endLine; n++) {
        const existingLine = ex.lines[n - ex.startLine] ?? '';
        const incomingLine = inc.lines[n - inc.startLine] ?? '';
        if (existingLine !== incomingLine) differing.push(n);
      }
      if (differing.length > 0) {
        conflictFound = true;
        result.conflicts.push({
          startLine: ov.startLine,
          endLine: ov.endLine,
          differingLines: differing,
          existingLines: ex.lines.slice(
            ov.startLine - ex.startLine,
            ov.endLine - ex.startLine + 1,
          ),
          incomingLines: inc.lines.slice(
            ov.startLine - inc.startLine,
            ov.endLine - inc.startLine + 1,
          ),
        });
      } else {
        // Evidence is recorded for the exact overlap span, not the whole
        // incoming span (which may include not-yet-stored lines).
        result.reobserved.push({ startLine: ov.startLine, endLine: ov.endLine });
      }
    }

    if (conflictFound) {
      // Conflicting observation: store nothing from it. The controller marks
      // the conflict and requests re-inspection or an authoritative refresh.
      continue;
    }

    // Accept only the sub-spans with genuinely new lines.
    const newSpans = subtractCoverage(inc.startLine, inc.endLine, coverage);
    for (const span of newSpans) {
      const slice = inc.lines.slice(
        span.startLine - inc.startLine,
        span.endLine - inc.startLine + 1,
      );
      const clipped: IncomingRange = {
        startLine: span.startLine,
        endLine: span.endLine,
        lines: slice,
        basis: inc.basis,
        capturedAt: inc.capturedAt,
      };
      result.accepted.push(clipped);
      virtualExisting.push({
        rangeId: '',
        startLine: clipped.startLine,
        endLine: clipped.endLine,
        lines: clipped.lines,
        basis: clipped.basis,
        capturedAt: clipped.capturedAt,
      });
      coverage.add(span.startLine, span.endLine);
    }
  }

  result.accepted = coalesceAdjacent(result.accepted);
  return result;
}

/**
 * Merge accepted ranges that touch (end+1 == next start) so one scrolling
 * pass produces one stored range instead of a chain of fragments.
 */
function coalesceAdjacent(ranges: IncomingRange[]): IncomingRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
  const out: IncomingRange[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1]!;
    const cur = sorted[i]!;
    if (cur.startLine === prev.endLine + 1 && cur.basis === prev.basis) {
      out[out.length - 1] = { ...prev, endLine: cur.endLine, lines: [...prev.lines, ...cur.lines] };
    } else {
      out.push(cur);
    }
  }
  return out;
}

/**
 * Full-document replacement check (addendum #4 revision rule):
 * Given a complete authoritative document, compare against stored content.
 * Returns differing line numbers so the caller can decide whether this is a
 * genuine new revision (source changed) or a bit-identical re-export (no-op).
 */
export function diffAgainstStored(
  stored: ExistingRange[],
  documentLines: string[],
): { differingLines: number[]; missingLines: number[] } {
  const differing: number[] = [];
  const covered = new RangeSet();
  for (const e of stored) {
    covered.add(e.startLine, e.endLine);
    for (let n = Math.max(1, e.startLine); n <= e.endLine && n <= documentLines.length; n++) {
      const storedLine = e.lines[n - e.startLine] ?? '';
      if (storedLine !== (documentLines[n - 1] ?? '')) differing.push(n);
    }
  }
  const missing: number[] = [];
  for (let n = 1; n <= documentLines.length; n++) {
    if (!covered.intersects(n, n)) missing.push(n);
  }
  return { differingLines: differing, missingLines: missing };
}
