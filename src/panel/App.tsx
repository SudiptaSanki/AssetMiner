/**
 * App shell — section rail with the 8 sections (spec Part 3.3/13) plus a
 * live "Where I am" location bar showing the active website file & status.
 */
import { useState } from 'react';
import { usePanel } from './store';
import { StatusDot } from './components';
import { DashboardPage } from './pages/Dashboard';
import { ExplorerPage } from './pages/Explorer';
import { SourceCapturePage } from './pages/SourceCapture';
import { AssetsPage } from './pages/Assets';
import { ComparisonPage } from './pages/Comparison';
import { HistoryPage } from './pages/History';
import { ExportPage } from './pages/Export';
import { SettingsPage } from './pages/Settings';
import type { ControllerStatus } from '../core/capture/CaptureController';

type SectionId = 'dashboard' | 'explorer' | 'capture' | 'assets' | 'compare' | 'history' | 'export' | 'settings';

const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '◧' },
  { id: 'explorer', label: 'Project Explorer', icon: '🗀' },
  { id: 'capture', label: 'Source Capture', icon: '⇥' },
  { id: 'assets', label: 'Assets', icon: '⛄' },
  { id: 'compare', label: 'File Comparison', icon: '⇹' },
  { id: 'history', label: 'Extraction History', icon: '🕘' },
  { id: 'export', label: 'Export Center', icon: '⤓' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export function App() {
  const [section, setSection] = useState<SectionId>('dashboard');
  const { state, controller, actions } = usePanel();
  const status: ControllerStatus = actions.captureStatus();

  const statusPill =
    status === 'running' ? { cls: 'am-dot am-dot-blue', text: 'Capturing' } :
    status === 'paused' ? { cls: 'am-dot am-dot-yellow', text: 'Paused' } :
    { cls: 'am-dot am-dot-grey', text: 'Stopped' };

  const liveStatus = controller.adapterInfo.liveStatus?.() ?? null;
  const capturingFile = state.files.find((f) => f.captureState === 'capturing') ?? null;
  const activePath = liveStatus?.activePath ?? controller.activeFilePath ?? capturingFile?.relativePath ?? null;
  const activeFile = activePath ? state.files.find((f) => f.relativePath === activePath) ?? null : null;

  const activeBadge = (() => {
    if (!activeFile) return null;
    if (activeFile.captureState === 'captured-full' && activeFile.verificationState === 'verified') {
      return { cls: 'am-pill am-pill-green', text: `✓ Verified complete (${activeFile.capturedLineCount} ln)` };
    }
    if (activeFile.captureState === 'captured-full') {
      return { cls: 'am-pill am-pill-yellow', text: `↻ 100% captured (${activeFile.capturedLineCount} ln) — verifying` };
    }
    if (activeFile.expectedLineCount !== null) {
      return {
        cls: 'am-pill am-pill-yellow',
        text: `⬇ Scroll slowly to bottom: ${activeFile.capturedLineCount}/${activeFile.expectedLineCount} lines`,
      };
    }
    if (activeFile.capturedLineCount > 0) {
      return { cls: 'am-pill am-pill-yellow', text: `⬇ Scroll to bottom (${activeFile.capturedLineCount} ln)` };
    }
    return { cls: 'am-pill', text: 'Open on page to capture' };
  })();

  return (
    <div className="am-app">
      <nav className="am-rail" aria-label="Asset Miner sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={section === s.id ? 'am-active' : ''}
            title={s.label}
            aria-label={s.label}
            aria-current={section === s.id}
            onClick={() => setSection(s.id)}
          >
            {s.icon}
          </button>
        ))}
        <span className="am-spacer" />
      </nav>
      <div className="am-main">
        <header className="am-header">
          <span className={statusPill.cls} aria-label={`capture ${statusPill.text}`} />
          <div style={{ minWidth: 0 }}>
            <div className="am-title">{state.project?.projectName ?? 'No project detected'}</div>
            <div className="am-sub">{state.origin}</div>
          </div>
          <div className="am-right">
            {state.lastError && <span className="am-err" title={state.lastError}>⚠</span>}
            {status === 'running' && <button className="am-btn" onClick={actions.pauseCapture}>Pause</button>}
            {status === 'paused' && <button className="am-btn am-btn-primary" onClick={actions.resumeCapture}>Resume</button>}
            {(status === 'running' || status === 'paused') && <button className="am-btn" onClick={actions.stopCapture}>Stop</button>}
          </div>
        </header>
        <div className="am-livebar" aria-label="Active page location">
          <span className="am-sub" style={{ color: '#7b8694' }}>On page:</span>
          {activeFile && <StatusDot capture={activeFile.captureState} verification={activeFile.verificationState} />}
          <span className="am-livepath" title={activePath ?? undefined}>
            {activePath ?? 'No file open on page'}
          </span>
          {activeBadge && <span className={activeBadge.cls}>{activeBadge.text}</span>}
          {!activeBadge && liveStatus?.hint && <span className="am-note">{liveStatus.hint}</span>}
          {activePath && section !== 'explorer' && (
            <button
              className="am-btn"
              style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}
              onClick={() => setSection('explorer')}
            >
              Open in Explorer
            </button>
          )}
        </div>
        <main className="am-content">
          {section === 'dashboard' && <DashboardPage />}
          {section === 'explorer' && <ExplorerPage />}
          {section === 'capture' && <SourceCapturePage />}
          {section === 'assets' && <AssetsPage />}
          {section === 'compare' && <ComparisonPage />}
          {section === 'history' && <HistoryPage />}
          {section === 'export' && <ExportPage />}
          {section === 'settings' && <SettingsPage />}
        </main>
      </div>
    </div>
  );
}
