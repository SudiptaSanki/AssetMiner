/**
 * Path identity & safety (spec Part 6, 11.4).
 *
 * Two distinct jobs, deliberately kept apart:
 *  1. canonicalizeRelativePath — turn whatever the page shows into ONE
 *     canonical identity so reopening a file can never create a duplicate.
 *  2. sanitizeForExport — make a canonical path safe to write into a ZIP on
 *     any OS (no traversal, no reserved names, bounded lengths).
 */

export interface SanitizeResult {
  ok: boolean;
  path: string;
  reason?: string;
}

const RESERVED_WINDOWS_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const MAX_SEGMENT = 180;
const MAX_TOTAL = 900;

/**
 * Normalize a path seen on a page into canonical relative form.
 * Returns null when the path cannot be represented as a safe relative path
 * (absolute, drive letter, UNC, or escapes the project root).
 */
export function canonicalizeRelativePath(input: string): string | null {
  if (typeof input !== 'string') return null;
  let p = input.trim();
  if (p === '' || p === '.' ) return null;
  p = p.replace(/\\/g, '/');
  // Strip common prefixes the page may include.
  p = p.replace(/^[a-zA-Z]:\//, ''); // drive letter — treat rest as relative
  p = p.replace(/^\/+/, ''); // leading slashes
  // Split, resolve '.' and '..' lexically.
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null; // escapes root — reject
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) return null;
  const canonical = out.join('/');
  // Control characters have no business in a path.
  if (/[\u0000-\u001f\u007f]/.test(canonical)) return null;
  return canonical;
}

export function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** Parent directory ('' for root-level, null for the root itself). */
export function parentPath(path: string): string | null {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Lowercase extension without dot; '' when none. Dotfiles (`.gitignore`) have none. */
export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return ''; // dotfiles or no extension
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Export-time sanitization. Canonical paths are already traversal-safe;
 * this additionally enforces OS-safe segments (Windows reserved names,
 * trailing dots/spaces, length bounds) for archive writers.
 */
export function sanitizeForExport(canonical: string): SanitizeResult {
  if (canonical === '') return { ok: false, path: '', reason: 'empty path' };
  if (canonical.length > MAX_TOTAL) {
    return { ok: false, path: '', reason: `path longer than ${MAX_TOTAL} characters` };
  }
  if (/^[a-zA-Z]:/.test(canonical) || canonical.startsWith('//') || canonical.startsWith('/')) {
    return { ok: false, path: '', reason: 'absolute paths are not allowed' };
  }
  const segments: string[] = [];
  for (const rawSeg of canonical.split('/')) {
    let seg = rawSeg.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '');
    // Windows dislikes trailing dots and spaces; collapse doubles of anything left.
    seg = seg.replace(/[. ]+$/g, '').replace(/\.\./g, '.').trim();
    if (seg === '' || seg === '.' ) {
      return { ok: false, path: '', reason: `empty segment in "${canonical}"` };
    }
    if (seg.length > MAX_SEGMENT) seg = seg.slice(0, MAX_SEGMENT);
    if (RESERVED_WINDOWS_NAMES.has(seg.toLowerCase())) seg = `_${seg}`;
    segments.push(seg);
  }
  return { ok: true, path: segments.join('/') };
}

/** True when a relative path can never traverse out of the export root. */
export function isTraversalSafe(canonical: string): boolean {
  if (canonical.startsWith('/') || canonical.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(canonical)) return false;
  let depth = 0;
  for (const seg of canonical.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      depth -= 1;
      if (depth < 0) return false;
    } else {
      depth += 1;
    }
  }
  return true;
}

/** Common-prefix trim: platforms often show `repo/root/...` prefixes. */
export function stripCommonRoot(path: string, rootHint: string): string {
  if (!rootHint) return path;
  const hint = rootHint.replace(/^\/+|\/+$/g, '');
  if (hint && (path === hint || path.startsWith(`${hint}/`))) {
    return path.slice(hint.length + 1);
  }
  return path;
}
