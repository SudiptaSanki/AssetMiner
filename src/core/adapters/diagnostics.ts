/**
 * Diagnostics collector — NEVER used for capture, only for troubleshooting.
 *
 * Purpose: on platforms like blink.new, real selectors must be verified
 * against the live DOM before the platform adapter is enabled (no invented
 * selectors). The user copies this snapshot from the panel and shares it;
 * the verified selectors then go into the platform adapter configuration.
 */
import { deepDetectEditorObserver } from '../observers';

export interface DiagnosticsSnapshot {
  capturedAt: string;
  location: { href: string; origin: string; topFrame: boolean };
  adapter: { id: string; notes: string };
  editor: {
    detected: boolean;
    kind: string | null;
    /** Ancestor chain of the editor root (tag + class), for selector design. */
    ancestry: string[];
  };
  frames: { src: string; sameOrigin: boolean }[];
  treeCandidates: {
    tag: string;
    classes: string;
    role: string | null;
    childCount: number;
    textSnippet: string;
  }[];
  hints: string[];
}

const TREE_HINT_SELECTOR = [
  '[role="tree"]',
  '[role="treeitem"]',
  '[class*="tree" i]',
  '[class*="file" i]',
  '[class*="folder" i]',
  '[class*="explorer" i]',
  '[data-tree]',
].join(', ');

export function collectDiagnostics(adapterInfo: { id: string; notes: string }): DiagnosticsSnapshot {
  const observer = deepDetectEditorObserver();
  const hints: string[] = [];

  const ancestry: string[] = [];
  if (observer) {
    // Read once to reach the root element of the detected editor.
    const snap = (() => {
      try {
        return observer.read();
      } catch {
        return null;
      }
    })();
    let el: Element | null = snap?.root ?? null;
    let depth = 0;
    while (el && depth < 8) {
      ancestry.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`);
      el = el.parentElement;
      depth += 1;
    }
  }

  const frames = Array.from(document.querySelectorAll('iframe')).slice(0, 20).map((f) => {
    const src = f.getAttribute('src') ?? '';
    let sameOrigin = false;
    try {
      sameOrigin = src === '' || new URL(src, location.href).origin === location.origin;
    } catch {
      sameOrigin = false;
    }
    return { src: src.slice(0, 200), sameOrigin };
  });

  // Diagnostic-only tree candidates (not used by any adapter).
  const seen = new Set<Element>();
  const treeCandidates: DiagnosticsSnapshot['treeCandidates'] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(TREE_HINT_SELECTOR)).slice(0, 400)) {
    if (seen.has(el) || treeCandidates.length >= 12) continue;
    seen.add(el);
    const classes = (typeof el.className === 'string' ? el.className : '').trim();
    if (classes === '' && !el.getAttribute('role')) continue;
    treeCandidates.push({
      tag: el.tagName.toLowerCase(),
      classes: classes.slice(0, 140),
      role: el.getAttribute('role'),
      childCount: el.children.length,
      textSnippet: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    });
  }

  if (!observer) {
    hints.push('No editor DOM detected yet. Open the platform\'s Code/source section and click a file so the editor renders, then click Refresh diagnostics.');
  }
  if (frames.some((f) => !f.sameOrigin)) {
    hints.push('Cross-origin iframes present — their content is not accessible by design; if the editor lives there, it needs its own frame injection (already attempted).');
  }
  if (treeCandidates.length === 0) {
    hints.push('No file-tree-like structures found — the platform\'s tree may need custom selectors (share this snapshot to get them configured).');
  }

  return {
    capturedAt: new Date().toISOString(),
    location: { href: location.href.slice(0, 200), origin: location.origin, topFrame: window.self === window.top },
    adapter: { id: adapterInfo.id, notes: adapterInfo.notes },
    editor: {
      detected: observer !== null,
      kind: observer?.kind ?? null,
      ancestry,
    },
    frames,
    treeCandidates,
    hints,
  };
}
