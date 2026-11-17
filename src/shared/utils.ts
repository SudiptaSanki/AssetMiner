/** Small shared utilities. No DOM, no extension APIs — safe everywhere. */

let idCounter = 0;

/** Collision-safe local id (timestamp + counter + entropy). */
export function localId(prefix: string): string {
  idCounter = (idCounter + 1) % 0xffff;
  const entropy = Math.floor(Math.random() * 0xffff).toString(36);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${entropy}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatTimeAgo(at: number | null | undefined, now = Date.now()): string {
  if (at === null || at === undefined) return '—';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString();
}

/** Debounce with leading-edge option; returns a cancellable function. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): ((...args: A) => void) & { cancel(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  const wrapped = (...args: A) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs) fn(...lastArgs);
    }, waitMs);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  wrapped.flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (lastArgs) fn(...lastArgs);
  };
  return wrapped;
}

/** Byte length of a string in UTF-8. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Split text into lines. Final line without trailing newline is still a line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  // A trailing newline technically ends the last line; treat it as a terminator
  // only, matching how editors count lines.
  if (lines.length > 0 && lines[lines.length - 1] === '' && normalized.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

export function joinLines(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** MIME type from extension for the file types we care about (best effort). */
const MIME_BY_EXT: Record<string, string> = {
  ts: 'text/typescript', tsx: 'text/typescript', js: 'text/javascript', jsx: 'text/javascript',
  mjs: 'text/javascript', cjs: 'text/javascript', json: 'application/json', css: 'text/css',
  scss: 'text/x-scss', sass: 'text/x-sass', less: 'text/x-less', html: 'text/html',
  htm: 'text/html', xml: 'application/xml', svg: 'image/svg+xml', md: 'text/markdown',
  txt: 'text/plain', csv: 'text/csv', yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff',
  woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
  pdf: 'application/pdf', wasm: 'application/wasm', zip: 'application/zip',
};

export function mimeFromExtension(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'ico', 'bmp', 'woff', 'woff2', 'ttf',
  'otf', 'eot', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'pdf', 'wasm', 'zip', 'exe', 'dll',
]);

export function isBinaryExtension(ext: string): boolean {
  return BINARY_EXTS.has(ext.toLowerCase());
}
