/**
 * Panel store — React context over the repositories, refreshed by the
 * in-page EventBus. All data flows through here; components never touch
 * chrome.* or IndexedDB directly.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { IDBPDatabase } from 'idb';
import type { AssetMinerSchema } from '../storage/db';
import type { EventBus } from '../shared/transport';
import type { ActivityRecord, AssetRecord, FileRecord, FolderRecord, PanelSettings, ProjectProgress, ProjectRecord } from '../shared/types';
import type { CaptureController, ControllerStatus } from '../core/capture/CaptureController';
import type { PanelHostHandle } from '../content/panel-host';
import { listActivity, listProjects } from '../storage/repositories/projects';
import { listFiles, listFolders } from '../storage/repositories/tree';
import { computeProjectProgress } from '../storage/repositories/progress';
import { listAssets } from '../storage/repositories/assets';

export interface PanelSnapshot {
  version: number;
  origin: string;
  project: ProjectRecord | null;
  files: FileRecord[];
  folders: FolderRecord[];
  progress: ProjectProgress | null;
  activity: ActivityRecord[];
  assets: AssetRecord[];
  adapterNotes: string;
  lastError: string | null;
}

export interface PanelActions {
  refresh(): void;
  captureStatus(): ControllerStatus;
  pauseCapture(): void;
  resumeCapture(): void;
  stopCapture(): void;
  getSettings(): PanelSettings;
  updateSettings(patch: Partial<PanelSettings>): void;
  resetLayout(): void;
}

export interface PanelContextValue {
  db: IDBPDatabase<AssetMinerSchema>;
  bus: EventBus;
  controller: CaptureController;
  host: PanelHostHandle;
  state: PanelSnapshot;
  actions: PanelActions;
  projectId: string | null;
}

const PanelContext = createContext<PanelContextValue | null>(null);

export function usePanel(): PanelContextValue {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error('usePanel outside PanelProvider');
  return ctx;
}

export function PanelProvider(props: {
  db: IDBPDatabase<AssetMinerSchema>;
  bus: EventBus;
  controller: CaptureController;
  host: PanelHostHandle;
  origin: string;
  adapterNotes: string;
  children: ReactNode;
}) {
  const { db, bus, controller, host, origin, adapterNotes } = props;
  const [version, setVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<PanelSnapshot>({
    version: 0,
    origin,
    project: null,
    files: [],
    folders: [],
    progress: null,
    activity: [],
    assets: [],
    adapterNotes,
    lastError: null,
  });
  const projectIdRef = useRef<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced full refresh — coalesces capture bursts into one query pass.
  const refresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(async () => {
      refreshTimer.current = null;
      try {
        const projects = await listProjects(db);
        // Prefer the controller's project; else the newest project for this origin.
        const controllerProject = controller.projectId
          ? projects.find((p) => p.projectId === controller.projectId) ?? null
          : null;
        const byOrigin = projects.filter((p) => p.sourceOrigin === origin);
        byOrigin.sort((a, b) => b.updatedAt - a.updatedAt);
        const project = controllerProject ?? byOrigin[0] ?? projects[projects.length - 1] ?? null;
        projectIdRef.current = project?.projectId ?? null;
        const [files, folders, progress, activity, assets] = project
          ? await Promise.all([
              listFiles(db, project.projectId),
              listFolders(db, project.projectId),
              computeProjectProgress(db, project.projectId),
              listActivity(db, project.projectId, 60),
              listAssets(db, project.projectId),
            ])
          : [[], [], null, [], []];
        setSnapshot({
          version: versionRef.current,
          origin,
          project,
          files,
          folders,
          progress,
          activity,
          assets,
          adapterNotes,
          lastError: controller.getLastError(),
        });
      } catch (err) {
        // The panel must survive storage hiccups; show the error honestly.
        setSnapshot((prev) => ({
          ...prev,
          lastError: err instanceof Error ? err.message : String(err),
        }));
      }
    }, 80);
  }, [db, origin, controller, adapterNotes]);

  const versionRef = useRef(0);
  useEffect(() => {
    const off = bus.on(() => {
      versionRef.current += 1;
      setVersion(versionRef.current);
      refresh();
    });
    refresh();
    return off;
  }, [bus, refresh]);

  const actions = useMemo<PanelActions>(
    () => ({
      refresh: () => {
        versionRef.current += 1;
        setVersion(versionRef.current);
        refresh();
      },
      captureStatus: () => controller.currentStatus,
      pauseCapture: () => controller.pause(),
      resumeCapture: () => controller.resume(),
      stopCapture: () => controller.stop(),
      getSettings: () => host.getSettings(),
      updateSettings: (patch) => {
        host.updateSettings(patch);
        versionRef.current += 1;
        setVersion(versionRef.current);
      },
      resetLayout: () => host.updateSettings({ ratio: 0.6 }),
    }),
    [controller, host, refresh],
  );

  const value = useMemo<PanelContextValue>(
    () => ({
      db,
      bus,
      controller,
      host,
      state: { ...snapshot, version },
      actions,
      projectId: projectIdRef.current,
    }),
    [db, bus, controller, host, snapshot, version, actions],
  );

  return <PanelContext.Provider value={value}>{props.children}</PanelContext.Provider>;
}
