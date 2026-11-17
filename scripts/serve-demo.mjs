/**
 * Minimal static file server for local testing (no dependencies).
 *
 * Serves the build output + fixtures so the extension can be exercised against
 * an http:// origin (some browsers restrict content-script injection on file://).
 *
 * Usage: node scripts/serve-demo.mjs [port]   → http://127.0.0.1:4173/demo/
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = (() => {
  try { return fileURLToPath(new URL('.', import.meta.url)); }
  catch { return process.cwd(); }
})();
const ROOT = resolve(__dirname, '..', 'dist');
const PORT = Number(process.argv[2] ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    // Prevent path traversal: normalized target must stay under ROOT.
    const target = normalize(join(ROOT, pathname));
    if (!target.startsWith(ROOT + '\\') && !target.startsWith(ROOT + '/')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT}`);
  console.log(`demo fixture:  http://127.0.0.1:${PORT}/demo/`);
});
