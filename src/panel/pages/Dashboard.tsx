/**
 * Dashboard (spec Part 13): project identity, honest totals, recent activity.
 */
import { usePanel } from '../store';
import { ActivityList, RangeBar, StatusDot } from '../components';
import { formatBytes } from '../../shared/utils';

export function DashboardPage() {
  const { state, actions } = usePanel();
  const { project, progress } = state;

  if (!project) {
    return (
      <div>
        <div className="am-card">
          <h3>Getting started</h3>
          <div className="am-empty">
            <b>No project detected on this page yet</b>
            Browse the website — open its file tree or code section. Asset Miner records what you inspect and shows progress here. Nothing is uploaded anywhere; everything stays in this browser.
          </div>
        </div>
        <div className="am-card">
          <h3>Adapter</h3>
          <div className="am-note">{state.adapterNotes}</div>
        </div>
      </div>
    );
  }

  const p = progress;
  return (
    <div>
      {state.lastError && (
        <div className="am-card" style={{ borderColor: '#7a2a2a' }}>
          <h3>Last error</h3>
          <div className="am-err">{state.lastError}</div>
        </div>
      )}
      <div className="am-card">
        <h3>Extraction summary</h3>
        <div className="am-stats">
          <div className="am-stat"><b>{p?.totalFiles ?? 0}</b><span>files discovered</span></div>
          <div className="am-stat"><b>{p?.completeFiles ?? 0}</b><span>verified complete</span></div>
          <div className="am-stat"><b>{p?.partialFiles ?? 0}</b><span>partially captured</span></div>
          <div className="am-stat"><b>{p?.pendingFiles ?? 0}</b><span>not inspected</span></div>
          <div className="am-stat"><b>{p?.conflictFiles ?? 0}</b><span>conflicts</span></div>
          <div className="am-stat"><b>{p?.errorFiles ?? 0}</b><span>errors</span></div>
          <div className="am-stat"><b>{p?.totalFolders ?? 0}</b><span>folders ({p?.inspectedFolders ?? 0} opened)</span></div>
          <div className="am-stat"><b>{(p?.capturedLines ?? 0).toLocaleString()}</b><span>captured lines</span></div>
          <div className="am-stat"><b>{formatBytes(p?.capturedBytes ?? 0)}</b><span>captured bytes</span></div>
        </div>
        <div style={{ marginTop: 10 }}>
          <div className="am-note">
            Files fully captured: <b style={{ color: '#e6edf3' }}>{p?.extractionPercent ?? 0}%</b>
            {' '}({p?.completeFiles ?? 0}/{p?.totalFiles ?? 0} — a file-count metric; line coverage per file is shown in the Explorer)
          </div>
          <RangeBar
            captured={p?.completeFiles ?? 0}
            expected={p?.totalFiles ?? null}
            missing={[]}
          />
        </div>
        <div className="am-note" style={{ marginTop: 8 }}>
          Discovery ≠ extraction: discovered files are only counted complete when capture AND verification both succeeded.
        </div>
      </div>

      <div className="am-card">
        <h3>Project</h3>
        <dl className="am-kv">
          <dt>Name</dt><dd>{project.projectName}</dd>
          <dt>Platform</dt><dd>{project.sourcePlatform}</dd>
          <dt>Origin</dt><dd>{project.sourceOrigin}</dd>
          <dt>Project ID</dt><dd>{project.projectId}</dd>
          <dt>Created</dt><dd>{new Date(project.createdAt).toLocaleString()}</dd>
        </dl>
        <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          <button className="am-btn" onClick={actions.refresh}>Refresh</button>
        </div>
      </div>

      <div className="am-card">
        <h3>Recent activity</h3>
        <ActivityList items={state.activity.slice(0, 12)} />
      </div>
    </div>
  );
}

// Re-exported for the Explorer header chip.
export function ConflictChip({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="am-warn">
      <StatusDot capture="partial" verification="conflict" /> {count} unresolved
    </span>
  );
}
