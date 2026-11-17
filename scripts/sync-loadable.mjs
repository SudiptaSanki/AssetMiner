/**
 * Mirror the built extension (dist/) into a second loadable root (extension/).
 *
 * Why: `dist/` is the primary unpacked-extension folder; `extension/` is a
 * fallback copy the user can load instead (e.g. if a build pass partially
 * cleared dist, or they simply prefer a stable path). The folder is rebuilt
 * from scratch each run — no stale files.
 *
 * Usage: node scripts/sync-loadable.mjs   (wired into `npm run build`)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = join(ROOT, 'dist');
const FALLBACK = join(ROOT, 'extension');

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('dist/manifest.json missing — run the full build first (npm run build)');
  process.exit(1);
}

// Validate before copying: a broken manifest must never become the fallback.
try {
  const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3) throw new Error('manifest_version must be 3');
  for (const icon of Object.values(manifest.icons ?? {})) {
    if (!existsSync(join(DIST, icon))) throw new Error(`missing icon file: ${icon}`);
  }
  if (!existsSync(join(DIST, manifest.background?.service_worker ?? ''))) {
    throw new Error('missing background service worker');
  }
} catch (err) {
  console.error('dist/ is not a loadable extension:', err instanceof Error ? err.message : err);
  process.exit(1);
}

rmSync(FALLBACK, { recursive: true, force: true });
mkdirSync(FALLBACK, { recursive: true });
cpSync(DIST, FALLBACK, { recursive: true, force: true });

console.log(`fallback root synced: ${FALLBACK}`);
console.log('loadable roots: dist/  and  extension/');
