/**
 * ScrollMonitor — debounced observation of editor scrolling and DOM mutation
 * (spec Part 5.2/17). The user browses normally; we re-read the editor after
 * activity settles. High-frequency events are debounced and observers detach
 * cleanly (no leaks).
 */
import { debounce } from '../../shared/utils';

export interface ScrollMonitorOptions {
  /** Debounce window for scroll/mutation activity (ms). */
  waitMs?: number;
  onActivity: () => void;
}

export class ScrollMonitor {
  private cleanupFns: (() => void)[] = [];
  private stopped = false;
  private trigger: (() => void) & { cancel(): void; flush(): void };

  constructor(targets: { scroller: HTMLElement | null; root: HTMLElement }, opts: ScrollMonitorOptions) {
    this.trigger = debounce(() => {
      if (!this.stopped) opts.onActivity();
    }, opts.waitMs ?? 150);

    if (targets.scroller) {
      const s = targets.scroller;
      s.addEventListener('scroll', this.trigger, { passive: true });
      this.cleanupFns.push(() => s.removeEventListener('scroll', this.trigger));
    }
    // Virtualized editors swap line DOM as the user scrolls; re-read on DOM
    // changes inside the editor root.
    const mo = new MutationObserver(() => this.trigger());
    mo.observe(targets.root, { childList: true, subtree: true, characterData: true });
    this.cleanupFns.push(() => mo.disconnect());

    // Resizes can re-render virtualized windows too.
    const ro = ('ResizeObserver' in globalThis) ? new ResizeObserver(() => this.trigger()) : null;
    if (ro) {
      ro.observe(targets.root);
      this.cleanupFns.push(() => ro.disconnect());
    }
  }

  /** Manual nudge (e.g. after the panel opens). */
  poke(): void {
    this.trigger();
  }

  stop(): void {
    this.stopped = true;
    this.trigger.cancel();
    for (const fn of this.cleanupFns.splice(0)) fn();
  }
}
