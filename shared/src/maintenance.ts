import type { Database } from './types.js';
import { pruneEvents, EVENT_PRUNE_BATCH_SIZE } from './event-ops.js';
import { pruneMessages, MESSAGE_PRUNE_BATCH_SIZE } from './message-ops.js';

export interface MaintenanceResult {
  eventsPruned: number;
  messagesPruned: number;
  walCheckpoint: boolean;
  errors: string[];
  warnings: string[];
}

const DEFAULT_EVENT_MAX_AGE_SECONDS = 86400; // 24h

/**
 * Run all maintenance operations in one exportable call.
 * Each operation runs independently — failures are collected, not thrown.
 * Returns a structured result for logging/observability.
 */
export function runMaintenance(db: Database, eventMaxAgeSeconds: number = DEFAULT_EVENT_MAX_AGE_SECONDS): MaintenanceResult {
  const result: MaintenanceResult = { eventsPruned: 0, messagesPruned: 0, walCheckpoint: false, errors: [], warnings: [] };

  try {
    db.pragma('wal_checkpoint(PASSIVE)');
    result.walCheckpoint = true;
  } catch (e) {
    result.errors.push(`WAL checkpoint: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    result.eventsPruned = pruneEvents(db, eventMaxAgeSeconds);
    if (result.eventsPruned >= EVENT_PRUNE_BATCH_SIZE) {
      result.warnings.push(`Event pruning hit batch limit (${EVENT_PRUNE_BATCH_SIZE}) — backlog likely, will catch up on next cycle`);
    }
  } catch (e) {
    result.errors.push(`Event pruning: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    result.messagesPruned = pruneMessages(db);
    if (result.messagesPruned >= MESSAGE_PRUNE_BATCH_SIZE) {
      result.warnings.push(`Message pruning hit batch limit (${MESSAGE_PRUNE_BATCH_SIZE}) — backlog likely, will catch up on next cycle`);
    }
  } catch (e) {
    result.errors.push(`Message pruning: ${e instanceof Error ? e.message : String(e)}`);
  }

  return result;
}
