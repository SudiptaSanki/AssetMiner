/**
 * Stable identity keys (spec Part 6).
 *
 * Primary file identity  = projectId + canonical relative path
 * Primary folder identity = projectId + canonical relative path
 * Revision identity      = fileId + revisionNumber
 * Range identity         = revisionId + line span
 *
 * These keys are deterministic, so revisiting a file/folder ALWAYS maps to the
 * existing record — duplicates are impossible at the storage layer.
 */
import type { ContentBasis } from '../../shared/types';
import { sha256Hex } from '../../shared/hash';

/** Stable project id from the origin + project name shown by the platform. */
export async function projectIdFor(origin: string, projectName: string): Promise<string> {
  const h = await sha256Hex(`${origin.normalize()}::${projectName.normalize()}`);
  return `prj_${h.slice(0, 20)}`;
}

export function fileKey(projectId: string, canonicalRelPath: string): string {
  return `${projectId}::${canonicalRelPath}`;
}

export function folderKey(projectId: string, canonicalRelPath: string): string {
  return `${projectId}::${canonicalRelPath === '' ? '.' : canonicalRelPath}`;
}

export function revisionKey(fileId: string, revisionNumber: number): string {
  return `${fileId}#r${revisionNumber}`;
}

export function rangeKey(revisionId: string, startLine: number, endLine: number): string {
  return `${revisionId}:${startLine}-${endLine}`;
}

export function conflictKey(
  revisionId: string,
  startLine: number,
  endLine: number,
  incomingChunkId: string,
): string {
  return `${revisionId}:${startLine}-${endLine}:${incomingChunkId.slice(0, 12)}`;
}

/** Strongest basis wins: document-model evidence outranks DOM reads. */
export function strongestBasis(a: ContentBasis, b: ContentBasis): ContentBasis {
  if (a === 'document-model' || b === 'document-model') return 'document-model';
  return 'dom-visible';
}
