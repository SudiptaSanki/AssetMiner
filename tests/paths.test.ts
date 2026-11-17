import { describe, expect, it } from 'vitest';
import {
  canonicalizeRelativePath,
  sanitizeForExport,
  isTraversalSafe,
  extensionOf,
  baseName,
  parentPath,
  joinPath,
  stripCommonRoot,
} from '../src/core/identity/paths';

describe('canonicalizeRelativePath', () => {
  it('normalizes separators and redundant segments', () => {
    expect(canonicalizeRelativePath('src\\components\\Header.tsx')).toBe('src/components/Header.tsx');
    expect(canonicalizeRelativePath('./src/./a/../b.js')).toBe('src/b.js');
    expect(canonicalizeRelativePath('/src/index.ts')).toBe('src/index.ts');
    expect(canonicalizeRelativePath('C:/proj/src/x.ts')).toBe('proj/src/x.ts');
  });

  it('rejects path escape attempts', () => {
    expect(canonicalizeRelativePath('../secret')).toBeNull();
    expect(canonicalizeRelativePath('a/../../b')).toBeNull();
    expect(canonicalizeRelativePath('')).toBeNull();
    expect(canonicalizeRelativePath('.')).toBeNull();
  });

  it('rejects control characters', () => {
    expect(canonicalizeRelativePath('a\u0000b.txt')).toBeNull();
    expect(canonicalizeRelativePath('a\nb.txt')).toBeNull();
  });
});

describe('sanitizeForExport', () => {
  it('passes through normal canonical paths', () => {
    expect(sanitizeForExport('src/components/Header.tsx')).toEqual({
      ok: true,
      path: 'src/components/Header.tsx',
    });
  });

  it('neutralizes Windows reserved names', () => {
    expect(sanitizeForExport('con')).toEqual({ ok: true, path: '_con' });
    expect(sanitizeForExport('aux/config.json')).toEqual({ ok: true, path: '_aux/config.json' });
  });

  it('strips trailing dots and spaces per segment', () => {
    expect(sanitizeForExport('weird name... /file .txt').path).toBe('weird name/file .txt');
  });

  it('rejects absolute and traversal paths', () => {
    expect(sanitizeForExport('/abs/path').ok).toBe(false);
    expect(sanitizeForExport('C:/x').ok).toBe(false);
    expect(sanitizeForExport('../up').ok).toBe(false);
  });

  it('enforces length bounds', () => {
    expect(sanitizeForExport('a'.repeat(1000)).ok).toBe(false);
    const longSeg = sanitizeForExport(`${'x'.repeat(300)}.txt`);
    expect(longSeg.ok).toBe(true);
    expect(longSeg.path.length).toBeLessThan(200);
  });
});

describe('isTraversalSafe', () => {
  it('accepts plain relative paths', () => {
    expect(isTraversalSafe('src/a.ts')).toBe(true);
    expect(isTraversalSafe('a/./b/../c.txt')).toBe(true);
  });
  it('rejects escapes and absolutes', () => {
    expect(isTraversalSafe('../x')).toBe(false);
    expect(isTraversalSafe('/root/x')).toBe(false);
    expect(isTraversalSafe('a\\b')).toBe(false);
    expect(isTraversalSafe('C:/x')).toBe(false);
  });
});

describe('path helpers', () => {
  it('extensionOf handles dotfiles and multi-dots', () => {
    expect(extensionOf('a/b/c.tsx')).toBe('tsx');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('README')).toBe('');
  });
  it('baseName / parentPath / joinPath', () => {
    expect(baseName('src/components/Header.tsx')).toBe('Header.tsx');
    expect(parentPath('src/components/Header.tsx')).toBe('src/components');
    expect(parentPath('README.md')).toBe('');
    expect(joinPath('src', 'a.ts')).toBe('src/a.ts');
    expect(joinPath('', 'a.ts')).toBe('a.ts');
  });
  it('stripCommonRoot removes a shown repo prefix', () => {
    expect(stripCommonRoot('repo/root/src/a.ts', 'repo/root')).toBe('src/a.ts');
    expect(stripCommonRoot('other/src/a.ts', 'repo/root')).toBe('other/src/a.ts');
  });
});
