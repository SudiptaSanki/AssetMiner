/**
 * Editor observers — read visible source ranges from known editor DOMs
 * (spec Part 5.4). Detection order: CodeMirror 6 → Monaco → CodeMirror 5 →
 * plain <pre>/<textarea>.
 *
 * Principles:
 *  - Line numbers come from gutter elements / aria metadata when available —
 *    never from DOM order alone when line identity matters.
 *  - Text extraction walks text nodes (spans, syntax highlights).
 *  - Total-line hints are only reported when they can be derived from layout
 *    geometry (virtualization spacers), and are marked layout-derived upstream.
 *    Scroll position is NEVER used to infer completeness.
 */
import type { RawRange } from '../../shared/types';

export type EditorKind = 'cm6' | 'monaco' | 'cm5' | 'plain';

/** Id of Asset Miner's own panel host element - always excluded from page scans. */
export const PANEL_HOST_ID = 'asset-miner-host';

export interface EditorSnapshot {
  editorKind: EditorKind;
  ranges: RawRange[];
  /** Exact or layout-derived total line count when computable; else null. */
  totalLinesHint: number | null;
  /** The scroller element the user scrolls (for the ScrollMonitor). */
  scroller: HTMLElement | null;
  /** The editor root element (for MutationObserver anchoring). */
  root: HTMLElement;
}

export interface EditorObserver {
  readonly kind: EditorKind;
  read(): EditorSnapshot | null;
}

/** Concatenate all text-node content of an element (no innerText layout deps). */
export function textOf(el: Element): string {
  let out = '';
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walk.nextNode();
  while (node) {
    out += node.nodeValue ?? '';
    node = walk.nextNode();
  }
  return out;
}

/** Parse "12" / " 34 " gutter text; null when not a plain number. */
function parseLineNumber(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function lineHeightOf(el: Element): number {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight);
  if (Number.isFinite(lh) && lh > 0) return lh;
  const fs = parseFloat(cs.fontSize);
  return Number.isFinite(fs) && fs > 0 ? fs * 1.4 : 21;
}

// ---------------------------------------------------------------------------
// CodeMirror 6
// ---------------------------------------------------------------------------

export class Cm6Observer implements EditorObserver {
  readonly kind = 'cm6' as const;
  constructor(private rootEl: HTMLElement) {}

  read(): EditorSnapshot | null {
    const content = this.rootEl.querySelector<HTMLElement>('.cm-content');
    const scroller = this.rootEl.querySelector<HTMLElement>('.cm-scroller');
    if (!content) return null;

    const lines = Array.from(content.children).filter(
      (c) => c instanceof HTMLElement && c.classList.contains('cm-line'),
    ) as HTMLElement[];
    if (lines.length === 0) return null;

    // Gutter elements pair 1:1 with rendered lines; spacer elements carry
    // padding for virtualized space. Their line-number text is authoritative.
    const gutterEls = Array.from(
      this.rootEl.querySelectorAll('.cm-lineNumbers .cm-gutterElement'),
    ) as HTMLElement[];

    const ranges: RawRange[] = [];
    let start: number | null = null;
    let collected: string[] = [];

    const flush = () => {
      if (start !== null && collected.length > 0) {
        ranges.push({ startLine: start, endLine: start + collected.length - 1, lines: collected });
      }
      start = null;
      collected = [];
    };

    let gi = 0; // index into gutterEls that are actual numbered elements
    for (const line of lines) {
      // Find the next numbered gutter element.
      while (gi < gutterEls.length && parseLineNumber(textOf(gutterEls[gi]!)) === null) gi++;
      const numEl = gutterEls[gi];
      const lineNo = numEl ? parseLineNumber(textOf(numEl)) : null;
      gi++;
      const text = textOf(line);
      if (lineNo === null) {
        // No line identity for this row — break contiguity, never guess.
        flush();
        continue;
      }
      if (start !== null && lineNo !== start + collected.length) flush();
      if (start === null) start = lineNo;
      collected.push(text);
    }
    flush();

    // No line-number gutter (many sites hide it): number lines by position,
    // but ONLY when the render window provably starts at line 1 - i.e. the
    // first content child is a real line and nothing is virtualized above it.
    if (ranges.length === 0 && !gutterEls.some((g) => parseLineNumber(textOf(g)) !== null)) {
      const first = content.firstElementChild;
      const padTop = parseFloat(getComputedStyle(content).paddingTop) || 0;
      const scrolledTop = !scroller || scroller.scrollTop <= 2;
      if (first && first.classList.contains('cm-line') && padTop < 40 && scrolledTop) {
        const seq: string[] = [];
        for (const child of Array.from(content.children)) {
          if (!(child instanceof HTMLElement) || !child.classList.contains('cm-line')) break;
          seq.push(textOf(child));
        }
        if (seq.length > 0) ranges.push({ startLine: 1, endLine: seq.length, lines: seq });
      }
    }

    // Everything rendered and nothing scrollable: the visible lines ARE the file.
    if (
      ranges.length === 1 &&
      ranges[0]!.startLine === 1 &&
      scroller &&
      scroller.scrollHeight > 0 &&
      scroller.scrollHeight <= scroller.clientHeight + 2
    ) {
      return { editorKind: this.kind, ranges, totalLinesHint: ranges[0]!.endLine, scroller, root: this.rootEl };
    }

    // Total from virtualization spacers: padding heights / line height.
    let hint: number | null = null;
    const firstNo = ranges[0]?.startLine ?? null;
    const lastNo = ranges.length > 0 ? ranges[ranges.length - 1]!.endLine : null;
    if (firstNo !== null && lastNo !== null && gutterEls.length > 0) {
      const lh = lineHeightOf(lines[0]!);
      let padBottom = 0;
      for (const g of gutterEls) {
        const t = parseLineNumber(textOf(g));
        if (t !== null) continue; // spacer elements have no number
        const cs = getComputedStyle(g);
        const pb = parseFloat(cs.paddingBottom) || 0;
        const pt = parseFloat(cs.paddingTop) || 0;
        padBottom += pb + pt;
      }
      const rendered = lastNo - firstNo + 1;
      if (lh > 0) {
        const spacerLines = Math.round(padBottom / lh);
        hint = rendered + spacerLines;
      }
    }
    if (ranges.length === 1 && ranges[0]!.startLine === 1 && hint === null) {
      const hasSpacerPadding = gutterEls.some((g) => {
        if (parseLineNumber(textOf(g)) !== null) return false;
        const cs = getComputedStyle(g);
        return (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.paddingTop) || 0) > 0;
      });
      if (!hasSpacerPadding && (!scroller || scroller.scrollHeight <= scroller.clientHeight + 4)) {
        hint = ranges[0]!.endLine;
      }
    }
    return { editorKind: this.kind, ranges, totalLinesHint: hint, scroller, root: this.rootEl };
  }
}

// ---------------------------------------------------------------------------
// Monaco
// ---------------------------------------------------------------------------

export class MonacoObserver implements EditorObserver {
  readonly kind = 'monaco' as const;
  constructor(private rootEl: HTMLElement) {}

  read(): EditorSnapshot | null {
    const viewLines = this.rootEl.querySelector<HTMLElement>('.view-lines');
    const scroller = this.rootEl.querySelector<HTMLElement>('.monaco-scrollable-element') ?? viewLines;
    if (!viewLines) return null;

    // Monaco positions rows absolutely and recycles DOM nodes, so DOM order is
    // NOT line order. Pair content rows with gutter rows by their `top`.
    const topOf = (el: HTMLElement): number => {
      const row = el.style.top ? el : (el.parentElement as HTMLElement | null) ?? el;
      const t = parseFloat(row.style.top);
      return Number.isFinite(t) ? Math.round(t) : NaN;
    };
    const lineEls = (Array.from(viewLines.querySelectorAll('.view-line')) as HTMLElement[])
      .sort((a, b) => (topOf(a) || 0) - (topOf(b) || 0));
    if (lineEls.length === 0) return null;

    // Monaco's line-number elements expose data-line-number (or numeric text).
    const numEls = Array.from(this.rootEl.querySelectorAll('.line-numbers')) as HTMLElement[];
    const numberByTop = new Map<number, number>();
    for (const el of numEls) {
      const attr = el.getAttribute('data-line-number');
      const n = (attr ? parseLineNumber(attr) : null) ?? parseLineNumber(textOf(el));
      const t = topOf(el);
      if (n !== null && Number.isFinite(t)) numberByTop.set(t, n);
    }
    const allTopsKnown = lineEls.every((el) => Number.isFinite(topOf(el)));
    let numbers: (number | null)[] = allTopsKnown && numberByTop.size > 0
      ? lineEls.map((el) => numberByTop.get(topOf(el)) ?? null)
      : numEls.map((el) => {
          const attr = el.getAttribute('data-line-number');
          if (attr) {
            const n = parseLineNumber(attr);
            if (n !== null) return n;
          }
          return parseLineNumber(textOf(el));
        });

    if (!numbers.some((n) => n !== null) && (!scroller || scroller.scrollTop <= 2)) {
      numbers = lineEls.map((_, idx) => idx + 1);
    }

    const ranges: RawRange[] = [];
    let start: number | null = null;
    let collected: string[] = [];
    const flush = () => {
      if (start !== null && collected.length > 0) {
        ranges.push({ startLine: start, endLine: start + collected.length - 1, lines: collected });
      }
      start = null;
      collected = [];
    };

    for (let i = 0; i < lineEls.length; i++) {
      const lineNo = numbers[i] ?? null;
      const text = textOf(lineEls[i]!);
      if (lineNo === null) {
        flush();
        continue;
      }
      if (start !== null && lineNo !== start + collected.length) flush();
      if (start === null) start = lineNo;
      collected.push(text);
    }
    flush();

    // Layout-derived total: content height / line height (Monaco virtualizes
    // via transforms; scrollHeight of .view-lines reflects full document).
    let hint: number | null = null;
    const firstNo = ranges[0]?.startLine ?? null;
    if (firstNo !== null && viewLines.parentElement) {
      const lh = lineHeightOf(lineEls[0]!);
      const full = viewLines.scrollHeight || parseFloat(viewLines.style.height) || 0;
      if (lh > 0 && full > 0) hint = Math.round(full / lh);
    }
    if (
      ranges.length === 1 &&
      ranges[0]!.startLine === 1 &&
      (hint === null || hint < ranges[0]!.endLine) &&
      (!scroller || scroller.scrollHeight <= scroller.clientHeight + 4)
    ) {
      hint = ranges[0]!.endLine;
    }
    return { editorKind: this.kind, ranges, totalLinesHint: hint, scroller: scroller as HTMLElement, root: this.rootEl };
  }
}

// ---------------------------------------------------------------------------
// CodeMirror 5 and plain code blocks (non-virtualized: full content)
// ---------------------------------------------------------------------------

class FullContentObserver implements EditorObserver {
  readonly kind: EditorKind;
  constructor(
    kind: EditorKind,
    private rootEl: HTMLElement,
    private lineSelector: string,
    private fallbackWhole: boolean,
  ) {
    this.kind = kind;
  }

  read(): EditorSnapshot | null {
    const lineEls = this.lineSelector
      ? (Array.from(this.rootEl.querySelectorAll(this.lineSelector)) as HTMLElement[])
      : [];
    if (lineEls.length > 0) {
      const lines = lineEls.map((el) => textOf(el));
      return {
        editorKind: this.kind,
        ranges: [{ startLine: 1, endLine: lines.length, lines }],
        totalLinesHint: lines.length,
        scroller: this.rootEl.closest('.CodeMirror-scroll') as HTMLElement | null,
        root: this.rootEl,
      };
    }
    if (this.fallbackWhole) {
      const text = this.rootEl instanceof HTMLTextAreaElement ? this.rootEl.value : textOf(this.rootEl);
      const lines = text.replace(/\n$/, '').split('\n');
      return {
        editorKind: this.kind,
        ranges: lines.length > 0 ? [{ startLine: 1, endLine: lines.length, lines }] : [],
        totalLinesHint: lines.length,
        scroller: null,
        root: this.rootEl,
      };
    }
    return null;
  }
}

export class Cm5Observer extends FullContentObserver {
  constructor(rootEl: HTMLElement) {
    super('cm5', rootEl, '.CodeMirror-code .CodeMirror-line', false);
  }
}

export class PlainCodeObserver extends FullContentObserver {
  constructor(rootEl: HTMLElement) {
    // pre>code with many lines, or a bare pre / textarea source view.
    super('plain', rootEl, '', true);
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Detect and return the best-matching observer for a root, or null. */
export function detectEditorObserver(root: ParentNode = document): EditorObserver | null {
  const cm6 = root.querySelector<HTMLElement>('.cm-editor');
  if (cm6) return new Cm6Observer(cm6);
  const monaco = root.querySelector<HTMLElement>('.monaco-editor');
  if (monaco) return new MonacoObserver(monaco);
  const cm5 = root.querySelector<HTMLElement>('.CodeMirror');
  if (cm5) return new Cm5Observer(cm5);
  // Plain source view: a <pre> with line-ish content (many children or newlines).
  const pres = Array.from(root.querySelectorAll<HTMLElement>('pre, textarea'));
  for (const pre of pres) {
    const text = pre instanceof HTMLTextAreaElement ? pre.value : textOf(pre);
    if (text.includes('\n') || pre.querySelector('code')) {
      return new PlainCodeObserver(pre);
    }
  }
  return null;
}

/**
 * Search across OPEN SHADOW ROOTS as well as the light DOM. Modern platforms
 * frequently shadow-DOM their editors, and plain querySelector never sees
 * inside. (Cross-origin iframes remain unreachable by design — those get the
 * all-frames content script instead.)
 */
export function deepQuerySelectorAll(selector: string, root: ParentNode = document): HTMLElement[] {
  const found: HTMLElement[] = [];
  const pushFrom = (scope: ParentNode) => {
    for (const el of Array.from(scope.querySelectorAll<HTMLElement>(selector))) found.push(el);
    for (const host of Array.from(scope.querySelectorAll<HTMLElement>('*'))) {
      // Never look inside Asset Miner's own panel (its tree/editor would feed back).
      if (host.shadowRoot && host.id !== PANEL_HOST_ID) pushFrom(host.shadowRoot);
    }
  };
  pushFrom(root);
  return found;
}

function visibleArea(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    // Headless/no-layout environments: treat as minimally visible unless hidden.
    return getComputedStyle(el).display === 'none' ? 0 : 1;
  }
  const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
  return w * h;
}

/**
 * The editor the user is actually looking at: the LARGEST VISIBLE editor on
 * the page (sites often also mount tiny editors for search boxes, terminals,
 * diff gutters or hidden tabs - picking the first one captured nothing).
 */
export function findBestEditorObserver(root: ParentNode = document): EditorObserver | null {
  const candidates: { area: number; make: () => EditorObserver }[] = [];
  for (const el of deepQuerySelectorAll('.cm-editor', root)) {
    candidates.push({ area: visibleArea(el), make: () => new Cm6Observer(el) });
  }
  for (const el of deepQuerySelectorAll('.monaco-editor', root)) {
    candidates.push({ area: visibleArea(el), make: () => new MonacoObserver(el) });
  }
  for (const el of deepQuerySelectorAll('.CodeMirror', root)) {
    candidates.push({ area: visibleArea(el), make: () => new Cm5Observer(el) });
  }
  if (!candidates.some((c) => c.area > 0)) {
    for (const pre of deepQuerySelectorAll('pre, textarea', root)) {
      const text = pre instanceof HTMLTextAreaElement ? pre.value : textOf(pre);
      if (text.includes('\n') || pre.querySelector('code')) {
        candidates.push({ area: visibleArea(pre), make: () => new PlainCodeObserver(pre) });
      }
    }
  }
  const visible = candidates.filter((c) => c.area > 0).sort((a, b) => b.area - a.area);
  return visible[0]?.make() ?? null;
}

/** Editor detection that also looks inside open shadow roots. */
export function deepDetectEditorObserver(root: ParentNode = document): EditorObserver | null {
  const best = findBestEditorObserver(root);
  if (best) return best;
  const cm6 = deepQuerySelectorAll('.cm-editor', root)[0];
  if (cm6) return new Cm6Observer(cm6);
  const monaco = deepQuerySelectorAll('.monaco-editor', root)[0];
  if (monaco) return new MonacoObserver(monaco);
  const cm5 = deepQuerySelectorAll('.CodeMirror', root)[0];
  if (cm5) return new Cm5Observer(cm5);
  for (const pre of deepQuerySelectorAll('pre, textarea', root)) {
    const text = pre instanceof HTMLTextAreaElement ? pre.value : textOf(pre);
    if (text.includes('\n') || pre.querySelector('code')) {
      return new PlainCodeObserver(pre);
    }
  }
  return null;
}
