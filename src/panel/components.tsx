/**
 * Shared panel components: status dots, range bars, code viewer, file tree.
 * All treat captured content as inert text — nothing is ever executed or
 * injected as markup (addendum #7).
 */
import { useMemo, useState, type ReactElement } from 'react';
import type { CaptureState, FileRecord, FolderRecord, LineRange, StatusDot as DotColor, VerificationState } from '../shared/types';
import { statusDot, statusLabel } from '../core/capture/CompletionDetector';
import { sortFilesBySourceOrder, sortFoldersBySourceOrder } from '../core/identity/order';
import { formatBytes, formatTimeAgo } from '../shared/utils';

export function StatusDot({ capture, verification, title }: { capture: CaptureState; verification: VerificationState; title?: string }) {
  const color: DotColor = statusDot(capture, verification);
  return <span className={`am-dot am-dot-${color}`} title={title ?? statusLabel(capture, verification)} aria-label={statusLabel(capture, verification)} />;
}

export function RangeBar({ captured, expected, missing }: { captured: number; expected: number | null; missing: LineRange[] }) {
  if (expected === null || expected <= 0) {
    return <div className="am-rangebar" title="Total length unknown — coverage not measurable"><i style={{ width: '100%' }} className="am-gap" /></div>;
  }
  const capturedPct = Math.min(100, (captured / expected) * 100);
  const gapPct = 100 - capturedPct;
  const gapTitle = missing.map((m) => `${m.startLine}–${m.endLine}`).join(', ');
  return (
    <div className="am-rangebar" title={missing.length ? `Missing: ${gapTitle}` : 'No gaps'}>
      <i style={{ width: `${capturedPct}%` }} />
      {gapPct > 0.5 && <i className="am-gap" style={{ width: `${gapPct}%` }} />}
    </div>
  );
}

export interface CodeLine {
  lineNo: number;
  text: string | null; // null = not captured (gap)
  state?: 'same' | 'diff' | 'missing';
}

/**
 * Windowed code viewer: renders a visible window of lines with numbers and
 * coverage/diff highlighting. Virtualization keeps 100k-line files smooth.
 */
export function CodeViewer(props: {
  lines: CodeLine[];
  maxHeight?: number;
  filter?: string | null;
  rowHeight?: number;
}) {
  const { lines, filter, rowHeight = 18 } = props;
  const [scrollTop, setScrollTop] = useState(0);
  const viewH = 380;
  const overscan = 12;
  const total = lines.length;

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(total, Math.ceil((scrollTop + viewH) / rowHeight) + overscan);
  const windowLines = lines.slice(first, last);

  const matches = useMemo(() => {
    if (!filter) return null;
    const f = filter.toLowerCase();
    return new Set(lines.filter((l) => (l.text ?? '').toLowerCase().includes(f)).map((l) => l.lineNo));
  }, [lines, filter]);

  return (
    <div
      className="am-code"
      style={{ maxHeight: props.maxHeight ?? 420, overflowY: 'auto' }}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
    >
      <div style={{ height: `${total * rowHeight}px`, position: 'relative' }}>
        <div style={{ transform: `translateY(${first * rowHeight}px)` }}>
          <table>
            <tbody>
              {windowLines.map((l) => (
                <tr
                  key={l.lineNo}
                  className={l.state === 'diff' ? 'am-diff' : l.state === 'missing' ? 'am-missing' : 'am-same'}
                  style={matches?.has(l.lineNo) ? { background: '#3a2d10' } : undefined}
                >
                  <td className="am-ln">{l.lineNo}</td>
                  <td>{l.text === null ? `⟨ not captured ⟩` : l.text === '' ? ' ' : l.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export interface TreeNode {
  name: string;
  path: string;
  folder: FolderRecord | null;
  children: Map<string, TreeNode>;
  files: FileRecord[];
}

export function buildTree(folders: FolderRecord[], files: FileRecord[]): TreeNode {
  const root: TreeNode = { name: '', path: '', folder: null, children: new Map(), files: [] };
  const ensure = (path: string): TreeNode => {
    if (path === '') return root;
    let node = root;
    let partial = '';
    for (const seg of path.split('/')) {
      partial = partial === '' ? seg : `${partial}/${seg}`;
      if (!node.children.has(seg)) {
        node.children.set(seg, { name: seg, path: partial, folder: null, children: new Map(), files: [] });
      }
      node = node.children.get(seg)!;
    }
    return node;
  };
  // Source page order is authoritative (spec Rule 1 + user requirement):
  // records arrive pre-sorted by displayOrder and insertion preserves it.
  for (const f of sortFoldersBySourceOrder(folders)) ensure(f.relativePath).folder = f;
  for (const file of sortFilesBySourceOrder(files)) {
    const dir = file.folderPath;
    ensure(dir).files.push(file);
  }
  return root;
}

/** Folder completion derived ONLY from discovered descendants (spec 7.4). */
export function folderCompletion(node: TreeNode): { total: number; complete: number; partial: number; pending: number } {
  let total = 0, complete = 0, partial = 0, pending = 0;
  const walk = (n: TreeNode) => {
    for (const f of n.files) {
      total += 1;
      if (f.captureState === 'captured-full' && f.verificationState === 'verified') complete += 1;
      else if (f.captureState === 'pending') pending += 1;
      else partial += 1;
    }
    for (const child of n.children.values()) walk(child);
  };
  walk(node);
  return { total, complete, partial, pending };
}

export function FileTree(props: {
  folders: FolderRecord[];
  files: FileRecord[];
  selectedFileId: string | null;
  activeFilePath?: string | null;
  onSelectFile(file: FileRecord): void;
  onInspectFolder?(folder: FolderRecord): void;
}) {
  const root = useMemo(() => buildTree(props.folders, props.files), [props.folders, props.files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (node: TreeNode, depth: number): ReactElement[] => {
    const out: ReactElement[] = [];
    // Folders keep the source page's sibling order (insertion order of the
    // Map); files likewise — no alphabetical re-sorting.
    const folderNames = [...node.children.keys()];
    const fileRows = [...node.files];

    for (const name of folderNames) {
      const child = node.children.get(name)!;
      const isCollapsed = collapsed.has(child.path);
      const stats = folderCompletion(child);
      const inspected = child.folder?.discoveryStatus === 'inspected';
      const label =
        stats.total > 0
          ? `${stats.complete === stats.total && inspected ? '●' : stats.complete > 0 ? '◐' : '○'} ${stats.complete}/${stats.total}`
          : inspected
            ? '(empty)'
            : 'not opened';
      out.push(
        <li key={`d:${child.path}`}>
          <div
            className="am-rowline"
            style={{ paddingLeft: 6 }}
            onClick={() => {
              toggle(child.path);
              if (child.folder && props.onInspectFolder) props.onInspectFolder(child.folder);
            }}
            role="treeitem"
            aria-expanded={!isCollapsed}
          >
            <span className="am-twist">{isCollapsed ? '▶' : '▼'}</span>
            <span className="am-name" style={{ fontWeight: 500 }}>{name}/</span>
            <span className="am-foldermeta">{label}</span>
          </div>
          {!isCollapsed && <ul role="group">{renderNode(child, depth + 1)}</ul>}
        </li>,
      );
    }
    for (const file of fileRows) {
      out.push(
        <li key={`f:${file.fileId}`}>
          <div
            className={`am-rowline${props.selectedFileId === file.fileId ? ' am-selected' : ''}`}
            style={{ paddingLeft: 6 }}
            onClick={() => props.onSelectFile(file)}
            role="treeitem"
          >
            <span className="am-twist" />
            <StatusDot capture={file.captureState} verification={file.verificationState} />
            <span className="am-name">{file.filename}</span>
            {props.activeFilePath === file.relativePath && (
              <span className="am-pill am-pill-live" title="Currently open on the website">LIVE</span>
            )}
            <span className="am-meta">
              {file.isBinary
                ? file.byteCount !== null
                  ? formatBytes(file.byteCount)
                  : 'binary'
                : file.coveragePercent !== null
                  ? `${file.capturedLineCount}/${file.expectedLineCount}`
                  : `${file.capturedLineCount} ln`}
            </span>
          </div>
        </li>,
      );
    }
    return out;
  };

  return (
    <div className="am-tree" role="tree">
      <ul>{renderNode(root, 0)}</ul>
    </div>
  );
}

export function ActivityList(props: { items: { activityId: string; at: number; kind: string; message: string; path: string | null }[] }) {
  if (props.items.length === 0) return <div className="am-empty"><b>No activity yet</b>Open files on the page — capture events appear here.</div>;
  return (
    <div className="am-list">
      {props.items.map((a) => (
        <div key={a.activityId} className="am-list-row">
          <span className="am-sub" style={{ flex: 'none', width: 62 }}>{formatTimeAgo(a.at)}</span>
          <span className="am-sub" style={{ flex: 'none', width: 66 }}>{a.kind}</span>
          <div className="am-grow">
            <div className="am-path" style={{ fontFamily: 'inherit' }}>{a.message}</div>
            {a.path && <div className="am-sub">{a.path}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
