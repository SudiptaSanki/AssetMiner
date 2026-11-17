/**
 * Offline PNG icon generator for Asset Miner.
 *
 * Uses only Node built-ins (zlib + a hand-rolled CRC32/chunk writer), so the
 * build has zero external tooling dependencies. Draws a deterministic icon:
 * dark slate rounded square with three gold diagonal "mining streak" bars.
 *
 * Usage: node scripts/gen-icons.mjs   -> writes public/icons/icon{16,32,48,128}.png
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'icons');

// ---------- PNG encoding ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- drawing ----------

const BG_TOP = [26, 43, 60];    // #1a2b3c
const BG_BOTTOM = [16, 27, 38]; // #101b26
const GOLD = [246, 190, 66];    // #f6be42
const GOLD_DARK = [204, 148, 30];
const TRANSPARENT = [0, 0, 0, 0];

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = Math.max(2, Math.round(size * 0.18)); // corner radius
  const put = (x, y, rgb, alpha = 255) => {
    const i = (y * size + x) * 4;
    rgba[i] = rgb[0];
    rgba[i + 1] = rgb[1];
    rgba[i + 2] = rgb[2];
    rgba[i + 3] = alpha;
  };
  const inRoundedSquare = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    const cx = Math.min(Math.max(x, r), size - 1 - r);
    const cy = Math.min(Math.max(y, r), size - 1 - r);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };
  // Three gold bars sweeping diagonally (like a pickaxe strike / mining streak).
  // Each bar is a band around a diagonal line x = y + offset.
  const bars = [
    { offset: -0.34, half: 0.055, color: GOLD },
    { offset: -0.12, half: 0.055, color: GOLD },
    { offset: 0.1, half: 0.055, color: GOLD_DARK },
  ];
  const u = size - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRoundedSquare(x, y)) {
        put(x, y, TRANSPARENT, 0);
        continue;
      }
      const diag = (x - y) / u; // -1..1 along the anti-diagonal
      const t = y / u;
      let color = mix(BG_TOP, BG_BOTTOM, t);
      for (const bar of bars) {
        const d = Math.abs(diag - bar.offset);
        if (d <= bar.half) {
          const edge = 1 - d / bar.half;
          color = mix(color, bar.color, 0.35 + 0.65 * edge);
          break;
        } else if (d <= bar.half * 2.2) {
          const glow = 1 - (d - bar.half) / (bar.half * 1.2);
          color = mix(color, bar.color, 0.18 * glow);
          break;
        }
      }
      put(x, y, [Math.round(color[0]), Math.round(color[1]), Math.round(color[2])], 255);
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = draw(size);
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
