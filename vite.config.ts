import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Main build: background service worker (ESM — manifest declares "type": "module").
 * The content script is built separately (IIFE) via vite.content.config.ts
 * because Chrome does not support ES module content scripts declared in the manifest.
 * public/ (manifest.json, icons/, demo/) is copied to dist/ by this pass only;
 * the content pass reuses the same outDir with emptyOutDir disabled.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        'background/service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
