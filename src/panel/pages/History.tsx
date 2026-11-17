/**
 * Extraction History (spec Part 13): sessions, revisions, activity log.
 */
import { useEffect, useMemo, useState } from 'react';
import { usePanel } from '../store';
import { ActivityList } from '../components';
import { listSessions } from '../../storage/repositories/projects';
import type { CaptureSessionRecord } from '../../shared/types';

export function HistoryPage() {
  const { state, db, projectId } = usePanel();
  const [sessions, setSessions] = useState<CaptureSessionRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!projectId) return;
      const rows = await listSessions(db, projectId);
      if (!cancelled) setSessions(rows.sort((a, b) => b.startedAt - a.startedAt));
    })();
    return () => { cancelled = true; };
  }, [db, projectId, state.version]);

  const revisionEvents = useMemo(
    () => state.activity.filter((a) => a.kind === 'revision' || a.kind === 'conflict'),
    [state.activity],
  );

  return (
    <div>
      <div className="am-card">
        <h3>Capture sessions</h3>
        <div className="am-list">
          {sessions.map((s) => (
            <div key={s.sessionId} className="am-list-row">
              <span className={`am-dot ${s.status === 'running' ? 'am-dot-blue' : s.status === 'paused' ? 'am-dot-yellow' : s.status === 'interrupted' ? 'am-dot-red' : 'am-dot-grey'}`} />
              <div className="am-grow">
                <div className="am-path" style={{ fontFamily: 'inherit' }}>
                  {new Date(s.startedAt).toLocaleString()} — {s.adapterId}
                </div>
                <div className="am-sub">
                  status: {s.status}{s.activeFilePath ? ` · active: ${s.activeFilePath}` : ''} · last activity {new Date(s.lastActivityAt).toLocaleTimeString()}
                </div>
              </div>
            </div>
          ))}
          {sessions.length === 0 && <div className="am-empty"><b>No sessions yet</b>Sessions start when a project is first detected.</div>}
        </div>
        <div className="am-note" style={{ marginTop: 6 }}>
          Interrupted sessions (browser closed mid-capture) are kept and their data preserved; capture resumes on the next run.
        </div>
      </div>

      <div className="am-card">
        <h3>Revisions & conflicts</h3>
        <div className="am-list">
          {revisionEvents.slice(0, 30).map((a) => (
            <div key={a.activityId} className="am-list-row">
              <span className={`am-dot ${a.kind === 'conflict' ? 'am-dot-red' : 'am-dot-yellow'}`} />
              <div className="am-grow">
                <div className="am-path" style={{ fontFamily: 'inherit' }}>{a.message}</div>
                <div className="am-sub">{a.path ?? ''} · {new Date(a.at).toLocaleString()}</div>
              </div>
            </div>
          ))}
          {revisionEvents.length === 0 && <div className="am-empty"><b>No revision events</b>Source changes and conflicts appear here.</div>}
        </div>
      </div>

      <div className="am-card">
        <h3>Full activity log</h3>
        <ActivityList items={state.activity} />
      </div>
    </div>
  );
}
