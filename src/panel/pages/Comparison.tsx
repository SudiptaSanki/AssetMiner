/**
 * File Comparison (spec Part 8): original page editor vs captured copy,
 * synchronized, with missing-range and difference highlighting.
 */
import { useMemo, useState } from 'react';
import { usePanel } from '../store';
import { CodeViewer, type CodeLine } from '../components';
import { readRevisionLines } from '../../storage/repositories/capture';
import { detectEditorObserver } from '../../core/observers';

export function ComparisonPage() {
  const { state, db } = usePanel();
  const [fileId, setFileId] = useState<string | null>(null);
  const [captured, setCaptured] = useState<CodeLine[] | null>(null);
  const [live, setLive] = useState<CodeLine[] | null>(null);
  const [filter, setFilter] = useState('');

  const candidates = useMemo(
    () => state.files.filter((f) => !f.isBinary && f.capturedLineCount > 0),
    [state.files],
  );

  const selected = useMemo(
    () => candidates.find((f) => f.fileId === fileId) ?? candidates[0] ?? null,
    [candidates, fileId],
  );

  // Load captured + live snapshots for the selected file.
  useMemo(() => {
    let cancelled = false;
    (async () => {
      if (!selected?.currentRevisionId) {
        setCaptured([]);
        setLive(null);
        return;
      }
      const lines = await readRevisionLines(db, selected.currentRevisionId);
      const rows: CodeLine[] = lines.map((text, i) => ({ lineNo: i + 1, text, state: 'same' }));
      if (cancelled) return;
      setCaptured(rows);

      // Live side: read what the editor currently shows (may be a window).
      const observer = detectEditorObserver(document);
      if (observer) {
        const snap = observer.read();
        const rowsLive: CodeLine[] = [];
        for (const r of snap?.ranges ?? []) {
          for (let i = 0; i < r.lines.length; i++) {
            rowsLive.push({ lineNo: r.startLine + i, text: r.lines[i] ?? '', state: 'same' });
          }
        }
        // Mark differences where both sides have the line.
        const capturedMap = new Map(rows.map((l) => [l.lineNo, l.text]));
        for (const l of rowsLive) {
          const capturedText = capturedMap.get(l.lineNo);
          if (capturedText !== undefined && capturedText !== l.text) l.state = 'diff';
        }
        if (!cancelled) setLive(rowsLive);
      } else {
        if (!cancelled) setLive(null);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.fileId, selected?.currentRevisionId, db]);

  if (candidates.length === 0) {
    return (
      <div className="am-empty">
        <b>Nothing to compare yet</b>
        Capture at least one file, then compare the page editor against the stored copy here.
      </div>
    );
  }

  return (
    <div>
      <div className="am-search">
        <select
          className="am-btn"
          style={{ flex: 1 }}
          value={selected?.fileId ?? ''}
          onChange={(e) => setFileId(e.target.value)}
          aria-label="File to compare"
        >
          {candidates.map((f) => (
            <option key={f.fileId} value={f.fileId}>{f.relativePath}</option>
          ))}
        </select>
        <input placeholder="Find in file…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find in file" />
      </div>

      <div className="am-card">
        <h3>Source comparison</h3>
        <div className="am-note" style={{ marginBottom: 8 }}>
          LEFT: the page editor as visible right now (a window for virtualized editors).
          RIGHT: Asset Miner's captured copy. Red lines differ; ⟨ not captured ⟩ marks gaps.
          Differences here mean the source changed after capture — re-scroll or re-sync.
        </div>
        <div className="am-compare">
          <div>
            <h4>Original (live editor){live === null ? ' — not detected on this page' : ''}</h4>
            {live === null ? (
              <div className="am-note">Open the file in the page editor to see the live side.</div>
            ) : live.length === 0 ? (
              <div className="am-note">Editor content not currently rendered.</div>
            ) : (
              <CodeViewer lines={live} maxHeight={360} filter={filter} />
            )}
          </div>
          <div>
            <h4>Captured copy</h4>
            {captured && captured.length > 0 ? (
              <CodeViewer lines={captured} maxHeight={360} filter={filter} />
            ) : (
              <div className="am-note">No captured content for this file.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
