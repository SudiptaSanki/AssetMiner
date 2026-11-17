/**
 * ARIA tree scanning — semantic discovery for platforms that implement
 * proper accessibility trees (role=tree/treeitem + aria-level).
 * Complements the structural geometry scanner; storage identity dedupes
 * anything both find.
 */

export interface TreeItem {
  path: string;
  isFolder: boolean;
  expanded: boolean;
  /** Sibling index in the source tree (0-based), for order preservation. */
  displayOrder: number;
}

export function scanAriaTree(root: ParentNode): TreeItem[] {
  const items: TreeItem[] = [];
  const trees = root.querySelectorAll('[role="tree"]');
  for (const tree of trees) {
    const els = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    // Stack of ancestor names by aria-level (default level grows by 1).
    const stack: { level: number; name: string }[] = [];
    // Sibling counters per rendered level keep the source's display order.
    const siblingCounter = new Map<number, number>();
    let lastLevel = 1;
    for (const el of els) {
      const level = Number(el.getAttribute('aria-level')) || stack.length + 1;
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim().split('\n')[0]!.trim();
      if (!name) continue;
      while (stack.length >= level) stack.pop();
      const parentPath = stack.map((s) => s.name).join('/');
      const isFolder = el.getAttribute('aria-expanded') !== null;
      const path = parentPath ? `${parentPath}/${name}` : name;
      // Restart sibling counting when the level increases (descended into a
      // new parent); continue within the same level.
      const idx = siblingCounter.get(level) ?? 0;
      siblingCounter.set(level, idx + 1);
      if (level !== lastLevel) {
        // Entering a deeper or shallower level: reset deeper counters.
        for (const key of [...siblingCounter.keys()]) {
          if (key > level) siblingCounter.delete(key);
        }
        lastLevel = level;
      }
      items.push({
        path,
        isFolder,
        expanded: el.getAttribute('aria-expanded') === 'true',
        displayOrder: idx,
      });
      if (isFolder) stack.push({ level, name });
    }
  }
  return items;
}
