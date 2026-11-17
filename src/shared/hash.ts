/**
 * Content hashing (Web Crypto SHA-256). Used for content-addressed chunk
 * storage (Rule: identical content is stored once) and integrity validation.
 */

export async function sha256Hex(text: string): Promise<string> {
  const subtle = getCrypto().subtle;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(digest);
}

export async function sha256Bytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await getCrypto().subtle.digest('SHA-256', view as unknown as BufferSource);
  return toHex(digest);
}

function getCrypto(): Crypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error('Web Crypto (crypto.subtle) is unavailable in this context');
  }
  return c;
}

function toHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i]!.toString(16).padStart(2, '0');
  }
  return out;
}
