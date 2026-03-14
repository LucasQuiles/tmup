/**
 * Lifecycle bridge: shared ingestion API for Claude-native lifecycle events.
 *
 * Hooks must call this shared code rather than writing raw SQL to tmup.db.
 * All ingestion is log-only — no task mutation or dispatch side effects.
 *
 * P5.1: probe -> log-only -> optional structured ingestion
 */
import type { Database, LifecycleEventType, LifecycleEventRow } from './types.js';
export interface LifecycleEventInput {
    event_type: LifecycleEventType;
    session_id?: string;
    agent_id?: string;
    payload?: Record<string, unknown>;
}
/**
 * Log a Claude-native lifecycle event into the lifecycle_events table.
 * This is the ONLY authorized ingress point for Claude hook → tmup state.
 */
export declare function logLifecycleEvent(db: Database, input: LifecycleEventInput): void;
/**
 * Get recent lifecycle events, optionally filtered by type.
 */
export declare function getLifecycleEvents(db: Database, eventType?: LifecycleEventType, limit?: number): LifecycleEventRow[];
/**
 * Prune old lifecycle events. Returns number of rows deleted.
 */
export declare function pruneLifecycleEvents(db: Database, maxAgeSeconds: number): number;
//# sourceMappingURL=lifecycle-bridge.d.ts.map