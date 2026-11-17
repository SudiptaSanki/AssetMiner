/**
 * Unified error type. Every user-visible failure maps to one of these kinds so
 * the UI can present an understandable message (spec Part 18) instead of
 * leaking stack traces.
 */
export type AssetMinerErrorKind =
  | 'storage'
  | 'quota'
  | 'integrity'
  | 'conflict'
  | 'observer'
  | 'export'
  | 'path'
  | 'unsupported'
  | 'network'
  | 'unknown';

export class AssetMinerError extends Error {
  readonly kind: AssetMinerErrorKind;
  /** True when the failing operation definitely did not modify stored data. */
  readonly clean: boolean;

  constructor(kind: AssetMinerErrorKind, message: string, options?: { clean?: boolean; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AssetMinerError';
    this.kind = kind;
    this.clean = options?.clean ?? true;
  }
}

export function toAssetMinerError(err: unknown, fallbackKind: AssetMinerErrorKind = 'unknown'): AssetMinerError {
  if (err instanceof AssetMinerError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const isQuota = /quota/i.test(message);
  return new AssetMinerError(isQuota ? 'quota' : fallbackKind, message, { cause: err, clean: !isQuota });
}

export const ERROR_MESSAGES: Record<AssetMinerErrorKind, string> = {
  storage: 'A local database problem occurred. Previously captured content was kept.',
  quota: 'Browser storage is full. Free space in Settings (Storage) and try again — nothing captured so far was deleted.',
  integrity: 'A stored content chunk failed its integrity check. The affected range was flagged for re-inspection.',
  conflict: 'Two captures of the same source range disagree. Re-open the file or run an authorized re-sync to resolve.',
  observer: 'The page editor changed in a way Asset Miner could not follow. Re-open the file to resume capture.',
  export: 'Export failed before the archive was written. No project data was modified.',
  path: 'A file path from the page could not be made safe for export.',
  unsupported: 'This website is not supported by a platform adapter yet. Generic capture may still work.',
  network: 'A resource could not be fetched from the page origin.',
  unknown: 'An unexpected error occurred.',
};
