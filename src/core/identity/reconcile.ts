/**
 * Path reconciliation - map a path the page shows somewhere (breadcrumb, tab
 * label, editor model URI) onto the path the FILE TREE uses for that file.
 *
 * Without this, the same file gets two identities: e.g. the tree says
 * `src/App.tsx` while the tab only says `App.tsx` (or the editor URI says
 * `/home/project/src/App.tsx`). Content then lands in a phantom root-level
 * file while the real tree entry stays empty - looks like "nothing captured"
 * and creates duplicates.
 */
import { canonicalizeRelativePath } from './paths';

function segs(p: string): string[] {
  return p.split('/').filter(Boolean);
}

function endsWithSegs(full: string[], tail: string[]): boolean {
  if (tail.length === 0 || tail.length > full.length) return false;
  for (let i = 1; i <= tail.length; i++) {
    if (full[full.length - i] !== tail[tail.length - i]) return false;
  }
  return true;
}

export interface ReconcileOptions {
  /** Preferred candidate when several known files match equally (e.g. last clicked). */
  prefer?: string | null;
}

/**
 * Returns the known tree path that best matches `candidate`, or the
 * canonical candidate itself when the tree has no matching entry.
 * Returns null for unusable input.
 */
export function reconcilePath(
  candidate: string,
  known: Iterable<string>,
  opts: ReconcileOptions = {},
): string | null {
  const c = canonicalizeRelativePath(candidate);
  if (!c) return null;
  const knownList = Array.from(known);
  if (knownList.includes(c)) return c;
  const cs = segs(c);

  // 1. Known paths that END WITH the candidate (candidate is a shorter view:
  //    tab label "App.tsx" or breadcrumb "components/Nav.tsx").
  const longer = knownList.filter((k) => endsWithSegs(segs(k), cs));
  if (longer.length === 1) return longer[0]!;
  if (longer.length > 1) {
    if (opts.prefer && longer.includes(opts.prefer)) return opts.prefer;
    return null; // ambiguous - never guess between two real files
  }

  // 2. Candidate ENDS WITH a known path (candidate has extra prefix:
  //    "/home/project/src/App.tsx" or "my-app/src/App.tsx"). Longest wins.
  const shorter = knownList
    .filter((k) => endsWithSegs(cs, segs(k)))
    .sort((a, b) => segs(b).length - segs(a).length);
  if (shorter.length > 0 && segs(shorter[0]!).length >= 2) return shorter[0]!;
  if (shorter.length === 1) return shorter[0]!;

  // 3. Candidate shares a known top-level folder somewhere in its middle:
  //    strip everything before it ("/home/project/src/new.ts" + tree has "src").
  const topLevels = new Set(knownList.map((k) => segs(k)[0]!).filter(Boolean));
  for (let i = 1; i < cs.length - 1; i++) {
    if (topLevels.has(cs[i]!)) return cs.slice(i).join('/');
  }
  return c;
}

/** Strip well-known workspace prefixes from editor model URIs. */
export function pathFromEditorUri(uriPath: string): string | null {
  if (!uriPath) return null;
  let p = uriPath;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw */
  }
  p = p.replace(/^\/+/, '');
  p = p.replace(/^(home\/[^/]+\/|home\/|workspace\/|workspaces\/[^/]+\/|project\/|projects\/[^/]+\/|app\/|tmp\/[^/]+\/)/, '');
  const c = canonicalizeRelativePath(p);
  if (!c) return null;
  const base = c.split('/').pop() ?? '';
  // Monaco's inmemory://model/1 style URIs carry no real file name.
  if (/^\d+$/.test(base) || base === '' ) return null;
  return c;
}
