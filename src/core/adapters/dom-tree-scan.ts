/**
 * Geometry-based DOM tree discovery — for platforms whose file trees use
 * custom components WITHOUT ARIA tree semantics (blink.new does).
 *
 * No invented selectors: the algorithm is structural.
 *  1. Filename-like leaves  — short, single-token text ending in an extension
 *                             (dotfiles like .env.local included).
 *  2. The tree pane         — the ancestor container holding the most such
 *                             leaves (the sidebar wins over tab bars).
 *  3. Folder rows           — sibling leaves WITHOUT an extension that share
 *                             their row-parent structure / icon / indentation
 *                             hierarchy with file rows.
 *  4. Nesting depth         — from row indentation geometry (chevron/icon/row
 *                             left offset; padding+margin fallback for headless).
 *  5. Source order          — document order of rows (displayOrder).
 *
 * Everything discovered through this scanner is marked `heuristic` upstream —
 * honest labeling per spec Part 6/16.
 */
import { deepQuerySelectorAll } from '../observers';
import { canonicalizeRelativePath } from '../identity/paths';

const FILENAME_RE = /^[A-Za-z0-9._@()[\]+#~$=,!&'-]{1,120}\.[A-Za-z0-9]{1,12}$/;
const DOTFILE_RE = /^\.[A-Za-z0-9._@+#~$=,!&'-]{1,120}$/;
const FOLDERNAME_RE = /^[A-Za-z0-9._@()[\]+#~$=,!&'-]{1,100}$/;
const CHEVRON_ONLY_RE = /^[▸▾►▼▶◀⌄›»•·+\-]$/;
const LEADING_CHEVRON_RE = /^[▸▾►▼▶◀⌄•·]\s+/;
const ICON_CLASS_RE = /icon|chevron|arrow|twist|caret|folder|dir|tree|codicon|lucide/i;
const ACTIVE_CLASS_RE = /\b(active|selected|current|is-active|is-selected)\b/i;

/** Well-known extensionless FILES (otherwise extensionless rows look like folders). */
export const KNOWN_EXTENSIONLESS_FILES = new Set([
  'dockerfile', 'makefile', 'license', 'licence', 'readme', 'procfile', 'gemfile',
  'rakefile', 'cname', 'changelog', 'authors', 'contributors', 'notice', 'codeowners',
  'jenkinsfile', 'vagrantfile', 'brewfile', 'podfile', 'justfile', 'caddyfile',
]);

/** Common IDE sidebar headers/tabs that should not be misread as empty folders. */
const NON_FOLDER_UI_LABELS = new Set([
  'files', 'explorer', 'search', 'settings', 'code', 'preview', 'terminal',
  'console', 'output', 'problems', 'ports',
]);

/**
 * Remembers ancestor paths between scans. Trees are virtualized and folders
 * collapse/scroll out of the DOM, so a single scan may only see the middle of
 * a deep branch. Without memory those rows would be rooted wrongly.
 */
export class TreeMemory {
  private byElement = new WeakMap<Element, string[]>();
  private byName = new Map<string, Set<string>>(); // name -> parent paths ('' = root)

  remember(leaf: Element, name: string, parentSegments: string[]): void {
    this.byElement.set(leaf, parentSegments);
    const set = this.byName.get(name) ?? new Set<string>();
    set.add(parentSegments.join('/'));
    this.byName.set(name, set);
  }

  recall(leaf: Element, name: string): string[] | null {
    const direct = this.byElement.get(leaf);
    if (direct) return direct;
    const set = this.byName.get(name);
    if (set && set.size === 1) {
      const only = [...set][0]!;
      return only === '' ? [] : only.split('/');
    }
    return null;
  }
}

export function filenameLike(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 120 || /\s/.test(t) || t.includes('/') || t.includes('›')) return false;
  if (DOTFILE_RE.test(t)) return true;
  return FILENAME_RE.test(t);
}

function isDecorativeChild(child: Element): boolean {
  const tag = child.tagName.toLowerCase();
  if (tag === 'svg' || tag === 'i' || tag === 'img' || tag === 'br' || tag === 'path' || child.querySelector('svg')) {
    return true;
  }
  const childText = (child.textContent ?? '').trim();
  return childText === '' || CHEVRON_ONLY_RE.test(childText);
}

/** A leaf-text element: carries text itself, only icon-ish / decorative element children. */
function isLeafText(el: Element): boolean {
  let hasText = false;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.nodeValue ?? '').trim().length > 0) hasText = true;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (isDecorativeChild(node as Element)) continue;
      return false; // real element child → not a leaf
    }
  }
  return hasText;
}

/** Extract the label text owned by `el`, skipping decorative icon/chevron children. */
function ownLabelText(el: Element): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? '';
    }
  }
  return out.trim().replace(LEADING_CHEVRON_RE, '').trim();
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    // No layout information (headless environments, or genuinely unfloated):
    // accept unless explicitly hidden — layout engines give real rects.
    return !(el instanceof HTMLElement && getComputedStyle(el).display === 'none');
  }
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.height > 44) return false; // rows are compact
  return true;
}

function findRowContainer(el: HTMLElement, pane: Element): HTMLElement {
  let row: HTMLElement = el;
  for (let i = 0; i < 3; i++) {
    const p = row.parentElement;
    if (!p || p === pane || !pane.contains(p)) break;
    const pr = p.getBoundingClientRect();
    if (pr.height > 48) break;
    row = p;
  }
  return row;
}

function explicitRowPath(el: HTMLElement, pane: Element): string | null {
  const attrs = ['data-path', 'data-file-path', 'data-filepath', 'data-am-path'];
  let cur: HTMLElement | null = el;
  for (let i = 0; i < 4 && cur && cur !== pane; i++, cur = cur.parentElement) {
    for (const attr of attrs) {
      const val = cur.getAttribute(attr);
      if (val) {
        const canonical = canonicalizeRelativePath(val);
        if (canonical) return canonical;
      }
    }
  }
  return null;
}

function hasFolderCue(el: HTMLElement, pane: Element): boolean {
  let cur: HTMLElement | null = el;
  for (let i = 0; i <= 2 && cur && cur !== pane; i++, cur = cur.parentElement) {
    if (cur.hasAttribute('aria-expanded')) return true;
    const cls = typeof cur.className === 'string' ? cur.className : '';
    if (ICON_CLASS_RE.test(cls)) return true;
    if (cur.querySelector('svg, img, i')) return true;
    for (const child of Array.from(cur.children)) {
      const ccls = typeof child.className === 'string' ? child.className : '';
      if (ICON_CLASS_RE.test(ccls)) return true;
    }
  }
  return false;
}

export interface TreeRow {
  name: string;
  path: string;
  isFolder: boolean;
  /** Document order within the pane — the source's sibling order. */
  displayOrder: number;
  /** The row-ish element (for click delegation). */
  element: HTMLElement;
  depth: number;
}

/**
 * Scan the page for a file-tree-like pane and return rows with derived paths.
 * Empty array when nothing tree-like exists (honest null result).
 */
export function scanGeometryTree(root: ParentNode = document, memory?: TreeMemory): TreeRow[] {
  // 1. Filename-like leaves anywhere (deep, incl. shadow roots).
  const fileLeaves: HTMLElement[] = [];
  for (const el of deepQuerySelectorAll('*', root)) {
    if (!isLeafText(el)) continue;
    if (!filenameLike(ownLabelText(el))) continue;
    fileLeaves.push(el);
  }
  if (fileLeaves.length < 2) return [];

  // 2. The pane: ancestor holding the most filename-like leaves.
  const counts = new Map<Element, number>();
  for (const leaf of fileLeaves) {
    let el: Element | null = leaf;
    for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
      counts.set(el, (counts.get(el) ?? 0) + 1);
    }
  }
  let pane: Element | null = null;
  let best = 0;
  for (const [el, c] of counts) {
    if (c > best) {
      best = c;
      pane = el;
    }
  }
  if (!pane || best < 2) return [];

  const inPane = (el: Element): boolean => pane!.contains(el);

  // 3. Row classification. File leaves first; their parent structure defines
  //    what a row-parent looks like for folder candidates.
  const parentKey = (el: Element): string => {
    const p = el.parentElement;
    if (!p) return '';
    return `${p.tagName}|${typeof p.className === 'string' ? p.className : ''}`;
  };
  const fileParentKeys = new Set(fileLeaves.filter(inPane).map(parentKey));

  interface RawRow {
    leaf: HTMLElement;
    rowEl: HTMLElement;
    name: string;
    isFolder: boolean;
    metric: number;
    deferred: boolean;
  }
  const rawRows: RawRow[] = [];

  const metricOf = (el: HTMLElement): number => {
    const rowEl = findRowContainer(el, pane!);
    const elRect = el.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();

    if (elRect.width === 0 && elRect.height === 0 && rowRect.width === 0 && rowRect.height === 0) {
      // Headless environment: sum paddingLeft + marginLeft up to 4 ancestors inside pane.
      let total = 0;
      let cur: HTMLElement | null = el;
      for (let i = 0; i < 4 && cur && cur !== pane; i++, cur = cur.parentElement) {
        const cs = getComputedStyle(cur);
        const pl = parseFloat(cs.paddingLeft);
        const ml = parseFloat(cs.marginLeft);
        if (Number.isFinite(pl) && pl > 0) total += pl;
        if (Number.isFinite(ml) && ml > 0) total += ml;
      }
      return total;
    }

    // Visual layout: measure the leftmost visible icon/chevron/label token inside the row,
    // so extra icons on folders (chevron + folder icon vs file icon) do not shift depth.
    let minLeft = elRect.width > 0 ? elRect.left : Infinity;
    for (const child of Array.from(rowEl.querySelectorAll<HTMLElement>('*'))) {
      if (child === el) break;
      const cr = child.getBoundingClientRect();
      if (cr.width <= 0 || cr.height <= 0 || cr.height > 44) continue;
      const tag = child.tagName.toLowerCase();
      const cls = typeof child.className === 'string' ? child.className : '';
      const isVisualIcon =
        tag === 'svg' ||
        tag === 'img' ||
        tag === 'i' ||
        (child.children.length === 0 && (ICON_CLASS_RE.test(cls) || CHEVRON_ONLY_RE.test((child.textContent ?? '').trim())));
      if (isVisualIcon && cr.left < minLeft) {
        minLeft = cr.left;
        break;
      }
    }
    if (Number.isFinite(minLeft)) return minLeft;
    if (rowRect.width > 0) {
      const pl = parseFloat(getComputedStyle(rowEl).paddingLeft) || 0;
      return rowRect.left + pl;
    }
    return 0;
  };

  const seenLeaves = new Set<HTMLElement>();
  for (const leaf of fileLeaves) {
    if (!inPane(leaf) || !isVisible(leaf)) continue;
    seenLeaves.add(leaf);
    rawRows.push({
      leaf,
      rowEl: findRowContainer(leaf, pane),
      name: ownLabelText(leaf),
      isFolder: false,
      metric: metricOf(leaf),
      deferred: false,
    });
  }

  // Folder candidates & extensionless files in the pane.
  for (const el of deepQuerySelectorAll('*', pane)) {
    if (seenLeaves.has(el) || !isLeafText(el) || !isVisible(el)) continue;
    const name = ownLabelText(el);
    if (!FOLDERNAME_RE.test(name) || filenameLike(name)) continue;
    if (name.length < 1) continue;
    if (KNOWN_EXTENSIONLESS_FILES.has(name.toLowerCase())) {
      rawRows.push({
        leaf: el,
        rowEl: findRowContainer(el, pane),
        name,
        isFolder: false,
        metric: metricOf(el),
        deferred: false,
      });
      continue;
    }
    const key = parentKey(el);
    const parentOk =
      fileParentKeys.has(key) ||
      fileParentKeys.has(
        (() => {
          const gp = el.parentElement?.parentElement;
          return gp ? `${gp.tagName}|${typeof gp.className === 'string' ? gp.className : ''}` : '';
        })(),
      );
    const hasIcon = Boolean(
      el.parentElement?.querySelector('svg, img, i') || el.parentElement?.parentElement?.querySelector('svg, img, i'),
    );
    const cue = hasFolderCue(el, pane);
    const isToolbarNoise =
      NON_FOLDER_UI_LABELS.has(name.toLowerCase()) && (name === name.toUpperCase() || (!parentOk && !hasIcon));
    if (isToolbarNoise) continue;

    if ((parentOk && (hasIcon || cue)) || cue) {
      rawRows.push({
        leaf: el,
        rowEl: findRowContainer(el, pane),
        name,
        isFolder: true,
        metric: metricOf(el),
        deferred: false,
      });
    } else if (!NON_FOLDER_UI_LABELS.has(name.toLowerCase())) {
      // May still be an iconless folder if the following row is indented deeper.
      rawRows.push({
        leaf: el,
        rowEl: findRowContainer(el, pane),
        name,
        isFolder: true,
        metric: metricOf(el),
        deferred: true,
      });
    }
  }

  // Sort in DOCUMENT order first so deferred folder promotion can inspect the next row.
  rawRows.sort((a, b) => {
    const pos = a.leaf.compareDocumentPosition(b.leaf);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  const filteredRows: RawRow[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const cur = rawRows[i]!;
    if (cur.deferred) {
      const next = rawRows[i + 1];
      if (!next || next.metric <= cur.metric + 3) continue;
    }
    filteredRows.push(cur);
  }

  if (filteredRows.length < 2) return [];

  // 4. Depth classes from the indentation metric (with 3px clustering tolerance).
  const sorted = filteredRows.map((r) => r.metric).sort((a, b) => a - b);
  const clusters: number[] = [];
  for (const m of sorted) {
    if (clusters.length === 0 || m - clusters[clusters.length - 1]! > 3) clusters.push(m);
  }
  const depthOf = (m: number): number => {
    let bestIdx = 0;
    for (let i = 0; i < clusters.length; i++) {
      if (Math.abs(clusters[i]! - m) <= Math.abs(clusters[bestIdx]! - m)) bestIdx = i;
    }
    return bestIdx;
  };

  // A "file" row followed by a deeper row is really a folder (e.g. `next.js/`).
  for (let i = 0; i < filteredRows.length - 1; i++) {
    const cur = filteredRows[i]!;
    if (!cur.isFolder && depthOf(filteredRows[i + 1]!.metric) > depthOf(cur.metric)) cur.isFolder = true;
  }

  // 5. Build paths in document order with an indent stack + TreeMemory.
  const rows: TreeRow[] = [];
  const stack: { depth: number; name: string }[] = [];
  filteredRows.forEach((r, index) => {
    const depth = depthOf(r.metric);
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    // Ancestors scrolled out / unmounted: recover them from earlier scans.
    if (depth > 0 && stack.length === 0 && memory) {
      const known = memory.recall(r.leaf, r.name);
      if (known && known.length > 0) {
        known.forEach((seg, i) => stack.push({ depth: depth - known.length + i, name: seg }));
      }
    }
    const explicit = explicitRowPath(r.leaf, pane!);
    const parentSegs = stack.map((s) => s.name);
    const path = explicit ?? (parentSegs.length ? `${parentSegs.join('/')}/${r.name}` : r.name);
    memory?.remember(r.leaf, r.name, explicit ? explicit.split('/').slice(0, -1) : parentSegs);
    if (r.isFolder) stack.push({ depth, name: r.name });
    rows.push({
      name: r.name,
      path,
      isFolder: r.isFolder,
      displayOrder: index,
      element: r.rowEl,
      depth,
    });
  });
  return rows;
}

/**
 * Find the currently highlighted/selected file row in a discovered geometry tree.
 */
export function findSelectedTreeRowPath(rows: TreeRow[]): string | null {
  const isMarkedActive = (el: Element | null): boolean => {
    if (!el) return false;
    if (el.getAttribute('aria-selected') === 'true') return true;
    const current = el.getAttribute('aria-current');
    if (current === 'page' || current === 'true') return true;
    if (el.getAttribute('data-selected') === 'true' || el.getAttribute('data-active') === 'true') return true;
    const state = el.getAttribute('data-state');
    if (state === 'active' || state === 'selected') return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    return ACTIVE_CLASS_RE.test(cls);
  };

  for (const r of rows) {
    if (r.isFolder) continue;
    if (isMarkedActive(r.element) || isMarkedActive(r.element.parentElement)) {
      return r.path;
    }
    for (const child of Array.from(r.element.children)) {
      if (isMarkedActive(child)) return r.path;
    }
  }
  return null;
}

/**
 * Active-file path from a breadcrumb near the editor, e.g.
 * "scripts › finalize-static-build.mjs" or "src / pages / App.tsx".
 * Works on composed breadcrumbs (segment spans) via container textContent.
 */
function parseBreadcrumbCandidate(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > 220) return null;
  if (text.includes('://')) return null;
  if (!/[›»/>]/.test(text)) return null;
  const parts = text.split(/\s*[›»/>]\s*/).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1]!;
  if (!filenameLike(last) && !KNOWN_EXTENSIONLESS_FILES.has(last.toLowerCase())) return null;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!FOLDERNAME_RE.test(parts[i]!)) return null;
  }
  return canonicalizeRelativePath(parts.join('/'));
}

export function findBreadcrumbPath(root: ParentNode = document): string | null {
  let best: string | null = null;
  for (const el of deepQuerySelectorAll('*', root)) {
    if (el.closest('.cm-editor, .monaco-editor, .CodeMirror, pre, code, script, style, #asset-miner-host')) {
      continue;
    }
    if (!isLeafText(el) && el.children.length === 0) continue;
    const text = el.textContent ?? '';
    const candidate = parseBreadcrumbCandidate(text);
    if (!candidate) continue;
    // Deepest match wins: skip containers whose child also matches.
    const childMatched = Array.from(el.children).some((c) => parseBreadcrumbCandidate(c.textContent ?? '') !== null);
    if (childMatched) continue;
    best = candidate;
  }
  return best;
}
