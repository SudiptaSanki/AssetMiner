/**
 * Settings (spec Part 13): layout, workspace mode, storage management,
 * privacy posture, data deletion.
 */
import { useState } from 'react';
import { usePanel } from '../store';
import { RATIO_MAX, RATIO_MIN } from '../../shared/types';
import { formatBytes } from '../../shared/utils';
import { deleteProjectCascade, garbageCollectChunks } from '../../storage/repositories/projects';
import { listProjects } from '../../storage/repositories/projects';
import { listFiles } from '../../storage/repositories/tree';
import { ERROR_MESSAGES } from '../../shared/errors';

export function SettingsPage() {
  const { state, db, actions, host } = usePanel();
  const settings = actions.getSettings();
  const [storageInfo, setStorageInfo] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const estimateStorage = async () => {
    setBusy(true);
    try {
      let text = '';
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        text = `usage ${formatBytes(est.usage ?? null)} of ${formatBytes(est.quota ?? null)} quota`;
      } else {
        text = 'estimate unavailable in this browser';
      }
      const projects = await listProjects(db);
      let files = 0;
      for (const p of projects) files += (await listFiles(db, p.projectId)).length;
      setStorageInfo(`${text} · ${projects.length} project(s), ${files} file record(s)`);
    } finally {
      setBusy(false);
    }
  };

  const gc = async () => {
    setBusy(true);
    try {
      const removed = await garbageCollectChunks(db);
      setStorageInfo(`garbage collection removed ${removed} unreferenced chunk(s)`);
      actions.refresh();
    } finally {
      setBusy(false);
    }
  };

  const deleteAll = async () => {
    setBusy(true);
    try {
      const projects = await listProjects(db);
      for (const p of projects) {
        await deleteProjectCascade(db, p.projectId);
      }
      await garbageCollectChunks(db);
      setConfirmDelete(false);
      actions.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="am-card">
        <h3>Workspace layout</h3>
        <label className="am-toggle">
          <span style={{ minWidth: 130 }}>Panel width</span>
          <input
            type="range"
            min={RATIO_MIN * 100}
            max={RATIO_MAX * 100}
            value={Math.round(settings.ratio * 100)}
            onChange={(e) => actions.updateSettings({ ratio: Number(e.target.value) / 100 })}
          />
          <b style={{ minWidth: 40 }}>{Math.round(settings.ratio * 100)}%</b>
        </label>
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button className="am-btn" onClick={actions.resetLayout}>Restore default 60% panel (40:60 split)</button>
        </div>
        <div className="am-toggle" style={{ marginTop: 10 }}>
          <span style={{ minWidth: 130 }}>Presentation</span>
          <label className="am-toggle">
            <input
              type="radio"
              checked={settings.workspaceMode === 'push'}
              onChange={() => actions.updateSettings({ workspaceMode: 'push' })}
            />
            <span>Push page aside (split view)</span>
          </label>
          <label className="am-toggle">
            <input
              type="radio"
              checked={settings.workspaceMode === 'overlay'}
              onChange={() => actions.updateSettings({ workspaceMode: 'overlay' })}
            />
            <span>Overlay (page unchanged)</span>
          </label>
        </div>
        <div className="am-note" style={{ marginTop: 6 }}>
          Drag the divider or focus it and use ←/→ (Home restores the default). The site side never shrinks below 320px.
        </div>
      </div>

      <div className="am-card">
        <h3>Storage</h3>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="am-btn" disabled={busy} onClick={() => void estimateStorage()}>Estimate usage</button>
          <button className="am-btn" disabled={busy} onClick={() => void gc()}>Clean unreferenced chunks</button>
        </div>
        {storageInfo && <div className="am-note" style={{ marginTop: 6 }}>{storageInfo}</div>}
        <div className="am-note" style={{ marginTop: 6 }}>
          All data lives in this browser's IndexedDB. {ERROR_MESSAGES.quota}
        </div>
      </div>

      <div className="am-card">
        <h3>Privacy</h3>
        <div className="am-note">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>No backend, no telemetry, no network calls by the extension itself.</li>
            <li>Captured page resources are fetched only from the page's own origin, on your click.</li>
            <li>Captured content is stored inertly and never executed.</li>
            <li>No passwords, cookies or authentication material are read or stored.</li>
            <li>The extension requests no host permissions up front; it reads only pages you activate it on (activeTab).</li>
          </ul>
        </div>
      </div>

      <div className="am-card" style={{ borderColor: '#7a2a2a' }}>
        <h3>Danger zone</h3>
        {!confirmDelete ? (
          <button className="am-btn am-btn-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Delete all saved projects and history
          </button>
        ) : (
          <div>
            <div className="am-err" style={{ marginBottom: 8 }}>
              This permanently removes every captured project, file, asset and log from this browser. There is no undo.
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="am-btn am-btn-danger" disabled={busy} onClick={() => void deleteAll()}>Yes, delete everything</button>
              <button className="am-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="am-card">
        <h3>Adapter</h3>
        <div className="am-note">{state.adapterNotes}</div>
        <div className="am-note" style={{ marginTop: 6 }}>
          Layout mode: {host.isVisible() ? 'panel visible' : 'panel hidden'} · origin: {state.origin}
        </div>
      </div>
    </div>
  );
}
