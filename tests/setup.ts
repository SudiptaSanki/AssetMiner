/**
 * Vitest setup: fake-indexeddb for storage tests, Web Crypto availability.
 */
import 'fake-indexeddb/auto';
import { beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

// Fresh database per test file.
beforeEach(() => {
  indexedDB = new IDBFactory();
});

// jsdom/happy-dom may lack structuredClone for some fake-indexeddb paths.
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
}
