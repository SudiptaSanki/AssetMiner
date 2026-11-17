import { describe, expect, it } from 'vitest';
import { evaluateCompletion, statusDot, statusLabel } from '../src/core/capture/CompletionDetector';

const base = {
  ranges: [],
  expectedLineCount: null as number | null,
  hasFullDocument: false,
  strongestBasis: 'dom-visible' as const,
  consistentObservations: 0,
  openConflictCount: 0,
  isCapturing: false,
  hasError: false,
};

describe('evaluateCompletion — independent capture and verification axes', () => {
  it('pending file with nothing captured', () => {
    const r = evaluateCompletion({ ...base });
    expect(r.captureState).toBe('pending');
    expect(r.verificationState).toBe('unverified');
    expect(r.coveragePercent).toBeNull();
    expect(r.missingRanges).toEqual([]);
  });

  it('partial capture of a known total', () => {
    const r = evaluateCompletion({
      ...base,
      ranges: [{ startLine: 1, endLine: 200 }],
      expectedLineCount: 723,
    });
    expect(r.captureState).toBe('partial');
    expect(r.verificationState).toBe('unverified');
    expect(r.capturedLineCount).toBe(200);
    expect(r.coveragePercent).toBeCloseTo(27.7, 1);
    // Gaps are reported as contiguous intervals: nothing is captured between
    // 201 and 723, so that is ONE gap span.
    expect(r.missingRanges).toEqual([{ startLine: 201, endLine: 723 }]);
  });

  it('full coverage of a known total — captured-full but UNVERIFIED without evidence', () => {
    const r = evaluateCompletion({
      ...base,
      ranges: [{ startLine: 1, endLine: 723 }],
      expectedLineCount: 723,
      consistentObservations: 1,
    });
    expect(r.captureState).toBe('captured-full');
    expect(r.verificationState).toBe('unverified');
    expect(r.coveragePercent).toBe(100);
    expect(statusDot(r.captureState, r.verificationState)).toBe('yellow');
  });

  it('full coverage + consistent re-observation → verified', () => {
    const r = evaluateCompletion({
      ...base,
      ranges: [{ startLine: 1, endLine: 723 }],
      expectedLineCount: 723,
      consistentObservations: 2,
    });
    expect(r.captureState).toBe('captured-full');
    expect(r.verificationState).toBe('verified');
    expect(statusDot(r.captureState, r.verificationState)).toBe('green');
    expect(statusLabel(r.captureState, r.verificationState)).toBe('Verified complete');
  });

  it('authorized document model verifies even with a single observation', () => {
    const r = evaluateCompletion({
      ...base,
      ranges: [{ startLine: 1, endLine: 723 }],
      expectedLineCount: 723,
      hasFullDocument: true,
      strongestBasis: 'document-model',
      consistentObservations: 1,
    });
    expect(r.captureState).toBe('captured-full');
    expect(r.verificationState).toBe('verified');
  });

  it('unknown total can NEVER be captured-full or 100%', () => {
    const r = evaluateCompletion({
      ...base,
      ranges: [{ startLine: 1, endLine: 5000 }],
      expectedLineCount: null,
    });
    expect(r.captureState).toBe('partial');
    expect(r.coveragePercent).toBeNull();
    expect(r.missingRanges).toEqual([]);
  });

  it('conflicts dominate verification', () => {
    const r = evaluateCompletion({
      ...base,
      ranges: [{ startLine: 1, endLine: 10 }],
      expectedLineCount: 10,
      hasFullDocument: true,
      strongestBasis: 'document-model',
      openConflictCount: 1,
    });
    expect(r.verificationState).toBe('conflict');
    expect(statusDot(r.captureState, r.verificationState)).toBe('red');
  });

  it('capturing state shows while actively receiving', () => {
    const r = evaluateCompletion({
      ...base,
      ranges: [{ startLine: 1, endLine: 50 }],
      expectedLineCount: 723,
      isCapturing: true,
    });
    expect(r.captureState).toBe('capturing');
    expect(statusDot(r.captureState, r.verificationState)).toBe('blue');
  });

  it('error state is sticky until cleared', () => {
    const r = evaluateCompletion({
      ...base,
      ranges: [{ startLine: 1, endLine: 5 }],
      expectedLineCount: 10,
      hasError: true,
    });
    expect(r.captureState).toBe('error');
    expect(statusDot(r.captureState, r.verificationState)).toBe('red');
  });

  it('captured beyond expected (stale total) still honest: 100% of known, partial list empty', () => {
    const r = evaluateCompletion({
      ...base,
      ranges: [{ startLine: 1, endLine: 50 }],
      expectedLineCount: 10,
    });
    expect(r.coveragePercent).toBe(100);
    expect(r.missingRanges).toEqual([]);
    expect(r.captureState).toBe('captured-full');
  });
});

describe('statusDot / statusLabel matrix', () => {
  it('grey for pending', () => {
    expect(statusDot('pending', 'unverified')).toBe('grey');
  });
  it('yellow for partial', () => {
    expect(statusDot('partial', 'unverified')).toBe('yellow');
  });
  it('yellow for captured-full but unverified (equivalence unproven)', () => {
    expect(statusDot('captured-full', 'unverified')).toBe('yellow');
  });
  it('green only for verified complete', () => {
    expect(statusDot('captured-full', 'verified')).toBe('green');
  });
  it('red for conflicts and errors', () => {
    expect(statusDot('partial', 'conflict')).toBe('red');
    expect(statusDot('error', 'unverified')).toBe('red');
  });
  it('labels match spec language', () => {
    expect(statusLabel('captured-full', 'unverified')).toBe('Capture complete — equivalence unproven');
    expect(statusLabel('partial', 'unverified')).toBe('Partially captured');
    expect(statusLabel('pending', 'unverified')).toBe('Not captured');
  });
});
