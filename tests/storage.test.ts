/**
 * Storage integration tests: canonical identity, duplicate prevention,
 * document revisions, transactional recovery, progress honesty.
 * Uses fake-indexeddb (fresh DB per test via tests/setup.ts).
 */
import { describe, expect, it } from 'vitest';
import { openDatabase, recoverInterruptedWrites } from '../src/storage/db';
import { getOrCreateProject } from '../src/storage/repositories/projects';
import { ensureFileDiscovered, ensureFolder, listFiles, listFolders } from '../src/storage/repositories/tree';
import { applyBinaryFileCapture, applyDocumentModel, getFileDetail, readRevisionLines, resolveConflict } from '../src/storage/repositories/capture';
import { ensureAssetDiscovered, setAssetCaptured } from '../src/storage/repositories/assets';
import { attachProjectAndAssets, buildExport } from '../src/core/export/engine';
import { ingestExposedContent } from '../src/core/dedup/DuplicateManager';
import { computeProjectProgress } from '../src/storage/repositories/progress';
import { localId } from '../src/shared/utils';
import { sha256Hex } from '../src/shared/hash';
import type { IDBPDatabase } from 'idb';
import type { AssetMinerSchema } from '../src/storage/db';

async function freshDb(): Promise<IDBPDatabase<AssetMinerSchema>> {
  return openDatabase(`test-${localId('db')}`);
}

async function setupProject(db: IDBPDatabase<AssetMinerSchema>) {
  const { project } = await getOrCreateProject(db, 'https://demo.local', 'my-project', 'demo');
  return project;
}

describe('canonical identity (spec Part 6 / Test 5)', () => {
  it('re-discovering the same path never creates a second record', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    const first = await ensureFileDiscovered(db, project.projectId, { path: 'src/pages/Home.tsx', pathSource: 'exact', isBinaryHint: false });
    const second = await ensureFileDiscovered(db, project.projectId, { path: '/src/pages/Home.tsx', pathSource: 'exact', isBinaryHint: false });
    expect(second.created).toBe(false);
    expect(second.file.fileId).toBe(first.file.fileId);
    const all = await listFiles(db, project.projectId);
    expect(all).toHaveLength(1);
  });

  it('revisiting a folder updates its record instead of duplicating it', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    await ensureFolder(db, project.projectId, 'src/components');
    await ensureFolder(db, project.projectId, 'src/components');
    await ensureFolder(db, project.projectId, '/src/components/');
    const folders = await listFolders(db, project.projectId);
    expect(folders).toHaveLength(1);
  });

  it('source display order is stored and updated on re-discovery', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    await ensureFileDiscovered(db, project.projectId, { path: 'b.ts', pathSource: 'exact', isBinaryHint: false, displayOrder: 1 });
    await ensureFileDiscovered(db, project.projectId, { path: 'a.ts', pathSource: 'exact', isBinaryHint: false, displayOrder: 0 });
    // Platform re-renders with different sibling positions:
    await ensureFileDiscovered(db, project.projectId, { path: 'b.ts', pathSource: 'exact', isBinaryHint: false, displayOrder: 3 });
    const files = await listFiles(db, project.projectId);
    const b = files.find((f) => f.relativePath === 'b.ts')!;
    expect(b.displayOrder).toBe(3);
    const a = files.find((f) => f.relativePath === 'a.ts')!;
    expect(a.displayOrder).toBe(0);
  });

  it('file discovery implies ancestor folders (parent-child relationships)', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    await ensureFileDiscovered(db, project.projectId, { path: 'a/b/c/deep.txt', pathSource: 'exact', isBinaryHint: false });
    const folders = await listFolders(db, project.projectId);
    expect(folders.map((f) => f.relativePath).sort()).toEqual(['a', 'a/b', 'a/b/c']);
    expect(folders.every((f) => f.parentPath !== undefined)).toBe(true);
  });
});

describe('progressive capture ingestion (Test 3/4)', () => {
  it('merges scrolled ranges without duplicates (200/723 example)', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

    const first = await ingestExposedContent(db, {
      projectId: project.projectId,
      path: 'src/pages/Home.tsx',
      momentId: localId('m'),
      basis: 'dom-visible',
      ranges: [{ startLine: 1, endLine: 200, lines: lines(200) }],
      totalLinesHint: 723,
      isBinaryHint: false,
    });
    expect(first.accepted).toBe(1);

    const second = await ingestExposedContent(db, {
      projectId: project.projectId,
      path: 'src/pages/Home.tsx',
      momentId: localId('m'),
      basis: 'dom-visible',
      ranges: [
        { startLine: 201, endLine: 400, lines: lines(400).slice(200) },
        { startLine: 190, endLine: 210, lines: lines(400).slice(189, 210) },
      ],
      totalLinesHint: 723,
      isBinaryHint: false,
    });
    expect(second.accepted).toBe(1); // only the genuinely new part

    const detail = (await getFileDetail(db, await firstAcceptedFileId(db, project.projectId)))!;
    expect(detail.file.capturedLineCount).toBe(400);
    expect(detail.file.coveragePercent).toBeCloseTo(55.3, 1);
    expect(detail.file.captureState).toBe('partial');
    expect(detail.file.missingRanges.map((r) => [r.startLine, r.endLine])).toEqual([
      [401, 723],
    ]);
  });

  it('repeated scrolling of the same lines stores nothing new (Test 4)', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    const lines = Array.from({ length: 50 }, (_, i) => `L${i + 1}`);
    for (let i = 0; i < 3; i++) {
      await ingestExposedContent(db, {
        projectId: project.projectId,
        path: 'src/a.ts',
        momentId: localId('m'),
        basis: 'dom-visible',
        ranges: [{ startLine: 1, endLine: 50, lines }],
        totalLinesHint: 50,
        isBinaryHint: false,
      });
    }
    const detail = (await getFileDetail(db, await fileIdOf(db, project.projectId, 'src/a.ts')))!;
    expect(detail.file.capturedLineCount).toBe(50);
    expect(detail.ranges.length).toBeLessThanOrEqual(1); // no duplicated ranges
    expect(detail.revisions).toHaveLength(1);
  });

  it('reopening a completed file reuses its record (Test 5)', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    const lines = ['alpha', 'beta'];
    await ingestExposedContent(db, {
      projectId: project.projectId,
      path: 'README.md',
      momentId: localId('m'),
      basis: 'dom-visible',
      ranges: [{ startLine: 1, endLine: 2, lines }],
      totalLinesHint: 2,
      isBinaryHint: false,
    });
    const before = (await getFileDetail(db, await fileIdOf(db, project.projectId, 'README.md')))!;
    await applyDocumentModel(db, { projectId: project.projectId, fileId: before.file.fileId, text: 'alpha\nbeta', sourceLabel: 'test' });
    const after = (await getFileDetail(db, before.file.fileId))!;
    expect(after.file.fileId).toBe(before.file.fileId);
    expect(after.revisions).toHaveLength(1);
    expect(after.file.captureState).toBe('captured-full');
    expect(after.file.verificationState).toBe('verified');
    expect(after.file.contentHash).toBe(await sha256Hex('alpha\nbeta\n'));
  });
});

describe('revisions (Test 6, addendum #4)', () => {
  it('a changed source creates a NEW revision; old snapshot is kept', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    const id = await seedCaptured(db, project.projectId, 'src/x.ts', ['old one', 'old two']);

    const r1 = await applyDocumentModel(db, { projectId: project.projectId, fileId: id, text: 'old one\nold two', sourceLabel: 'test' });
    expect(r1.newRevision).toBe(false);

    const r2 = await applyDocumentModel(db, { projectId: project.projectId, fileId: id, text: 'old one\nCHANGED', sourceLabel: 'test' });
    expect(r2.newRevision).toBe(true);
    expect(r2.differingLines).toEqual([2]);

    const detail = (await getFileDetail(db, id))!;
    expect(detail.revisions).toHaveLength(2);
    expect(detail.revisions[0]!.status).toBe('superseded');
    expect(detail.revisions[1]!.status).toBe('open');
    expect(detail.file.currentRevisionId).toBe(detail.revisions[1]!.revisionId);
    // Old content preserved:
    const oldLines = await readRevisionLines(db, detail.revisions[0]!.revisionId);
    expect(oldLines).toEqual(['old one', 'old two']);
    const newLines = await readRevisionLines(db, detail.revisions[1]!.revisionId);
    expect(newLines).toEqual(['old one', 'CHANGED']);
  });

  it('never mixes revisions: new DOM content lands in the current revision', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    const id = await seedCaptured(db, project.projectId, 'src/y.ts', ['A', 'B', 'C']);
    await applyDocumentModel(db, { projectId: project.projectId, fileId: id, text: 'A2\nB2\nC2', sourceLabel: 'test' });
    await ingestExposedContent(db, {
      projectId: project.projectId,
      path: 'src/y.ts',
      momentId: localId('m'),
      basis: 'dom-visible',
      ranges: [{ startLine: 1, endLine: 3, lines: ['A2', 'B2', 'C2'] }],
      totalLinesHint: 3,
      isBinaryHint: false,
    });
    const detail = (await getFileDetail(db, id))!;
    const lines = await readRevisionLines(db, detail.file.currentRevisionId!);
    expect(lines).toEqual(['A2', 'B2', 'C2']);
  });
});

describe('conflicts', () => {
  it('conflicting DOM content is stored as a conflict, not an overwrite', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    const id = await seedCaptured(db, project.projectId, 'src/c.ts', ['x', 'y', 'z']);

    const res = await ingestExposedContent(db, {
      projectId: project.projectId,
      path: 'src/c.ts',
      momentId: localId('m'),
      basis: 'dom-visible',
      ranges: [{ startLine: 1, endLine: 3, lines: ['x', 'CONFLICTING', 'z'] }],
      totalLinesHint: 3,
      isBinaryHint: false,
    });
    expect(res.conflicts).toHaveLength(1);

    const detail = (await getFileDetail(db, id))!;
    expect(detail.conflicts).toHaveLength(1);
    expect(detail.file.verificationState).toBe('conflict');
    expect(detail.file.conflictCount).toBe(1);
    // Stored content unchanged:
    const lines = await readRevisionLines(db, detail.file.currentRevisionId!);
    expect(lines).toEqual(['x', 'y', 'z']);
  });

  it('user can resolve keep-stored or keep-incoming explicitly', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    const id = await seedCaptured(db, project.projectId, 'src/r.ts', ['x', 'y']);
    await ingestExposedContent(db, {
      projectId: project.projectId,
      path: 'src/r.ts',
      momentId: localId('m'),
      basis: 'dom-visible',
      ranges: [{ startLine: 1, endLine: 2, lines: ['x', 'NEW'] }],
      totalLinesHint: 2,
      isBinaryHint: false,
    });
    const detail1 = (await getFileDetail(db, id))!;
    const conflictId = detail1.conflicts[0]!.conflictId;

    await resolveConflict(db, conflictId, 'keep-incoming');
    const detail2 = (await getFileDetail(db, id))!;
    expect(detail2.file.conflictCount).toBe(0);
    expect(detail2.file.verificationState).not.toBe('conflict');
    const lines = await readRevisionLines(db, detail2.file.currentRevisionId!);
    expect(lines).toEqual(['x', 'NEW']);
  });
});

describe('transactional recovery (addendum #6)', () => {
  it('open journal rows roll back their ranges and recompute aggregates', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    const id = await seedCaptured(db, project.projectId, 'src/rec.ts', ['a', 'b', 'c']);

    // Simulate a crash mid-batch: a journal row left open + an orphan range.
    const revId = (await getFileDetail(db, id))!.file.currentRevisionId!;
    const journalId = localId('jr');
    await db.put('journal', { journalId, projectId: project.projectId, intent: 'capture-batch', createdAt: Date.now(), done: false, summary: 'crashed' });
    await db.put('ranges', {
      rangeId: `${revId}:10-12`,
      revisionId: revId,
      fileId: id,
      startLine: 10,
      endLine: 12,
      chunkId: 'nonexistent',
      basis: 'dom-visible',
      capturedAt: Date.now(),
      journalId,
    });

    const report = await recoverInterruptedWrites(db);
    expect(report.rolledBackJournals).toEqual([journalId]);
    const detail = (await getFileDetail(db, id))!;
    expect(detail.ranges.some((r) => r.journalId === journalId)).toBe(false);
    expect(detail.file.capturedLineCount).toBe(3);
    const journals = await db.getAll('journal');
    expect(journals).toHaveLength(0);
  });

  it('interrupted sessions are marked interrupted', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    const { startSession } = await import('../src/storage/repositories/projects');
    const s = await startSession(db, project.projectId, 'https://demo.local', 'demo');
    const report = await recoverInterruptedWrites(db);
    expect(report.interruptedSessions).toContain(s.sessionId);
    const after = await db.get('sessions', s.sessionId);
    expect(after!.status).toBe('interrupted');
  });
});

describe('progress honesty (Test 7, spec 7.3)', () => {
  it('distinguishes discovered from captured from verified', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    // 3 files: one complete+verified, one partial, one untouched
    const idA = await seedCaptured(db, project.projectId, 'src/a.ts', ['1', '2']);
    await applyDocumentModel(db, { projectId: project.projectId, fileId: idA, text: '1\n2', sourceLabel: 'test' });
    await seedCaptured(db, project.projectId, 'src/b.ts', ['x'], 5);
    await ensureFileDiscovered(db, project.projectId, { path: 'src/c.ts', pathSource: 'exact', isBinaryHint: false });

    const p = await computeProjectProgress(db, project.projectId);
    expect(p.totalFiles).toBe(3);
    expect(p.completeFiles).toBe(1);
    expect(p.partialFiles).toBe(1);
    expect(p.pendingFiles).toBe(1);
    expect(p.extractionPercent).toBeCloseTo(33.3, 1);
  });

  it('verifies full DOM capture in 2 passes while non-overlapping partial chunks stay unverified', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);

    // Split into two non-overlapping halves: full coverage, but no re-observation yet.
    await ingestExposedContent(db, {
      projectId: project.projectId,
      path: 'src/two.ts',
      momentId: 'm1',
      basis: 'dom-visible',
      ranges: [{ startLine: 1, endLine: 5, lines: lines.slice(0, 5) }],
      totalLinesHint: 10,
      isBinaryHint: false,
    });
    const afterHalf = await ingestExposedContent(db, {
      projectId: project.projectId,
      path: 'src/two.ts',
      momentId: 'm2',
      basis: 'dom-visible',
      ranges: [{ startLine: 6, endLine: 10, lines: lines.slice(5, 10) }],
      totalLinesHint: 10,
      isBinaryHint: false,
    });
    expect(afterHalf.captureState).toBe('captured-full');
    expect(afterHalf.verificationState).toBe('unverified');

    // One re-observation pass verifies it (green).
    const verified = await ingestExposedContent(db, {
      projectId: project.projectId,
      path: 'src/two.ts',
      momentId: 'm3',
      basis: 'dom-visible',
      ranges: [{ startLine: 1, endLine: 5, lines: lines.slice(0, 5) }],
      totalLinesHint: 10,
      isBinaryHint: false,
    });
    expect(verified.captureState).toBe('captured-full');
    expect(verified.verificationState).toBe('verified');
  });

  it('captures binary files and base64 assets and exports them at exact paths', async () => {
    const db = await freshDb();
    const project = await setupProject(db);
    const sampleB64 = btoa('PNGDATA');

    const { file } = await ensureFileDiscovered(db, project.projectId, {
      path: 'public/logo.png',
      pathSource: 'exact',
      isBinaryHint: true,
    });
    const captured = await applyBinaryFileCapture(db, {
      projectId: project.projectId,
      fileId: file.fileId,
      base64: sampleB64,
      byteSize: 7,
      mimeType: 'image/png',
    });
    expect(captured?.captureState).toBe('captured-full');
    expect(captured?.verificationState).toBe('verified');
    expect(captured?.isBinary).toBe(true);

    const { asset } = await ensureAssetDiscovered(db, project.projectId, {
      url: 'https://demo.local/favicon.ico',
      mimeTypeHint: 'image/x-icon',
    });
    await setAssetCaptured(db, asset.assetId, { inlineText: `base64:${btoa('ICON')}`, byteSize: 4 });

    const bundle = await buildExport(db, project.projectId, 'original');
    await attachProjectAndAssets(
      db,
      bundle,
      project.projectId,
      project.projectName,
      project.sourceOrigin,
      project.sourcePlatform,
      true,
      [],
    );

    expect(bundle.zip.file('public/logo.png')).toBeTruthy();
    expect(await bundle.zip.file('public/logo.png')!.async('string')).toBe('PNGDATA');
    expect(bundle.zip.file('assets/favicon.ico')).toBeTruthy();
    expect(await bundle.zip.file('assets/favicon.ico')!.async('string')).toBe('ICON');
    expect(bundle.report.summary.filesIncluded).toBe(1);
  });
});

// ---------------------------------------------------------------- helpers

async function fileIdOf(db: IDBPDatabase<AssetMinerSchema>, projectId: string, path: string): Promise<string> {
  const files = await listFiles(db, projectId);
  const f = files.find((x) => x.relativePath === path);
  if (!f) throw new Error(`file not found: ${path}`);
  return f.fileId;
}

async function firstAcceptedFileId(db: IDBPDatabase<AssetMinerSchema>, projectId: string): Promise<string> {
  return fileIdOf(db, projectId, 'src/pages/Home.tsx');
}

async function seedCaptured(
  db: IDBPDatabase<AssetMinerSchema>,
  projectId: string,
  path: string,
  lines: string[],
  totalHint?: number,
): Promise<string> {
  await ingestExposedContent(db, {
    projectId,
    path,
    momentId: localId('m'),
    basis: 'dom-visible',
    ranges: [{ startLine: 1, endLine: lines.length, lines }],
    totalLinesHint: totalHint ?? lines.length,
    isBinaryHint: false,
  });
  return fileIdOf(db, projectId, path);
}
