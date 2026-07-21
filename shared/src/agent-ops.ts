import type { Database, AgentRow, TaskAttemptRow, TaskRow } from './types.js';
import { logEvent } from './event-ops.js';

export function registerAgent(
  db: Database,
  agentId: string,
  paneIndex: number,
  role?: string
): void {
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

export function updateHeartbeat(
  db: Database,
  agentId: string,
  codexSessionId?: string,
  paneIndex?: number
): void {
  const result = db.prepare(`
    UPDATE agents SET
      last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      codex_session_id = COALESCE(?, codex_session_id),
      pane_index = COALESCE(?, pane_index)
    WHERE id = ?
  `).run(codexSessionId ?? null, paneIndex ?? null, agentId);
  if (result.changes === 0) {
    throw new Error(`Agent ${agentId} not found — heartbeat requires prior registration`);
  }
}

export function getStaleAgents(db: Database, maxAgeSeconds: number): AgentRow[] {
  return db.prepare(`
    SELECT * FROM agents
    WHERE status = 'active'
      AND last_heartbeat_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds')
  `).all(`-${maxAgeSeconds}`) as AgentRow[];
}

import { BACKOFF_BASE_SECONDS, STALE_AGENT_THRESHOLD_SECONDS } from './constants.js';

export interface ReconciliationResult {
  agent_id: string;
  task_id: string | null;
  attempt_id: string | null;
  action: 'retained' | 'retried' | 'needs_review' | 'inconclusive' | 'shutdown';
  reason: string;
  mutated: boolean;
}

type PaneLiveness = 'alive' | 'shell' | 'dead' | 'unknown';

function hasValidLaunchReceipt(task: TaskRow, attempt: TaskAttemptRow | undefined): boolean {
  if (task.role_required !== 1) return true;
  return attempt !== undefined
    && attempt.task_id === task.id
    && attempt.agent_id === task.owner
    && attempt.role === task.role
    && attempt.status === 'running'
    && attempt.execution_outcome === null
    && Boolean(attempt.selector?.trim())
    && attempt.selector !== 'unknown'
    && Boolean(attempt.requested_model.trim())
    && attempt.requested_model !== 'unknown';
}

export function reconcileClaim(
  db: Database,
  agentId: string,
  paneLivenessCallback: (paneIndex: number) => PaneLiveness,
  options: { staleThresholdSeconds?: number; dryRun?: boolean } = {},
): ReconciliationResult {
  const staleThresholdSeconds = options.staleThresholdSeconds ?? STALE_AGENT_THRESHOLD_SECONDS;
  const dryRun = options.dryRun === true;
  const reconcile = db.transaction(() => {
    const agent = db.prepare(
      "SELECT * FROM agents WHERE id = ? AND status = 'active' AND last_heartbeat_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds')"
    ).get(agentId, `-${staleThresholdSeconds}`) as AgentRow | undefined;
    if (!agent) {
      return {
        agent_id: agentId,
        task_id: null,
        attempt_id: null,
        action: 'retained' as const,
        reason: 'agent_not_stale',
        mutated: false,
      };
    }

    const task = db.prepare(
      "SELECT * FROM tasks WHERE owner = ? AND status = 'claimed' ORDER BY claimed_at DESC LIMIT 1"
    ).get(agentId) as TaskRow | undefined;
    const attempt = task
      ? db.prepare(`
          SELECT * FROM task_attempts
          WHERE task_id = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT 1
        `).get(task.id) as TaskAttemptRow | undefined
      : undefined;

    if (!task) {
      if (!dryRun) {
        db.prepare("UPDATE agents SET status = 'shutdown' WHERE id = ?").run(agentId);
        logEvent(db, agentId, 'agent_heartbeat_stale', {
          action: 'shutdown', reason: 'stale_agent_without_claim',
        });
      }
      return {
        agent_id: agentId,
        task_id: null,
        attempt_id: attempt?.id ?? null,
        action: 'shutdown' as const,
        reason: 'stale_agent_without_claim',
        mutated: !dryRun,
      };
    }

    const liveness = paneLivenessCallback(agent.pane_index);
    if (liveness === 'alive') {
      const receiptValid = hasValidLaunchReceipt(task, attempt);
      if (!dryRun) {
        db.prepare(
          "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
        ).run(agentId);
        logEvent(db, agentId, 'agent_heartbeat_stale', {
          action: 'refreshed',
          reason: receiptValid ? 'pane_alive' : 'pane_alive_receipt_missing',
          task_id: task.id,
          attempt_id: attempt?.id ?? null,
        });
      }
      return {
        agent_id: agentId,
        task_id: task.id,
        attempt_id: attempt?.id ?? null,
        action: 'retained' as const,
        reason: receiptValid ? 'pane_alive' : 'pane_alive_receipt_missing',
        mutated: !dryRun,
      };
    }

    if (liveness === 'unknown') {
      if (!dryRun) {
        if (attempt?.status === 'running' && attempt.execution_outcome === null) {
          db.prepare(`
            UPDATE task_attempts
            SET status = 'abandoned', execution_outcome = 'inconclusive',
                failure_reason = 'pane_liveness_unknown',
                ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ? AND status = 'running' AND execution_outcome IS NULL
          `).run(attempt.id);
        }
        db.prepare("UPDATE tasks SET execution_outcome = 'inconclusive' WHERE id = ?").run(task.id);
        logEvent(db, agentId, 'agent_heartbeat_stale', {
          action: 'inconclusive', reason: 'pane_liveness_unknown',
          task_id: task.id, attempt_id: attempt?.id ?? null,
        });
      }
      return {
        agent_id: agentId,
        task_id: task.id,
        attempt_id: attempt?.id ?? null,
        action: 'inconclusive' as const,
        reason: 'pane_liveness_unknown',
        mutated: !dryRun,
      };
    }

    const isRetriable = task.retry_count < task.max_retries;
    const action = isRetriable ? 'retried' as const : 'needs_review' as const;
    const reason = liveness === 'shell'
      ? isRetriable ? 'pane_shell' : 'pane_shell_retries_exhausted'
      : isRetriable ? 'pane_dead' : 'pane_dead_retries_exhausted';
    if (!dryRun) {
      if (attempt?.status === 'running' && attempt.execution_outcome === null) {
        db.prepare(`
          UPDATE task_attempts
          SET status = 'abandoned', failure_reason = ?,
              ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'running' AND execution_outcome IS NULL
        `).run(reason, attempt.id);
      }
      if (isRetriable) {
        const backoffSeconds = BACKOFF_BASE_SECONDS * Math.pow(2, task.retry_count);
        const retryAfter = new Date(Date.now() + backoffSeconds * 1000).toISOString();
        db.prepare(`
          UPDATE tasks
          SET status = 'pending', owner = NULL, failure_reason = 'timeout',
              retry_count = retry_count + 1, retry_after = ?, execution_outcome = NULL
          WHERE id = ?
        `).run(retryAfter, task.id);
      } else {
        db.prepare(`
          UPDATE tasks
          SET status = 'needs_review', owner = NULL, failure_reason = 'timeout'
          WHERE id = ?
        `).run(task.id);
      }
      db.prepare("UPDATE agents SET status = 'shutdown' WHERE id = ?").run(agentId);
      logEvent(db, agentId, 'agent_heartbeat_stale', {
        action, reason, task_id: task.id, attempt_id: attempt?.id ?? null,
      });
    }
    return {
      agent_id: agentId,
      task_id: task.id,
      attempt_id: attempt?.id ?? null,
      action,
      reason,
      mutated: !dryRun,
    };
  });

  return reconcile.immediate();
}

export function recoverDeadClaim(
  db: Database,
  agentId: string,
  staleThresholdSeconds: number = STALE_AGENT_THRESHOLD_SECONDS,
  paneLivenessCallback?: (paneIndex: number) => 'alive' | 'shell' | 'dead' | 'unknown'
): string[] {
  const result = reconcileClaim(
    db,
    agentId,
    paneLivenessCallback ?? (() => 'dead'),
    { staleThresholdSeconds },
  );
  return result.task_id && (result.action === 'retried' || result.action === 'needs_review')
    ? [result.task_id]
    : [];
}

export function getActiveAgents(db: Database): AgentRow[] {
  return db.prepare("SELECT * FROM agents WHERE status = 'active'").all() as AgentRow[];
}

export function getAgent(db: Database, agentId: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as AgentRow | undefined;
}

/** Look up the active agent occupying a specific tmux pane. Used by reprompt and status tools. */
export function getAgentByPaneIndex(db: Database, paneIndex: number): AgentRow | undefined {
  return db.prepare(
    "SELECT * FROM agents WHERE pane_index = ? AND status = 'active' ORDER BY registered_at DESC LIMIT 1"
  ).get(paneIndex) as AgentRow | undefined;
}
