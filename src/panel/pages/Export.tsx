/**
 * Export Center (spec Part 11/13): mode selection, completeness summary,
 * ZIP export with honest validation report.
 */
import { useMemo, useState } from 'react';
import { usePanel } from '../store';
import { attachProjectAndAssets, buildExport, bundleToBlob, downloadBlob, type ExportMode } from '../../core/export/engine';
import { RangeBar } from '../components';

export function ExportPage() {
  const { state, db, projectId } = usePanel();
  const [mode, setMode] = useState<ExportMode>('original');
  const [includeAssets, setIncludeAssets] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const p = state.progress;
  const summaryRows = useMemo(() => {
    if (!p) return null;
    return [
      { label: 'Files discovered', value: p.totalFiles },
      { label: 'Verified complete', value: p.completeFiles },
      { label: 'Partially captured', value: p.partialFiles },
      { label: 'Never inspected', value: p.pendingFiles },
      { label: 'Folders (opened / total)', value: `${p.inspectedFolders}/${p.totalFolders}` },
      { label: 'Captured source lines', value: p.capturedLines.toLocaleString() },
    ];
  }, [p]);

  const doExport = async () => {
    if (!projectId || !state.project) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const bundle = await buildExport(db, projectId, mode);
      await attachProjectAndAssets(
        db,
        bundle,
        projectId,
        state.project.projectName,
        state.project.sourceOrigin,
        state.project.sourcePlatform,
        includeAssets,
        state.assets,
      );
      const blob = await bundleToBlob(bundle);
      downloadBlob(blob, bundle.filename);
      setResult(
        `${bundle.filename}: ${bundle.report.summary.filesIncluded} file(s) included, ${bundle.report.summary.filesSkipped} skipped. Archive marked ${bundle.report.summary.completeArchive ? 'COMPLETE' : 'INCOMPLETE — see asset-miner-report.json inside the ZIP'}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doExportSingle = async (fileId: string, filename: string) => {
    setBusy(true);
    try {
      const { readRevisionLines } = await import('../../storage/repositories/capture');
      const { downloadText } = await import('../../core/export/engine');
      const file = state.files.find((f) => f.fileId === fileId);
      if (!file?.currentRevisionId) return;
      const lines = await readRevisionLines(db, file.currentRevisionId);
      downloadText(lines.join('\n'), filename);
    } finally {
      setBusy(false);
    }
  };

  const incomplete = p !== null && (p.pendingFiles > 0 || p.partialFiles > 0 || p.conflictFiles > 0 || p.errorFiles > 0);

  return (
    <div>
      <div className="am-card">
        <h3>Completeness summary</h3>
        {summaryRows && p ? (
          <>
            <div className="am-list">
              {summaryRows.map((row) => (
                <div key={row.label} className="am-list-row">
                  <div className="am-grow am-sub">{row.label}</div>
                  <b style={{ color: '#e6edf3' }}>{row.value}</b>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <RangeBar captured={p.completeFiles} expected={p.totalFiles} missing={[]} />
              <div className="am-note" style={{ marginTop: 4 }}>
                {p.completeFiles}/{p.totalFiles} files fully captured & verified
              </div>
            </div>
          </>
        ) : (
          <div className="am-empty"><b>No project</b>Detect a project first.</div>
        )}
      </div>

      <div className="am-card">
        <h3>Export options</h3>
        <label className="am-toggle">
          <input type="radio" checked={mode === 'original'} onChange={() => setMode('original')} />
          <span>
            <b>Original recovery</b> — only genuinely captured content at original paths. Never inserts placeholders. Missing content stays out of files (gap lists in the report).
          </span>
        </label>
        <label className="am-toggle">
          <input type="radio" checked={mode === 'reconstructed'} onChange={() => setMode('reconstructed')} />
          <span>
            <b>Reconstructed</b> — fills uncaptured ranges with clearly-marked placeholder lines so the tree opens cleanly. Every synthesis is labeled in-file and in ASSET-MINER-RECONSTRUCTION.md.
          </span>
        </label>
        <label className="am-toggle">
          <input type="checkbox" checked={includeAssets} onChange={(e) => setIncludeAssets(e.target.checked)} />
          <span>Include captured page assets (images/fonts/etc.) under assets/</span>
        </label>
      </div>

      {incomplete && (
        <div className="am-card" style={{ borderColor: '#7a5c1a' }}>
          <h3>Before you export</h3>
          <div className="am-warn">
            This project is not fully captured. The ZIP will be generated honestly: captured content plus a report that identifies every missing range, unverified file and skipped path. It will NOT be marked complete.
          </div>
        </div>
      )}

      <div className="am-card">
        <h3>Actions</h3>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="am-btn am-btn-primary" disabled={busy || !projectId} onClick={() => void doExport()}>
            Export project ZIP
          </button>
        </div>
        {result && <div className="am-note" style={{ marginTop: 8 }}>{result}</div>}
        {error && <div className="am-err" style={{ marginTop: 8 }}>{error}</div>}
      </div>

      <div className="am-card">
        <h3>Individual file export</h3>
        <div className="am-list" style={{ maxHeight: 260, overflow: 'auto' }}>
          {state.files.filter((f) => f.currentRevisionId && f.capturedLineCount > 0).slice(0, 100).map((f) => (
            <div key={f.fileId} className="am-list-row">
              <span className="am-path am-grow">{f.relativePath}</span>
              <span className="am-sub">{f.capturedLineCount} ln</span>
              <button className="am-btn" disabled={busy} onClick={() => void doExportSingle(f.fileId, f.filename)}>Save</button>
            </div>
          ))}
          {state.files.filter((f) => f.currentRevisionId && f.capturedLineCount > 0).length === 0 && (
            <div className="am-empty"><b>No captured files yet</b></div>
          )}
        </div>
      </div>
    </div>
  );
}
