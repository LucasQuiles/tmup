import type { Database, EventType, EventRow } from './types.js';

export function logEvent(
  db: Database,
  actor: string | null,
  eventType: EventType,
  payload?: Record<string, unknown>
): void {
  db.prepare(
    'INSERT INTO events (actor, event_type, payload) VALUES (?, ?, ?)'
  ).run(actor, eventType, payload ? JSON.stringify(payload) : null);
}

export const EVENT_PRUNE_BATCH_SIZE = 1000;

/**
 * Prune old events in bounded batches to avoid long-running deletes.
 * Returns the number of pruned rows.
 */
export function pruneEvents(db: Database, maxAgeSeconds: number): number {
  const result = db.prepare(`
    DELETE FROM events WHERE id IN (
      SELECT id FROM events
      WHERE timestamp < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds')
      LIMIT ?
    )
  `).run(`-${maxAgeSeconds}`, EVENT_PRUNE_BATCH_SIZE);
  return result.changes;
}

export function getRecentEvents(
  db: Database,
  eventType?: EventType,
  limit: number = 50
): EventRow[] {
  if (eventType) {
    return db.prepare(
      'SELECT * FROM events WHERE event_type = ? ORDER BY id DESC LIMIT ?'
    ).all(eventType, limit) as EventRow[];
  }
  return db.prepare(
    'SELECT * FROM events ORDER BY id DESC LIMIT ?'
  ).all(limit) as EventRow[];
}
