/**
 * Project progress aggregation (spec Part 7.3) — discovery counts and
 * extraction counts are reported SEPARATELY and never conflated.
 */
import type { IDBPDatabase } from 'idb';
import type { AssetMinerSchemaType, ProjectProgress } from './schema-shims';

export async function computeProjectProgress(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
): Promise<ProjectProgress> {
  const files = await db.getAllFromIndex('files', 'by-project', projectId);
  const folders = await db.getAllFromIndex('folders', 'by-project', projectId);

  const progress: ProjectProgress = {
    totalFolders: folders.length,
    inspectedFolders: folders.filter((f) => f.discoveryStatus === 'inspected').length,
    totalFiles: files.length,
    completeFiles: 0,
    partialFiles: 0,
    pendingFiles: 0,
    errorFiles: 0,
    conflictFiles: 0,
    capturedLines: 0,
    capturedBytes: 0,
    extractionPercent: null,
  };

  for (const f of files) {
    if (f.captureState === 'captured-full') progress.completeFiles += 1;
    else if (f.captureState === 'pending') progress.pendingFiles += 1;
    else if (f.captureState === 'error') progress.errorFiles += 1;
    else progress.partialFiles += 1; // capturing or partial
    if (f.verificationState === 'conflict') progress.conflictFiles += 1;
    progress.capturedLines += f.capturedLineCount;
    progress.capturedBytes += f.byteCount ?? 0;
  }

  // "Extraction %" counts files fully captured over files discovered — it is
  // a FILE completeness metric, not a content-coverage metric, and the UI
  // must label it as such.
  if (progress.totalFiles > 0) {
    progress.extractionPercent = Math.round((progress.completeFiles / progress.totalFiles) * 1000) / 10;
  }
  return progress;
}
