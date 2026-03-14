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
export function logLifecycleEvent(
  db: Database,
  input: LifecycleEventInput
): void {
  db.prepare(`
    INSERT INTO lifecycle_events (event_type, session_id, agent_id, payload)
    VALUES (?, ?, ?, ?)
  `).run(
    input.event_type,
    input.session_id ?? null,
    input.agent_id ?? null,
    input.payload ? JSON.stringify(input.payload) : null
  );
}

/**
 * Get recent lifecycle events, optionally filtered by type.
 */
export function getLifecycleEvents(
  db: Database,
  eventType?: LifecycleEventType,
  limit: number = 50
): LifecycleEventRow[] {
  if (eventType) {
    return db.prepare(
      'SELECT * FROM lifecycle_events WHERE event_type = ? ORDER BY id DESC LIMIT ?'
    ).all(eventType, limit) as LifecycleEventRow[];
  }
  return db.prepare(
    'SELECT * FROM lifecycle_events ORDER BY id DESC LIMIT ?'
  ).all(limit) as LifecycleEventRow[];
}

/**
 * Prune old lifecycle events. Returns number of rows deleted.
 */
export function pruneLifecycleEvents(db: Database, maxAgeSeconds: number): number {
  const result = db.prepare(`
    DELETE FROM lifecycle_events WHERE id IN (
      SELECT id FROM lifecycle_events
      WHERE timestamp < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds')
      LIMIT 1000
    )
  `).run(`-${maxAgeSeconds}`);
  return result.changes;
}
