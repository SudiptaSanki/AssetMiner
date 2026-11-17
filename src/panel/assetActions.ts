/**
 * Asset actions bridging the panel UI to the asset pipeline: discovery,
 * capture (fetch from page origin only), preview and export.
 */
import type { CaptureController } from '../core/capture/CaptureController';
import { discoverPageAssets, type DiscoveredAsset } from '../core/assets/scanner';
import { ensureAssetDiscovered, listAssets, setAssetCaptured, setAssetUnavailable } from '../storage/repositories/assets';
import { exportAssetsAsZip } from '../core/assets/exportAssets';
import { deepQuerySelectorAll } from '../core/observers';
import { readControllerDb } from './controllerDb';

function controllerDb(controller: CaptureController) {
  return readControllerDb(controller);
}

function captureLoadedImageFallback(url: string): string | null {
  try {
    const imgs = deepQuerySelectorAll('img', document) as HTMLImageElement[];
    const match = imgs.find((img) => (img.currentSrc || img.src) === url && img.complete && img.naturalWidth > 0);
    if (!match) return null;
    const canvas = document.createElement('canvas');
    canvas.width = match.naturalWidth;
    canvas.height = match.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(match, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

export interface AssetViewModel {
  asset: {
    assetId: string;
    url: string;
    filename: string;
    mimeType: string;
    category: string;
    byteSize: number | null;
    status: string;
    lastError: string | null;
  };
  previewKind: 'image' | 'code' | 'none';
  previewUrl?: string;
  previewText?: string;
}

/** Fetch a resource from the page origin (or blob/loaded img); no third-party upload. */
async function fetchResource(url: string): Promise<{ bytes: ArrayBuffer | null; text: string | null; error?: string }> {
  if (url.startsWith('data:')) {
    return { bytes: null, text: url, error: undefined };
  }
  try {
    const u = new URL(url, location.href);
    if (!url.startsWith('blob:') && u.origin !== location.origin) {
      const fallback = captureLoadedImageFallback(url);
      if (fallback) return { bytes: null, text: fallback };
      return { bytes: null, text: null, error: 'cross-origin resource — skipped (minimum-permission policy)' };
    }
    const res = await fetch(u.href, { credentials: 'omit' });
    if (!res.ok) {
      const fallback = captureLoadedImageFallback(url);
      if (fallback) return { bytes: null, text: fallback };
      return { bytes: null, text: null, error: `HTTP ${res.status}` };
    }
    const buf = await res.arrayBuffer();
    return { bytes: buf, text: null };
  } catch (err) {
    const fallback = captureLoadedImageFallback(url);
    if (fallback) return { bytes: null, text: fallback };
    return { bytes: null, text: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    out += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

export const fetchAndStoreAsset = {
  /** Scan the page and upsert discovered resources (idempotent). */
  async discover(controller: CaptureController, onChanged: () => void): Promise<void> {
    const projectId = controller.projectId;
    if (!projectId) return;
    const found: DiscoveredAsset[] = discoverPageAssets();
    for (const item of found) {
      const { created } = await ensureAssetDiscovered(controllerDb(controller), projectId, {
        url: item.url,
        mimeTypeHint: item.mimeTypeHint,
      });
      if (created) onChanged();
    }
    onChanged();
  },

  /** Fetch + store one asset's bytes (addendum: untrusted, inert storage). */
  async capture(controller: CaptureController, assetId: string, onChanged: () => void): Promise<void> {
    const db = controllerDb(controller);
    const projectId = controller.projectId;
    if (!projectId) return;
    const asset = await db.get('assets', assetId);
    if (!asset) return;
    const res = await fetchResource(asset.url);
    if (res.error && res.bytes === null && res.text === null) {
      await setAssetUnavailable(db, assetId, res.error);
      onChanged();
      return;
    }
    if (res.text !== null && res.text.startsWith('data:')) {
      // Data URI stored as-is; thumbnails derive from it directly.
      await setAssetCaptured(db, assetId, { inlineText: res.text, byteSize: Math.round((res.text.length * 3) / 4) });
    } else if (res.bytes !== null) {
      const base64 = toBase64(res.bytes);
      await setAssetCaptured(db, assetId, { inlineText: `base64:${base64}`, byteSize: res.bytes.byteLength });
    } else {
      await setAssetUnavailable(db, assetId, res.error ?? 'empty response');
    }
    onChanged();
  },

  /** Build an inert preview model (no script execution, ever). */
  async preview(controller: CaptureController, assetId: string): Promise<AssetViewModel> {
    const db = controllerDb(controller);
    const asset = await db.get('assets', assetId);
    if (!asset) {
      return { asset: { assetId, url: '', filename: '?', mimeType: '', category: 'other', byteSize: null, status: 'unknown', lastError: null }, previewKind: 'none' };
    }
    let previewKind: AssetViewModel['previewKind'] = 'none';
    let previewUrl: string | undefined;
    let previewText: string | undefined;

    if (asset.category === 'image' || asset.category === 'vector') {
      previewKind = 'image';
      if (asset.inlineText?.startsWith('data:')) previewUrl = asset.inlineText;
      else if (asset.inlineText?.startsWith('base64:')) previewUrl = `data:${asset.mimeType};base64,${asset.inlineText.slice(7)}`;
      else if (asset.status !== 'captured') previewUrl = asset.url; // direct load from page origin
    } else if (asset.category === 'source' || asset.category === 'other') {
      if (asset.inlineText?.startsWith('data:')) {
        const comma = asset.inlineText.indexOf(',');
        try {
          previewText = decodeURIComponent(atob(asset.inlineText.slice(comma + 1)));
          previewKind = 'code';
        } catch { /* not decodable text */ }
      } else if (asset.inlineText?.startsWith('base64:')) {
        try {
          previewText = atob(asset.inlineText.slice(7));
          previewKind = 'code';
        } catch { /* binary */ }
      } else if (asset.url && !asset.url.startsWith('data:')) {
        try {
          const u = new URL(asset.url);
          if (u.origin === location.origin) {
            const res = await fetch(asset.url, { credentials: 'omit' });
            if (res.ok) {
              const text = await res.text();
              previewText = text.slice(0, 20000);
              previewKind = 'code';
            }
          }
        } catch { /* preview is best-effort */ }
      }
    }
    return { asset: { ...asset }, previewKind, previewUrl, previewText };
  },

  /** Export selected assets as a ZIP via anchor download (local-only). */
  async exportSelected(controller: CaptureController, assetIds: string[], onChanged: () => void): Promise<void> {
    const db = controllerDb(controller);
    const projectId = controller.projectId;
    if (!projectId) return;
    const assets = await listAssets(db, projectId);
    const chosen = assets.filter((a) => assetIds.includes(a.assetId));
    await exportAssetsAsZip(db, chosen, `asset-miner-assets-${new Date().toISOString().slice(0, 10)}.zip`);
    onChanged();
  },
};
