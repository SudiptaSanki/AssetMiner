/**
 * Project, session and activity repositories.
 */
import type { IDBPDatabase } from 'idb';
import type {
  ActivityKind,
  ActivityRecord,
  AssetMinerSchemaType,
  CaptureSessionRecord,
  ProjectRecord,
  SessionStatus,
} from './schema-shims';
import { projectIdFor } from '../../core/identity/keys';
import { localId } from '../../shared/utils';

const ACTIVITY_CAP = 500;

export async function getOrCreateProject(
  db: IDBPDatabase<AssetMinerSchemaType>,
  origin: string,
  projectName: string,
  sourcePlatform: string,
): Promise<{ project: ProjectRecord; created: boolean }> {
  const projectId = await projectIdFor(origin, projectName);
  const existing = await db.get('projects', projectId);
  if (existing) return { project: existing, created: false };
  const now = Date.now();
  const project: ProjectRecord = {
    projectId,
    projectName,
    sourcePlatform,
    sourceOrigin: origin,
    rootPath: '',
    createdAt: now,
    updatedAt: now,
    caseSensitivePaths: true,
  };
  await db.put('projects', project);
  return { project, created: true };
}

export async function listProjects(db: IDBPDatabase<AssetMinerSchemaType>): Promise<ProjectRecord[]> {
  return db.getAll('projects');
}

export async function getProject(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
): Promise<ProjectRecord | undefined> {
  return db.get('projects', projectId);
}

export async function touchProject(db: IDBPDatabase<AssetMinerSchemaType>, projectId: string): Promise<void> {
  const p = await db.get('projects', projectId);
  if (!p) return;
  await db.put('projects', { ...p, updatedAt: Date.now() });
}

/**
 * Delete a project and all dependent rows. Chunk garbage collection is a
 * separate pass (garbageCollectChunks) so deletion stays one concern.
 */
export async function deleteProjectCascade(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
): Promise<void> {
  const filesTx = db.transaction('files', 'readonly');
  const fileIds = await filesTx.objectStore('files').index('by-project').getAllKeys(projectId);
  await filesTx.done;

  const tx = db.transaction(
    ['projects', 'folders', 'files', 'revisions', 'ranges', 'conflicts', 'sessions', 'journal', 'assets', 'activity'],
    'readwrite',
  );
  const projects = tx.objectStore('projects');
  const folders = tx.objectStore('folders');
  const files = tx.objectStore('files');
  const revisions = tx.objectStore('revisions');
  const ranges = tx.objectStore('ranges');
  const conflicts = tx.objectStore('conflicts');
  const sessions = tx.objectStore('sessions');
  const journal = tx.objectStore('journal');
  const assets = tx.objectStore('assets');
  const activity = tx.objectStore('activity');

  await projects.delete(projectId);

  let c = await folders.index('by-project').openCursor(IDBKeyRange.only(projectId));
  while (c) { await c.delete(); c = await c.continue(); }

  let f = await files.index('by-project').openCursor(IDBKeyRange.only(projectId));
  while (f) { await f.delete(); f = await f.continue(); }

  for (const fid of fileIds) {
    let r = await revisions.index('by-file').openCursor(IDBKeyRange.only(fid as string));
    while (r) { await r.delete(); r = await r.continue(); }
    let g = await ranges.index('by-file').openCursor(IDBKeyRange.only(fid as string));
    while (g) { await g.delete(); g = await g.continue(); }
  }

  let k = await conflicts.index('by-project').openCursor(IDBKeyRange.only(projectId));
  while (k) { await k.delete(); k = await k.continue(); }
  let s = await sessions.index('by-project').openCursor(IDBKeyRange.only(projectId));
  while (s) { await s.delete(); s = await s.continue(); }
  let j = await journal.openCursor();
  while (j) { if (j.value.projectId === projectId) await j.delete(); j = await j.continue(); }
  let a = await assets.index('by-project').openCursor(IDBKeyRange.only(projectId));
  while (a) { await a.delete(); a = await a.continue(); }
  let l = await activity.index('by-project').openCursor(IDBKeyRange.only(projectId));
  while (l) { await l.delete(); l = await l.continue(); }

  await tx.done;
}

/** Remove chunks no longer referenced by any range. Rare, explicit maintenance. */
export async function garbageCollectChunks(db: IDBPDatabase<AssetMinerSchemaType>): Promise<number> {
  const referenced = new Set<string>();
  {
    const tx = db.transaction('ranges', 'readonly');
    let cursor = await tx.objectStore('ranges').openCursor();
    while (cursor) {
      referenced.add(cursor.value.chunkId);
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  let removed = 0;
  const tx = db.transaction('chunks', 'readwrite');
  let c = await tx.objectStore('chunks').openCursor();
  while (c) {
    if (!referenced.has(c.value.chunkId)) { await c.delete(); removed += 1; }
    c = await c.continue();
  }
  await tx.done;
  return removed;
}

// ---------------------------------------------------------------- sessions

export async function startSession(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
  origin: string,
  adapterId: string,
): Promise<CaptureSessionRecord> {
  const session: CaptureSessionRecord = {
    sessionId: localId('ses'),
    projectId,
    origin,
    adapterId,
    activeFilePath: null,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    status: 'running',
  };
  await db.put('sessions', session);
  return session;
}

export async function updateSession(
  db: IDBPDatabase<AssetMinerSchemaType>,
  sessionId: string,
  patch: Partial<Pick<CaptureSessionRecord, 'activeFilePath' | 'status' | 'lastActivityAt'>>,
): Promise<void> {
  const s = await db.get('sessions', sessionId);
  if (!s) return;
  await db.put('sessions', { ...s, ...patch, lastActivityAt: Date.now() });
}

export async function setSessionStatus(
  db: IDBPDatabase<AssetMinerSchemaType>,
  sessionId: string,
  status: SessionStatus,
): Promise<void> {
  await updateSession(db, sessionId, { status });
}

export async function listSessions(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
): Promise<CaptureSessionRecord[]> {
  return db.getAllFromIndex('sessions', 'by-project', projectId);
}

// ---------------------------------------------------------------- activity

export async function logActivity(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
  kind: ActivityKind,
  message: string,
  path: string | null = null,
): Promise<void> {
  if (!projectId) return;
  const record: ActivityRecord = {
    activityId: localId('act'),
    projectId,
    at: Date.now(),
    kind,
    path,
    message,
  };
  const tx = db.transaction('activity', 'readwrite');
  await tx.objectStore('activity').put(record);
  await tx.done;
  // Keep the log bounded.
  await trimActivity(db, projectId);
}

async function trimActivity(db: IDBPDatabase<AssetMinerSchemaType>, projectId: string): Promise<void> {
  const countTx = db.transaction('activity', 'readonly');
  const count = await countTx.objectStore('activity').index('by-project').count(IDBKeyRange.only(projectId));
  await countTx.done;
  if (count <= ACTIVITY_CAP) return;
  const excess = count - ACTIVITY_CAP;
  const tx = db.transaction('activity', 'readwrite');
  let c = await tx.objectStore('activity').index('by-project-at').openCursor(
    IDBKeyRange.bound([projectId, 0], [projectId, Infinity]),
  );
  let n = 0;
  while (c && n < excess) { await c.delete(); n += 1; c = await c.continue(); }
  await tx.done;
}

export async function listActivity(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
  limit = 100,
): Promise<ActivityRecord[]> {
  const all = await db.getAllFromIndex(
    'activity',
    'by-project-at',
    IDBKeyRange.bound([projectId, 0], [projectId, Infinity]),
  );
  return all.slice(-limit).reverse();
}
