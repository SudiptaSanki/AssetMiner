/**
 * Folder & file repositories — the canonical identity layer (spec Part 6).
 *
 * Every write goes through deterministic keys
 * (`projectId::canonicalRelativePath`), so a folder or file that is revisited
 * updates its existing record and can never be duplicated.
 */
import type { IDBPDatabase } from 'idb';
import type { AssetMinerSchemaType, FileRecord, FolderRecord, PathSource } from './schema-shims';
import { baseName, canonicalizeRelativePath, extensionOf, joinPath, parentPath } from '../../core/identity/paths';
import { fileKey, folderKey } from '../../core/identity/keys';
import { isBinaryExtension, mimeFromExtension } from '../../shared/utils';

// ---------------------------------------------------------------- folders

export async function ensureFolder(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
  relativePath: string,
  opts: { knownEmpty?: boolean; displayOrder?: number } = {},
): Promise<FolderRecord> {
  const canonical = canonicalizeRelativePath(relativePath);
  if (!canonical) throw new Error(`invalid folder path: ${relativePath}`);
  const folderId = folderKey(projectId, canonical);
  const now = Date.now();
  const existing = await db.get('folders', folderId);
  if (existing) {
    // Revisiting updates the existing record — never creates a duplicate.
    // displayOrder follows the source's CURRENT rendering (platforms reorder).
    const knownEmpty = existing.knownEmpty || opts.knownEmpty === true;
    const displayOrder = opts.displayOrder ?? existing.displayOrder;
    if (
      knownEmpty !== existing.knownEmpty ||
      displayOrder !== existing.displayOrder ||
      existing.discoveryStatus === 'inspected'
    ) {
      const updated: FolderRecord = { ...existing, knownEmpty, displayOrder };
      await db.put('folders', updated);
      return updated;
    }
    return existing;
  }
  const record: FolderRecord = {
    folderId,
    projectId,
    parentPath: parentPath(canonical) ?? '',
    relativePath: canonical,
    name: baseName(canonical),
    discoveryStatus: 'discovered',
    knownEmpty: opts.knownEmpty === true,
    displayOrder: opts.displayOrder ?? Number.MAX_SAFE_INTEGER,
    firstSeenAt: now,
    lastInspectedAt: null,
  };
  await db.put('folders', record);
  return record;
}

/** Ensure every ancestor folder of a path exists (files imply their parents). */
export async function ensureFoldersForPath(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
  canonicalFilePath: string,
): Promise<void> {
  const dir = parentPath(canonicalFilePath) ?? '';
  if (dir === '') return;
  const segments = dir.split('/');
  let partial = '';
  for (const seg of segments) {
    partial = joinPath(partial, seg);
    await ensureFolder(db, projectId, partial);
  }
}

export async function markFolderInspected(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
  canonicalRelativePath: string,
): Promise<void> {
  const folderId = folderKey(projectId, canonicalRelativePath);
  const existing = await db.get('folders', folderId);
  if (!existing) return;
  await db.put('folders', {
    ...existing,
    discoveryStatus: 'inspected',
    lastInspectedAt: Date.now(),
  });
}

export async function listFolders(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
): Promise<FolderRecord[]> {
  return db.getAllFromIndex('folders', 'by-project', projectId);
}

// ---------------------------------------------------------------- files

export interface FileDiscoveryInput {
  path: string;
  pathSource: PathSource;
  isBinaryHint: boolean;
  /** Position among siblings as shown by the source tree (0-based). */
  displayOrder?: number;
}

/**
 * Idempotent file discovery. The same path always maps to the same record;
 * re-discovery refreshes metadata (including source order) without resetting
 * capture progress.
 */
export async function ensureFileDiscovered(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
  input: FileDiscoveryInput,
): Promise<{ file: FileRecord; created: boolean }> {
  const canonical = canonicalizeRelativePath(input.path);
  if (!canonical) throw new Error(`invalid file path: ${input.path}`);
  await ensureFoldersForPath(db, projectId, canonical);
  const fileId = fileKey(projectId, canonical);
  const now = Date.now();
  const existing = await db.get('files', fileId);
  if (existing) {
    if (input.displayOrder !== undefined && input.displayOrder !== existing.displayOrder) {
      const updated: FileRecord = { ...existing, displayOrder: input.displayOrder };
      await db.put('files', updated);
      return { file: updated, created: false };
    }
    return { file: existing, created: false };
  }
  const filename = baseName(canonical);
  const ext = extensionOf(canonical);
  const record: FileRecord = {
    fileId,
    projectId,
    folderPath: parentPath(canonical) ?? '',
    relativePath: canonical,
    filename,
    extension: ext,
    mimeType: mimeFromExtension(ext),
    currentRevisionId: null,
    captureState: 'pending',
    verificationState: 'unverified',
    expectedLineCount: null,
    expectedLineCountSource: null,
    capturedLineCount: 0,
    coveragePercent: null,
    missingRanges: [],
    isBinary: input.isBinaryHint || isBinaryExtension(ext),
    byteCount: null,
    pathSource: input.pathSource,
    displayOrder: input.displayOrder ?? Number.MAX_SAFE_INTEGER,
    conflictCount: 0,
    contentHash: null,
    firstSeenAt: now,
    lastInspectedAt: null,
    lastUpdated: now,
    lastError: null,
  };
  await db.put('files', record);
  return { file: record, created: true };
}

export async function getFile(
  db: IDBPDatabase<AssetMinerSchemaType>,
  fileId: string,
): Promise<FileRecord | undefined> {
  return db.get('files', fileId);
}

export async function listFiles(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
): Promise<FileRecord[]> {
  return db.getAllFromIndex('files', 'by-project', projectId);
}

export async function listFilesInFolder(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
  folderPath: string,
): Promise<FileRecord[]> {
  return db.getAllFromIndex('files', 'by-folder', [projectId, folderPath]);
}
