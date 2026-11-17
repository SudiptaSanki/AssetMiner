/**
 * Source-order preservation (user requirement: folder/file order must never
 * break). The source page's tree row order is authoritative everywhere —
 * explorer UI, previews and export. Alphabetical sorting is ONLY a fallback
 * for records discovered before order information existed.
 */
import type { FileRecord, FolderRecord } from '../../shared/types';

export interface OrderedLike {
  displayOrder: number;
  name?: string;
  filename?: string;
}

/**
 * Compare siblings by the source page's order; tie-break alphabetically
 * (deterministic when a platform re-renders rows without indices).
 */
export function compareBySourceOrder(a: OrderedLike, b: OrderedLike): number {
  const ao = Number.isFinite(a.displayOrder) ? a.displayOrder : Number.MAX_SAFE_INTEGER;
  const bo = Number.isFinite(b.displayOrder) ? b.displayOrder : Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  const an = a.name ?? a.filename ?? '';
  const bn = b.name ?? b.filename ?? '';
  return an.localeCompare(bn, undefined, { numeric: true });
}

export function sortFoldersBySourceOrder(folders: FolderRecord[]): FolderRecord[] {
  return [...folders].sort(compareBySourceOrder);
}

export function sortFilesBySourceOrder(files: FileRecord[]): FileRecord[] {
  return [...files].sort(compareBySourceOrder);
}
