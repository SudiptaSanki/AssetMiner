/**
 * Asset repository — discovered page resources (images, fonts, media, …).
 */
import type { IDBPDatabase } from 'idb';
import type { AssetCategory, AssetMinerSchemaType, AssetRecord } from './schema-shims';
import { sha256Hex } from '../../shared/hash';
import { baseName, extensionOf } from '../../core/identity/paths';
import { mimeFromExtension } from '../../shared/utils';

export function categorize(extension: string, mimeType: string): AssetCategory {
  const ext = extension.toLowerCase();
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'ico'].includes(ext)) {
    return ext === 'svg' ? 'vector' : 'image';
  }
  if (ext === 'svg' || mime === 'image/svg+xml') return 'vector';
  if (mime.startsWith('font/') || ['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) return 'font';
  if (mime.startsWith('audio/') || mime.startsWith('video/') || ['mp3', 'wav', 'ogg', 'mp4', 'webm'].includes(ext)) {
    return 'media';
  }
  if (['css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'xml', 'txt', 'md', 'csv', 'html'].includes(ext)) return 'source';
  if (['pdf', 'doc', 'docx'].includes(ext)) return 'document';
  return 'other';
}

export interface AssetDiscoveryInput {
  url: string;
  mimeTypeHint?: string;
}

/** Idempotent asset discovery keyed by project + URL hash. */
export async function ensureAssetDiscovered(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
  input: AssetDiscoveryInput,
): Promise<{ asset: AssetRecord; created: boolean }> {
  const urlHash = await sha256Hex(input.url);
  const assetId = `${projectId}::${urlHash}`;
  const existing = await db.get('assets', assetId);
  if (existing) return { asset: existing, created: false };

  let pathPart = input.url;
  try {
    const u = new URL(input.url);
    pathPart = u.pathname;
    if (u.protocol === 'data:') pathPart = '';
  } catch {
    /* not an absolute URL — use as-is */
  }
  const filename = pathPart === '' ? `asset-${urlHash.slice(0, 8)}` : baseName(pathPart) || `asset-${urlHash.slice(0, 8)}`;
  const ext = extensionOf(filename);
  const mimeType = input.mimeTypeHint ?? mimeFromExtension(ext);
  const record: AssetRecord = {
    assetId,
    projectId,
    url: input.url,
    category: categorize(ext, mimeType),
    filename,
    extension: ext,
    mimeType,
    chunkId: null,
    inlineText: null,
    byteSize: null,
    status: 'discovered',
    discoveredAt: Date.now(),
    capturedAt: null,
    lastError: null,
  };
  await db.put('assets', record);
  return { asset: record, created: true };
}

export async function setAssetCaptured(
  db: IDBPDatabase<AssetMinerSchemaType>,
  assetId: string,
  data: { chunkId?: string; inlineText?: string; byteSize?: number },
): Promise<void> {
  const asset = await db.get('assets', assetId);
  if (!asset) return;
  await db.put('assets', {
    ...asset,
    status: 'captured',
    chunkId: data.chunkId ?? asset.chunkId,
    inlineText: data.inlineText ?? asset.inlineText,
    byteSize: data.byteSize ?? asset.byteSize,
    capturedAt: Date.now(),
    lastError: null,
  });
}

export async function setAssetUnavailable(
  db: IDBPDatabase<AssetMinerSchemaType>,
  assetId: string,
  error: string,
): Promise<void> {
  const asset = await db.get('assets', assetId);
  if (!asset) return;
  await db.put('assets', { ...asset, status: 'unavailable', lastError: error });
}

export async function listAssets(
  db: IDBPDatabase<AssetMinerSchemaType>,
  projectId: string,
): Promise<AssetRecord[]> {
  return db.getAllFromIndex('assets', 'by-project', projectId);
}
