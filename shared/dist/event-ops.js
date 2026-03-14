export function logEvent(db, actor, eventType, payload) {
    db.prepare('INSERT INTO events (actor, event_type, payload) VALUES (?, ?, ?)').run(actor, eventType, payload ? JSON.stringify(payload) : null);
}
export const EVENT_PRUNE_BATCH_SIZE = 1000;
/**
 * Prune old events in bounded batches to avoid long-running deletes.
 * Returns the number of pruned rows.
 */
export function pruneEvents(db, maxAgeSeconds) {
    const result = db.prepare(`
    DELETE FROM events WHERE id IN (
      SELECT id FROM events
      WHERE timestamp < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds')
      LIMIT ?
    )
  `).run(`-${maxAgeSeconds}`, EVENT_PRUNE_BATCH_SIZE);
    return result.changes;
}
export function getRecentEvents(db, eventType, limit = 50) {
    if (eventType) {
        return db.prepare('SELECT * FROM events WHERE event_type = ? ORDER BY id DESC LIMIT ?').all(eventType, limit);
    }
    return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
}
//# sourceMappingURL=event-ops.js.map