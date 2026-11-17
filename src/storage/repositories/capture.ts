/**
 * Capture repository — transactional capture writes, revisions, conflicts,
 * aggregate recomputation and interrupted-write recovery (addendum #2, #4, #6).
 *
 * Write discipline:
 *   Phase 1: journal row (done=false) committed in its own transaction.
 *   Phase 2: all content/hash computation happens BEFORE the main transaction
 *            opens (crypto is async; IndexedDB transactions must not be kept
 *            open across arbitrary async work).
 *   Phase 3: one read-write transaction writes ranges + chunks + revision +
 *            file aggregates and finally removes the journal row; tx.done is
 *            the commit point. Any failure aborts atomically; a leftover open
 *            journal row triggers rollback.
 *   Activity logging happens AFTER transactions close, never inside them.
 */
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import {
  type AssetMinerSchemaType,
  type ChunkRecord,
  type ConflictDraft,
  type ConflictRecord,
  type ContentBasis,
  type FileRecord,
  type IncomingRange,
  type LineRange,
  type RangeRecord,
  type RevisionRecord,
} from './schema-shims';
import { conflictKey, rangeKey, revisionKey, strongestBasis } from '../../core/identity/keys';
import { evaluateCompletion } from '../../core/capture/CompletionDetector';
import { diffAgainstStored, type ExistingRange } from '../../core/capture/ContentMerger';
import { sha256Hex } from '../../shared/hash';
import { joinLines, localId, splitLines } from '../../shared/utils';
import { AssetMinerError } from '../../shared/errors';
import { rw } from '../db';
import { logActivity } from './projects';

/** Max lines per stored range/chunk — keeps transactions and memory bounded. */
const CHUNK_LINES = 500;
/** Cap on retained distinct observation moments per revision. */
const MAX_MOMENTS = 64;

type CaptureStore = 'files' | 'revisions' | 'ranges' | 'chunks' | 'conflicts' | 'journal' | 'activity';
type CaptureTx = IDBPTransaction<AssetMinerSchemaType, CaptureStore[], 'readwrite'>;

function captureTx(db: IDBPDatabase<AssetMinerSchemaType>): CaptureTx {
  return db.transaction(
    ['files', 'revisions', 'ranges', 'chunks', 'conflicts', 'journal', 'activity'],
    'readwrite',
  );
}

export interface PreparedChunk {
  startLine: number;
  endLine: number;
  text: string;
  chunkId: string;
  byteSize: number;
}

/** Split lines into bounded, content-addressed chunks (pre-transaction). */
export async function prepareChunks(startLine: number, lines: string[]): Promise<PreparedChunk[]> {
  const chunks: PreparedChunk[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    const text = joinLines(slice);
    const chunkId = await sha256Hex(text);
    chunks.push({
      startLine: startLine + i,
      endLine: startLine + i + slice.length - 1,
      text,
      chunkId,
      byteSize: new TextEncoder().encode(text).length,
    });
  }
  return chunks;
}

async function beginJournal(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
  intent: 'capture-batch' | 'export' | 'asset-batch',
  summary: string,
): Promise<string> {
  const journalId = localId('jr');
  const tx = db.transaction('journal', 'readwrite');
  await tx.store.put({
    journalId,
    projectId,
    intent,
    createdAt: Date.now(),
    done: false,
    summary,
  });
  await tx.done;
  return journalId;
}

// ---------------------------------------------------------------------------
// Aggregate recomputation (runs INSIDE a transaction)
// ---------------------------------------------------------------------------

/**
 * Recompute all derived file fields from stored facts. The single place where
 * capture/verification states are decided for persistence.
 *
 * IMPORTANT: only IndexedDB requests may be awaited inside a transaction —
 * awaiting anything else (e.g. crypto) lets the transaction auto-commit.
 * Content hashing therefore happens AFTER the transaction, in
 * maybeComputeContentHash().
 */
export async function recomputeFileInTx(
  tx: CaptureTx,
  fileId: string,
  opts: { isCapturing?: boolean; hasError?: string | null } = {},
): Promise<FileRecord | undefined> {
  const files = tx.objectStore('files');
  const revisions = tx.objectStore('revisions');
  const ranges = tx.objectStore('ranges');
  const conflicts = tx.objectStore('conflicts');

  const file: FileRecord | undefined = await files.get(fileId);
  if (!file) return undefined;

  const rev: RevisionRecord | undefined = file.currentRevisionId
    ? await revisions.get(file.currentRevisionId)
    : undefined;

  const storedRanges: RangeRecord[] = rev
    ? await ranges.index('by-revision').getAll(rev.revisionId)
    : [];

  const openConflicts: ConflictRecord[] = rev
    ? (await conflicts.index('by-file').getAll(fileId)).filter(
        (c) => c.revisionId === rev.revisionId && c.resolvedAt === null,
      )
    : [];

  const evaluation = evaluateCompletion({
    ranges: storedRanges.map((r) => ({ startLine: r.startLine, endLine: r.endLine })),
    expectedLineCount: file.expectedLineCount,
    hasFullDocument: rev?.hasFullDocument ?? false,
    strongestBasis: rev?.basis ?? 'dom-visible',
    consistentObservations: rev?.observationMoments.length ?? 0,
    openConflictCount: openConflicts.length,
    isCapturing: opts.isCapturing ?? false,
    hasError: opts.hasError !== undefined && opts.hasError !== null,
  });

  const now = Date.now();
  const updated: FileRecord = {
    ...file,
    captureState: evaluation.captureState,
    verificationState: evaluation.verificationState,
    capturedLineCount: evaluation.capturedLineCount,
    coveragePercent: evaluation.coveragePercent,
    missingRanges: evaluation.missingRanges,
    conflictCount: openConflicts.length,
    contentHash: rev?.contentHash ?? null,
    lastUpdated: now,
    lastError: opts.hasError !== undefined ? opts.hasError : file.lastError,
  };
  await files.put(updated);
  return updated;
}

/**
 * Post-transaction pass: when a revision first reaches full coverage, compute
 * and persist its content hash (crypto must run OUTSIDE transactions).
 */
export async function maybeComputeContentHash(
  db: IDBPDatabase<AssetMinerSchemaType>,
  fileId: string,
): Promise<FileRecord | undefined> {
  const file = await db.get('files', fileId);
  if (!file || !file.currentRevisionId || file.contentHash !== null) return file;
  if (file.captureState !== 'captured-full' || file.expectedLineCount === null) return file;

  const rev = await db.get('revisions', file.currentRevisionId);
  if (!rev || rev.contentHash !== null) return file;

  const storedRanges = await db.getAllFromIndex('ranges', 'by-revision', rev.revisionId);
  const sorted = [...storedRanges].sort((a, b) => a.startLine - b.startLine);
  const out: string[] = [];
  let cursor = 1;
  let complete = true;
  for (const r of sorted) {
    if (r.startLine > cursor) { complete = false; break; }
    if (r.endLine < cursor) continue;
    const chunk = await db.get('chunks', r.chunkId);
    if (!chunk) { complete = false; break; }
    const lines = splitLines(chunk.text);
    for (let n = cursor; n <= r.endLine; n++) out.push(lines[n - r.startLine] ?? '');
    cursor = r.endLine + 1;
  }
  if (complete && cursor > file.expectedLineCount) {
    const hash = await sha256Hex(joinLines(out));
    const tx = captureTx(db);
    const revNow = await tx.objectStore('revisions').get(rev.revisionId);
    const fileNow = await tx.objectStore('files').get(fileId);
    if (revNow && fileNow && revNow.contentHash === null && fileNow.captureState === 'captured-full') {
      await tx.objectStore('revisions').put({ ...revNow, contentHash: hash });
      const updated = { ...fileNow, contentHash: hash };
      await tx.objectStore('files').put(updated);
      await tx.done;
      return updated;
    }
    await tx.done;
  }
  return file;
}

// ---------------------------------------------------------------------------
// Progressive capture batch
// ---------------------------------------------------------------------------

export interface CaptureBatchInput {
  projectId: string;
  fileId: string;
  momentId: string;
  basis: ContentBasis;
  accepted: IncomingRange[];
  reobserved: LineRange[];
  conflicts: ConflictDraft[];
  /** Reliable total-line hint from the observer, when it exposes one. */
  totalLinesHint: number | null;
  totalLinesHintSource: 'layout-derived' | 'editor-metadata';
}

export async function applyCaptureBatch(
  db: IDBPDatabase<AssetMinerSchemaType>,
  input: CaptureBatchInput,
): Promise<{ file: FileRecord | undefined }> {
  const journalId = await beginJournal(
    db,
    input.projectId,
    'capture-batch',
    input.conflicts.length > 0 ? `capture+conflicts ${input.fileId}` : `capture ${input.fileId}`,
  );
  return commitCaptureBatch(db, input, journalId);
}

async function commitCaptureBatch(
  db: IDBPDatabase<AssetMinerSchemaType>,
  input: CaptureBatchInput,
  journalId: string,
): Promise<{ file: FileRecord | undefined }> {
  const now = Date.now();

  // Pre-transaction content preparation (async crypto outside IDB tx).
  const prepared: PreparedChunk[] = [];
  for (const range of input.accepted) {
    prepared.push(...(await prepareChunks(range.startLine, range.lines)));
  }
  const conflictPrep = await Promise.all(
    input.conflicts.map(async (c) => ({
      draft: c,
      existingChunkId: await sha256Hex(joinLines(c.existingLines)),
      incomingChunkId: await sha256Hex(joinLines(c.incomingLines)),
      existingText: joinLines(c.existingLines),
      incomingText: joinLines(c.incomingLines),
    })),
  );

  let resultFile: FileRecord | undefined;
  try {
    const tx = captureTx(db);
    const files = tx.objectStore('files');
    const revisions = tx.objectStore('revisions');
    const ranges = tx.objectStore('ranges');
    const chunksStore = tx.objectStore('chunks');
    const conflictsStore = tx.objectStore('conflicts');

    const file: FileRecord | undefined = await files.get(input.fileId);
    if (!file) throw new AssetMinerError('integrity', `capture referenced an unknown file record`);

    // Current (or first) revision of this file.
    let rev: RevisionRecord | undefined = file.currentRevisionId
      ? await revisions.get(file.currentRevisionId)
      : undefined;
    if (!rev) {
      rev = {
        revisionId: revisionKey(file.fileId, 1),
        fileId: file.fileId,
        revisionNumber: 1,
        basis: input.basis,
        totalLines: null,
        contentHash: null,
        observationMoments: [],
        hasFullDocument: false,
        status: 'open',
        supersededBy: null,
        createdAt: now,
        lastCaptureAt: now,
      };
      await revisions.put(rev);
    }
    // ALWAYS re-read: the record must reflect the revision binding above
    // before any later field updates are written (stale-write hazard).
    let fileNow: FileRecord = (await files.get(input.fileId)) ?? file;
    if (fileNow.currentRevisionId !== rev.revisionId) {
      fileNow = { ...fileNow, currentRevisionId: rev.revisionId };
      await files.put(fileNow);
    }

    // Store accepted content (already clipped to new lines by the merger).
    for (const chunk of prepared) {
      if (!(await chunksStore.get(chunk.chunkId))) {
        const record: ChunkRecord = {
          chunkId: chunk.chunkId,
          text: chunk.text,
          byteSize: chunk.byteSize,
          createdAt: now,
        };
        await chunksStore.put(record);
      }
      const range: RangeRecord = {
        rangeId: rangeKey(rev.revisionId, chunk.startLine, chunk.endLine),
        revisionId: rev.revisionId,
        fileId: file.fileId,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        chunkId: chunk.chunkId,
        basis: input.basis,
        capturedAt: now,
        journalId,
      };
      await ranges.put(range);
    }

    // Evidence: initial capture counts as observation #1; identical re-observation counts as #2.
    if (
      (input.reobserved.length > 0 || (rev.observationMoments.length === 0 && input.accepted.length > 0)) &&
      !rev.observationMoments.includes(input.momentId)
    ) {
      rev = { ...rev, observationMoments: [...rev.observationMoments, input.momentId].slice(-MAX_MOMENTS) };
      await revisions.put(rev);
    }

    // Conflicts: persist both sides' content, never overwrite stored content.
    // Chunk ids were pre-computed outside the transaction.
    for (const cp of conflictPrep) {
      const sides: { id: string; text: string }[] = [
        { id: cp.existingChunkId, text: cp.existingText },
        { id: cp.incomingChunkId, text: cp.incomingText },
      ];
      for (const side of sides) {
        if (!(await chunksStore.get(side.id))) {
          await chunksStore.put({
            chunkId: side.id,
            text: side.text,
            byteSize: new TextEncoder().encode(side.text).length,
            createdAt: now,
          });
        }
      }
      const record: ConflictRecord = {
        conflictId: conflictKey(rev.revisionId, cp.draft.startLine, cp.draft.endLine, cp.incomingChunkId),
        projectId: file.projectId,
        fileId: file.fileId,
        revisionId: rev.revisionId,
        startLine: cp.draft.startLine,
        endLine: cp.draft.endLine,
        differingLines: [...cp.draft.differingLines],
        existingChunkId: cp.existingChunkId,
        incomingChunkId: cp.incomingChunkId,
        detectedAt: now,
        resolvedAt: null,
        resolution: 'unresolved',
      };
      if (!(await conflictsStore.get(record.conflictId))) await conflictsStore.put(record);
    }

    // Expected line count from a hint — only when nothing reliable known yet.
    if (input.totalLinesHint !== null && input.totalLinesHint > 0 && fileNow.expectedLineCount === null) {
      await files.put({
        ...fileNow,
        expectedLineCount: input.totalLinesHint,
        expectedLineCountSource: input.totalLinesHintSource,
      });
    }

    // Revision metadata refresh.
    const revFinal: RevisionRecord | undefined = await revisions.get(rev.revisionId);
    if (revFinal) {
      await revisions.put({
        ...revFinal,
        basis: strongestBasis(revFinal.basis, input.basis),
        lastCaptureAt: now,
        totalLines:
          revFinal.totalLines ??
          (input.totalLinesHint !== null && input.totalLinesHint > 0 ? input.totalLinesHint : null),
      });
    }

    resultFile = await recomputeFileInTx(tx, file.fileId);
    await tx.objectStore('journal').delete(journalId);
    await tx.done;
  } catch (err) {
    // Journal row is still open (done=false) — roll the partial batch back
    // immediately so the session can continue safely.
    await rollbackJournal(db, journalId);
    throw err;
  }

  if (prepared.length > 0 || conflictPrep.length > 0) {
    await logActivity(
      db,
      input.projectId,
      conflictPrep.length > 0 ? 'conflict' : 'capture',
      conflictPrep.length > 0
        ? `Content conflict detected alongside ${prepared.length} newly captured range(s)`
        : `Captured ${prepared.length} new range(s)`,
      resultFile?.relativePath ?? null,
    );
  }
  // Crypto pass for newly-completed revisions runs outside any transaction.
  if (resultFile) resultFile = (await maybeComputeContentHash(db, resultFile.fileId)) ?? resultFile;
  return { file: resultFile };
}

/** Remove partially-written rows of an uncommitted journal batch. */
async function rollbackJournal(
  db: IDBPDatabase<AssetMinerSchemaType>,
  journalId: string,
): Promise<void> {
  const journal = await db.get('journal', journalId);
  if (!journal) return; // committed already
  const touchedFileIds = new Set<string>();
  {
    const tx = rw(db, ['ranges', 'journal']);
    let cursor = await tx.objectStore('ranges').index('by-journal').openCursor(IDBKeyRange.only(journalId));
    while (cursor) {
      touchedFileIds.add(cursor.value.fileId);
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.objectStore('journal').delete(journalId);
    await tx.done;
  }
  for (const fileId of touchedFileIds) {
    const tx = captureTx(db);
    await recomputeFileInTx(tx, fileId);
    await tx.done;
  }
}

// ---------------------------------------------------------------------------
// Authorized full-document capture (addendum #3/#4: revision discipline)
// ---------------------------------------------------------------------------

export interface DocumentInput {
  projectId: string;
  fileId: string;
  text: string;
  sourceLabel: string;
}

export async function applyDocumentModel(
  db: IDBPDatabase<AssetMinerSchemaType>,
  input: DocumentInput,
): Promise<{ file: FileRecord | undefined; newRevision: boolean; differingLines: number[] }> {
  const now = Date.now();
  const docLines = splitLines(input.text);

  // ---- Pre-read phase (plain gets; no open transaction to protect) ----
  const fileRead: FileRecord | undefined = await db.get('files', input.fileId);
  if (!fileRead) throw new AssetMinerError('integrity', 'document referenced an unknown file record');

  const currentRevRead: RevisionRecord | undefined = fileRead.currentRevisionId
    ? await db.get('revisions', fileRead.currentRevisionId)
    : undefined;

  const stored: ExistingRange[] = [];
  if (currentRevRead) {
    const storedRanges: RangeRecord[] = await db.getAllFromIndex('ranges', 'by-revision', currentRevRead.revisionId);
    for (const r of storedRanges) {
      const chunk = await db.get('chunks', r.chunkId);
      stored.push({
        rangeId: r.rangeId,
        startLine: r.startLine,
        endLine: r.endLine,
        lines: chunk ? splitLines(chunk.text) : [],
        basis: r.basis,
        capturedAt: r.capturedAt,
      });
    }
  }
  const diff = diffAgainstStored(stored, docLines);

  // Decide the revision plan and prepare all content BEFORE opening a
  // transaction (crypto must never run inside one).
  const plan = await planDocumentWrite(fileRead, currentRevRead, docLines, diff, now);

  // ---- Journal + write phase ----
  const journalId = await beginJournal(db, input.projectId, 'capture-batch', `document ${input.fileId}`);
  let resultFile: FileRecord | undefined;
  try {
    const tx = captureTx(db);
    const files = tx.objectStore('files');
    const revisions = tx.objectStore('revisions');
    const ranges = tx.objectStore('ranges');
    const chunksStore = tx.objectStore('chunks');

    // Guard: the current revision must still match the plan's assumption.
    const fileNow: FileRecord | undefined = await files.get(input.fileId);
    if (!fileNow) throw new AssetMinerError('integrity', 'file disappeared during document capture');
    if ((fileNow.currentRevisionId ?? null) !== (currentRevRead?.revisionId ?? null)) {
      throw new AssetMinerError('conflict', 'the file changed while the document was being prepared — retry');
    }

    if (plan.supersede) {
      await revisions.put({ ...currentRevRead!, status: 'superseded', supersededBy: plan.revisionNumber });
    }
    await revisions.put(plan.revision);
    await files.put({ ...fileNow, currentRevisionId: plan.revision.revisionId });

    for (const chunk of plan.chunks) {
      if (!(await chunksStore.get(chunk.chunkId))) {
        await chunksStore.put({
          chunkId: chunk.chunkId,
          text: chunk.text,
          byteSize: chunk.byteSize,
          createdAt: now,
        });
      }
      await ranges.put({
        rangeId: rangeKey(plan.revision.revisionId, chunk.startLine, chunk.endLine),
        revisionId: plan.revision.revisionId,
        fileId: fileNow.fileId,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        chunkId: chunk.chunkId,
        basis: 'document-model',
        capturedAt: now,
        journalId,
      });
    }

    // Reliable total from the document model — strongest provenance.
    const latest: FileRecord | undefined = await files.get(fileNow.fileId);
    if (latest && (latest.expectedLineCount === null || latest.expectedLineCountSource !== 'document-model')) {
      await files.put({
        ...latest,
        expectedLineCount: docLines.length,
        expectedLineCountSource: 'document-model',
      });
    }

    resultFile = await recomputeFileInTx(tx, fileNow.fileId);
    await tx.objectStore('journal').delete(journalId);
    await tx.done;
  } catch (err) {
    await rollbackJournal(db, journalId);
    throw err;
  }

  resultFile = (await maybeComputeContentHash(db, input.fileId)) ?? resultFile;

  if (plan.supersede && resultFile) {
    await logActivity(
      db,
      input.projectId,
      'revision',
      `Source changed — created revision r${plan.revisionNumber} (${diff.differingLines.length} differing lines)`,
      resultFile.relativePath,
    );
  }
  return { file: resultFile, newRevision: plan.supersede, differingLines: diff.differingLines };
}

interface DocumentWritePlan {
  revision: RevisionRecord;
  revisionNumber: number;
  supersede: boolean;
  chunks: PreparedChunk[];
}

/**
 * Revision policy (addendum #4):
 *  - no current revision            → create r1
 *  - identical content              → strengthen current revision, fill gaps only
 *  - differing content              → NEW revision; the old snapshot is kept
 *    (marked superseded) and never mixed with the new document's content.
 */
async function planDocumentWrite(
  file: FileRecord,
  currentRev: RevisionRecord | undefined,
  docLines: string[],
  diff: { differingLines: number[]; missingLines: number[] },
  now: number,
): Promise<DocumentWritePlan> {
  if (!currentRev) {
    return {
      revisionNumber: 1,
      supersede: false,
      revision: {
        revisionId: revisionKey(file.fileId, 1),
        fileId: file.fileId,
        revisionNumber: 1,
        basis: 'document-model',
        totalLines: docLines.length,
        contentHash: null,
        observationMoments: [],
        hasFullDocument: true,
        status: 'open',
        supersededBy: null,
        createdAt: now,
        lastCaptureAt: now,
      },
      chunks: await prepareChunks(1, docLines),
    };
  }
  if (diff.differingLines.length === 0) {
    // Same source content: strengthen the existing revision, fill gaps only.
    const missingRuns: { start: number; end: number }[] = [];
    for (const n of diff.missingLines) {
      const last = missingRuns[missingRuns.length - 1];
      if (last && n === last.end + 1) last.end = n;
      else missingRuns.push({ start: n, end: n });
    }
    const chunks: PreparedChunk[] = [];
    for (const run of missingRuns) {
      chunks.push(...(await prepareChunks(run.start, docLines.slice(run.start - 1, run.end))));
    }
    return {
      revisionNumber: currentRev.revisionNumber,
      supersede: false,
      revision: {
        ...currentRev,
        basis: 'document-model',
        totalLines: docLines.length,
        hasFullDocument: true,
        lastCaptureAt: now,
      },
      chunks,
    };
  }
  const next = currentRev.revisionNumber + 1;
  return {
    revisionNumber: next,
    supersede: true,
    revision: {
      revisionId: revisionKey(file.fileId, next),
      fileId: file.fileId,
      revisionNumber: next,
      basis: 'document-model',
      totalLines: docLines.length,
      contentHash: null,
      observationMoments: [],
      hasFullDocument: true,
      status: 'open',
      supersededBy: null,
      createdAt: now,
      lastCaptureAt: now,
    },
    chunks: await prepareChunks(1, docLines),
  };
}

export async function applyBinaryFileCapture(
  db: IDBPDatabase<AssetMinerSchemaType>,
  input: { projectId: string; fileId: string; base64: string; byteSize: number; mimeType: string },
): Promise<FileRecord | undefined> {
  const now = Date.now();
  const chunkId = await sha256Hex(input.base64);
  const fileRead: FileRecord | undefined = await db.get('files', input.fileId);
  if (!fileRead) throw new AssetMinerError('integrity', 'binary capture referenced an unknown file record');

  const currentRevRead: RevisionRecord | undefined = fileRead.currentRevisionId
    ? await db.get('revisions', fileRead.currentRevisionId)
    : undefined;
  const revNo = currentRevRead ? currentRevRead.revisionNumber + 1 : 1;

  // Check if current revision already holds identical binary chunk.
  if (currentRevRead) {
    const existingRanges = await db.getAllFromIndex('ranges', 'by-revision', currentRevRead.revisionId);
    if (existingRanges.length === 1 && existingRanges[0]!.chunkId === chunkId) {
      return fileRead;
    }
  }

  const journalId = await beginJournal(db, input.projectId, 'capture-batch', `binary ${input.fileId}`);
  let resultFile: FileRecord | undefined;
  try {
    const tx = captureTx(db);
    const files = tx.objectStore('files');
    const revisions = tx.objectStore('revisions');
    const ranges = tx.objectStore('ranges');
    const chunksStore = tx.objectStore('chunks');

    const fileNow: FileRecord | undefined = await files.get(input.fileId);
    if (!fileNow) throw new AssetMinerError('integrity', 'file disappeared during binary capture');

    if (currentRevRead) {
      await revisions.put({ ...currentRevRead, status: 'superseded', supersededBy: revNo });
    }
    const rev: RevisionRecord = {
      revisionId: revisionKey(fileNow.fileId, revNo),
      fileId: fileNow.fileId,
      revisionNumber: revNo,
      basis: 'document-model',
      totalLines: 1,
      contentHash: chunkId,
      observationMoments: [],
      hasFullDocument: true,
      status: 'open',
      supersededBy: null,
      createdAt: now,
      lastCaptureAt: now,
    };
    await revisions.put(rev);

    if (!(await chunksStore.get(chunkId))) {
      await chunksStore.put({
        chunkId,
        text: input.base64,
        byteSize: input.byteSize,
        createdAt: now,
      });
    }
    await ranges.put({
      rangeId: rangeKey(rev.revisionId, 1, 1),
      revisionId: rev.revisionId,
      fileId: fileNow.fileId,
      startLine: 1,
      endLine: 1,
      chunkId,
      basis: 'document-model',
      capturedAt: now,
      journalId,
    });

    const updated: FileRecord = {
      ...fileNow,
      currentRevisionId: rev.revisionId,
      isBinary: true,
      mimeType: input.mimeType || fileNow.mimeType,
      byteCount: input.byteSize,
      expectedLineCount: 1,
      expectedLineCountSource: 'document-model',
      capturedLineCount: 1,
      coveragePercent: 100,
      missingRanges: [],
      captureState: 'captured-full',
      verificationState: 'verified',
      contentHash: chunkId,
      lastInspectedAt: now,
      lastUpdated: now,
      lastError: null,
    };
    await files.put(updated);
    resultFile = updated;
    await tx.objectStore('journal').delete(journalId);
    await tx.done;
  } catch (err) {
    await rollbackJournal(db, journalId);
    throw err;
  }

  await logActivity(db, input.projectId, 'capture', `Captured binary file (${input.byteSize} bytes)`, resultFile?.relativePath ?? null);
  return resultFile;
}

// ---------------------------------------------------------------------------
// Conflict resolution (explicit, user-driven — never silent)
// ---------------------------------------------------------------------------

export async function resolveConflict(
  db: IDBPDatabase<AssetMinerSchemaType>,
  conflictId: string,
  resolution: 'keep-stored' | 'keep-incoming',
): Promise<FileRecord | undefined> {
  const now = Date.now();
  let resultFile: FileRecord | undefined;
  let activityLog: { projectId: string; message: string; path: string } | null = null;

  {
    const tx = captureTx(db);
    const conflictsStore = tx.objectStore('conflicts');
    const conflict: ConflictRecord | undefined = await conflictsStore.get(conflictId);
    if (conflict && conflict.resolvedAt === null) {
      const file: FileRecord | undefined = await tx.objectStore('files').get(conflict.fileId);
      if (file) {
        const rev: RevisionRecord | undefined = file.currentRevisionId
          ? await tx.objectStore('revisions').get(file.currentRevisionId)
          : undefined;

        if (resolution === 'keep-incoming' && rev && rev.revisionId === conflict.revisionId) {
          // Replace the stored span with the incoming content inside the
          // current revision — an explicit user decision, recorded in the row.
          let cursor = await tx.objectStore('ranges').index('by-revision').openCursor(IDBKeyRange.only(rev.revisionId));
          while (cursor) {
            const r = cursor.value;
            if (r.startLine <= conflict.endLine && r.endLine >= conflict.startLine) {
              await cursor.delete();
            }
            cursor = await cursor.continue();
          }
          const chunk = await tx.objectStore('chunks').get(conflict.incomingChunkId);
          if (chunk) {
            await tx.objectStore('ranges').put({
              rangeId: rangeKey(rev.revisionId, conflict.startLine, conflict.endLine),
              revisionId: rev.revisionId,
              fileId: file.fileId,
              startLine: conflict.startLine,
              endLine: conflict.endLine,
              chunkId: conflict.incomingChunkId,
              basis: rev.basis,
              capturedAt: now,
              journalId: null,
            });
          }
          if (rev.contentHash !== null) {
            await tx.objectStore('revisions').put({ ...rev, contentHash: null });
          }
        }

        await conflictsStore.put({ ...conflict, resolvedAt: now, resolution: 'reinspected' });
        resultFile = await recomputeFileInTx(tx, file.fileId);
        activityLog = {
          projectId: file.projectId,
          message: `Conflict at lines ${conflict.startLine}–${conflict.endLine} resolved (${resolution})`,
          path: file.relativePath,
        };
      }
    }
    await tx.done;
  }

  if (activityLog) {
    await logActivity(db, activityLog.projectId, 'conflict', activityLog.message, activityLog.path);
  }
  return resultFile;
}

// ---------------------------------------------------------------------------
// Read models for UI and export
// ---------------------------------------------------------------------------

/** Full line array of a revision (index 0 = line 1). */
export async function readRevisionLines(
  db: IDBPDatabase<AssetMinerSchemaType>,
  revisionId: string,
): Promise<string[]> {
  const ranges = await db.getAllFromIndex('ranges', 'by-revision', revisionId);
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
  const out: string[] = [];
  for (const r of sorted) {
    const chunk = await db.get('chunks', r.chunkId);
    const lines = chunk ? splitLines(chunk.text) : [];
    for (let n = r.startLine; n <= r.endLine; n++) {
      out[n - 1] = lines[n - r.startLine] ?? '';
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = '';
  return out;
}

export interface FileDetail {
  file: FileRecord;
  revisions: RevisionRecord[];
  ranges: RangeRecord[];
  conflicts: ConflictRecord[];
}

export async function getFileDetail(
  db: IDBPDatabase<AssetMinerSchemaType>,
  fileId: string,
): Promise<FileDetail | undefined> {
  const file = await db.get('files', fileId);
  if (!file) return undefined;
  const revisions = await db.getAllFromIndex('revisions', 'by-file', fileId);
  const ranges = file.currentRevisionId
    ? await db.getAllFromIndex('ranges', 'by-revision', file.currentRevisionId)
    : [];
  const conflicts = await db.getAllFromIndex('conflicts', 'by-file', fileId);
  return {
    file,
    revisions: revisions.sort((a, b) => a.revisionNumber - b.revisionNumber),
    ranges: ranges.sort((a, b) => a.startLine - b.startLine),
    conflicts: conflicts.filter((c) => c.revisionId === file.currentRevisionId),
  };
}

export async function listRevisions(
  db: IDBPDatabase<AssetMinerSchemaType>,
  fileId: string,
): Promise<RevisionRecord[]> {
  const revs = await db.getAllFromIndex('revisions', 'by-file', fileId);
  return revs.sort((a, b) => a.revisionNumber - b.revisionNumber);
}

/** Recompute aggregates outside a capture batch (after recovery, on stop, etc.). */
export async function recomputeFileOutsideTx(
  db: IDBPDatabase<AssetMinerSchemaType>,
  fileId: string,
  opts: { isCapturing?: boolean; hasError?: string | null } = {},
): Promise<FileRecord | undefined> {
  const tx = captureTx(db);
  const result = await recomputeFileInTx(tx, fileId, opts);
  await tx.done;
  return result;
}

export async function setFileCapturing(
  db: IDBPDatabase<AssetMinerSchemaType>,
  fileId: string,
  isCapturing: boolean,
): Promise<FileRecord | undefined> {
  return recomputeFileOutsideTx(db, fileId, { isCapturing });
}

export async function setFileError(
  db: IDBPDatabase<AssetMinerSchemaType>,
  fileId: string,
  message: string | null,
): Promise<FileRecord | undefined> {
  return recomputeFileOutsideTx(db, fileId, { hasError: message });
}

export async function markFileInspected(
  db: IDBPDatabase<AssetMinerSchemaType>,
  fileId: string,
): Promise<void> {
  const file = await db.get('files', fileId);
  if (!file) return;
  await db.put('files', { ...file, lastInspectedAt: Date.now() });
}

/**
 * Rollback entry point used by recoverInterruptedWrites in ../db.ts.
 * Recomputes aggregates for files whose uncommitted ranges were removed.
 */
export async function recomputeFilesForRecovery(
  db: IDBPDatabase<AssetMinerSchemaType>,
  fileIds: string[],
): Promise<void> {
  for (const fileId of fileIds) {
    await recomputeFileOutsideTx(db, fileId);
  }
}
