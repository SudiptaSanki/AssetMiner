/**
 * Platform adapter contract (spec Part 10).
 *
 * Adapters translate a specific website's DOM/API into DiscoveryEvents.
 * They must be isolated: a failure or change in one adapter must not affect
 * others. Honesty rules: an adapter only claims detection when it can really
 * read the platform; selectors must never be invented — the blink adapter
 * ships disabled with an empty configuration for exactly that reason.
 */
import type { DiscoveryEvent } from '../../shared/types';

export interface AdapterStartOptions {
  emit: (ev: DiscoveryEvent) => void;
}

/** Live, human-readable adapter state for the panel ("where am I"). */
export interface AdapterLiveStatus {
  /** Path of the file currently open on the page, as resolved against the tree. */
  activePath: string | null;
  /** A code editor is visible on the page (or in a frame). */
  editorFound: boolean;
  /** Full editor text is readable (no scrolling needed). */
  fullTextAvailable: boolean;
  /** Rows currently recognised in the page's file tree. */
  treeRows: number;
  /** One-line guidance for the user, when something blocks capture. */
  hint: string | null;
}

export interface PlatformAdapter {
  /** Stable id, persisted with sessions. */
  readonly id: string;
  readonly displayName: string;
  /** Human-readable capabilities & limitations, surfaced in the UI. */
  readonly notes: string;
  /** Synchronous DOM check: can this adapter really read this page? */
  detect(): boolean;
  /** Begin watching the page; forward discovery events to `emit`. */
  start(opts: AdapterStartOptions): void;
  /** Stop recording new observations (panel Pause). */
  pause(): void;
  resume(): void;
  /** Fully detach listeners. */
  stop(): void;
  /**
   * Optional: ask the platform for an authorized full document (official
   * export interface, editor API). Emits `document-available` when granted.
   */
  requestFullDocument?(path: string): Promise<void>;
  /** Optional live state for the panel. */
  liveStatus?(): AdapterLiveStatus;
}
