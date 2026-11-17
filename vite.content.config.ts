import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Content-script build: a single self-contained IIFE bundle.
 * - No code splitting / dynamic imports (content scripts cannot be ES modules).
 * - CSS is NOT emitted as a page-level stylesheet. The panel renders inside a
 *   Shadow DOM root and adopts styles from `?inline` imports, so nothing leaks
 *   into the host page. cssCodeSplit is disabled so any stray CSS stays in one
 *   predictable file that the host never loads.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        'content/content-script': resolve(__dirname, 'src/content/content-entry.ts'),
      },
      output: {
        format: 'iife',
        entryFileNames: '[name].js',
        assetFileNames: 'assets/[name][extname]',
        inlineDynamicImports: true,
      },
    },
  },
});
