/**
 * Blink.new adapter — DISABLED BY DEFAULT, intentionally.
 *
 * The implementation addendum forbids inventing website selectors and claiming
 * an adapter works without testing it against the real platform. blink.new's
 * DOM structure could not be verified during development, so this adapter
 * ships with an EMPTY configuration: detect() returns false until a user who
 * can see the real site fills in the selectors below.
 *
 * To enable (requires the site open in a browser):
 *   1. Inspect the real blink.new project page (Code section).
 *   2. Fill BLINK_SELECTORS with real selectors (see comments).
 *   3. Rebuild. The adapter then behaves like the demo fixture adapter,
 *      reading the tree via your selectors and the editor via the standard
 *      CodeMirror/Monaco observers.
 *   4. Verify honestly in the panel; adjust until tree paths and line numbers
 *      look right.
 */
import type { DiscoveryEvent } from '../../shared/types';
import type { AdapterStartOptions, PlatformAdapter } from './types';
import { detectEditorObserver, textOf } from '../observers';
import { ScrollMonitor } from '../capture/ScrollMonitor';
import { canonicalizeRelativePath } from '../identity/paths';

export interface BlinkSelectors {
  /** Element that only exists on a blink.new project page. */
  rootMarker: string;
  /** Selector matching every file/folder row in the project tree. */
  treeRow: string;
  /** Attribute or text on a row carrying its path/filename. */
  rowPathAttribute: string | null;
  /** How to tell a folder row from a file row (attribute presence). */
  folderIndicatorAttribute: string | null;
  /** Selector for the container holding the current editor. */
  editorRoot: string;
  /** Selector for the active file tab/title showing the current filename. */
  activeFileTitle: string;
}

export const BLINK_SELECTORS: BlinkSelectors = {
  rootMarker: '',            // e.g. '[data-blink-project]' — MUST be verified on the real site
  treeRow: '',
  rowPathAttribute: null,
  folderIndicatorAttribute: null,
  editorRoot: '',
  activeFileTitle: '',
};

export function blinkConfigured(): boolean {
  return (
    BLINK_SELECTORS.rootMarker !== '' &&
    BLINK_SELECTORS.treeRow !== '' &&
    BLINK_SELECTORS.editorRoot !== ''
  );
}

export class BlinkAdapter implements PlatformAdapter {
  readonly id = 'blink';
  readonly displayName = 'Blink.new';
  readonly notes = blinkConfigured()
    ? 'Selector-configured Blink.new adapter. Verify tree paths and captured line numbers against the real site; report mismatches via the comparison view.'
    : 'Not configured. This adapter is disabled until real selectors are provided in src/core/adapters/blink.ts (see the README section "Enabling the Blink.new adapter"). Nothing is invented on your behalf.';

  private emit: ((ev: DiscoveryEvent) => void) | null = null;
  private monitor: ScrollMonitor | null = null;
  private listeners: (() => void)[] = [];
  private paused = false;
  private started = false;

  detect(): boolean {
    return blinkConfigured() && document.querySelector(BLINK_SELECTORS.rootMarker) !== null;
  }

  start(opts: AdapterStartOptions): void {
    if (!blinkConfigured() || this.started) return;
    this.started = true;
    this.emit = opts.emit;
    this.emit({
      type: 'project-detected',
      name: document.title || 'blink project',
      origin: location.origin,
      adapterId: this.id,
    });

    const discoverRows = () => {
      for (const row of Array.from(document.querySelectorAll<HTMLElement>(BLINK_SELECTORS.treeRow))) {
        const raw =
          (BLINK_SELECTORS.rowPathAttribute && row.getAttribute(BLINK_SELECTORS.rowPathAttribute)) ||
          (row.textContent || '').trim().split('\n')[0]!;
        const canonical = canonicalizeRelativePath(raw);
        if (!canonical) continue;
        const isFolder =
          BLINK_SELECTORS.folderIndicatorAttribute !== null &&
          row.hasAttribute(BLINK_SELECTORS.folderIndicatorAttribute);
        if (isFolder) {
          this.safeEmit({ type: 'folder-discovered', path: canonical, knownEmpty: false });
        } else {
          this.safeEmit({ type: 'file-discovered', path: canonical, pathSource: 'exact', isBinaryHint: false });
        }
      }
    };
    discoverRows();
    const mo = new MutationObserver(discoverRows);
    mo.observe(document.body, { childList: true, subtree: true });
    this.listeners.push(() => mo.disconnect());

    const editorRoot = document.querySelector<HTMLElement>(BLINK_SELECTORS.editorRoot);
    if (editorRoot) {
      const observer = detectEditorObserver(editorRoot) ?? null;
      const readNow = () => {
        if (this.paused || !this.emit) return;
        const titleEl = document.querySelector<HTMLElement>(BLINK_SELECTORS.activeFileTitle);
        const canonical = titleEl ? canonicalizeRelativePath(textOf(titleEl)) : null;
        const path = canonical ?? 'active-file';
        const snap = observer?.read();
        if (!snap || snap.ranges.length === 0) return;
        this.emit({
          type: 'content-exposed',
          path,
          basis: 'dom-visible',
          ranges: snap.ranges,
          totalLinesHint: snap.totalLinesHint,
        });
      };
      const snap = observer?.read();
      if (snap) {
        this.monitor = new ScrollMonitor({ scroller: snap.scroller, root: snap.root }, { onActivity: readNow, waitMs: 200 });
        setTimeout(readNow, 120);
      }
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.monitor?.poke();
  }

  stop(): void {
    this.started = false;
    this.paused = false;
    this.monitor?.stop();
    this.monitor = null;
    for (const off of this.listeners.splice(0)) off();
    this.emit = null;
  }

  private safeEmit(ev: DiscoveryEvent): void {
    if (this.emit && !this.paused) this.emit(ev);
  }
}
