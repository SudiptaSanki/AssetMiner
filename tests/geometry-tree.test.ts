/**
 * Geometry tree scanner tests — replicating the blink.new shape observed in
 * the field: a sidebar of custom rows (chevron svg + label span, NO aria
 * roles), nesting via indentation, and a breadcrumb header above the editor
 * ("scripts › finalize-static-build.mjs").
 */
import { describe, expect, it } from 'vitest';
import {
  filenameLike,
  scanGeometryTree,
  findBreadcrumbPath,
  findSelectedTreeRowPath,
  TreeMemory,
} from '../src/core/adapters/dom-tree-scan';
import { pathFromEditorUri, reconcilePath } from '../src/core/identity/reconcile';

function row(label: string, depth: number, isFolder: boolean): HTMLElement {
  // blink-like row: <div class="flex"><svg/><span>name</span></div>
  const r = document.createElement('div');
  r.className = 'flex items-center';
  r.style.paddingLeft = `${8 + depth * 16}px`; // headless: padding is the metric
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  r.appendChild(svg);
  const span = document.createElement('span');
  span.textContent = label;
  r.appendChild(span);
  void isFolder;
  return r;
}

function mountBlinkLikeTree(): HTMLElement {
  const sidebar = document.createElement('nav');
  sidebar.className = 'w-full';
  // Root files (depth 0)
  sidebar.appendChild(row('package.json', 0, false));
  sidebar.appendChild(row('tailwind.config.js', 0, false));
  // Folder + nested (depth 1)
  sidebar.appendChild(row('scripts', 0, true));
  sidebar.appendChild(row('finalize-static-build.mjs', 1, false));
  sidebar.appendChild(row('src', 0, true));
  sidebar.appendChild(row('main.tsx', 1, false));
  sidebar.appendChild(row('lib', 1, true));
  sidebar.appendChild(row('utils.ts', 2, false));
  document.body.appendChild(sidebar);
  return sidebar;
}

describe('filenameLike', () => {
  it('accepts extension files and dotfiles', () => {
    expect(filenameLike('finalize-static-build.mjs')).toBe(true);
    expect(filenameLike('package.json')).toBe(true);
    expect(filenameLike('.env.local')).toBe(true);
    expect(filenameLike('main.tsx')).toBe(true);
  });
  it('rejects folders, sentences, breadcrumbs', () => {
    expect(filenameLike('scripts')).toBe(false);
    expect(filenameLike('Open in new tab')).toBe(false);
    expect(filenameLike('scripts › finalize-static-build.mjs')).toBe(false);
    expect(filenameLike('')).toBe(false);
  });
});

describe('scanGeometryTree (blink.new shape)', () => {
  it('derives folders, files, nesting and paths with no aria roles', () => {
    const sidebar = mountBlinkLikeTree();
    const rows = scanGeometryTree(document);

    const byPath = new Map(rows.map((r) => [r.path, r]));
    expect(byPath.get('scripts')?.isFolder).toBe(true);
    expect(byPath.get('src')?.isFolder).toBe(true);
    expect(byPath.get('src/lib')?.isFolder).toBe(true);
    expect(byPath.get('scripts/finalize-static-build.mjs')?.isFolder).toBe(false);
    expect(byPath.get('src/main.tsx')).toBeTruthy();
    expect(byPath.get('src/lib/utils.ts')).toBeTruthy();

    // Editor/tab noise is NOT part of the tree.
    expect(rows.some((r) => r.path.includes('untitled'))).toBe(false);
    sidebar.remove();
  });

  it('preserves the sidebar document order, not alphabetical', () => {
    const sidebar = mountBlinkLikeTree();
    const rows = scanGeometryTree(document);
    const names = rows.filter((r) => !r.isFolder).map((r) => r.path);
    // package.json comes BEFORE tailwind.config.js and before src/* — as rendered.
    expect(names.indexOf('package.json')).toBeLessThan(names.indexOf('tailwind.config.js'));
    expect(names.indexOf('package.json')).toBeLessThan(names.indexOf('src/main.tsx'));
    sidebar.remove();
  });

  it('returns empty (honest null) when no tree-like pane exists', () => {
    const div = document.createElement('div');
    div.textContent = 'just some page copy with no filenames here';
    document.body.appendChild(div);
    expect(scanGeometryTree(document)).toEqual([]);
    div.remove();
  });
});

describe('findBreadcrumbPath', () => {
  it('reads "scripts › finalize-static-build.mjs" into a canonical path', () => {
    const header = document.createElement('div');
    const b1 = document.createElement('span');
    b1.textContent = 'scripts';
    const sep = document.createElement('span');
    sep.textContent = ' › ';
    const b2 = document.createElement('span');
    b2.textContent = 'finalize-static-build.mjs';
    header.append(b1, sep, b2);
    document.body.appendChild(header);

    expect(findBreadcrumbPath()).toBe('scripts/finalize-static-build.mjs');
    header.remove();
  });

  it('ignores breadcrumbs that do not end in a filename', () => {
    const header = document.createElement('div');
    header.textContent = 'Project › Settings';
    document.body.appendChild(header);
    expect(findBreadcrumbPath()).toBeNull();
    header.remove();
  });
});

describe('scanGeometryTree robustness', () => {
  it('keeps same-named folders at different paths and extensionless files', () => {
    const nav = document.createElement('nav');
    nav.appendChild(row('src', 0, true));
    nav.appendChild(row('lib', 1, true));
    nav.appendChild(row('a.ts', 2, false));
    nav.appendChild(row('node_modules', 0, true));
    nav.appendChild(row('pkg', 1, true));
    nav.appendChild(row('lib', 2, true));
    nav.appendChild(row('b.js', 3, false));
    nav.appendChild(row('Dockerfile', 0, false));
    document.body.appendChild(nav);
    const paths = scanGeometryTree(document).map((r) => r.path);
    expect(paths).toContain('src/lib/a.ts');
    expect(paths).toContain('node_modules/pkg/lib');
    expect(paths).toContain('node_modules/pkg/lib/b.js');
    expect(paths).toContain('Dockerfile');
    nav.remove();
  });

  it('recovers ancestors via memory when parents scroll out of the DOM', () => {
    const mem = new TreeMemory();
    const nav = document.createElement('nav');
    nav.appendChild(row('src', 0, true));
    nav.appendChild(row('lib', 1, true));
    const f = row('a.ts', 2, false);
    nav.appendChild(f);
    nav.appendChild(row('b.ts', 2, false));
    nav.appendChild(row('z.ts', 0, false));
    document.body.appendChild(nav);
    scanGeometryTree(document, mem);
    nav.children[0]!.remove();
    nav.children[0]!.remove();
    const paths = scanGeometryTree(document, mem).map((r) => r.path);
    expect(paths).toContain('src/lib/a.ts');
    expect(paths).toContain('src/lib/b.ts');
    nav.remove();
  });

  it('discovers folders with font/chevron icons and differing row tags, plus active row', () => {
    const sidebar = document.createElement('aside');
    const folderBtn = document.createElement('button');
    folderBtn.className = 'folder-row';
    folderBtn.style.paddingLeft = '8px';
    const chev = document.createElement('span');
    chev.textContent = '▾';
    folderBtn.append(chev, document.createTextNode('components'));
    sidebar.appendChild(folderBtn);

    const fileLink = document.createElement('a');
    fileLink.className = 'file-row active';
    fileLink.style.paddingLeft = '24px';
    const icon = document.createElement('i');
    icon.className = 'codicon codicon-file';
    const fileSpan = document.createElement('span');
    fileSpan.textContent = 'Button.tsx';
    fileLink.append(icon, fileSpan);
    sidebar.appendChild(fileLink);

    const fileLink2 = document.createElement('a');
    fileLink2.className = 'file-row';
    fileLink2.style.paddingLeft = '8px';
    fileLink2.appendChild(Object.assign(document.createElement('span'), { textContent: 'package.json' }));
    sidebar.appendChild(fileLink2);

    document.body.appendChild(sidebar);
    const rows = scanGeometryTree(document);
    const paths = rows.map((r) => r.path);
    expect(paths).toContain('components');
    expect(paths).toContain('components/Button.tsx');
    expect(paths).toContain('package.json');
    expect(findSelectedTreeRowPath(rows)).toBe('components/Button.tsx');
    sidebar.remove();
  });

  it('reads slash-separated breadcrumbs outside code blocks', () => {
    const bar = document.createElement('div');
    bar.textContent = 'src / components / Button.tsx';
    document.body.appendChild(bar);
    expect(findBreadcrumbPath()).toBe('src/components/Button.tsx');
    bar.remove();
  });
});

describe('path reconciliation', () => {
  it('reconciles short tab names, extra prefixes, and ambiguous matches', () => {
    const known = ['src/App.tsx', 'src/components/index.ts', 'src/lib/index.ts'];
    expect(reconcilePath('App.tsx', known)).toBe('src/App.tsx');
    expect(reconcilePath('/home/project/src/App.tsx', known)).toBe('src/App.tsx');
    expect(reconcilePath('index.ts', known)).toBeNull();
    expect(reconcilePath('index.ts', known, { prefer: 'src/lib/index.ts' })).toBe('src/lib/index.ts');
  });

  it('extracts clean relative paths from editor model URIs', () => {
    expect(pathFromEditorUri('/home/user/src/pages/Home.tsx')).toBe('src/pages/Home.tsx');
    expect(pathFromEditorUri('/1')).toBeNull();
  });
});

