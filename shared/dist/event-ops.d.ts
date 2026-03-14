import type { Database, EventType, EventRow } from './types.js';
export declare function logEvent(db: Database, actor: string | null, eventType: EventType, payload?: Record<string, unknown>): void;
export declare const EVENT_PRUNE_BATCH_SIZE = 1000;
/**
 * Prune old events in bounded batches to avoid long-running deletes.
 * Returns the number of pruned rows.
 */
export declare function pruneEvents(db: Database, maxAgeSeconds: number): number;
export declare function getRecentEvents(db: Database, eventType?: EventType, limit?: number): EventRow[];
//# sourceMappingURL=event-ops.d.ts.map