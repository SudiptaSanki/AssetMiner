/**
 * Generic editor adapter — best-effort capture on websites without a dedicated
 * adapter (spec Part 10: unsupported sites keep generic capability).
 *
 * Discovery & capture capabilities:
 *  1. ARIA trees (role=tree/treeitem + aria-level) — semantic, preferred.
 *  2. GEOMETRY tree scan (dom-tree-scan.ts) — structural, for platforms with
 *     custom components and no ARIA semantics. Remembers scrolled-out parents.
 *  3. Dynamic editor binding (findBestEditorObserver) — re-evaluates on file
 *     switches, clicks, mutations, and periodic ticks so changing tabs/files
 *     never leaves a stale observer.
 *  4. MAIN-world page bridge (__assetMinerBridge) — receives full in-memory
 *     documents from Monaco / CodeMirror 6 / CodeMirror 5 / Ace when available.
 *  5. Binary / SVG preview capture — captures visible logos/images when a
 *     binary/vector file is active in the tree.
 *
 * Active-file identity, in priority order (reconciled against tree paths):
 *  a. breadcrumb near the editor ("scripts › finalize-static-build.mjs")
 *  b. highlighted / selected row in the file tree
 *  c. the file row clicked in the discovered tree (10m recency)
 *  d. active file tab ([role=tab][aria-selected=true], .tab.active, etc.)
 *  e. sticky fallback
 */
import type { DiscoveryEvent } from '../../shared/types';
import type { AdapterLiveStatus, AdapterStartOptions, PlatformAdapter } from './types';
import { deepDetectEditorObserver, findBestEditorObserver } from '../observers';
import { ScrollMonitor } from '../capture/ScrollMonitor';
import { baseName, canonicalizeRelativePath, extensionOf } from '../identity/paths';
import { pathFromEditorUri, reconcilePath } from '../identity/reconcile';
import { debounce, mimeFromExtension, splitLines } from '../../shared/utils';
import {
  filenameLike,
  findBreadcrumbPath,
  findSelectedTreeRowPath,
  KNOWN_EXTENSIONLESS_FILES,
  scanGeometryTree,
  TreeMemory,
  type TreeRow,
} from './dom-tree-scan';
import { scanAriaTree } from './dom-tree-scan-aria';

const FALLBACK_PROJECT = 'active-editor';
const TREE_CLICK_RECENCY_MS = 10 * 60_000;
const IMAGE_BINARY_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'bmp', 'avif']);

interface BridgeDocMessage {
  kind: string;
  key: string;
  uri: string;
  path: string;
  area: number;
  same: boolean;
  text: string | null;
}

export class GenericEditorAdapter implements PlatformAdapter {
  readonly id = 'generic-editor';
  readonly displayName = FALLBACK_PROJECT;
  readonly notes =
    'Generic editor support (CodeMirror 6, Monaco, CodeMirror 5, Ace, plain code blocks). Discovers file trees via ARIA semantics or geometry scanning, reads full editor documents via page bridge when exposed, and captures scrolled ranges & image previews.';

  private emit: ((ev: DiscoveryEvent) => void) | null = null;
  private monitor: ScrollMonitor | null = null;
  private boundRoot: HTMLElement | null = null;
  private boundScroller: HTMLElement | null = null;
  private listeners: (() => void)[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private paused = false;
  private started = false;
  private lastPath: string | null = null;
  private geoRows: TreeRow[] = [];
  private treeMemory = new TreeMemory();
  private lastTreeClick: { path: string; at: number } | null = null;

  private knownFilePaths = new Set<string>();
  private knownFolderPaths = new Set<string>();
  private emittedFolders = new Set<string>();
  private emittedInspected = new Set<string>();
  private emittedFiles = new Map<string, number>();

  private bridgeActive = false;
  private bridgeTextCache = new Map<string, string>();
  private lastBridgeEmittedText = new Map<string, string>();
  private lastVisibleDocText: string | null = null;
  private lastDomSigByPath = new Map<string, { sig: string; count: number }>();
  private capturedPreviewPaths = new Set<string>();

  /** True once an editor observer was actually bound (for the watchdog). */
  hasEditor = false;

  detect(): boolean {
    return (
      deepDetectEditorObserver(document) !== null ||
      scanAriaTree(document).length > 0 ||
      scanGeometryTree(document).length > 0
    );
  }

  start(opts: AdapterStartOptions): void {
    if (this.started) return;
    this.started = true;
    this.emit = opts.emit;
    this.emit({
      type: 'project-detected',
      name: FALLBACK_PROJECT,
      origin: location.origin,
      adapterId: this.id,
    });

    const emitAncestorsInspected = (canonicalPath: string) => {
      const parts = canonicalPath.split('/');
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join('/');
        if (!this.emittedInspected.has(ancestor)) {
          this.emittedInspected.add(ancestor);
          this.knownFolderPaths.add(ancestor);
          this.safeEmit({ type: 'folder-inspected', path: ancestor });
        }
      }
    };

    // ---- Tree discovery: ARIA (semantic) + geometry (structural) ----
    const scanTree = () => {
      for (const item of scanAriaTree(document)) {
        const canonical = canonicalizeRelativePath(item.path);
        if (!canonical) continue;
        emitAncestorsInspected(canonical);
        if (item.isFolder) {
          this.knownFolderPaths.add(canonical);
          if (!this.emittedFolders.has(canonical)) {
            this.emittedFolders.add(canonical);
            this.safeEmit({ type: 'folder-discovered', path: canonical, knownEmpty: false, displayOrder: item.displayOrder });
          }
          if (item.expanded && !this.emittedInspected.has(canonical)) {
            this.emittedInspected.add(canonical);
            this.safeEmit({ type: 'folder-inspected', path: canonical });
          }
        } else {
          this.knownFilePaths.add(canonical);
          const prevOrder = this.emittedFiles.get(canonical);
          if (prevOrder === undefined || prevOrder !== item.displayOrder) {
            this.emittedFiles.set(canonical, item.displayOrder);
            this.safeEmit({
              type: 'file-discovered',
              path: canonical,
              pathSource: 'heuristic',
              isBinaryHint: false,
              displayOrder: item.displayOrder,
            });
          }
        }
      }

      this.geoRows = scanGeometryTree(document, this.treeMemory);
      for (const row of this.geoRows) {
        const canonical = canonicalizeRelativePath(row.path);
        if (!canonical) continue;
        emitAncestorsInspected(canonical);
        if (row.isFolder) {
          this.knownFolderPaths.add(canonical);
          if (!this.emittedFolders.has(canonical)) {
            this.emittedFolders.add(canonical);
            this.safeEmit({ type: 'folder-discovered', path: canonical, knownEmpty: false, displayOrder: row.displayOrder });
          }
        } else {
          this.knownFilePaths.add(canonical);
          const prevOrder = this.emittedFiles.get(canonical);
          if (prevOrder === undefined || prevOrder !== row.displayOrder) {
            this.emittedFiles.set(canonical, row.displayOrder);
            this.safeEmit({
              type: 'file-discovered',
              path: canonical,
              pathSource: 'heuristic',
              isBinaryHint: false,
              displayOrder: row.displayOrder,
            });
          }
        }
      }
    };
    scanTree();
    const treeMo = new MutationObserver(debounce(scanTree, 150));
    const treeRoot = document.querySelector('[role="tree"]') ?? document.body;
    if (treeRoot) treeMo.observe(treeRoot, { childList: true, subtree: true });
    this.listeners.push(() => treeMo.disconnect());

    const onScroll = debounce(scanTree, 150);
    document.addEventListener('scroll', onScroll, true);
    this.listeners.push(() => document.removeEventListener('scroll', onScroll, true));

    // ---- Dynamic editor reading + ScrollMonitor rebinding ----
    const readNow = (forceEmit = false) => {
      if (this.paused || !this.emit) return;
      const observer = findBestEditorObserver(document) ?? deepDetectEditorObserver(document);
      if (!observer) {
        const active = this.resolveActivePath();
        if (active && active !== 'active-file/untitled') {
          void this.tryCapturePreviewAsset(active);
        }
        return;
      }

      this.hasEditor = true;
      const snap = observer.read();
      if (!snap || snap.ranges.length === 0) {
        const active = this.resolveActivePath();
        if (active && active !== 'active-file/untitled') {
          void this.tryCapturePreviewAsset(active);
        }
        return;
      }

      if (snap.root !== this.boundRoot || snap.scroller !== this.boundScroller) {
        this.monitor?.stop();
        this.boundRoot = snap.root;
        this.boundScroller = snap.scroller;
        this.monitor = new ScrollMonitor(
          { scroller: snap.scroller, root: snap.root },
          { onActivity: () => readNow(true), waitMs: 150 },
        );
      }

      const path = this.resolveActivePath();
      const fileChanged = path !== this.lastPath;
      if (fileChanged) {
        if (this.lastPath) this.safeEmit({ type: 'file-closed', path: this.lastPath });
        this.lastPath = path;
        this.safeEmit({ type: 'file-activated', path });
        // Schedule follow-up reads so short files (no scrollbar) auto-verify in 2 observations.
        this.scheduleFollowUps(() => readNow(true));
      }

      const sig = `${snap.totalLinesHint ?? 'n'}:${snap.ranges.map((r) => `${r.startLine}-${r.endLine}:${r.lines.join('\n').length}`).join('|')}`;
      const prev = this.lastDomSigByPath.get(path);
      if (!forceEmit && prev && prev.sig === sig && prev.count >= 2) {
        return;
      }
      if (prev && prev.sig === sig) {
        prev.count += 1;
      } else {
        this.lastDomSigByPath.set(path, { sig, count: 1 });
      }

      this.emit({
        type: 'content-exposed',
        path,
        basis: 'dom-visible',
        ranges: snap.ranges,
        totalLinesHint: snap.totalLinesHint,
      });
    };

    // ---- Tree clicks: the user inspected a folder / opened a file ----
    const onClick = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (target.closest('#asset-miner-host')) return;

      let matched = false;
      const ariaItem = target.closest<HTMLElement>('[role="treeitem"]');
      if (ariaItem) {
        const label = (ariaItem.getAttribute('aria-label') || ariaItem.textContent || '').trim().split('\n')[0]!;
        for (const item of scanAriaTree(document)) {
          if (item.path.split('/').pop() !== label) continue;
          const canonical = canonicalizeRelativePath(item.path);
          if (!canonical) continue;
          if (item.isFolder) this.safeEmit({ type: 'folder-inspected', path: canonical });
          else {
            this.safeEmit({ type: 'file-activated', path: canonical });
            this.lastTreeClick = { path: canonical, at: Date.now() };
            void this.tryCapturePreviewAsset(canonical, true);
          }
          matched = true;
          break;
        }
      }

      if (!matched) {
        for (const row of this.geoRows) {
          if (row.element === target || row.element.contains(target)) {
            const canonical = canonicalizeRelativePath(row.path);
            if (!canonical) continue;
            if (row.isFolder) {
              this.safeEmit({ type: 'folder-inspected', path: canonical });
            } else {
              this.safeEmit({ type: 'file-activated', path: canonical });
              this.lastTreeClick = { path: canonical, at: Date.now() };
              void this.tryCapturePreviewAsset(canonical, true);
            }
            matched = true;
            break;
          }
        }
      }

      // Re-scan tree & editor shortly after any page click (handles tab/file switching).
      this.scheduleTimer(() => {
        scanTree();
        readNow(true);
      }, 100);
      this.scheduleTimer(() => {
        scanTree();
        readNow(true);
      }, 650);
    };
    document.addEventListener('click', onClick, true);
    this.listeners.push(() => document.removeEventListener('click', onClick, true));

    // ---- MAIN-world page bridge listener ----
    const onMessage = (ev: MessageEvent) => {
      if (this.paused || !this.emit) return;
      if (ev.source !== window || !ev.data || ev.data.source !== '__assetMinerBridge' || ev.data.type !== 'docs') {
        return;
      }
      const docs = Array.isArray(ev.data.docs) ? (ev.data.docs as BridgeDocMessage[]) : [];
      if (docs.length === 0) return;
      this.bridgeActive = true;

      let bestDoc: { doc: BridgeDocMessage; text: string } | null = null;
      for (const doc of docs) {
        const text = !doc.same && typeof doc.text === 'string' ? doc.text : this.bridgeTextCache.get(doc.key);
        if (typeof text !== 'string') continue;
        if (!doc.same && typeof doc.text === 'string') {
          this.bridgeTextCache.set(doc.key, doc.text);
        }
        if (doc.area > 0 && (!bestDoc || doc.area > bestDoc.doc.area)) {
          bestDoc = { doc, text };
        }

        // Known Monaco/URI-backed models can be attributed directly when reconciled.
        if (doc.path || doc.uri) {
          const candidate = pathFromEditorUri(doc.path || doc.uri);
          if (candidate) {
            const matched = reconcilePath(candidate, this.knownFilePaths, {
              prefer: this.lastTreeClick?.path ?? this.lastPath,
            });
            if (matched && this.knownFilePaths.has(matched)) {
              if (this.lastBridgeEmittedText.get(matched) !== text) {
                this.lastBridgeEmittedText.set(matched, text);
                this.safeEmit({
                  type: 'document-available',
                  path: matched,
                  basis: 'document-model',
                  text,
                  totalLines: splitLines(text).length,
                  sourceLabel: `${doc.kind} page editor`,
                });
              }
            }
          }
        }
      }

      if (bestDoc) {
        const active = this.resolveActivePath();
        if (active && active !== 'active-file/untitled') {
          const activeBase = baseName(active);
          const docUri = bestDoc.doc.path || bestDoc.doc.uri;
          const uriCandidate = docUri ? pathFromEditorUri(docUri) : null;
          const uriConflict = Boolean(uriCandidate && baseName(uriCandidate) !== activeBase);
          const clickAge = this.lastTreeClick ? Date.now() - this.lastTreeClick.at : Infinity;
          const staleClickBuffer =
            active !== this.lastPath &&
            bestDoc.text === this.lastVisibleDocText &&
            bestDoc.text.length > 0 &&
            clickAge < 1200;

          if (!uriConflict && !staleClickBuffer && this.lastBridgeEmittedText.get(active) !== bestDoc.text) {
            if (active !== this.lastPath) {
              if (this.lastPath) this.safeEmit({ type: 'file-closed', path: this.lastPath });
              this.lastPath = active;
              this.safeEmit({ type: 'file-activated', path: active });
            }
            this.lastVisibleDocText = bestDoc.text;
            this.lastBridgeEmittedText.set(active, bestDoc.text);
            this.safeEmit({
              type: 'document-available',
              path: active,
              basis: 'document-model',
              text: bestDoc.text,
              totalLines: splitLines(bestDoc.text).length,
              sourceLabel: `${bestDoc.doc.kind} page editor`,
            });
          } else {
            this.lastVisibleDocText = bestDoc.text;
          }
        }
      }
    };
    window.addEventListener('message', onMessage);
    this.listeners.push(() => window.removeEventListener('message', onMessage));
    window.postMessage({ source: '__assetMinerContent', type: 'resend' }, '*');

    // ---- Initial read + lightweight heartbeat for late-mounting editors ----
    this.scheduleTimer(() => readNow(true), 120);
    const heartbeat = setInterval(() => {
      if (!this.paused) readNow(false);
    }, 900);
    this.listeners.push(() => clearInterval(heartbeat));
  }

  liveStatus(): AdapterLiveStatus {
    const active = this.resolveActivePath();
    const activePath = active && active !== 'active-file/untitled' ? active : null;
    let hint: string | null = null;
    if (this.geoRows.length === 0 && this.knownFilePaths.size === 0) {
      hint = 'Expand folders in the file tree on the website so Asset Miner can see the structure.';
    } else if (!this.hasEditor && !this.bridgeActive) {
      hint = 'Click a file on the website to open its code editor or preview.';
    } else if (!activePath) {
      hint = 'Editor detected, but the file path is unclear — click the file in the tree or select it in Project Explorer.';
    }
    return {
      activePath,
      editorFound: this.hasEditor || this.bridgeActive,
      fullTextAvailable: this.bridgeActive,
      treeRows: this.knownFilePaths.size + this.knownFolderPaths.size,
      hint,
    };
  }

  /**
   * Active-file identity, by descending confidence, reconciled against known tree paths:
   * breadcrumb → highlighted tree row → recent tree click → active tab → sticky fallback.
   */
  private resolveActivePath(): string {
    const prefer =
      this.lastTreeClick && Date.now() - this.lastTreeClick.at < TREE_CLICK_RECENCY_MS
        ? this.lastTreeClick.path
        : this.lastPath;

    const crumb = findBreadcrumbPath();
    if (crumb) {
      const reconciled = reconcilePath(crumb, this.knownFilePaths, { prefer });
      if (reconciled) return reconciled;
    }

    const selectedRow = findSelectedTreeRowPath(this.geoRows) ?? this.findSelectedAriaPath();
    if (selectedRow) {
      const reconciled = reconcilePath(selectedRow, this.knownFilePaths, { prefer });
      if (reconciled) return reconciled;
    }

    if (this.lastTreeClick && Date.now() - this.lastTreeClick.at < TREE_CLICK_RECENCY_MS) {
      return this.lastTreeClick.path;
    }

    const labelEl =
      document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
      document.querySelector<HTMLElement>('[role="tab"][data-state="active"]') ??
      document.querySelector<HTMLElement>('tab.active, .tab.active, .active-tab, .file-tab.active');
    if (labelEl && !labelEl.closest('#asset-miner-host')) {
      const rawLabel = (
        labelEl.getAttribute('aria-label') ||
        labelEl.getAttribute('title') ||
        labelEl.textContent ||
        ''
      )
        .trim()
        .split('\n')[0]!
        .replace(/\s*[×✕●•]\s*$/, '')
        .trim();
      if (rawLabel.length > 0 && rawLabel.length < 200) {
        const reconciled = reconcilePath(rawLabel, this.knownFilePaths, { prefer });
        if (reconciled && (this.knownFilePaths.has(reconciled) || filenameLike(baseName(reconciled)) || KNOWN_EXTENSIONLESS_FILES.has(baseName(reconciled).toLowerCase()))) {
          return reconciled;
        }
      }
    }
    return this.lastPath ?? 'active-file/untitled';
  }

  private findSelectedAriaPath(): string | null {
    const selected = document.querySelector<HTMLElement>('[role="tree"] [role="treeitem"][aria-selected="true"]');
    if (!selected) return null;
    const label = (selected.getAttribute('aria-label') || selected.textContent || '').trim().split('\n')[0]!.trim();
    if (!label) return null;
    for (const item of scanAriaTree(document)) {
      if (!item.isFolder && item.path.split('/').pop() === label) {
        return canonicalizeRelativePath(item.path);
      }
    }
    return null;
  }

  private async tryCapturePreviewAsset(path: string, force = false): Promise<void> {
    if (this.paused || !this.emit) return;
    const ext = extensionOf(path);
    const isSvg = ext === 'svg';
    const isBinaryImg = IMAGE_BINARY_EXTS.has(ext);
    if (!isSvg && !isBinaryImg) return;
    if (!force && this.capturedPreviewPaths.has(path)) return;

    const treePane = this.geoRows[0]?.element.closest('nav, aside, [role="tree"]') ?? null;
    const inWorkspace = (el: Element): boolean => {
      if (el.closest('#asset-miner-host, [role="tree"]')) return false;
      if (treePane && treePane.contains(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 16 && r.height >= 16;
    };

    if (isSvg) {
      // Only capture SVG preview as file source if no code editor is visible.
      if (findBestEditorObserver(document) !== null) return;
      const svgs = Array.from(document.querySelectorAll('svg')).filter(inWorkspace);
      svgs.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      });
      const svg = svgs[0];
      if (!svg) return;
      try {
        const xml = new XMLSerializer().serializeToString(svg);
        if (!xml || xml.length > 500_000) return;
        this.capturedPreviewPaths.add(path);
        this.safeEmit({
          type: 'document-available',
          path,
          basis: 'document-model',
          text: xml,
          totalLines: splitLines(xml).length,
          sourceLabel: 'svg-preview',
        });
      } catch {
        /* serialization failed */
      }
      return;
    }

    // Binary image preview capture.
    const imgs = Array.from(document.querySelectorAll('img')).filter(inWorkspace);
    if (imgs.length === 0) return;
    const fname = baseName(path).toLowerCase();
    const byName = imgs.find((img) => (img.currentSrc || img.src || '').toLowerCase().includes(fname));
    const targetImg =
      byName ??
      imgs.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      })[0];
    if (!targetImg) return;

    const src = targetImg.currentSrc || targetImg.src;
    if (!src) return;
    const extracted = await readImageAsBase64(targetImg, src, mimeFromExtension(ext));
    if (!extracted) return;
    this.capturedPreviewPaths.add(path);
    this.safeEmit({
      type: 'binary-available',
      path,
      base64: extracted.base64,
      byteSize: extracted.byteSize,
      mimeType: extracted.mimeType,
    });
  }

  private scheduleTimer(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      if (!this.started) return;
      fn();
    }, ms);
    this.timers.push(id);
  }

  private scheduleFollowUps(fn: () => void): void {
    this.scheduleTimer(fn, 120);
    this.scheduleTimer(fn, 350);
    this.scheduleTimer(fn, 700);
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
    this.boundRoot = null;
    this.boundScroller = null;
    for (const id of this.timers.splice(0)) clearTimeout(id);
    for (const off of this.listeners.splice(0)) off();
    this.emit = null;
  }

  private safeEmit(ev: DiscoveryEvent): void {
    if (this.emit && !this.paused) this.emit(ev);
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    out += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

async function readImageAsBase64(
  img: HTMLImageElement,
  src: string,
  fallbackMime: string,
): Promise<{ base64: string; byteSize: number; mimeType: string } | null> {
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',');
    if (comma < 0) return null;
    const header = src.slice(5, comma);
    const mime = header.split(';')[0] || fallbackMime;
    const body = src.slice(comma + 1);
    const base64 = header.includes(';base64') ? body : btoa(unescape(encodeURIComponent(decodeURIComponent(body))));
    return { base64, byteSize: Math.round((base64.length * 3) / 4), mimeType: mime };
  }

  try {
    const u = new URL(src, location.href);
    if (u.protocol === 'blob:' || u.origin === location.origin) {
      const res = await fetch(u.href, { credentials: 'omit' });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const mimeType = res.headers.get('content-type')?.split(';')[0] || fallbackMime;
        return { base64: arrayBufferToBase64(buf), byteSize: buf.byteLength, mimeType };
      }
    }
  } catch {
    /* fall through to canvas fallback */
  }

  // Fallback for already-rendered images via canvas snapshot.
  try {
    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];
        if (base64) {
          return { base64, byteSize: Math.round((base64.length * 3) / 4), mimeType: 'image/png' };
        }
      }
    }
  } catch {
    /* tainted canvas — cannot read */
  }
  return null;
}
