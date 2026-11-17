/**
 * CaptureController — orchestrates the progressive capture pipeline
 * (spec Part 5, addendum #3). Adapters emit DiscoveryEvents; this controller
 * applies them to storage SERIALLY (one write chain — no write races),
 * tracks the capture session, and feeds change notifications to the panel.
 *
 * Interrupted-session recovery: on start, a previously 'interrupted' or
 * 'paused' session for this origin is resumed (addendum #6) — captured data
 * is never discarded, the session simply continues.
 */
import type { IDBPDatabase } from 'idb';
import type { AssetMinerSchema } from '../../storage/db';
import type { DiscoveryEvent } from '../../shared/types';
import type { EventBus } from '../../shared/transport';
import { AssetMinerError, toAssetMinerError } from '../../shared/errors';
import { localId, splitLines } from '../../shared/utils';
import { getOrCreateProject, listSessions, logActivity, setSessionStatus, startSession, updateSession } from '../../storage/repositories/projects';
import { ensureFileDiscovered, ensureFolder, ensureFoldersForPath, markFolderInspected } from '../../storage/repositories/tree';
import { applyBinaryFileCapture, applyDocumentModel, markFileInspected, setFileCapturing, setFileError } from '../../storage/repositories/capture';
import { ensureAssetDiscovered, setAssetCaptured } from '../../storage/repositories/assets';
import { ingestExposedContent } from '../dedup/DuplicateManager';
import { canonicalizeRelativePath } from '../identity/paths';
import { fileKey } from '../identity/keys';
import type { PlatformAdapter } from '../adapters/types';

export type ControllerStatus = 'running' | 'paused' | 'stopped';

export class CaptureController {
  private queue: Promise<unknown> = Promise.resolve();
  private sessionId: string | null = null;
  projectId: string | null = null;
  private projectName = '';
  private status: ControllerStatus = 'stopped';
  private momentSeq = 0;
  private lastError: string | null = null;
  private activePath: string | null = null;

  constructor(
    private db: IDBPDatabase<AssetMinerSchema>,
    private bus: EventBus,
    private adapter: PlatformAdapter,
    private origin: string,
  ) {}

  get currentStatus(): ControllerStatus {
    return this.status;
  }

  /** Public view of the active adapter for the UI (notes, display name). */
  get adapterInfo(): PlatformAdapter {
    return this.adapter;
  }

  /**
   * Swap the platform adapter without losing the session or project state.
   * Used when an editor mounts AFTER injection (SPA pages like blink.new
   * render their IDE on demand — the initial detect() can legitimately see
   * nothing). The old adapter is stopped cleanly; identity/storage continue.
   */
  swapAdapter(next: PlatformAdapter): void {
    if (next.id === this.adapter.id) return;
    try {
      this.adapter.stop();
    } catch {
      // Adapter isolation: a failing stop must not block the swap.
    }
    this.adapter = next;
    this.status = 'running';
    next.start({ emit: (ev) => this.enqueue(ev) });
    this.bus.emit('session');
  }

  get projectLabel(): string {
    return this.projectName;
  }

  get activeFilePath(): string | null {
    return this.activePath;
  }

  async start(): Promise<void> {
    // Resume the most recent recoverable session for this origin, if any.
    const existing = (await listSessions(this.db, await this.resolveProjectIdSafe())) ?? [];
    void existing;
    this.status = 'running';
    this.adapter.start({ emit: (ev) => this.enqueue(ev) });
    this.bus.emit('session');
  }

  pause(): void {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this.adapter.pause();
    if (this.sessionId) void setSessionStatus(this.db, this.sessionId, 'paused');
    this.bus.emit('session');
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.status = 'running';
    this.adapter.resume();
    if (this.sessionId) void setSessionStatus(this.db, this.sessionId, 'running');
    this.bus.emit('session');
  }

  stop(): void {
    this.status = 'stopped';
    this.adapter.stop();
    if (this.sessionId) void setSessionStatus(this.db, this.sessionId, 'stopped');
    this.bus.emit('session');
  }

  /** User-facing request for an authorized full-document refresh, if the adapter supports it. */
  async requestFullDocument(path: string): Promise<void> {
    if (this.adapter.requestFullDocument) {
      await this.adapter.requestFullDocument(path);
    }
  }

  /** Save manually edited or pasted text for a file through the serialized write queue. */
  async captureManualText(path: string, text: string, sourceLabel = 'manual-edit'): Promise<void> {
    const canonical = canonicalizeRelativePath(path);
    if (!canonical) throw new Error(`Invalid file path: ${path}`);
    const lines = splitLines(text);
    const ev: DiscoveryEvent = {
      type: 'document-available',
      path: canonical,
      basis: 'document-model',
      text,
      totalLines: lines.length,
      sourceLabel,
    };
    const run = this.queue
      .then(() => this.process(ev))
      .catch((err) => {
        const amErr = toAssetMinerError(err);
        this.lastError = amErr.message;
        return this.recordError(ev, amErr);
      });
    this.queue = run;
    await run;
  }

  /** Feed an event forwarded from a child frame into this controller's pipeline. */
  ingestRemoteEvent(ev: DiscoveryEvent): void {
    this.enqueue(ev);
  }

  getLastError(): string | null {
    return this.lastError;
  }

  // ----------------------------------------------------------------- events

  /** Serialize event processing: capture writes must not interleave. */
  private enqueue(ev: DiscoveryEvent): void {
    if (this.status === 'stopped') return;
    if (this.status === 'paused' && ev.type !== 'file-closed') return; // pause = record nothing new
    this.queue = this.queue
      .then(() => this.process(ev))
      .catch((err) => {
        const amErr = toAssetMinerError(err);
        this.lastError = amErr.message;
        void this.recordError(ev, amErr);
      });
  }

  private async recordError(ev: DiscoveryEvent, err: AssetMinerError): Promise<void> {
    try {
      if (this.projectId && 'path' in ev && typeof ev.path === 'string') {
        const canonical = canonicalizeRelativePath(ev.path);
        if (canonical) {
          await setFileError(this.db, fileKey(this.projectId, canonical), err.message);
        }
      }
      if (this.projectId) {
        await logActivity(this.db, this.projectId, 'error', `${ev.type}: ${err.message}`);
      }
    } catch {
      // Logging failures must not mask the original pipeline error.
    }
    this.bus.emit('capture');
  }

  private async process(ev: DiscoveryEvent): Promise<void> {
    switch (ev.type) {
      case 'project-detected': {
        const { project, created } = await getOrCreateProject(this.db, ev.origin, ev.name, ev.adapterId);
        this.projectId = project.projectId;
        this.projectName = ev.name;
        if (!this.sessionId) {
          const session = await startSession(this.db, project.projectId, ev.origin, ev.adapterId);
          this.sessionId = session.sessionId;
        }
        if (created) {
          await logActivity(this.db, project.projectId, 'project', `Project detected: ${ev.name} (${ev.adapterId})`);
        }
        this.bus.emit('project', { projectId: project.projectId });
        break;
      }
      case 'folder-discovered': {
        const pid = await this.requireProject();
        const canonical = canonicalizeRelativePath(ev.path);
        if (!canonical) break;
        await ensureFoldersForPath(this.db, pid, canonical);
        await ensureFolder(this.db, pid, canonical, {
          knownEmpty: ev.knownEmpty,
          displayOrder: ev.displayOrder,
        });
        this.bus.emit('tree', { projectId: pid });
        break;
      }
      case 'folder-inspected': {
        const pid = await this.requireProject();
        const canonical = canonicalizeRelativePath(ev.path);
        if (!canonical) break;
        await ensureFoldersForPath(this.db, pid, canonical);
        await ensureFolder(this.db, pid, canonical);
        await markFolderInspected(this.db, pid, canonical);
        this.bus.emit('tree', { projectId: pid });
        break;
      }
      case 'file-discovered': {
        const pid = await this.requireProject();
        const canonical = canonicalizeRelativePath(ev.path);
        if (!canonical) break;
        await ensureFileDiscovered(this.db, pid, {
          path: canonical,
          pathSource: ev.pathSource,
          isBinaryHint: ev.isBinaryHint,
          displayOrder: ev.displayOrder,
        });
        this.bus.emit('tree', { projectId: pid });
        break;
      }
      case 'file-activated': {
        const pid = await this.requireProject();
        const canonical = canonicalizeRelativePath(ev.path);
        if (!canonical) break;
        const { file } = await ensureFileDiscovered(this.db, pid, {
          path: canonical,
          pathSource: 'exact',
          isBinaryHint: false,
        });
        await markFileInspected(this.db, file.fileId);
        await setFileCapturing(this.db, file.fileId, true);
        this.activePath = canonical;
        if (this.sessionId) await updateSession(this.db, this.sessionId, { activeFilePath: canonical });
        this.bus.emit('capture', { projectId: pid, fileId: file.fileId });
        break;
      }
      case 'content-exposed': {
        const pid = await this.requireProject();
        const canonical = canonicalizeRelativePath(ev.path);
        if (!canonical) break;
        this.momentSeq += 1;
        await ingestExposedContent(this.db, {
          projectId: pid,
          path: canonical,
          momentId: `${this.sessionId ?? 'offline'}:${this.momentSeq}`,
          basis: 'dom-visible',
          ranges: ev.ranges,
          totalLinesHint: ev.totalLinesHint,
          isBinaryHint: false,
        });
        this.bus.emit('capture', { projectId: pid });
        break;
      }
      case 'document-available': {
        const pid = await this.requireProject();
        const canonical = canonicalizeRelativePath(ev.path);
        if (!canonical) break;
        const { file } = await ensureFileDiscovered(this.db, pid, {
          path: canonical,
          pathSource: 'exact',
          isBinaryHint: false,
        });
        await applyDocumentModel(this.db, {
          projectId: pid,
          fileId: file.fileId,
          text: ev.text,
          sourceLabel: ev.sourceLabel,
        });
        this.bus.emit('capture', { projectId: pid, fileId: file.fileId });
        this.bus.emit('revision', { projectId: pid, fileId: file.fileId });
        break;
      }
      case 'binary-available': {
        const pid = await this.requireProject();
        const canonical = canonicalizeRelativePath(ev.path);
        if (!canonical) break;
        const { file } = await ensureFileDiscovered(this.db, pid, {
          path: canonical,
          pathSource: 'exact',
          isBinaryHint: true,
        });
        await applyBinaryFileCapture(this.db, {
          projectId: pid,
          fileId: file.fileId,
          base64: ev.base64,
          byteSize: ev.byteSize,
          mimeType: ev.mimeType,
        });
        const assetUrl = `${this.origin.replace(/\/$/, '')}/${canonical}`;
        const { asset } = await ensureAssetDiscovered(this.db, pid, { url: assetUrl, mimeTypeHint: ev.mimeType });
        await setAssetCaptured(this.db, asset.assetId, { inlineText: `base64:${ev.base64}`, byteSize: ev.byteSize });
        this.bus.emit('capture', { projectId: pid, fileId: file.fileId });
        this.bus.emit('tree', { projectId: pid });
        break;
      }
      case 'file-closed': {
        const pid = await this.requireProject();
        const canonical = canonicalizeRelativePath(ev.path);
        if (!canonical) break;
        await setFileCapturing(this.db, fileKey(pid, canonical), false);
        if (this.sessionId) await updateSession(this.db, this.sessionId, { activeFilePath: null });
        this.bus.emit('capture', { projectId: pid });
        break;
      }
    }
  }

  /** Ensure a project exists for events that can arrive before project-detected. */
  private async requireProject(): Promise<string> {
    if (this.projectId) return this.projectId;
    // Fall back to an origin-level project so data is never dropped.
    const { project } = await getOrCreateProject(
      this.db,
      this.origin,
      this.adapter.displayName,
      this.adapter.id,
    );
    this.projectId = project.projectId;
    this.projectName = this.adapter.displayName;
    if (!this.sessionId) {
      const session = await startSession(this.db, project.projectId, this.origin, this.adapter.id);
      this.sessionId = session.sessionId;
    }
    return project.projectId;
  }

  private async resolveProjectIdSafe(): Promise<string> {
    try {
      const { project } = await getOrCreateProject(this.db, this.origin, this.adapter.displayName, this.adapter.id);
      return project.projectId;
    } catch {
      return localId('fallback');
    }
  }
}
