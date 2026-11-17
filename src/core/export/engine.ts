/**
 * Export engine (spec Part 11, addendum: honest completeness).
 *
 * Modes:
 *  - original:      captured content at original paths ONLY. No fabricated
 *                   content, no placeholders. Partial files export their
 *                   captured ranges and the report lists every gap.
 *  - reconstructed: additionally fills gaps with clearly-marked marker lines
 *                   and adds reconstruction notes, so the archive can be
 *                   opened as a working tree while staying honest about what
 *                   was recovered vs synthesized.
 *
 * Before zipping: paths are sanitized, traversal rejected, identity duplicates
 * (impossible by construction, but verified) reported, and the manifest lists
 * every file's capture/verification state.
 */
import JSZip from 'jszip';
import type { IDBPDatabase } from 'idb';
import type { AssetMinerSchema } from '../../storage/db';
import type { AssetRecord, FileRecord, FolderRecord } from '../../shared/types';
import { listFiles, listFolders } from '../../storage/repositories/tree';
import { readRevisionLines } from '../../storage/repositories/capture';
import { sanitizeForExport } from '../identity/paths';
import { sortFilesBySourceOrder } from '../identity/order';
import { joinLines } from '../../shared/utils';

export type ExportMode = 'original' | 'reconstructed';

export interface ExportFileEntry {
  /** Final in-archive path ('' = skipped). */
  archivePath: string;
  relativePath: string;
  /** Sibling position in the source tree — the export preserves that order. */
  displayOrder: number;
  text: string | null; // null → not included (unsafe path or no content)
  isBinary?: boolean;
  captureState: string;
  verificationState: string;
  capturedLineCount: number;
  expectedLineCount: number | null;
  coveragePercent: number | null;
  missingRanges: { startLine: number; endLine: number }[];
  contentHash: string | null;
  skipReason?: string;
}

export interface ExportReport {
  tool: 'asset-miner';
  version: '0.1.0';
  generatedAt: string;
  mode: ExportMode;
  project: { id: string; name: string; origin: string; platform: string } | null;
  summary: {
    folders: number;
    filesTotal: number;
    filesIncluded: number;
    filesComplete: number;
    filesPartial: number;
    filesPending: number;
    filesSkipped: number;
    totalCapturedLines: number;
    completeArchive: boolean; // false whenever ANY discovered file is not fully captured+verified
  };
  files: ExportFileEntry[];
  skipped: { relativePath: string; reason: string }[];
  warnings: string[];
}

export interface ExportBundle {
  zip: JSZip;
  report: ExportReport;
  filename: string;
}

const MISSING_MARKER = (from: number, to: number) =>
  `<<<<<<< ASSET-MINER MISSING RANGE lines ${from}-${to} — content never captured >>>>>>>`;

export async function buildExport(
  db: IDBPDatabase<AssetMinerSchema>,
  projectId: string,
  mode: ExportMode,
): Promise<ExportBundle> {
  const files: FileRecord[] = await listFiles(db, projectId);
  const folders: FolderRecord[] = await listFolders(db, projectId);
  const warnings: string[] = [];
  const skipped: { relativePath: string; reason: string }[] = [];
  const entries: ExportFileEntry[] = [];
  const binaryPayloads = new Map<string, string>();

  // Source page order is authoritative for the report (and ZIP entry order).
  for (const file of sortFilesBySourceOrder(files)) {
    const sanitized = sanitizeForExport(file.relativePath);
    if (!sanitized.ok) {
      skipped.push({ relativePath: file.relativePath, reason: sanitized.reason ?? 'unsafe path' });
      entries.push({
        archivePath: '',
        relativePath: file.relativePath,
        displayOrder: file.displayOrder,
        text: null,
        isBinary: file.isBinary,
        captureState: file.captureState,
        verificationState: file.verificationState,
        capturedLineCount: file.capturedLineCount,
        expectedLineCount: file.expectedLineCount,
        coveragePercent: file.coveragePercent,
        missingRanges: file.missingRanges,
        contentHash: file.contentHash,
        skipReason: sanitized.reason,
      });
      continue;
    }
    let text: string | null = null;
    if (file.currentRevisionId && file.isBinary) {
      const ranges = await db.getAllFromIndex('ranges', 'by-revision', file.currentRevisionId);
      const firstRange = ranges[0];
      if (firstRange) {
        const chunk = await db.get('chunks', firstRange.chunkId);
        if (chunk?.text) binaryPayloads.set(sanitized.path, chunk.text);
      }
    } else if (file.currentRevisionId && file.capturedLineCount > 0 && !file.isBinary) {
      const lines = await readRevisionLines(db, file.currentRevisionId);
      if (mode === 'reconstructed' && file.missingRanges.length > 0 && file.expectedLineCount !== null) {
        const filled: string[] = [];
        for (let n = 1; n <= file.expectedLineCount; n++) {
          const line = lines[n - 1];
          if (line === undefined || line === '') {
            // Determine whether this line is inside a known missing range.
            const inGap = file.missingRanges.some((m) => n >= m.startLine && n <= m.endLine);
            filled.push(inGap ? MISSING_MARKER(n, n) : (line ?? ''));
          } else {
            filled.push(line);
          }
        }
        text = joinLines(filled);
      } else {
        const expected = file.expectedLineCount;
        text = expected === null ? joinLines(lines) : joinLines(lines.slice(0, expected));
      }
    }
    entries.push({
      archivePath: sanitized.path,
      relativePath: file.relativePath,
      displayOrder: file.displayOrder,
      text,
      isBinary: file.isBinary,
      captureState: file.captureState,
      verificationState: file.verificationState,
      capturedLineCount: file.capturedLineCount,
      expectedLineCount: file.expectedLineCount,
      coveragePercent: file.coveragePercent,
      missingRanges: file.missingRanges,
      contentHash: file.contentHash,
    });
  }

  // Identity duplicates are impossible (single key per path), but the export
  // still verifies (spec 11.4) and would report a collision if it ever saw one.
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.archivePath) continue;
    if (seen.has(e.archivePath)) {
      e.archivePath = '';
      e.skipReason = 'duplicate archive path';
      skipped.push({ relativePath: e.relativePath, reason: 'duplicate archive path' });
    }
    seen.add(e.archivePath);
  }

  const included = entries.filter((e) => e.archivePath && (e.text !== null || binaryPayloads.has(e.archivePath)));
  const completeFiles = entries.filter((e) => e.captureState === 'captured-full' && e.verificationState === 'verified');
  const partialFiles = entries.filter((e) => e.captureState !== 'pending' && e.captureState !== 'captured-full');
  const pendingFiles = entries.filter((e) => e.captureState === 'pending');

  if (pendingFiles.length > 0) {
    warnings.push(`${pendingFiles.length} discovered file(s) were never inspected — they are NOT in this archive.`);
  }
  if (partialFiles.length > 0) {
    warnings.push(`${partialFiles.length} file(s) are partially captured — gaps are listed per file in this report.`);
  }
  if (entries.some((e) => e.captureState === 'captured-full' && e.verificationState !== 'verified')) {
    warnings.push('Some fully captured files lack verification evidence (single observation); see verificationState.');
  }

  const report: ExportReport = {
    tool: 'asset-miner',
    version: '0.1.0',
    generatedAt: new Date().toISOString(),
    mode,
    project: null, // filled by caller with project metadata
    summary: {
      folders: folders.length,
      filesTotal: entries.length,
      filesIncluded: included.length,
      filesComplete: completeFiles.length,
      filesPartial: partialFiles.length,
      filesPending: pendingFiles.length,
      filesSkipped: skipped.length,
      totalCapturedLines: entries.reduce((sum, e) => sum + e.capturedLineCount, 0),
      completeArchive: entries.length > 0 && completeFiles.length === entries.length,
    },
    files: entries,
    skipped,
    warnings,
  };

  const zip = new JSZip();
  for (const e of entries) {
    if (!e.archivePath) continue;
    if (e.text !== null) {
      zip.file(e.archivePath, e.text);
    } else {
      const b64 = binaryPayloads.get(e.archivePath);
      if (b64) zip.file(e.archivePath, b64, { base64: true });
    }
  }
  // Preserve discovered folder hierarchy (including empty/unopened folders).
  for (const folder of folders) {
    const safe = sanitizeForExport(folder.relativePath);
    if (safe.ok) zip.folder(safe.path);
  }
  zip.file('asset-miner-report.json', JSON.stringify(report, null, 2));
  if (mode === 'reconstructed') {
    zip.file(
      'ASSET-MINER-RECONSTRUCTION.md',
      [
        '# Asset Miner reconstruction notes',
        '',
        `Generated: ${report.generatedAt}`,
        '',
        'This archive is a RECONSTRUCTED export. Files containing lines marked with',
        '`<<<<<<< ASSET-MINER MISSING RANGE ... >>>>>>>` had gaps that were never captured;',
        'those marker lines are synthesized placeholders, NOT original source content.',
        'For the pure captured content without any synthesis, export in "original" mode',
        'and consult asset-miner-report.json for per-file gap lists.',
        '',
        `Files included: ${report.summary.filesIncluded} · complete: ${report.summary.filesComplete} · partial: ${report.summary.filesPartial} · never inspected: ${report.summary.filesPending}`,
      ].join('\n'),
    );
  }

  const projectName = report.project?.name ?? 'project';
  const stamp = new Date().toISOString().slice(0, 10);
  return { zip, report, filename: `${projectName}-${mode}-${stamp}.zip` };
}

/** Attach project metadata + captured assets to a bundle before download. */
export async function attachProjectAndAssets(
  db: IDBPDatabase<AssetMinerSchema>,
  bundle: ExportBundle,
  projectId: string,
  projectName: string,
  origin: string,
  platform: string,
  includeAssets: boolean,
  assets: AssetRecord[],
): Promise<ExportBundle> {
  bundle.report.project = { id: projectId, name: projectName, origin, platform };
  if (includeAssets) {
    const { listAssets } = await import('../../storage/repositories/assets');
    void assets;
    const all = await listAssets(db, projectId);
    let exported = 0;
    for (const asset of all) {
      if (asset.status !== 'captured') continue;
      let base64: string | null = null;
      if (asset.inlineText?.startsWith('base64:')) {
        base64 = asset.inlineText.slice(7);
      } else if (asset.inlineText?.startsWith('data:')) {
        const comma = asset.inlineText.indexOf(',');
        if (comma > 0) {
          const header = asset.inlineText.slice(5, comma);
          const body = asset.inlineText.slice(comma + 1);
          if (header.includes(';base64')) {
            base64 = body;
          } else {
            try {
              base64 = btoa(unescape(encodeURIComponent(decodeURIComponent(body))));
            } catch {
              base64 = null;
            }
          }
        }
      } else if (asset.chunkId) {
        const chunk = await db.get('chunks', asset.chunkId);
        if (chunk) {
          // Chunk holds base64 text for binary assets.
          base64 = chunk.text;
        }
      }
      if (!base64) continue;
      const safe = sanitizeForExport(`assets/${asset.filename}`);
      if (!safe.ok) continue;
      bundle.zip.file(safe.path, base64, { base64: true });
      exported += 1;
    }
    bundle.report.warnings.push(`${exported} captured page asset(s) included under assets/.`);
  }
  // Report must reflect final state — regenerate the embedded report file.
  bundle.zip.file('asset-miner-report.json', JSON.stringify(bundle.report, null, 2));
  return bundle;
}

export async function bundleToBlob(bundle: ExportBundle): Promise<Blob> {
  return bundle.zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/**
 * Trigger a browser download from the content-script context via an anchor
 * (no chrome.downloads permission needed; the blob never leaves the page).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Individual file download (spec 9.1: select one, save one). */
export function downloadText(text: string, filename: string): void {
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
}
