/**
 * Log a Claude-native lifecycle event into the lifecycle_events table.
 * This is the ONLY authorized ingress point for Claude hook → tmup state.
 */
export function logLifecycleEvent(db, input) {
    db.prepare(`
    INSERT INTO lifecycle_events (event_type, session_id, agent_id, payload)
    VALUES (?, ?, ?, ?)
  `).run(input.event_type, input.session_id ?? null, input.agent_id ?? null, input.payload ? JSON.stringify(input.payload) : null);
}
/**
 * Get recent lifecycle events, optionally filtered by type.
 */
export function getLifecycleEvents(db, eventType, limit = 50) {
    if (eventType) {
        return db.prepare('SELECT * FROM lifecycle_events WHERE event_type = ? ORDER BY id DESC LIMIT ?').all(eventType, limit);
    }
    return db.prepare('SELECT * FROM lifecycle_events ORDER BY id DESC LIMIT ?').all(limit);
}
/**
 * Prune old lifecycle events. Returns number of rows deleted.
 */
export function pruneLifecycleEvents(db, maxAgeSeconds) {
    const result = db.prepare(`
    DELETE FROM lifecycle_events WHERE id IN (
      SELECT id FROM lifecycle_events
      WHERE timestamp < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds')
      LIMIT 1000
    )
  `).run(`-${maxAgeSeconds}`);
    return result.changes;
}
//# sourceMappingURL=lifecycle-bridge.js.map