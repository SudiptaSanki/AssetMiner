import { describe, expect, it } from 'vitest';
import { compareBySourceOrder, sortFoldersBySourceOrder, sortFilesBySourceOrder } from '../src/core/identity/order';
import type { FileRecord, FolderRecord } from '../src/shared/types';

function folder(path: string, displayOrder: number): FolderRecord {
  const name = path.split('/').pop()!;
  return {
    folderId: path,
    projectId: 'p',
    parentPath: '',
    relativePath: path,
    name,
    discoveryStatus: 'discovered',
    knownEmpty: false,
    displayOrder,
    firstSeenAt: 0,
    lastInspectedAt: null,
  };
}

function file(path: string, displayOrder: number): FileRecord {
  const name = path.split('/').pop()!;
  return {
    fileId: path,
    projectId: 'p',
    folderPath: '',
    relativePath: path,
    filename: name,
    extension: '',
    mimeType: 'text/plain',
    currentRevisionId: null,
    captureState: 'pending',
    verificationState: 'unverified',
    expectedLineCount: null,
    expectedLineCountSource: null,
    capturedLineCount: 0,
    coveragePercent: null,
    missingRanges: [],
    isBinary: false,
    byteCount: null,
    pathSource: 'exact',
    displayOrder,
    conflictCount: 0,
    contentHash: null,
    firstSeenAt: 0,
    lastInspectedAt: null,
    lastUpdated: 0,
    lastError: null,
  };
}

describe('source order preservation (user requirement: order must never break)', () => {
  it('sorts by the source page order, not alphabetically', () => {
    const rows = [
      file('zeta.ts', 0),
      file('alpha.ts', 1),
      file('middle.ts', 2),
    ];
    expect(sortFilesBySourceOrder(rows).map((f) => f.filename)).toEqual(['zeta.ts', 'alpha.ts', 'middle.ts']);
  });

  it('falls back to alphabetical when order is unknown (MAX_SAFE_INTEGER)', () => {
    const rows = [file('b.ts', Number.MAX_SAFE_INTEGER), file('a.ts', Number.MAX_SAFE_INTEGER)];
    expect(sortFilesBySourceOrder(rows).map((f) => f.filename)).toEqual(['a.ts', 'b.ts']);
  });

  it('places unknown-order rows after known-order rows', () => {
    const rows = [file('unknown.ts', Number.MAX_SAFE_INTEGER), file('known.ts', 5)];
    expect(sortFilesBySourceOrder(rows).map((f) => f.filename)).toEqual(['known.ts', 'unknown.ts']);
  });

  it('works for folders identically', () => {
    const rows = [folder('src/zz', 1), folder('src/aa', 0)];
    expect(sortFoldersBySourceOrder(rows).map((f) => f.name)).toEqual(['aa', 'zz']);
  });

  it('compareBySourceOrder is stable and deterministic on ties', () => {
    const a = { displayOrder: 3, name: 'x' };
    const b = { displayOrder: 3, name: 'x' };
    expect(compareBySourceOrder(a, b)).toBe(0);
  });
});
