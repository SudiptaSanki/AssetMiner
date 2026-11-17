/**
 * Assets (spec Part 9/13): page resource discovery, preview, selection, export.
 */
import { useEffect, useMemo, useState } from 'react';
import { usePanel } from '../store';
import { fetchAndStoreAsset, type AssetViewModel } from '../assetActions';
import { buildAssetThumbnail } from '../../core/assets/thumbnails';
import { formatBytes } from '../../shared/utils';

const CATEGORY_ICON: Record<string, string> = {
  image: '🖼', vector: '✒', font: '🅰', source: '{ }', media: '▶', document: '🖨', other: '▪',
};

export function AssetsPage() {
  const { state, actions, controller } = usePanel();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [view, setView] = useState<AssetViewModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [catFilter, setCatFilter] = useState<string>('all');

  const categories = useMemo(() => {
    const set = new Set(state.assets.map((a) => a.category));
    return ['all', ...[...set].sort()];
  }, [state.assets]);

  const visible = useMemo(
    () => (catFilter === 'all' ? state.assets : state.assets.filter((a) => a.category === catFilter)),
    [state.assets, catFilter],
  );

  // Discover page resources on first visit to this section per session change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await fetchAndStoreAsset.discover(controller, () => {
          if (!cancelled) actions.refresh();
        });
      } catch {
        /* discovery is best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [controller, actions]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const captureOne = async (assetId: string) => {
    setBusy(true);
    try {
      await fetchAndStoreAsset.capture(controller, assetId, () => actions.refresh());
    } finally {
      setBusy(false);
    }
  };

  const captureSelected = async () => {
    setBusy(true);
    try {
      for (const id of selected) {
        await fetchAndStoreAsset.capture(controller, id, () => actions.refresh());
      }
    } finally {
      setBusy(false);
    }
  };

  const exportSelected = async () => {
    setBusy(true);
    try {
      await fetchAndStoreAsset.exportSelected(controller, [...selected], () => actions.refresh());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="am-card">
        <h3>Page resources</h3>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {categories.map((c) => (
            <button key={c} className={`am-btn${catFilter === c ? ' am-btn-primary' : ''}`} onClick={() => setCatFilter(c)}>
              {c === 'all' ? `all (${state.assets.length})` : `${CATEGORY_ICON[c] ?? c} ${c} (${state.assets.filter((a) => a.category === c).length})`}
            </button>
          ))}
        </div>
        <div className="am-note">
          Resources visible on this page (images, fonts, styles…). Data-URI and inline SVG content is captured directly; remote resources are fetched from the page origin only, on demand.
        </div>
        {selected.size > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="am-btn am-btn-primary" disabled={busy} onClick={captureSelected}>Capture selected ({selected.size})</button>
            <button className="am-btn" disabled={busy} onClick={exportSelected}>Export selected</button>
            <button className="am-btn" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}
      </div>

      {view && (
        <div className="am-card">
          <h3>Preview — {view.asset.filename}</h3>
          {view.previewKind === 'image' && <img src={view.previewUrl} alt={view.asset.filename} style={{ maxWidth: '100%', maxHeight: 220, background: '#0b0f14', borderRadius: 6 }} />}
          {view.previewKind === 'code' && <pre className="am-code" style={{ maxHeight: 240, whiteSpace: 'pre-wrap' }}>{view.previewText}</pre>}
          {view.previewKind === 'none' && <div className="am-note">No preview for this type. Status: {view.asset.status}</div>}
          <dl className="am-kv" style={{ marginTop: 8 }}>
            <dt>URL</dt><dd>{view.asset.url.length > 120 ? `${view.asset.url.slice(0, 120)}…` : view.asset.url}</dd>
            <dt>Type</dt><dd>{view.asset.mimeType} · {view.asset.category}</dd>
            <dt>Size</dt><dd>{formatBytes(view.asset.byteSize)}</dd>
            <dt>Status</dt><dd>{view.asset.status}{view.asset.lastError ? ` — ${view.asset.lastError}` : ''}</dd>
          </dl>
        </div>
      )}

      <div className="am-card">
        <h3>Discovered resources ({visible.length})</h3>
        <div className="am-grid">
          {visible.map((a) => {
            const thumb = buildAssetThumbnail(a);
            return (
            <div key={a.assetId} className={`am-tile${selected.has(a.assetId) ? ' am-selected' : ''}`} onClick={() => toggle(a.assetId)}>
              {thumb ? <img src={thumb} alt="" /> : <div style={{ height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26 }}>{CATEGORY_ICON[a.category] ?? '▪'}</div>}
              <div className="am-tilename" title={a.filename}>{a.filename}</div>
              <div className="am-tilemeta">{a.status === 'captured' ? 'captured' : a.status === 'unavailable' ? 'unavailable' : 'discovered'}{a.byteSize !== null ? ` · ${formatBytes(a.byteSize)}` : ''}</div>
              <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                <button className="am-btn" style={{ fontSize: 11, padding: '2px 6px', flex: 1 }} onClick={(e) => { e.stopPropagation(); void (async () => { togglePreview(a); })(); }}>Preview</button>
                <button className="am-btn" style={{ fontSize: 11, padding: '2px 6px', flex: 1 }} disabled={busy || a.status === 'unavailable'} onClick={(e) => { e.stopPropagation(); void captureOne(a.assetId); }}>Capture</button>
              </div>
            </div>
            );
          })}
          {visible.length === 0 && <div className="am-empty"><b>No resources found yet</b>Asset Miner lists resources the page actually loads.</div>}
        </div>
      </div>
    </div>
  );

  function togglePreview(a: (typeof visible)[number]) {
    void (async () => {
      const vm = await fetchAndStoreAsset.preview(controller, a.assetId);
      setView(vm);
    })();
  }
}
