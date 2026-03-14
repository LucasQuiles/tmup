import { generateMessageId } from './id.js';
const MAX_MESSAGES_PER_AGENT = 1000;
const MAX_PAYLOAD_LENGTH = 100000;
const BROADCAST_MAX_AGE_SECONDS = 3600; // Only include broadcasts from the last hour
export function sendMessage(db, input) {
    if (input.payload.length > MAX_PAYLOAD_LENGTH) {
        throw new Error(`Message payload exceeds ${MAX_PAYLOAD_LENGTH} character limit`);
    }
    const run = db.transaction(() => {
        // Check per-agent message limit
        const count = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE from_agent = ?').get(input.from_agent);
        if (count.cnt >= MAX_MESSAGES_PER_AGENT) {
            throw new Error(`Agent ${input.from_agent} has reached the ${MAX_MESSAGES_PER_AGENT} message limit`);
        }
        // Enforce routing semantics: only broadcast messages get null recipient
        let toAgent;
        if (input.type === 'broadcast') {
            toAgent = null;
        }
        else {
            toAgent = input.to_agent ?? null;
            if (!toAgent) {
                throw new Error(`Non-broadcast message of type '${input.type}' must have a non-empty recipient (to_agent)`);
            }
        }
        const id = generateMessageId();
        db.prepare(`
      INSERT INTO messages (id, from_agent, to_agent, type, payload, task_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.from_agent, toAgent, input.type, input.payload, input.task_id ?? null);
        return id;
    });
    return run.immediate();
}
export function getInbox(db, agentId, markRead = false) {
    // Broadcasts are never marked read (shared resource), so filter by age to prevent
    // unbounded accumulation. Direct messages use read_at tracking as normal.
    const query = `
    SELECT * FROM messages
    WHERE (
      (to_agent = ? AND read_at IS NULL)
      OR (to_agent IS NULL AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds'))
    )
    ORDER BY created_at ASC
  `;
    const broadcastAge = `-${BROADCAST_MAX_AGE_SECONDS}`;
    if (markRead) {
        const readInbox = db.transaction(() => {
            const messages = db.prepare(query).all(agentId, broadcastAge);
            if (messages.length > 0) {
                const now = new Date().toISOString();
                // Only mark direct messages as read — broadcasts (to_agent IS NULL) must
                // remain unread so other agents can still consume them
                for (const m of messages) {
                    if (m.to_agent !== null) {
                        db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL').run(now, m.id);
                    }
                }
            }
            return messages;
        });
        return readInbox.immediate();
    }
    return db.prepare(query).all(agentId, broadcastAge);
}
export function getUnreadCount(db, agentId) {
    const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM messages
    WHERE (
      (to_agent = ? AND read_at IS NULL)
      OR (to_agent IS NULL AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds'))
    )
  `).get(agentId, `-${BROADCAST_MAX_AGE_SECONDS}`);
    return row.cnt;
}
export function postCheckpoint(db, taskId, agentId, message) {
    const run = db.transaction(() => {
        // Verify task exists and is in an active state
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        if (!task)
            throw new Error(`Task ${taskId} not found`);
        if (task.status !== 'claimed') {
            throw new Error(`Cannot checkpoint task ${taskId} in status '${task.status}'`);
        }
        // Verify task is owned by this agent (lead can checkpoint any active task)
        if (agentId !== 'lead' && task.owner !== agentId) {
            throw new Error(`Task ${taskId} cannot be checkpointed by '${agentId}': not the owning agent`);
        }
        // Insert checkpoint message to lead (inlined to avoid nested IMMEDIATE)
        const id = generateMessageId();
        db.prepare(`
      INSERT INTO messages (id, from_agent, to_agent, type, payload, task_id)
      VALUES (?, ?, 'lead', 'checkpoint', ?, ?)
    `).run(id, agentId, message, taskId);
        // Update task result_summary with latest checkpoint
        db.prepare('UPDATE tasks SET result_summary = ? WHERE id = ?').run(message, taskId);
    });
    run.immediate();
}
export const MESSAGE_PRUNE_BATCH_SIZE = 500;
const PRUNE_MAX_AGE_SECONDS = 86400; // 24 hours
/**
 * Prune old messages in bounded batches:
 * - Read direct messages older than max age
 * - Expired broadcasts older than max age
 * Returns the number of pruned rows.
 */
export function pruneMessages(db, maxAgeSeconds = PRUNE_MAX_AGE_SECONDS) {
    const result = db.prepare(`
    DELETE FROM messages WHERE id IN (
      SELECT id FROM messages
      WHERE (
        (to_agent IS NOT NULL AND read_at IS NOT NULL AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds'))
        OR (to_agent IS NULL AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds'))
      )
      LIMIT ?
    )
  `).run(`-${maxAgeSeconds}`, `-${maxAgeSeconds}`, MESSAGE_PRUNE_BATCH_SIZE);
    return result.changes;
}
//# sourceMappingURL=message-ops.js.map