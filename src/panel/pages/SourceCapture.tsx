/**
 * Source Capture (spec Part 13): active file, live coverage, ranges, controls.
 */
import { useMemo, useState } from 'react';
import { usePanel } from '../store';
import { RangeBar, StatusDot } from '../components';
import { formatTimeAgo } from '../../shared/utils';
import { statusLabel } from '../../core/capture/CompletionDetector';
import { canonicalizeRelativePath } from '../../core/identity/paths';
import { collectDiagnostics } from '../../core/adapters/diagnostics';

export function SourceCapturePage() {
  const { state, controller, actions } = usePanel();
  const [showAll, setShowAll] = useState(false);

  const liveStatus = controller.adapterInfo.liveStatus?.() ?? null;

  // The "active" file: live adapter location or most recently inspected.
  const activeFile = useMemo(() => {
    const livePath = liveStatus?.activePath ?? controller.activeFilePath;
    if (livePath) {
      const exact = state.files.find((f) => f.relativePath === livePath);
      if (exact) return exact;
    }
    const candidates = state.files.filter((f) => f.captureState === 'capturing');
    if (candidates.length > 0) return candidates[0]!;
    const inspected = [...state.files]
      .filter((f) => f.lastInspectedAt !== null)
      .sort((a, b) => (b.lastInspectedAt ?? 0) - (a.lastInspectedAt ?? 0));
    return inspected[0] ?? null;
  }, [state.files, liveStatus?.activePath, controller.activeFilePath]);

  const status = actions.captureStatus();

  const conflictFiles = useMemo(
    () => state.files.filter((f) => f.verificationState === 'conflict' || f.conflictCount > 0),
    [state.files],
  );
  const errorFiles = useMemo(() => state.files.filter((f) => f.lastError), [state.files]);
  const listed = showAll ? state.files : state.files.filter((f) => f.captureState !== 'pending').slice(0, 40);

  return (
    <div>
      <CaptureCoach activeFile={activeFile} />
      <DiagnosticsCard />

      <div className="am-card">
        <h3>Capture session</h3>
        <dl className="am-kv">
          <dt>State</dt><dd>{status}</dd>
          <dt>Adapter</dt><dd>{controller.adapterInfo.displayName}</dd>
          <dt>Active file</dt><dd>{liveStatus?.activePath ?? activeFile?.relativePath ?? '—'}</dd>
          {liveStatus && (
            <>
              <dt>Capture mode</dt>
              <dd>{liveStatus.fullTextAvailable ? 'Full editor document (page bridge active)' : 'DOM-visible progressive scroll'}</dd>
            </>
          )}
        </dl>
        <div className="am-note" style={{ marginTop: 6 }}>
          {controller.adapterInfo.notes}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {status === 'running' && <button className="am-btn" onClick={actions.pauseCapture}>Pause capture</button>}
          {status === 'paused' && <button className="am-btn am-btn-primary" onClick={actions.resumeCapture}>Resume capture</button>}
          {(status === 'running' || status === 'paused') && <button className="am-btn am-btn-danger" onClick={actions.stopCapture}>Stop capture</button>}
        </div>
        <div className="am-note" style={{ marginTop: 6 }}>
          While running, opening files and scrolling records exposed content automatically — no per-scroll button.
        </div>
      </div>

      {activeFile && !activeFile.isBinary && (
        <div className="am-card">
          <h3>Active file coverage</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <StatusDot capture={activeFile.captureState} verification={activeFile.verificationState} />
            <b style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{activeFile.relativePath}</b>
          </div>
          <RangeBar captured={activeFile.capturedLineCount} expected={activeFile.expectedLineCount} missing={activeFile.missingRanges} />
          <div className="am-note" style={{ marginTop: 6 }}>
            {activeFile.expectedLineCount !== null
              ? `Captured ${activeFile.capturedLineCount} / ${activeFile.expectedLineCount} lines (${activeFile.coveragePercent ?? 0}%) — total from ${activeFile.expectedLineCountSource ?? 'unknown'}`
              : `Captured ${activeFile.capturedLineCount} lines — total length unknown, coverage not measurable`}
            {' · '}{statusLabel(activeFile.captureState, activeFile.verificationState)}
            {activeFile.lastInspectedAt !== null && ` · inspected ${formatTimeAgo(activeFile.lastInspectedAt)}`}
          </div>
          {activeFile.missingRanges.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="am-sub" style={{ color: '#9fb0c0', fontSize: 12, marginBottom: 4 }}>Missing ranges</div>
              <div className="am-list">
                {activeFile.missingRanges.slice(0, 12).map((m) => (
                  <div key={`${m.startLine}-${m.endLine}`} className="am-list-row">
                    <span className="am-path">lines {m.startLine}–{m.endLine}</span>
                    <span className="am-sub">{m.endLine - m.startLine + 1} lines</span>
                  </div>
                ))}
              </div>
              <div className="am-note" style={{ marginTop: 4 }}>Scroll through those ranges on the page (or run an authorized re-sync) to fill them.</div>
            </div>
          )}
        </div>
      )}

      {conflictFiles.length > 0 && (
        <div className="am-card" style={{ borderColor: '#7a2a2a' }}>
          <h3>Conflicts — action needed</h3>
          {conflictFiles.map((f) => (
            <div key={f.fileId} className="am-list-row">
              <StatusDot capture={f.captureState} verification={f.verificationState} />
              <div className="am-grow">
                <div className="am-path">{f.relativePath}</div>
                <div className="am-sub">{f.conflictCount} conflicting range(s) — two captures disagree; re-open the file or use an authorized re-sync.</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {errorFiles.length > 0 && (
        <div className="am-card" style={{ borderColor: '#7a2a2a' }}>
          <h3>Errors</h3>
          {errorFiles.slice(0, 10).map((f) => (
            <div key={f.fileId} className="am-list-row">
              <StatusDot capture={f.captureState} verification={f.verificationState} />
              <div className="am-grow">
                <div className="am-path">{f.relativePath}</div>
                <div className="am-err">{f.lastError}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="am-card">
        <h3>Files in capture ({listed.length}{!showAll && state.files.length > listed.length ? ` of ${state.files.length}` : ''})</h3>
        <div className="am-list">
          {listed.map((f) => (
            <div key={f.fileId} className="am-list-row">
              <StatusDot capture={f.captureState} verification={f.verificationState} />
              <div className="am-grow">
                <div className="am-path">{f.relativePath}{f.pathSource === 'heuristic' ? ' (heuristic path)' : ''}</div>
                <RangeBar captured={f.capturedLineCount} expected={f.expectedLineCount} missing={f.missingRanges} />
              </div>
              <span className="am-sub" style={{ flex: 'none' }}>
                {f.coveragePercent !== null ? `${f.coveragePercent}%` : `${f.capturedLineCount} ln`}
              </span>
            </div>
          ))}
          {listed.length === 0 && <div className="am-empty"><b>No capture yet</b>Open a file on the page.</div>}
        </div>
        {!showAll && state.files.length > listed.length && (
          <button className="am-btn" style={{ marginTop: 8 }} onClick={() => setShowAll(true)}>
            Show all {state.files.length} files
          </button>
        )}
      </div>
    </div>
  );
}

// keep tree-shaker honest: canonicalize is used by tests re-exported elsewhere
void canonicalizeRelativePath;

/**
 * DiagnosticsCard — troubleshooting surface for unsupported platforms
 * (blink.new today). Shows what was detected and produces a shareable
 * snapshot so real selectors can be configured from VERIFIED DOM —
 * nothing is invented.
 */
export function DiagnosticsCard() {
  const { controller, actions } = usePanel();
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = () => {
    const data = collectDiagnostics(controller.adapterInfo);
    setSnapshot(JSON.stringify(data, null, 2));
    setCopied(false);
    actions.refresh();
  };

  const copy = async () => {
    if (!snapshot) return;
    try {
      await navigator.clipboard.writeText(snapshot);
      setCopied(true);
    } catch {
      // Clipboard can be blocked; the raw text stays selectable below.
      setCopied(false);
    }
  };

  return (
    <div className="am-card">
      <h3>Diagnostics — nothing capturing?</h3>
      <div className="am-note">
        On platforms without a dedicated adapter (blink.new), capture works when a known editor
        (CodeMirror/Monaco) is rendered. If the panel stayed empty:
        <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          <li>Open the platform's <b>Code</b> section and <b>click a file</b> so the editor renders.</li>
          <li>Asset Miner re-scans every ~1.5s and binds automatically once the editor exists.</li>
          <li>Still nothing? Press <b>Run diagnostics</b> — if an editor is found it will show its type here.</li>
          <li>For full tree/folder support, <b>Copy diagnostics</b> and share the snapshot: the platform's real selectors get configured from it.</li>
        </ol>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="am-btn" onClick={run}>Run diagnostics</button>
        {snapshot && (
          <button className="am-btn am-btn-primary" onClick={() => void copy()}>
            {copied ? 'Copied ✓' : 'Copy diagnostics'}
          </button>
        )}
      </div>
      {snapshot && (
        <pre className="am-code" style={{ marginTop: 8, maxHeight: 220, whiteSpace: 'pre-wrap', fontSize: 10.5 }}>
          {snapshot}
        </pre>
      )}
    </div>
  );
}

/**
 * CaptureCoach — tells the user exactly how to capture a file COMPLETELY
 * (user requirement: slow scrolling, both directions). Virtualized editors
 * only render the visible window; fast scrolling skips lines, so the coach
 * drives a two-pass rhythm and points at the precise remaining ranges.
 */
export function CaptureCoach({ activeFile }: { activeFile: import('../../shared/types').FileRecord | null }) {
  if (!activeFile || activeFile.isBinary) return null;
  const total = activeFile.expectedLineCount;
  const captured = activeFile.capturedLineCount;
  const missing = activeFile.missingRanges;
  const unverified = activeFile.captureState === 'captured-full' && activeFile.verificationState !== 'verified';
  const completeVerified = activeFile.captureState === 'captured-full' && activeFile.verificationState === 'verified';

  return (
    <div className="am-card" style={{ borderColor: completeVerified ? '#2a5c33' : '#3a4a5c' }}>
      <h3>Capture coach</h3>
      {completeVerified ? (
        <div className="am-note" style={{ color: '#7bd88f' }}>
          ✓ {activeFile.relativePath} is captured and verified. You can move to the next file — or re-open it anytime; Asset Miner will reuse its record without duplicating anything.
        </div>
      ) : unverified ? (
        <div className="am-note">
          <b style={{ color: '#d29922' }}>All {total} lines captured — one more pass for verification.</b><br />
          Scroll through this file once more, slowly from top to bottom. The editor re-renders the same lines; Asset Miner compares them with what it stored. When a second independent observation matches, the file turns <span className="am-dot am-dot-green" style={{ verticalAlign: 'middle' }} /> Verified complete.
        </div>
      ) : (
        <div className="am-note">
          <b style={{ color: '#9fb0c0' }}>How to capture {total !== null ? `all ${total} lines` : 'the full file'}:</b>
          <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li>Scroll <b>slowly</b> to the bottom — virtualized editors only render what you see, so fast scrolling skips lines.</li>
            <li>Then scroll back <b>up slowly</b> to the top — this fills lines the first pass missed and gives consistency evidence.</li>
            <li>Watch the coverage bar below grow; keep going until missing ranges are empty.</li>
            <li>If the platform offers an export/re-sync button, run it — a complete authorized document verifies instantly.</li>
          </ol>
        </div>
      )}
      {missing.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="am-sub" style={{ color: '#9fb0c0', fontSize: 12, marginBottom: 4 }}>
            Next: scroll through these ranges ({captured}{total !== null ? `/${total}` : ''} lines captured so far)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {missing.slice(0, 10).map((m) => (
              <span key={`${m.startLine}-${m.endLine}`} className="am-btn" style={{ cursor: 'default', fontSize: 11 }}>
                lines {m.startLine}–{m.endLine}
              </span>
            ))}
            {missing.length > 10 && <span className="am-note">+{missing.length - 10} more</span>}
          </div>
        </div>
      )}
    </div>
  );
}
