/**
 * PanelHost — the in-page docked workspace (spec Part 3).
 *
 * Mounts a Shadow-DOM panel on the right side of the viewport with a draggable
 * divider. Default ratio 40:60 (site:panel). Two workspace modes:
 *   push    — the page is reflowed (html margin-right) so site + panel share
 *             the viewport like a true split-pane (default)
 *   overlay — panel floats above the page without reflow
 *
 * A11y: the divider is a focusable separator; arrow keys resize, Home resets
 * to the 40:60 default. Ratio persists per-origin for the session.
 */
import {
  DEFAULT_PANEL_RATIO,
  MIN_PANEL_PX,
  MIN_SITE_PX,
  RATIO_MAX,
  RATIO_MIN,
  type PanelSettings,
  type WorkspaceMode,
} from '../shared/types';
import { clamp } from '../shared/utils';

const HOST_ID = 'asset-miner-host';
const STORAGE_PREFIX = 'am:panel:';

export interface PanelHostHandle {
  readonly shadow: ShadowRoot;
  readonly container: HTMLDivElement; // React mount point, inside the shadow
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  toggle(): boolean;
  getSettings(): PanelSettings;
  updateSettings(patch: Partial<PanelSettings>): void;
  dispose(): void;
}

interface StoredSettings extends PanelSettings {
  visible: boolean;
}

async function loadSettings(origin: string): Promise<StoredSettings> {
  const fallback: StoredSettings = { ratio: DEFAULT_PANEL_RATIO, workspaceMode: 'push', visible: false };
  try {
    const ext = globalThis.chrome;
    if (ext?.storage?.session) {
      const got = await ext.storage.session.get([STORAGE_PREFIX + origin]);
      const value = got[STORAGE_PREFIX + origin] as StoredSettings | undefined;
      if (value && typeof value.ratio === 'number') return { ...fallback, ...value };
    }
  } catch {
    // storage unavailable — fall through to localStorage
  }
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + origin);
    if (raw) {
      const value = JSON.parse(raw) as StoredSettings;
      if (typeof value.ratio === 'number') return { ...fallback, ...value };
    }
  } catch {
    // corrupt entry — defaults
  }
  return fallback;
}

function persistSettings(origin: string, settings: StoredSettings): void {
  try {
    const ext = globalThis.chrome;
    if (ext?.storage?.session) {
      void ext.storage.session.set({ [STORAGE_PREFIX + origin]: settings });
    }
  } catch {
    /* session storage best-effort */
  }
  try {
    localStorage.setItem(STORAGE_PREFIX + origin, JSON.stringify(settings));
  } catch {
    /* some hosts block localStorage */
  }
}

export async function createPanelHost(stylesText: string, origin: string): Promise<PanelHostHandle> {
  const settings = await loadSettings(origin);

  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText =
    'position:fixed;top:0;right:0;bottom:0;z-index:2147483646;' +
    'width:0;pointer-events:none;contain:layout style;';
  const shadow = host.attachShadow({ mode: 'open' });

  // Panel styles live INSIDE the shadow root — nothing leaks to the host page.
  let sheet: CSSStyleSheet | null = null;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(stylesText);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const styleEl = document.createElement('style');
    styleEl.textContent = stylesText;
    shadow.appendChild(styleEl);
  }

  // Host-page reset for our own subtree only.
  const reset = document.createElement('style');
  reset.textContent = ':host{all:initial}';
  shadow.appendChild(reset);

  const frame = document.createElement('div');
  frame.className = 'am-frame';
  frame.setAttribute('part', 'asset-miner-frame');

  const divider = document.createElement('div');
  divider.className = 'am-divider';
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-label', 'Resize Asset Miner workspace');
  divider.setAttribute('tabindex', '0');

  const container = document.createElement('div');
  container.className = 'am-app';
  frame.append(divider, container);
  shadow.appendChild(frame);
  document.documentElement.appendChild(host);

  // ------------------------------------------------------------ geometry
  let current: StoredSettings = { ...settings };

  function applyGeometry() {
    const vw = window.innerWidth;
    const maxBySite = vw - MIN_SITE_PX;
    const minByPanel = MIN_PANEL_PX;
    let ratio = clamp(current.ratio, RATIO_MIN, RATIO_MAX);
    let width = Math.round(vw * ratio);
    if (width > maxBySite) width = maxBySite;
    if (width < minByPanel) width = Math.min(minByPanel, vw);
    ratio = width / vw;
    host.style.width = `${width}px`;
    host.style.pointerEvents = current.visible ? 'auto' : 'none';
    frame.classList.toggle('am-hidden', !current.visible);
    divider.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    divider.setAttribute('aria-valuetext', `panel ${Math.round(ratio * 100)}% of viewport`);
    // Push mode: reflow the page; overlay: leave it alone.
    if (current.visible && current.workspaceMode === 'push') {
      document.documentElement.style.setProperty('margin-right', `${width}px`, 'important');
    } else {
      document.documentElement.style.removeProperty('margin-right');
    }
  }

  function setRatio(rawRatio: number, persist = true) {
    const vw = window.innerWidth;
    current.ratio = clamp(rawRatio, Math.max(RATIO_MIN, MIN_PANEL_PX / vw), Math.min(RATIO_MAX, (vw - MIN_SITE_PX) / vw));
    applyGeometry();
    if (persist) persistSettings(origin, current);
  }

  // ------------------------------------------------------------ dragging
  let dragging = false;
  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('am-divider-active');
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    setRatio(1 - e.clientX / window.innerWidth);
  };
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try {
      divider.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    divider.classList.remove('am-divider-active');
    document.body.style.userSelect = '';
  };
  divider.addEventListener('pointerdown', onPointerDown);
  divider.addEventListener('pointermove', onPointerMove);
  divider.addEventListener('pointerup', endDrag);
  divider.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------ keyboard
  divider.addEventListener('keydown', (e) => {
    const step = 0.03;
    if (e.key === 'ArrowLeft') {
      setRatio(current.ratio + step); // widen panel (divider moves left)
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      setRatio(current.ratio - step);
      e.preventDefault();
    } else if (e.key === 'Home') {
      setRatio(DEFAULT_PANEL_RATIO); // restore the 40:60 default
      e.preventDefault();
    }
  });

  const onResize = () => applyGeometry();
  window.addEventListener('resize', onResize);

  applyGeometry();
  // An initial nudge lets layouts that depend on viewport queries settle.
  setTimeout(applyGeometry, 50);

  const handle: PanelHostHandle = {
    shadow,
    container,
    setVisible(visible: boolean) {
      current.visible = visible;
      applyGeometry();
      persistSettings(origin, current);
    },
    isVisible: () => current.visible,
    toggle() {
      handle.setVisible(!current.visible);
      return current.visible;
    },
    getSettings: (): PanelSettings => ({
      ratio: current.ratio,
      workspaceMode: current.workspaceMode as WorkspaceMode,
    }),
    updateSettings(patch: Partial<PanelSettings>) {
      if (patch.ratio !== undefined) setRatio(patch.ratio);
      if (patch.workspaceMode !== undefined) current.workspaceMode = patch.workspaceMode;
      applyGeometry();
      persistSettings(origin, current);
    },
    dispose() {
      window.removeEventListener('resize', onResize);
      document.documentElement.style.removeProperty('margin-right');
      host.remove();
    },
  };
  return handle;
}
