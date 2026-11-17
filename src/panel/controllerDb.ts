/**
 * Controller → database handle accessor. The CaptureController holds the db
 * privately; this module provides the single sanctioned way for panel-side
 * asset actions to reach the same database instance.
 */
import type { IDBPDatabase } from 'idb';
import type { AssetMinerSchema } from '../storage/db';
import type { CaptureController } from '../core/capture/CaptureController';

const DB_SLOT = Symbol('am.db');

export function attachDb(controller: CaptureController, db: IDBPDatabase<AssetMinerSchema>): void {
  (controller as unknown as Record<symbol, unknown>)[DB_SLOT] = db;
}

export function readControllerDb(controller: CaptureController): IDBPDatabase<AssetMinerSchema> {
  const db = (controller as unknown as Record<symbol, unknown>)[DB_SLOT];
  if (!db) throw new Error('database not attached to controller');
  return db as IDBPDatabase<AssetMinerSchema>;
}
