/**
 * Page resource scanner (spec Part 9) — discovery ONLY, no fetching.
 * Sources: <img>, inline <svg>, <link> stylesheets/fonts, srcset, video/audio,
 * CSS url() in inline styles, performance resource entries. Data URIs, blob:
 * and same-origin resources are capturable; cross-origin URLs are recorded but
 * marked unavailable on capture (minimum-permission posture).
 */
import { deepQuerySelectorAll } from '../observers';

export interface DiscoveredAsset {
  url: string;
  mimeTypeHint?: string;
}

const MAX_SCAN = 800;

export function discoverPageAssets(): DiscoveredAsset[] {
  const found = new Map<string, DiscoveredAsset>();

  const add = (url: string, hint?: string) => {
    if (!url || url.startsWith('javascript:')) return;
    if (url.startsWith('data:')) {
      // Only reasonably sized inline data is worth recording.
      if (url.length > 400_000) return;
      const mime = url.slice(5, url.indexOf(';') > 0 ? url.indexOf(';') : url.indexOf(','));
      found.set(url, { url, mimeTypeHint: mime });
      return;
    }
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'blob:') return;
      if (!found.has(u.href)) found.set(u.href, { url: u.href, mimeTypeHint: hint });
    } catch {
      /* malformed URL — skip */
    }
  };

  for (const el of deepQuerySelectorAll('img', document).slice(0, MAX_SCAN)) {
    const img = el as HTMLImageElement;
    add(img.currentSrc || img.src, undefined);
  }
  for (const svg of deepQuerySelectorAll('svg', document).slice(0, 200)) {
    if (svg.querySelector('foreignObject')) continue; // embedded HTML — skip
    try {
      const serialized = new XMLSerializer().serializeToString(svg);
      if (serialized.length <= 200_000) {
        const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(serialized)))}`;
        add(dataUrl, 'image/svg+xml');
      }
    } catch {
      /* serialization guard */
    }
  }
  for (const link of deepQuerySelectorAll('link[href]', document).slice(0, MAX_SCAN)) {
    const rel = (link as HTMLLinkElement).rel.toLowerCase();
    const type = (link as HTMLLinkElement).type || undefined;
    if (rel.includes('stylesheet') || rel.includes('icon') || rel.includes('font') || rel.includes('preload')) {
      add((link as HTMLLinkElement).href, type);
    }
  }
  for (const media of deepQuerySelectorAll('video, audio, source', document).slice(0, 200)) {
    add((media as HTMLMediaElement).src);
  }
  for (const el of deepQuerySelectorAll('[style*="url("]', document).slice(0, 200)) {
    const matches = el.style.cssText.match(/url\((['"]?)([^'")]+)\1\)/g) ?? [];
    for (const m of matches) {
      const inner = m.replace(/^url\((['"]?)/, '').replace(/\)$/, '').replace(/^['"]|['"]$/g, '');
      add(inner);
    }
  }
  // Performance entries catch resources the DOM no longer references.
  try {
    for (const entry of performance.getEntriesByType('resource').slice(-400)) {
      add(entry.name);
    }
  } catch {
    /* performance API unavailable */
  }

  return [...found.values()];
}
