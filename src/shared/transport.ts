/**
 * In-page event bus — the change feed connecting the capture pipeline to the
 * React panel. Both live in the same content-script context, so a plain
 * synchronous bus is sufficient (no chrome.runtime round-trips for UI data).
 */

export type ChangeReason =
  | 'project'
  | 'tree'
  | 'capture'
  | 'conflict'
  | 'revision'
  | 'session'
  | 'assets'
  | 'export'
  | 'settings'
  | 'storage';

export interface ChangeEvent {
  reason: ChangeReason;
  projectId?: string;
  fileId?: string;
}

type Handler = (e: ChangeEvent) => void;

export class EventBus {
  private handlers = new Set<Handler>();

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(reason: ChangeReason, detail: Omit<ChangeEvent, 'reason'> = {}): void {
    const event: ChangeEvent = { reason, ...detail };
    for (const h of [...this.handlers]) {
      try {
        h(event);
      } catch {
        // A broken UI handler must never break the capture pipeline.
      }
    }
  }
}
