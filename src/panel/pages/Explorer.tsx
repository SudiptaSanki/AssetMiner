/**
 * Project Explorer (spec Part 4/7.4): hierarchy with per-file indicators,
 * live "where am I" tracking, side-by-side IDE code/image preview & manual editing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePanel } from '../store';
import { CodeViewer, FileTree, type CodeLine } from '../components';
import { getFileDetail, readRevisionLines } from '../../storage/repositories/capture';
import { deepDetectEditorObserver, findBestEditorObserver } from '../../core/observers';
import { downloadBlob, downloadText } from '../../core/export/engine';
import { formatBytes, joinLines } from '../../shared/utils';
import type { FileRecord } from '../../shared/types';

export function ExplorerPage() {
  const { db, state, controller, actions } = usePanel();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [followActive, setFollowActive] = useState(true);
  const [previewLines, setPreviewLines] = useState<CodeLine[] | null>(null);
  const [binaryPreviewUrl, setBinaryPreviewUrl] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);

  // Manual code editor state
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // New file inline creator
  const [creatingNew, setCreatingNew] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [newFileText, setNewFileText] = useState('');

  const liveStatus = controller.adapterInfo.liveStatus?.() ?? null;
  const activePath = liveStatus?.activePath ?? controller.activeFilePath ?? null;

  const selected = useMemo(
    () => (selectedId ? state.files.find((f) => f.fileId === selectedId) ?? null : null),
    [state.files, selectedId],
  );

  const visibleFiles = useMemo(() => {
    if (!filter) return state.files;
    const f = filter.toLowerCase();
    return state.files.filter((x) => x.relativePath.toLowerCase().includes(f));
  }, [state.files, filter]);

  const loadFilePreview = useCallback(
    async (file: FileRecord) => {
      setLoading(true);
      try {
        const detail = await getFileDetail(db, file.fileId);
        if (!detail?.file.currentRevisionId) {
          setBinaryPreviewUrl(null);
          setPreviewLines([]);
          return;
        }
        if (file.isBinary) {
          setPreviewLines(null);
          const firstRange = detail.ranges[0];
          if (firstRange) {
            const chunk = await db.get('chunks', firstRange.chunkId);
            if (chunk?.text) {
              setBinaryPreviewUrl(`data:${file.mimeType || 'application/octet-stream'};base64,${chunk.text}`);
              return;
            }
          }
          setBinaryPreviewUrl(null);
          return;
        }
        setBinaryPreviewUrl(null);
        const lines = await readRevisionLines(db, detail.file.currentRevisionId);
        const expected = file.expectedLineCount ?? lines.length;
        const rows: CodeLine[] = [];
        for (let n = 1; n <= Math.max(expected, lines.length); n++) {
          const text = lines[n - 1];
          const inGap = file.missingRanges.some((m) => n >= m.startLine && n <= m.endLine);
          rows.push({
            lineNo: n,
            text: text === undefined || inGap ? null : text,
            state: text === undefined || inGap ? 'missing' : 'same',
          });
        }
        setPreviewLines(rows);
      } finally {
        setLoading(false);
      }
    },
    [db],
  );

  // Follow the active file on the website automatically when enabled.
  useEffect(() => {
    if (!followActive || editing || !activePath) return;
    const match = state.files.find((f) => f.relativePath === activePath);
    if (match && match.fileId !== selectedId) {
      setSelectedId(match.fileId);
      setNotice(null);
    }
  }, [followActive, editing, activePath, state.files, selectedId]);

  // Keep the selected file's preview synced with new captures.
  useEffect(() => {
    if (!selected || editing) return;
    void loadFilePreview(selected);
  }, [selected, state.version, editing, loadFilePreview]);

  const handleSelectFile = (file: FileRecord) => {
    setEditing(false);
    setNotice(null);
    setSelectedId(file.fileId);
  };

  const startEditing = async () => {
    if (!selected || selected.isBinary) return;
    let initial = '';
    if (selected.currentRevisionId) {
      const lines = await readRevisionLines(db, selected.currentRevisionId);
      initial = lines.join('\n');
    } else if (previewLines && previewLines.length > 0) {
      initial = previewLines.map((l) => l.text ?? '').join('\n');
    }
    setDraftText(initial);
    setEditing(true);
    setNotice(null);
  };

  const saveEdit = async () => {
    if (!selected) return;
    setSaving(true);
    setNotice(null);
    try {
      await controller.captureManualText(selected.relativePath, draftText, 'manual-edit');
      setEditing(false);
      actions.refresh();
      setNotice('Saved & marked verified.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const captureFromPageEditor = async () => {
    if (!selected) return;
    setNotice(null);
    // Ask the MAIN-world bridge to push full text if available.
    window.postMessage({ source: '__assetMinerContent', type: 'resend' }, '*');
    const observer = findBestEditorObserver(document) ?? deepDetectEditorObserver(document);
    const snap = observer?.read() ?? null;
    if (!snap || snap.ranges.length === 0) {
      setNotice('No visible code editor found on the page right now — open this file on the website or use Edit / Fix Code.');
      return;
    }
    const isWholeDocument =
      snap.ranges.length === 1 &&
      snap.ranges[0]!.startLine === 1 &&
      (snap.totalLinesHint === null || snap.totalLinesHint <= snap.ranges[0]!.endLine);
    if (isWholeDocument) {
      await controller.captureManualText(selected.relativePath, snap.ranges[0]!.lines.join('\n'), 'manual-capture');
      actions.refresh();
      setNotice(`Captured ${snap.ranges[0]!.lines.length} lines from page editor.`);
    } else {
      controller.ingestRemoteEvent({
        type: 'content-exposed',
        path: selected.relativePath,
        basis: 'dom-visible',
        ranges: snap.ranges,
        totalLinesHint: snap.totalLinesHint,
      });
      actions.refresh();
      const first = snap.ranges[0]!.startLine;
      const last = snap.ranges[snap.ranges.length - 1]!.endLine;
      setNotice(`Captured visible lines ${first}–${last} into ${selected.relativePath}. Scroll slowly to capture remaining lines.`);
    }
  };

  const saveSingleFile = async () => {
    if (!selected || !selected.currentRevisionId) return;
    if (selected.isBinary) {
      const detail = await getFileDetail(db, selected.fileId);
      const firstRange = detail?.ranges[0];
      if (!firstRange) return;
      const chunk = await db.get('chunks', firstRange.chunkId);
      if (!chunk?.text) return;
      const bin = atob(chunk.text);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      downloadBlob(new Blob([bytes], { type: selected.mimeType || 'application/octet-stream' }), selected.filename);
      return;
    }
    const lines = await readRevisionLines(db, selected.currentRevisionId);
    const expected = selected.expectedLineCount;
    const text = expected === null ? joinLines(lines) : joinLines(lines.slice(0, expected));
    downloadText(text, selected.filename);
  };

  const createNewFile = async () => {
    const path = newFilePath.trim();
    if (!path) return;
    setSaving(true);
    try {
      await controller.captureManualText(path, newFileText, 'manual-create');
      setCreatingNew(false);
      setNewFilePath('');
      setNewFileText('');
      actions.refresh();
    } finally {
      setSaving(false);
    }
  };

  const guidanceBanner = (() => {
    if (!selected) return null;
    if (selected.isBinary) {
      if (selected.captureState === 'captured-full' && selected.currentRevisionId) {
        return { cls: 'am-banner am-banner-ok', text: `✓ Binary asset captured (${formatBytes(selected.byteCount)}). Preview below and included in ZIP.` };
      }
      return { cls: 'am-banner am-banner-info', text: 'Open/preview this image on the website (or capture it in Assets) to store it at this tree path.' };
    }
    if (selected.captureState === 'captured-full' && selected.verificationState === 'verified') {
      return { cls: 'am-banner am-banner-ok', text: `✓ Full code captured (${selected.capturedLineCount} lines). No scrolling needed.` };
    }
    if (selected.captureState === 'captured-full') {
      return { cls: 'am-banner am-banner-warn', text: `↻ All ${selected.capturedLineCount} lines captured — one quick re-observation verifies it (or click Edit / Fix Code to save).` };
    }
    if (selected.capturedLineCount > 0) {
      const gapText = selected.missingRanges.length > 0
        ? selected.missingRanges.slice(0, 3).map((m) => `${m.startLine}–${m.endLine}`).join(', ')
        : 'remaining lines';
      return {
        cls: 'am-banner am-banner-warn',
        text: `⬇ Long file: scroll slowly from top to bottom on the website so the remaining lines (${gapText}) render and get captured without duplicates.`,
      };
    }
    return {
      cls: 'am-banner am-banner-info',
      text: 'Open this file on the website to capture it automatically — or click "Capture from Page Editor" / "Edit / Fix Code" below.',
    };
  })();

  return (
    <div>
      <div className="am-search">
        <input
          placeholder="Filter paths…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter file paths"
        />
        <span className="am-note" style={{ alignSelf: 'center' }}>{visibleFiles.length} files</span>
        <button className="am-btn" onClick={() => setCreatingNew((v) => !v)}>+ New File</button>
      </div>

      <label className="am-toggle" style={{ marginBottom: 6 }}>
        <input type="checkbox" checked={followActive} onChange={(e) => setFollowActive(e.target.checked)} />
        <span>Follow active file on page {activePath ? `(${activePath})` : ''}</span>
      </label>

      {creatingNew && (
        <div className="am-card">
          <h3>Create or paste a file</h3>
          <div className="am-search" style={{ marginTop: 0 }}>
            <input
              placeholder="Relative path (e.g. src/utils/helper.ts)"
              value={newFilePath}
              onChange={(e) => setNewFilePath(e.target.value)}
            />
          </div>
          <textarea
            className="am-editor"
            style={{ minHeight: 140 }}
            placeholder="Paste file contents here…"
            value={newFileText}
            onChange={(e) => setNewFileText(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="am-btn am-btn-primary" disabled={saving || !newFilePath.trim()} onClick={() => void createNewFile()}>
              Save File
            </button>
            <button className="am-btn" onClick={() => setCreatingNew(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="am-card">
        <h3>Project tree</h3>
        {state.folders.length === 0 && state.files.length === 0 ? (
          <div className="am-empty">
            <b>Nothing discovered yet</b>
            Expand folders on the website — the structure appears here with per-file status dots.
          </div>
        ) : (
          <FileTree
            folders={state.folders}
            files={visibleFiles}
            selectedFileId={selected?.fileId ?? null}
            activeFilePath={activePath}
            onSelectFile={handleSelectFile}
          />
        )}
        <div className="am-note" style={{ marginTop: 6 }}>
          Folder badges: ● all discovered files complete+verified · ◐ some progress · ○ none yet. Unopened folders are never marked complete.
        </div>
      </div>

      {selected && (
        <div className="am-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <h3 style={{ margin: 0, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', textTransform: 'none' }}>
              {selected.relativePath}
            </h3>
            {!selected.isBinary && !editing && (
              <>
                <button className="am-btn" onClick={() => void captureFromPageEditor()}>Capture from Page Editor</button>
                <button className="am-btn am-btn-primary" onClick={() => void startEditing()}>Edit / Fix Code</button>
              </>
            )}
            {selected.currentRevisionId && !editing && (
              <button className="am-btn" onClick={() => void saveSingleFile()}>Save File</button>
            )}
          </div>

          {guidanceBanner && <div className={guidanceBanner.cls}>{guidanceBanner.text}</div>}
          {notice && <div className="am-note" style={{ marginBottom: 6, color: '#79c0ff' }}>{notice}</div>}

          {editing ? (
            <div>
              <textarea
                className="am-editor"
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                aria-label={`Edit ${selected.relativePath}`}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <button className="am-btn am-btn-primary" disabled={saving} onClick={() => void saveEdit()}>
                  {saving ? 'Saving…' : 'Save & Mark Verified'}
                </button>
                <button className="am-btn" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
                <span className="am-note" style={{ marginLeft: 'auto' }}>
                  {draftText === '' ? 0 : draftText.split('\n').length} lines
                </span>
              </div>
            </div>
          ) : selected.isBinary ? (
            binaryPreviewUrl ? (
              <div style={{ textAlign: 'center', padding: 8, background: '#0b0f14', borderRadius: 6, border: '1px solid #222a31' }}>
                <img src={binaryPreviewUrl} alt={selected.filename} style={{ maxWidth: '100%', maxHeight: 240, objectFit: 'contain' }} />
              </div>
            ) : (
              <div className="am-note">
                Binary asset ({selected.mimeType}) — open its preview on the page or check the Assets section.
              </div>
            )
          ) : previewLines === null ? (
            <div className="am-note">{loading ? 'Loading…' : 'No content captured yet — open this file on the page and scroll through it.'}</div>
          ) : previewLines.length === 0 ? (
            <div className="am-note">No content captured yet — open this file on the page and scroll through it, or click Edit / Fix Code to paste it.</div>
          ) : (
            <>
              <div className="am-note" style={{ marginBottom: 6 }}>
                {selected.capturedLineCount}
                {selected.expectedLineCount !== null ? ` / ${selected.expectedLineCount}` : ''} lines captured
                {selected.coveragePercent !== null ? ` (${selected.coveragePercent}%)` : ''} · revision r
                {selected.currentRevisionId?.split('#r')[1] ?? '—'}
                {selected.missingRanges.length > 0 && ` · ${selected.missingRanges.length} missing range(s) marked ⟨ not captured ⟩`}
              </div>
              <CodeViewer lines={previewLines} maxHeight={340} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
