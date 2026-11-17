/**
 * Content-script entry point.
 *
 * Boot sequence (spec Part 3, addendum #1/#7):
 *  1. Adapter registry detects the best platform adapter for this frame.
 *     - TOP FRAME: mounts the Shadow-DOM panel (40:60 default) + React app.
 *     - CHILD FRAMES: capture-only. The panel never mounts in an iframe; a
 *       frame only boots at all when an EDITOR is detected inside it, so
 *       preview iframes stay untouched. Same-origin frames share the same
 *       IndexedDB as the top frame, so their captures merge into the project.
 *  2. The database opens; interrupted sessions/writes are recovered.
 *  3. The CaptureController starts with the detected adapter.
 *  4. WATCHDOG: SPA platforms (blink.new & similar) render their IDE long
 *     after page load, so a one-shot detect() would see nothing. While no
 *     editor is bound, a light interval re-scans (including shadow roots)
 *     and swaps in the generic editor adapter the moment one appears.
 *
 * The script is idempotent (guarded double-injection) and never modifies the
 * page beyond the panel host element and the optional push-mode margin.
 */
import panelCssText from '../panel/styles.css?inline';
import { createPanelHost, type PanelHostHandle } from './panel-host';
import { openDatabase, recoverInterruptedWrites } from '../storage/db';
import { EventBus } from '../shared/transport';
import { MSG_TOGGLE_PANEL, type BackgroundMessage } from '../shared/messaging';
import { selectAdapter } from '../core/adapters/registry';
import { GenericEditorAdapter } from '../core/adapters/generic-editor';
import { DemoFixtureAdapter } from '../core/adapters/demo-fixture';
import { CaptureController } from '../core/capture/CaptureController';
import { deepDetectEditorObserver } from '../core/observers';
import type { DiscoveryEvent } from '../shared/types';
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { PanelProvider } from '../panel/store';
import { App } from '../panel/App';
import { attachDb } from '../panel/controllerDb';

const BOOT_FLAG = '__assetMinerBooted';
const WATCHDOG_INTERVAL_MS = 1500;
const WATCHDOG_MAX_TICKS = 240; // ~6 minutes, then stop scanning.

async function boot(): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  if (w[BOOT_FLAG]) return; // idempotent injection
  w[BOOT_FLAG] = true;

  const isTop = window.self === window.top;
  if (isTop) {
    await bootTopFrame();
  } else {
    await bootChildFrame();
  }
}

// ---------------------------------------------------------------- top frame

async function bootTopFrame(): Promise<void> {
  const bus = new EventBus();
  const origin = location.origin;

  const detected = selectAdapter();
  const adapter = detected.adapter ?? new GenericEditorAdapter();

  const host = await createPanelHost(panelCssText, origin);

  const db = await openDatabase();
  await recoverInterruptedWrites(db);

  const controller = new CaptureController(db, bus, adapter, origin);
  attachDb(controller, db);
  await controller.start();

  const root = createRoot(host.container);
  root.render(
    createElement(PanelProvider, {
      db,
      bus,
      controller,
      host,
      origin,
      adapterNotes: adapter.notes,
      children: createElement(App),
    }),
  );

  wireToggle(host, controller);
  wireChildFrameRelay(controller);
  startWatchdog(controller);
}

function wireChildFrameRelay(controller: CaptureController): void {
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source === window || !ev.data || ev.data.source !== '__assetMinerFrame') return;
    const event = ev.data.event as DiscoveryEvent | undefined;
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'project-detected' && controller.projectId) return;
    controller.ingestRemoteEvent(event);
  });
}

// ------------------------------------------------------------- child frame

/**
 * Child frames boot ONLY when an editor is found inside them (preview
 * iframes and ad frames never activate). The panel never mounts here; the
 * frame simply feeds capture events into its origin's database.
 */
async function bootChildFrame(): Promise<void> {
  if (deepDetectEditorObserver() === null) {
    // Editor may mount later (SPA inside frame) — light re-scan, then boot.
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (deepDetectEditorObserver() !== null) {
        clearInterval(timer);
        void startChildCapture();
      } else if (ticks > 120) {
        clearInterval(timer);
      }
    }, 2000);
    return;
  }
  await startChildCapture();
}

async function startChildCapture(): Promise<void> {
  const adapter = selectAdapter().adapter ?? new GenericEditorAdapter();
  adapter.start({
    emit: (ev) => {
      try {
        window.top?.postMessage({ source: '__assetMinerFrame', event: ev }, '*');
      } catch {
        /* top frame unreachable */
      }
    },
  });
  console.info('[Asset Miner] capture-only frame active:', location.href);
}

// ---------------------------------------------------------------- watchdog

/**
 * Re-detect late-mounting editors and swap adapters when one appears. This is
 * what makes SPA platforms (blink.new) work: the user clicks the toolbar
 * before opening the Code section, the editor mounts minutes later, and the
 * watchdog binds capture at that moment.
 */
function startWatchdog(controller: CaptureController): void {
  const current = controller.adapterInfo;
  if (current.id === 'demo-fixture') return; // fixture is static & verified
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    const active = controller.adapterInfo;
    const needsSwap =
      (active.id === 'none') ||
      (active instanceof GenericEditorAdapter && !active.hasEditor);
    if (!needsSwap) {
      clearInterval(timer);
      return;
    }
    if (deepDetectEditorObserver() !== null) {
      clearInterval(timer);
      controller.swapAdapter(new GenericEditorAdapter());
      return;
    }
    // The demo fixture can also appear via SPA navigation in tests/dev.
    if (new DemoFixtureAdapter().detect()) {
      clearInterval(timer);
      controller.swapAdapter(new DemoFixtureAdapter());
      return;
    }
    if (ticks > WATCHDOG_MAX_TICKS) clearInterval(timer);
  }, WATCHDOG_INTERVAL_MS);
}

// ----------------------------------------------------------------- toggle

let wireToggleDone = false;
function wireToggle(host: PanelHostHandle, controller: CaptureController): void {
  if (wireToggleDone) return;
  wireToggleDone = true;
  chrome.runtime.onMessage.addListener((msg: BackgroundMessage) => {
    if (msg?.type === MSG_TOGGLE_PANEL) {
      const visible = host.toggle();
      // Capture liveness follows panel visibility — bounded resource use.
      if (visible && controller.currentStatus === 'paused') controller.resume();
      if (!visible && controller.currentStatus === 'running') controller.pause();
    }
    return undefined;
  });
}

void boot();
