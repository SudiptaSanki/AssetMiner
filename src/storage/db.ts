/**
 * IndexedDB schema, migrations, transactional helpers and interrupted-write
 * recovery (spec Part 12/17, addendum #6).
 *
 * Guarantees implemented here:
 *  - Schema is versioned; migrations are explicit and forward-only.
 *  - Multi-store capture writes use a two-phase journal so a crash or quota
 *    failure mid-batch can NEVER leave half-written capture state: on open,
 *    uncommitted batches are rolled back and aggregates recomputed.
 *  - Quota errors are surfaced as AssetMinerError('quota') — existing data is
 *    never silently deleted to make room.
 */
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type {
  ActivityRecord,
  AssetRecord,
  CaptureSessionRecord,
  ChunkRecord,
  ConflictRecord,
  FileRecord,
  FolderRecord,
  JournalRecord,
  ProjectRecord,
  RangeRecord,
  RevisionRecord,
} from '../shared/types';
import { toAssetMinerError } from '../shared/errors';

export interface AssetMinerSchema extends DBSchema {
  projects: {
    key: string;
    value: ProjectRecord;
    indexes: { 'by-origin': string };
  };
  folders: {
    key: string;
    value: FolderRecord;
    indexes: { 'by-project': string };
  };
  files: {
    key: string;
    value: FileRecord;
    indexes: { 'by-project': string; 'by-folder': [string, string] };
  };
  revisions: {
    key: string;
    value: RevisionRecord;
    indexes: { 'by-file': string };
  };
  ranges: {
    key: string;
    value: RangeRecord;
    indexes: { 'by-revision': string; 'by-file': string; 'by-journal': string };
  };
  chunks: { key: string; value: ChunkRecord };
  conflicts: {
    key: string;
    value: ConflictRecord;
    indexes: { 'by-file': string; 'by-project': string };
  };
  sessions: {
    key: string;
    value: CaptureSessionRecord;
    indexes: { 'by-project': string; 'by-origin': string };
  };
  journal: { key: string; value: JournalRecord };
  assets: {
    key: string;
    value: AssetRecord;
    indexes: { 'by-project': string };
  };
  activity: {
    key: string;
    value: ActivityRecord;
    indexes: { 'by-project': string; 'by-project-at': [string, number] };
  };
}

export const DB_NAME = 'asset-miner';
export const DB_VERSION = 1;

export const STORES = [
  'projects', 'folders', 'files', 'revisions', 'ranges', 'chunks',
  'conflicts', 'sessions', 'journal', 'assets', 'activity',
] as const;

export type StoreName = (typeof STORES)[number];

export interface RecoveryReport {
  rolledBackJournals: string[];
  interruptedSessions: string[];
}

/**
 * Open (and migrate) the database. After opening, callers MUST run
 * `recoverInterruptedWrites()` before accepting new capture writes.
 */
export async function openDatabase(name = DB_NAME): Promise<IDBPDatabase<AssetMinerSchema>> {
  const db = await openDB<AssetMinerSchema>(name, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, _tx) {
      // Migration steps are keyed by the version they upgrade FROM.
      // v0 → v1: initial schema.
      if (oldVersion < 1) {
        const projects = db.createObjectStore('projects', { keyPath: 'projectId' });
        projects.createIndex('by-origin', 'sourceOrigin');
        const folders = db.createObjectStore('folders', { keyPath: 'folderId' });
        folders.createIndex('by-project', 'projectId');
        const files = db.createObjectStore('files', { keyPath: 'fileId' });
        files.createIndex('by-project', 'projectId');
        files.createIndex('by-folder', ['projectId', 'folderPath']);
        const revisions = db.createObjectStore('revisions', { keyPath: 'revisionId' });
        revisions.createIndex('by-file', 'fileId');
        const ranges = db.createObjectStore('ranges', { keyPath: 'rangeId' });
        ranges.createIndex('by-revision', 'revisionId');
        ranges.createIndex('by-file', 'fileId');
        ranges.createIndex('by-journal', 'journalId');
        db.createObjectStore('chunks', { keyPath: 'chunkId' });
        const conflicts = db.createObjectStore('conflicts', { keyPath: 'conflictId' });
        conflicts.createIndex('by-file', 'fileId');
        conflicts.createIndex('by-project', 'projectId');
        const sessions = db.createObjectStore('sessions', { keyPath: 'sessionId' });
        sessions.createIndex('by-project', 'projectId');
        sessions.createIndex('by-origin', 'origin');
        db.createObjectStore('journal', { keyPath: 'journalId' });
        const assets = db.createObjectStore('assets', { keyPath: 'assetId' });
        assets.createIndex('by-project', 'projectId');
        const activity = db.createObjectStore('activity', { keyPath: 'activityId' });
        activity.createIndex('by-project', 'projectId');
        activity.createIndex('by-project-at', ['projectId', 'at']);
      }
      // Future migrations go here as `if (oldVersion < 2) { ... }`.
    },
    blocked() {
      // Another tab holds an older version open; nothing to do but wait.
    },
    blocking() {
      // We hold an old version open and are blocking another tab's upgrade.
      // The correct citizen behavior is to close so the other tab can proceed;
      // data is safe because every write is transactional.
    },
  });
  return db;
}

// ---------------------------------------------------------------------------
// Transaction helpers (idb v8: plain transaction + await tx.done)
// ---------------------------------------------------------------------------

export type RwTx = IDBPTransaction<AssetMinerSchema, StoreName[], 'readwrite'>;

/** Open a read-write transaction over the given stores. */
export function rw(db: IDBPDatabase<AssetMinerSchema>, stores: readonly StoreName[]): RwTx {
  return db.transaction(stores as StoreName[], 'readwrite');
}

/**
 * Await a transaction's completion, mapping failures to typed errors.
 * MUST be called for every transaction opened via rw() — it is the commit point.
 */
export async function commit(tx: { done: Promise<unknown> }): Promise<void> {
  try {
    await tx.done;
  } catch (err) {
    throw toAssetMinerError(err, 'storage');
  }
}

/**
 * Roll back interrupted write batches: any journal row left uncommitted means
 * its data writes (ranges tagged with the journalId) are partial — remove them
 * and recompute aggregates. Never touches committed data.
 */
export async function recoverInterruptedWrites(
  db: IDBPDatabase<AssetMinerSchema>,
): Promise<RecoveryReport> {
  const { recomputeFilesForRecovery } = await import('./repositories/capture');
  const rolledBackJournals: string[] = [];
  const touchedFileIds = new Set<string>();

  const pending = await db.getAll('journal');
  for (const j of pending) {
    if (j.done) continue;
    rolledBackJournals.push(j.journalId);
    const tx = rw(db, ['ranges', 'journal']);
    let cursor = await tx.objectStore('ranges').index('by-journal').openCursor(IDBKeyRange.only(j.journalId));
    while (cursor) {
      touchedFileIds.add(cursor.value.fileId);
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.objectStore('journal').delete(j.journalId);
    await commit(tx);
  }

  // Sessions that were 'running' when the previous context died.
  const interruptedSessions: string[] = [];
  const sTx = rw(db, ['sessions']);
  let sCursor = await sTx.objectStore('sessions').openCursor();
  while (sCursor) {
    const s = sCursor.value;
    if (s.status === 'running') {
      interruptedSessions.push(s.sessionId);
      await sCursor.update({ ...s, status: 'interrupted' });
    }
    sCursor = await sCursor.continue();
  }
  await commit(sTx);

  if (touchedFileIds.size > 0) {
    await recomputeFilesForRecovery(db, [...touchedFileIds]);
  }
  return { rolledBackJournals, interruptedSessions };
}
