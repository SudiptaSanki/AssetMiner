/**
 * Demo fixture adapter — the reference adapter, exercised end-to-end by the
 * local demo IDE (public/demo/index.html) and by the test suite.
 *
 * The fixture is our own page, so the integration contract is exact:
 *   [data-asset-miner-demo]            root marker
 *   [data-am-type="folder"|"file"]     tree rows with [data-am-path]
 *   .cm-editor / .cm-scroller / …      CodeMirror-6-style virtualized editor
 *   CustomEvent "am:document"          authorized full-document export
 *   window.__amFixture                 test hook (content lookup)
 */
import type { DiscoveryEvent } from '../../shared/types';
import type { AdapterStartOptions, PlatformAdapter } from './types';
import { Cm6Observer, textOf } from '../observers';
import { ScrollMonitor } from '../capture/ScrollMonitor';
import { canonicalizeRelativePath } from '../identity/paths';
import { debounce } from '../../shared/utils';

interface FixtureApi {
  openFile(path: string): void;
  fileIndex: Map<string, { path: string; lines: number; kind: string; rev: number; content: string[] }>;
}

function fixtureApi(): FixtureApi | null {
  const w = window as unknown as { __amFixture?: FixtureApi };
  return w.__amFixture ?? null;
}

export class DemoFixtureAdapter implements PlatformAdapter {
  readonly id = 'demo-fixture';
  readonly displayName = 'Demo IDE (local fixture)';
  readonly notes =
    'Reference adapter for the bundled demo IDE. Full support: tree discovery, virtualized progressive capture, authorized full-document re-sync, revision simulation.';

  private emit: ((ev: DiscoveryEvent) => void) | null = null;
  private monitor: ScrollMonitor | null = null;
  private listeners: (() => void)[] = [];
  private paused = false;
  private started = false;
  private knownFiles = new Set<string>();

  detect(): boolean {
    return document.querySelector('[data-asset-miner-demo]') !== null;
  }

  start(opts: AdapterStartOptions): void {
    if (this.started) return;
    this.started = true;
    this.emit = opts.emit;
    this.emit({
      type: 'project-detected',
      name: 'my-project',
      origin: location.origin,
      adapterId: this.id,
    });

    // ---- Tree: initial discovery of every visible row (DOM order = source order) ----
    const tree = document.querySelector('[data-asset-miner-demo] #tree') ?? document;
    const discoverVisible = () => {
      // Only TOP-LEVEL rows get sibling indices from this flat scan; nested
      // rows are discovered on expansion, where their own parent context is
      // scanned. Flat per-parent indices are emitted per parent below.
      const siblingsPerParent = new Map<string, number>();
      for (const row of Array.from(tree.querySelectorAll<HTMLElement>('[data-am-type]'))) {
        const raw = row.dataset.amPath ?? '';
        const canonical = canonicalizeRelativePath(raw);
        if (!canonical) continue;
        // Sibling order: count only rows sharing the same visual parent list.
        const parentList = row.parentElement?.closest('ul');
        const parentKey = parentList ? this.parentKeyOf(row) : canonical;
        const idx = siblingsPerParent.get(parentKey) ?? 0;
        siblingsPerParent.set(parentKey, idx + 1);
        if (row.dataset.amType === 'folder') {
          this.safeEmit({
            type: 'folder-discovered',
            path: canonical,
            knownEmpty: /empty/.test(row.textContent ?? ''),
            displayOrder: idx,
          });
        } else if (!this.knownFiles.has(canonical)) {
          this.knownFiles.add(canonical);
          this.safeEmit({
            type: 'file-discovered',
            path: canonical,
            pathSource: 'exact',
            isBinaryHint: /\.(png|ico|jpg|jpeg|webp|gif|woff2?|ttf|otf)$/i.test(canonical),
            displayOrder: idx,
          });
        }
      }
    };
    discoverVisible();
    // Tree expansion renders children lazily — watch for them.
    const treeMo = new MutationObserver(() => discoverVisible());
    treeMo.observe(tree, { childList: true, subtree: true });
    this.listeners.push(() => treeMo.disconnect());

    // ---- Tree interactions: clicks tell us what the user inspected ----
    const onClick = (e: Event) => {
      const target = (e.target as Element | null)?.closest<HTMLElement>('[data-am-type]');
      if (!target) return;
      const canonical = canonicalizeRelativePath(target.dataset.amPath ?? '');
      if (!canonical) return;
      if (target.dataset.amType === 'folder') {
        this.safeEmit({ type: 'folder-inspected', path: canonical });
        // After expansion, new child rows render — give the MO a beat, but
        // also discover synchronously for already-rendered subtrees.
        setTimeout(discoverVisible, 60);
      } else {
        this.safeEmit({ type: 'file-activated', path: canonical });
      }
    };
    document.addEventListener('click', onClick, true);
    this.listeners.push(() => document.removeEventListener('click', onClick, true));

    // ---- Editor: progressive capture of the active file ----
    const editorRoot = document.querySelector<HTMLElement>('.cm-editor');
    if (editorRoot) {
      const observer = new Cm6Observer(editorRoot);
      const readNow = () => {
        if (this.paused || !this.emit) return;
        const path = this.activePath();
        if (!path) return;
        const snap = observer.read();
        if (!snap || snap.ranges.length === 0) return;
        this.emit({
          type: 'content-exposed',
          path,
          basis: 'dom-visible',
          ranges: snap.ranges,
          totalLinesHint: snap.totalLinesHint,
        });
      };
      this.monitor = new ScrollMonitor(
        { scroller: editorRoot.querySelector<HTMLElement>('.cm-scroller'), root: editorRoot },
        { onActivity: readNow, waitMs: 120 },
      );
      // Editor re-renders on file open too.
      const editorMo = new MutationObserver(debounce(readNow, 80));
      editorMo.observe(editorRoot, { childList: true, subtree: true, characterData: true });
      this.listeners.push(() => editorMo.disconnect());
      // Initial read after mount.
      setTimeout(readNow, 80);
    }

    // ---- Authorized document events (fixture's official export) ----
    const onDoc = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string }>).detail;
      const canonical = detail ? canonicalizeRelativePath(detail.path) : null;
      if (!canonical) return;
      const api = fixtureApi();
      const entry = api?.fileIndex.get(canonical);
      if (!entry || this.paused) return;
      this.safeEmit({
        type: 'document-available',
        path: canonical,
        basis: 'document-model',
        text: entry.content.join('\n'),
        totalLines: entry.lines,
        sourceLabel: 'fixture authorized export',
      });
    };
    document.addEventListener('am:document', onDoc);
    this.listeners.push(() => document.removeEventListener('am:document', onDoc));
  }

  /** Sibling-group key: the enclosing folder's path, or 'root' at top level. */
  private parentKeyOf(row: HTMLElement): string {
    const folderAncestor = row.parentElement
      ?.closest('li')
      ?.parentElement // the child <ul>
      ?.closest('li')
      ?.querySelector<HTMLElement>(':scope > .row[data-am-type="folder"]');
    const canonical = folderAncestor ? canonicalizeRelativePath(folderAncestor.dataset.amPath ?? '') : null;
    return canonical ?? 'root';
  }

  private activePath(): string | null {
    // The fixture marks the active tree row.
    const row = document.querySelector<HTMLElement>('#tree .row.active[data-am-type="file"]');
    const canonical = row ? canonicalizeRelativePath(row.dataset.amPath ?? '') : null;
    if (canonical) return canonical;
    // Fallback: active tab label.
    const tab = document.querySelector<HTMLElement>('#active-tab b');
    const fromTab = tab ? canonicalizeRelativePath(textOf(tab)) : null;
    return fromTab;
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
