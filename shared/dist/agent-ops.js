import { logEvent } from './event-ops.js';
export function registerAgent(db, agentId, paneIndex, role) {
    db.prepare(`
    INSERT INTO agents (id, pane_index, role, status, last_heartbeat_at, registered_at)
    VALUES (?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      pane_index = excluded.pane_index,
      role = excluded.role,
      status = 'active',
      last_heartbeat_at = excluded.last_heartbeat_at
  `).run(agentId, paneIndex, role ?? null);
    logEvent(db, agentId, 'agent_registered', { pane_index: paneIndex, role });
}
export function updateHeartbeat(db, agentId, codexSessionId) {
    let result;
    if (codexSessionId !== undefined) {
        result = db.prepare(`
      UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), codex_session_id = ?
      WHERE id = ?
    `).run(codexSessionId, agentId);
    }
    else {
        result = db.prepare("UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(agentId);
    }
    if (result.changes === 0) {
        throw new Error(`Agent ${agentId} not found — heartbeat requires prior registration`);
    }
}
export function getStaleAgents(db, maxAgeSeconds) {
    return db.prepare(`
    SELECT * FROM agents
    WHERE status = 'active'
      AND last_heartbeat_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds')
  `).all(`-${maxAgeSeconds}`);
}
import { BACKOFF_BASE_SECONDS, STALE_AGENT_THRESHOLD_SECONDS } from './constants.js';
export function recoverDeadClaim(db, agentId, staleThresholdSeconds = STALE_AGENT_THRESHOLD_SECONDS, paneLivenessCallback) {
    const recover = db.transaction(() => {
        const recovered = [];
        // Re-verify agent is still stale inside the transaction to close the TOCTOU window
        // between getStaleAgents() detection and this recovery action
        const agent = db.prepare("SELECT * FROM agents WHERE id = ? AND status = 'active' AND last_heartbeat_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds')").get(agentId, `-${staleThresholdSeconds}`);
        if (!agent)
            return []; // Agent recovered (heartbeat arrived) or already shut down
        // Pane-liveness check: if process is still running, refresh heartbeat and skip recovery
        if (paneLivenessCallback) {
            const liveness = paneLivenessCallback(agent.pane_index);
            if (liveness === 'alive') {
                db.prepare("UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(agentId);
                logEvent(db, agentId, 'agent_heartbeat_stale', { action: 'refreshed', reason: 'pane_alive' });
                return [];
            }
        }
        const tasks = db.prepare("SELECT * FROM tasks WHERE owner = ? AND status = 'claimed'").all(agentId);
        for (const task of tasks) {
            const isRetriable = task.retry_count < task.max_retries;
            const newStatus = isRetriable ? 'pending' : 'needs_review';
            if (isRetriable) {
                const backoffSeconds = BACKOFF_BASE_SECONDS * Math.pow(2, task.retry_count);
                const retryAfter = new Date(Date.now() + backoffSeconds * 1000).toISOString();
                db.prepare(`
          UPDATE tasks SET status = ?, owner = NULL, failure_reason = 'timeout', retry_count = retry_count + 1, retry_after = ?
          WHERE id = ?
        `).run(newStatus, retryAfter, task.id);
            }
            else {
                db.prepare(`
          UPDATE tasks SET status = ?, owner = NULL, failure_reason = 'timeout'
          WHERE id = ?
        `).run(newStatus, task.id);
            }
            recovered.push(task.id);
            logEvent(db, agentId, 'agent_heartbeat_stale', { task_id: task.id, new_status: newStatus });
        }
        // Mark agent as shutdown
        db.prepare("UPDATE agents SET status = 'shutdown' WHERE id = ?").run(agentId);
        return recovered;
    });
    return recover.immediate();
}
export function getActiveAgents(db) {
    return db.prepare("SELECT * FROM agents WHERE status = 'active'").all();
}
export function getAgent(db, agentId) {
    return db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
}
export function getAgentByPaneIndex(db, paneIndex) {
    return db.prepare("SELECT * FROM agents WHERE pane_index = ? AND status = 'active' ORDER BY registered_at DESC LIMIT 1").get(paneIndex);
}
//# sourceMappingURL=agent-ops.js.map