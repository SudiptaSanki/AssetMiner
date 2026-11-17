/**
 * Asset Miner — shared domain types.
 *
 * Central design rule (spec Part 2 / implementation addendum #2):
 * capture state and verification state are INDEPENDENT.
 *   - Capture state answers: "how much of the content did we obtain?"
 *   - Verification state answers: "what evidence do we have that what we
 *     obtained is the actual, complete source?"
 * A file can be fully captured but unverified; it can have full line coverage
 * without proven equivalence to the original source; it can be partially
 * captured and verified for the part it has. Both databases and UI render
 * these as two separate axes, never one boolean.
 */

/** How a piece of content became visible to us. */
export type ContentBasis =
  /** Complete document model obtained through an authorized interface (editor API, official export). */
  | 'document-model'
  /** Content read from editor DOM the user has visible right now. */
  | 'dom-visible';

/** Independent axis 1 — content acquisition. */
export type CaptureState =
  /** Discovered but never inspected. */
  | 'pending'
  /** A capture session is currently receiving content for this file. */
  | 'capturing'
  /** Some ranges captured; gaps remain or total length is unknown. */
  | 'partial'
  /** All expected lines captured (coverage 100% of a known total). */
  | 'captured-full'
  /** Capture error (observer failure, storage/quota problem). */
  | 'error';

/** Independent axis 2 — evidence about fidelity to the original source. */
export type VerificationState =
  /** No independent evidence yet. */
  | 'unverified'
  /**
   * Evidence exists: a complete authorized document model, OR full coverage of
   * a known total plus a consistent re-observation of previously captured lines.
   */
  | 'verified'
  /** Two captures disagree for the same line range and it is unresolved. */
  | 'conflict'
  /** The source changed after this capture; a newer revision exists. */
  | 'stale';

/** Combined dot color for tree/list indicators (derived, never stored). */
export type StatusDot = 'green' | 'yellow' | 'grey' | 'blue' | 'red';

export type PathSource = 'exact' | 'heuristic';

/** 1-based inclusive line interval. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

// ---------------------------------------------------------------------------
// Entities (IndexedDB stores — spec Part 12, extended with revisions & journal)
// ---------------------------------------------------------------------------

export interface ProjectRecord {
  projectId: string;
  projectName: string;
  sourcePlatform: string;
  sourceOrigin: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
  /** Project-scoped capture settings. */
  caseSensitivePaths: boolean;
}

export interface FolderRecord {
  /** `${projectId}::${relativePath}` — canonical, one folder one record. */
  folderId: string;
  projectId: string;
  parentPath: string; // '' for root-level folders
  relativePath: string;
  name: string;
  /** discovered = seen in a tree; inspected = user expanded it. */
  discoveryStatus: 'discovered' | 'inspected';
  /** True when the source showed the folder but it had no children rendered. */
  knownEmpty: boolean;
  /**
   * Position among its siblings as shown by the source page (0-based, from
   * tree row order). The source's order is authoritative — never re-sorted
   * alphabetically in UI or export.
   */
  displayOrder: number;
  firstSeenAt: number;
  lastInspectedAt: number | null;
}

export interface FileRecord {
  /** `${projectId}::${relativePath}` — stable across revisions (addendum #4). */
  fileId: string;
  projectId: string;
  folderPath: string; // parent dir, '' = project root
  relativePath: string; // canonical relative path
  filename: string;
  extension: string;
  mimeType: string;
  currentRevisionId: string | null;
  captureState: CaptureState;
  verificationState: VerificationState;
  /** Known expected line count — only from reliable info, never invented. */
  expectedLineCount: number | null;
  /** Provenance of the expected count — surfaced in the UI for honesty. */
  expectedLineCountSource: 'document-model' | 'editor-metadata' | 'layout-derived' | null;
  /** Size of the union of captured line ranges in the current revision. */
  capturedLineCount: number;
  /** captured / expected, only when expected is known. */
  coveragePercent: number | null;
  /** Gaps between line 1..expected that are not captured. */
  missingRanges: LineRange[];
  isBinary: boolean;
  byteCount: number | null;
  pathSource: PathSource;
  /**
   * Position among its siblings as shown by the source page (0-based, from
   * tree row order). The source's order is authoritative — never re-sorted
   * alphabetically in UI or export.
   */
  displayOrder: number;
  /** Number of unresolved conflicts in the current revision. */
  conflictCount: number;
  /** Hash of the current revision's complete reconstruction, when complete. */
  contentHash: string | null;
  /** How the file path was determined matters for honesty in the UI. */
  firstSeenAt: number;
  lastInspectedAt: number | null;
  lastUpdated: number;
  lastError: string | null;
}

/** Immutable snapshot of a file's content at one point in time. */
export interface RevisionRecord {
  /** `${fileId}#r${revisionNumber}` */
  revisionId: string;
  fileId: string;
  revisionNumber: number; // 1-based, monotonic
  /** Strongest basis that contributed to this revision. */
  basis: ContentBasis;
  /** True once an authorized complete document model was captured into this revision. */
  hasFullDocument: boolean;
  /** Total line count, when reliably known. */
  totalLines: number | null;
  /** Hash of the full reconstruction — set once coverage is complete. */
  contentHash: string | null;
  /** Distinct capture-moment ids whose re-observation matched stored content (consistency evidence). */
  observationMoments: string[];
  status: 'open' | 'superseded';
  supersededBy: number | null;
  createdAt: number;
  lastCaptureAt: number | null;
}

export interface RangeRecord {
  /** `${revisionId}:${startLine}-${endLine}` */
  rangeId: string;
  revisionId: string;
  fileId: string;
  startLine: number; // 1-based inclusive
  endLine: number;
  /** Content-addressed chunk id (sha256 of the range text). */
  chunkId: string;
  basis: ContentBasis;
  capturedAt: number;
  /** Write-journal marker for interrupted-session recovery (addendum #6). */
  journalId: string | null;
}

export interface ChunkRecord {
  /** sha256 hex of the text — content addressing makes identical content single-copy. */
  chunkId: string;
  text: string;
  byteSize: number;
  createdAt: number;
}

export interface ConflictRecord {
  /** `${revisionId}:${startLine}-${endLine}:${incomingHash}` */
  conflictId: string;
  projectId: string;
  fileId: string;
  revisionId: string;
  startLine: number;
  endLine: number;
  /** Line numbers inside the span whose content disagrees. */
  differingLines: number[];
  existingChunkId: string;
  incomingChunkId: string;
  detectedAt: number;
  resolvedAt: number | null;
  resolution: 'unresolved' | 'superseded' | 'reinspected';
}

export type SessionStatus = 'running' | 'paused' | 'stopped' | 'interrupted';

export interface CaptureSessionRecord {
  sessionId: string;
  projectId: string;
  origin: string;
  adapterId: string;
  activeFilePath: string | null;
  startedAt: number;
  lastActivityAt: number;
  status: SessionStatus;
}

/**
 * Write-intent journal for transactional multi-store capture batches.
 * Phase 1: journal row written (committed) with done=false.
 * Phase 2: data rows written; journal row updated to done=true (same tx).
 * On open, any journal with done=false has its data rows (tagged with the
 * journalId) removed and dependent aggregates recomputed — never silently kept,
 * never silently discarded (addendum #6).
 */
export interface JournalRecord {
  journalId: string;
  projectId: string;
  intent: 'capture-batch' | 'export' | 'asset-batch';
  createdAt: number;
  done: boolean;
  summary: string;
}

export type AssetCategory =
  | 'image'
  | 'vector'
  | 'font'
  | 'source'
  | 'media'
  | 'document'
  | 'other';

export interface AssetRecord {
  /** `${projectId}::${sha256(url)}` */
  assetId: string;
  projectId: string;
  url: string;
  category: AssetCategory;
  filename: string;
  extension: string;
  mimeType: string;
  /** Fetched bytes chunk id, when the resource could be retrieved. */
  chunkId: string | null;
  /** Inline data (data: URI text or serialized SVG) when fetch was not needed. */
  inlineText: string | null;
  byteSize: number | null;
  status: 'discovered' | 'captured' | 'unavailable';
  discoveredAt: number;
  capturedAt: number | null;
  lastError: string | null;
}

export type ActivityKind =
  | 'project'
  | 'folder'
  | 'file'
  | 'capture'
  | 'conflict'
  | 'revision'
  | 'export'
  | 'asset'
  | 'storage'
  | 'session'
  | 'error';

export interface ActivityRecord {
  activityId: string;
  projectId: string;
  at: number;
  kind: ActivityKind;
  path: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Discovery events (adapters/observers → CaptureController)
// ---------------------------------------------------------------------------

/** A content range as seen by an observer, before identity/dedup processing. */
export interface RawRange {
  startLine: number;
  endLine: number;
  /** Exact line texts, length === endLine - startLine + 1. */
  lines: string[];
}

export type DiscoveryEvent =
  | { type: 'project-detected'; name: string; origin: string; adapterId: string }
  | { type: 'folder-discovered'; path: string; knownEmpty: boolean; displayOrder?: number }
  | { type: 'folder-inspected'; path: string }
  | {
      type: 'file-discovered';
      path: string;
      pathSource: PathSource;
      isBinaryHint: boolean;
      displayOrder?: number;
    }
  | { type: 'file-activated'; path: string }
  | {
      type: 'content-exposed';
      path: string;
      basis: 'dom-visible';
      ranges: RawRange[];
      /** Reliable total-line hint from the editor, when exposed. */
      totalLinesHint: number | null;
    }
  | {
      type: 'document-available';
      path: string;
      basis: 'document-model';
      text: string;
      totalLines: number;
      /** Human label of the authorized source (e.g. "editor document model"). */
      sourceLabel: string;
    }
  | {
      type: 'binary-available';
      path: string;
      base64: string;
      byteSize: number;
      mimeType: string;
    }
  | { type: 'file-closed'; path: string };

export interface ProjectProgress {
  totalFolders: number;
  inspectedFolders: number;
  totalFiles: number;
  completeFiles: number;
  partialFiles: number;
  pendingFiles: number;
  errorFiles: number;
  conflictFiles: number;
  capturedLines: number;
  capturedBytes: number;
  extractionPercent: number | null;
}

// ---------------------------------------------------------------------------
// Panel / workspace settings
// ---------------------------------------------------------------------------

export type WorkspaceMode = 'push' | 'overlay';

export interface PanelSettings {
  /** Panel width as a 0..1 ratio of viewport; default 0.6 (spec: 40:60). */
  ratio: number;
  workspaceMode: WorkspaceMode;
}

export const DEFAULT_PANEL_RATIO = 0.6;
export const MIN_PANEL_PX = 320;
export const MIN_SITE_PX = 320;
export const RATIO_MIN = 0.2;
export const RATIO_MAX = 0.85;
