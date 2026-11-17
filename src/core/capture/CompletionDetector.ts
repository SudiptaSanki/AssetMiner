/**
 * CompletionDetector — derives the two INDEPENDENT status axes from raw
 * capture facts (spec Part 5.5/7, addendum #2).
 *
 *   captureState      what we hold:  pending → capturing → partial → captured-full
 *   verificationState what we can prove about it: unverified → verified
 *                     (or conflict / stale)
 *
 * Non-negotiables encoded here:
 *  - "captured-full" requires a KNOWN total with 100% interval coverage.
 *  - "verified" requires either an authorized complete document model, or full
 *    coverage of a known total plus at least one consistent re-observation.
 *  - Scroll position is never an input. Reaching an editor's bottom proves
 *    nothing and contributes nothing here.
 *  - Unknown total length can never produce "captured-full" or 100%.
 */
import type {
  CaptureState,
  ContentBasis,
  LineRange,
  StatusDot,
  VerificationState,
} from '../../shared/types';
import { RangeSet } from '../ranges/RangeSet';

export interface CompletionInput {
  /** Captured ranges of the CURRENT revision (line spans only). */
  ranges: LineRange[];
  /** Expected total line count from a reliable source, or null when unknown. */
  expectedLineCount: number | null;
  /** True when the current revision includes an authorized full-document capture. */
  hasFullDocument: boolean;
  /** Strongest content basis contributing to the current revision. */
  strongestBasis: ContentBasis;
  /** Count of distinct capture moments that re-observed stored lines identically. */
  consistentObservations: number;
  /** Unresolved conflicts on the current revision. */
  openConflictCount: number;
  /** Is a capture session actively working on this file right now? */
  isCapturing: boolean;
  /** Sticky error recorded by the controller (observer/storage failure). */
  hasError: boolean;
}

export interface CompletionEvaluation {
  captureState: CaptureState;
  verificationState: VerificationState;
  capturedLineCount: number;
  coveragePercent: number | null;
  missingRanges: LineRange[];
}

export function evaluateCompletion(input: CompletionInput): CompletionEvaluation {
  const set = new RangeSet(input.ranges);
  const capturedLineCount = set.coveredCount();
  const known = input.expectedLineCount !== null && input.expectedLineCount > 0;

  const capturedWithin = known ? set.coveredWithin(input.expectedLineCount!) : capturedLineCount;
  const missingRanges = known ? set.gapsWithin(input.expectedLineCount!) : [];
  const coveragePercent = known
    ? Math.round((capturedWithin / input.expectedLineCount!) * 1000) / 10
    : null;
  const completeCoverage = known && capturedWithin === input.expectedLineCount;

  // ---- capture axis ----
  let captureState: CaptureState;
  if (input.hasError) {
    captureState = 'error';
  } else if (capturedLineCount === 0) {
    captureState = input.isCapturing ? 'capturing' : 'pending';
  } else if (completeCoverage || input.hasFullDocument) {
    captureState = input.isCapturing ? 'capturing' : 'captured-full';
  } else {
    captureState = 'partial';
  }
  // While actively receiving content, "capturing" communicates liveness even
  // if the union is already complete (final state lands when capture settles).
  if (input.isCapturing && captureState === 'partial') captureState = 'capturing';

  // ---- verification axis ----
  let verificationState: VerificationState;
  if (input.openConflictCount > 0) {
    verificationState = 'conflict';
  } else if (input.hasFullDocument && input.strongestBasis === 'document-model') {
    // Complete authorized document model = evidence of the whole source.
    verificationState = 'verified';
  } else if (completeCoverage && input.consistentObservations >= 2) {
    // Full coverage of a known total, re-observed consistently at distinct
    // moments = evidence the stored content matches what the editor shows.
    verificationState = 'verified';
  } else {
    verificationState = 'unverified';
  }

  return {
    captureState,
    verificationState,
    capturedLineCount,
    coveragePercent,
    missingRanges,
  };
}

/**
 * Dot color for tree/list indicators (spec 7.1). Green is reserved for
 * genuinely verified completion — captured-full alone stays yellow when
 * verification evidence is missing ("capture complete, equivalence unproven").
 */
export function statusDot(
  captureState: CaptureState,
  verificationState: VerificationState,
): StatusDot {
  if (captureState === 'error' || verificationState === 'conflict') return 'red';
  if (captureState === 'capturing') return 'blue';
  if (captureState === 'captured-full' && verificationState === 'verified') return 'green';
  if (captureState === 'pending') return 'grey';
  return 'yellow'; // partial, or captured-full but unverified/stale
}

export function statusLabel(
  captureState: CaptureState,
  verificationState: VerificationState,
): string {
  if (captureState === 'error') return 'Capture error';
  if (verificationState === 'conflict') return 'Content conflict — re-inspect';
  if (captureState === 'capturing') return 'Capturing…';
  if (captureState === 'pending') return 'Not captured';
  if (captureState === 'captured-full') {
    return verificationState === 'verified'
      ? 'Verified complete'
      : 'Capture complete — equivalence unproven';
  }
  return 'Partially captured';
}
