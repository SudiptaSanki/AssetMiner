/** Build a same-origin-safe thumbnail data URL for an asset record. */
import type { AssetRecord } from '../../shared/types';

export function buildAssetThumbnail(asset: AssetRecord): string | null {
  if (asset.inlineText?.startsWith('data:')) return asset.inlineText;
  if (asset.inlineText?.startsWith('base64:')) return `data:${asset.mimeType};base64,${asset.inlineText.slice(7)}`;
  if (asset.category === 'image' || asset.category === 'vector') {
    if (asset.url && !asset.url.startsWith('data:') && isSameOrigin(asset.url)) return asset.url;
  }
  return null;
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === location.origin;
  } catch {
    return false;
  }
}
