/**
 * Adapter registry (spec Part 10): ordered detection, first match wins.
 * Adapters are isolated — a failed detect() just moves to the next candidate.
 */
import type { PlatformAdapter } from './types';
import { DemoFixtureAdapter } from './demo-fixture';
import { BlinkAdapter } from './blink';
import { GenericEditorAdapter } from './generic-editor';

export const ADAPTERS: PlatformAdapter[] = [
  new DemoFixtureAdapter(),
  new BlinkAdapter(),
  new GenericEditorAdapter(),
];

export interface AdapterSelection {
  adapter: PlatformAdapter | null;
  /** All adapters whose detect() returned true (first is chosen). */
  matched: PlatformAdapter[];
}

export function selectAdapter(all: PlatformAdapter[] = ADAPTERS): AdapterSelection {
  const matched: PlatformAdapter[] = [];
  for (const adapter of all) {
    try {
      if (adapter.detect()) matched.push(adapter);
    } catch {
      // Adapter isolation: a throwing detect() never blocks others.
    }
  }
  return { adapter: matched[0] ?? null, matched };
}
