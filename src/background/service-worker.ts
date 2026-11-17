/**
 * Background service worker (MV3, ES module).
 *
 * Minimal responsibilities (privacy posture: no host permissions by default):
 *  - Action click → inject the content script under activeTab and toggle the
 *    in-page panel. The content script guards against double-injection itself.
 * No tabs/webNavigation listeners, no background data access, no network.
 */
import { MSG_PING, MSG_TOGGLE_PANEL, type BackgroundMessage } from '../shared/messaging';

const CONTENT_FILES = ['content/content-script.js'];
const BRIDGE_FILE = 'content/page-bridge.js';

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) {
    // ActiveTab does not cover chrome:// pages; stay silent elsewhere (file://
    // works only after the user enables file access for the extension).
    return;
  }
  try {
    // Read-only bridge in the PAGE world: lets us read the full text the
    // page's editor already holds (virtualized editors only render visible
    // lines in the DOM). Failure here is non-fatal - DOM capture still works.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: [BRIDGE_FILE],
        world: 'MAIN',
      });
    } catch (err) {
      console.warn('[Asset Miner] page bridge unavailable:', err);
    }
    // allFrames: SPAs often host their code editor inside an (same-origin)
    // iframe; the content script boots capture-only in such frames and never
    // mounts a second panel.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: CONTENT_FILES,
    });
    await chrome.tabs.sendMessage(tab.id, { type: MSG_TOGGLE_PANEL } satisfies BackgroundMessage);
  } catch (err) {
    console.warn('[Asset Miner] could not attach to this page:', err);
  }
});

// Ping lets tests and future extension contexts check liveness.
chrome.runtime.onMessage.addListener((msg: BackgroundMessage, _sender, sendResponse) => {
  if (msg?.type === MSG_PING) {
    sendResponse({ ok: true });
  }
  // No async response path is used; return false implicitly.
});
