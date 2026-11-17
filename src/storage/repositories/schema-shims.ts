/**
 * Type shims that keep repository imports short. The real schema lives in
 * ../db.ts; this module re-exports the database type under a shorter alias
 * plus the record types the repositories use.
 */
export type { AssetMinerSchema as AssetMinerSchemaType } from '../db';
export type {
  ActivityKind,
  ActivityRecord,
  AssetCategory,
  AssetRecord,
  CaptureSessionRecord,
  ChunkRecord,
  ConflictRecord,
  ContentBasis,
  FileRecord,
  FolderRecord,
  JournalRecord,
  LineRange,
  PathSource,
  ProjectProgress,
  ProjectRecord,
  RangeRecord,
  RawRange,
  RevisionRecord,
  SessionStatus,
} from '../../shared/types';
export type { ConflictDraft, IncomingRange, ExistingRange } from '../../core/capture/ContentMerger';
