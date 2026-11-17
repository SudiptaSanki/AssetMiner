/**
 * Typed message contracts between the background service worker and the
 * content script (panel toggle). UI data flows through the in-page EventBus.
 */

export const MSG_TOGGLE_PANEL = 'am:toggle-panel';
export const MSG_PING = 'am:ping';

export interface TogglePanelMessage {
  type: typeof MSG_TOGGLE_PANEL;
}

export interface PingMessage {
  type: typeof MSG_PING;
}

export type BackgroundMessage = TogglePanelMessage | PingMessage;
