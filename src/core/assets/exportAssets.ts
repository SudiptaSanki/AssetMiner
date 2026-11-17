/** ZIP export for selected assets (content-script local download). */
import JSZip from 'jszip';
import type { IDBPDatabase } from 'idb';
import type { AssetMinerSchema } from '../../storage/db';
import type { AssetRecord } from '../../shared/types';
import { sanitizeForExport } from '../identity/paths';
import { downloadBlob } from '../export/engine';

export async function exportAssetsAsZip(
  db: IDBPDatabase<AssetMinerSchema>,
  assets: AssetRecord[],
  filename: string,
): Promise<void> {
  const zip = new JSZip();
  const used = new Set<string>();
  const manifest: { filename: string; url: string; mimeType: string; byteSize: number | null }[] = [];

  for (const asset of assets) {
    if (asset.status !== 'captured') continue;
    let data: string | null = null;
    let isBase64 = false;
    if (asset.inlineText?.startsWith('base64:')) {
      data = asset.inlineText.slice(7);
      isBase64 = true;
    } else if (asset.inlineText?.startsWith('data:')) {
      const comma = asset.inlineText.indexOf(',');
      if (comma > 0) {
        data = asset.inlineText.slice(comma + 1);
        isBase64 = true;
      }
    } else if (asset.chunkId) {
      const chunk = await db.get('chunks', asset.chunkId);
      if (chunk) {
        data = chunk.text;
        isBase64 = false;
      }
    }
    if (data === null) continue;
    let name = sanitizeForExport(asset.filename).path || `asset-${asset.assetId.slice(-8)}`;
    let n = 1;
    while (used.has(name)) {
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
      n += 1;
    }
    used.add(name);
    zip.file(name, data, isBase64 ? { base64: true } : undefined);
    manifest.push({ filename: name, url: asset.url, mimeType: asset.mimeType, byteSize: asset.byteSize });
  }

  zip.file('asset-miner-assets.json', JSON.stringify({ exportedAt: new Date().toISOString(), count: manifest.length, assets: manifest }, null, 2));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  downloadBlob(blob, filename);
}
