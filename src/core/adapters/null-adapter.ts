/**
 * NullAdapter — for pages with no detectable editor. It never fabricates
 * capture events; asset discovery in the panel still works because it does
 * not depend on the adapter. Honest fallback, not a placeholder capture path.
 */
import type { AdapterStartOptions, PlatformAdapter } from './types';

export class NullAdapter implements PlatformAdapter {
  readonly id = 'none';
  readonly displayName = 'No editor detected';
  readonly notes =
    'No supported editor detected on this page. Source capture is unavailable here; the Assets section can still discover and extract page resources. Platform adapters are added in src/core/adapters/.';

  detect(): boolean {
    return false;
  }
  start(_opts: AdapterStartOptions): void {
    /* intentionally inert — no capture events are ever emitted */
  }
  pause(): void {}
  resume(): void {}
  stop(): void {}
}
