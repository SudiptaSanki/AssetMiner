/**
 * DuplicateManager — the facade the capture controller talks to.
 *
 * Wraps identity keys, content hashing and the repositories into the
 * duplicate-prevention guarantees (spec Part 6):
 *   - one canonical record per project+path (storage-level)
 *   - content-addressed chunks (identical content stored once)
 *   - re-observed ranges never re-written, merged by the merger, not concatenated
 */
import type { IDBPDatabase } from 'idb';
import type { AssetMinerSchemaType } from '../../storage/repositories/schema-shims';
import { ensureFileDiscovered } from '../../storage/repositories/tree';
import { applyCaptureBatch } from '../../storage/repositories/capture';
import { mergeRanges, type ConflictDraft, type IncomingRange } from '../capture/ContentMerger';
import { sha256Hex } from '../../shared/hash';

export interface StoredRangeForMerge {
  rangeId: string;
  startLine: number;
  endLine: number;
  lines: string[];
  basis: IncomingRange['basis'];
  capturedAt: number;
}

/**
 * Run the duplicate-prevention pipeline for freshly exposed content:
 * discover-if-needed → merge against stored ranges → transactional batch.
 */
export async function ingestExposedContent(
  db: IDBPDatabase<AssetMinerSchemaType>,
  params: {
    projectId: string;
    path: string;
    momentId: string;
    basis: IncomingRange['basis'];
    ranges: { startLine: number; endLine: number; lines: string[] }[];
    totalLinesHint: number | null;
    isBinaryHint: boolean;
  },
): Promise<{
  accepted: number;
  reobserved: number;
  conflicts: ConflictDraft[];
  captureState?: import('../../shared/types').CaptureState;
  verificationState?: import('../../shared/types').VerificationState;
}> {
  const { file, created } = await ensureFileDiscovered(db, params.projectId, {
    path: params.path,
    pathSource: 'exact',
    isBinaryHint: params.isBinaryHint,
  });
  void created;

  // Load stored content of the current revision for overlap comparison.
  const existing: StoredRangeForMerge[] = [];
  if (file.currentRevisionId) {
    const stored = await db.getAllFromIndex('ranges', 'by-revision', file.currentRevisionId);
    for (const r of stored) {
      const chunk = await db.get('chunks', r.chunkId);
      if (!chunk) continue;
      const lines = chunk.text.replace(/\n$/, '').split('\n');
      existing.push({
        rangeId: r.rangeId,
        startLine: r.startLine,
        endLine: r.endLine,
        lines,
        basis: r.basis,
        capturedAt: r.capturedAt,
      });
    }
  }

  const incoming: IncomingRange[] = params.ranges
    .filter((r) => r.endLine >= r.startLine && r.lines.length === r.endLine - r.startLine + 1)
    .map((r) => ({ ...r, basis: params.basis, capturedAt: Date.now() }));

  const result = mergeRanges(existing, incoming);
  const batch = await applyCaptureBatch(db, {
    projectId: params.projectId,
    fileId: file.fileId,
    momentId: params.momentId,
    basis: params.basis,
    accepted: result.accepted,
    reobserved: result.reobserved,
    conflicts: result.conflicts,
    totalLinesHint: params.totalLinesHint,
    totalLinesHintSource: 'layout-derived',
  });

  return {
    accepted: result.accepted.length,
    reobserved: result.reobserved.length,
    conflicts: result.conflicts,
    captureState: batch.file?.captureState,
    verificationState: batch.file?.verificationState,
  };
}

/** Content-address existence check used by asset ingestion. */
export async function contentHashOf(text: string): Promise<string> {
  return sha256Hex(text);
}
