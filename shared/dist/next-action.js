import { getRecentEvents } from './event-ops.js';
import { getActiveAgents } from './agent-ops.js';
import { CLAIMED_DURATION_WARNING_SECONDS } from './constants.js';
/**
 * Synthesize a single recommended next action from DAG state.
 * Pure domain logic — no adapter concerns (grid state, MCP response formatting).
 */
export function getNextAction(db, paneInfo) {
    // 1. Tasks needing review (highest priority — represents a failure/retry scenario)
    const needsReview = db.prepare("SELECT * FROM tasks WHERE status = 'needs_review' ORDER BY priority DESC LIMIT 1").get();
    if (needsReview) {
        return {
            kind: 'needs_review',
            message: `Task T-${needsReview.id} (${needsReview.subject}) needs review — ${needsReview.failure_reason ?? 'unknown reason'}. Review and reset or cancel.`,
        };
    }
    // 2. Unread blocker messages (agent is stuck)
    const blocker = db.prepare("SELECT * FROM messages WHERE type = 'blocker' AND read_at IS NULL ORDER BY created_at ASC LIMIT 1").get();
    if (blocker) {
        return {
            kind: 'blocker',
            message: `Blocker from ${blocker.from_agent}${blocker.task_id ? ` on T-${blocker.task_id}` : ''}. Resolve before proceeding.\n\n[WORKER MESSAGE from ${blocker.from_agent}, type=blocker${blocker.task_id ? `, task=${blocker.task_id}` : ''}]:\n${blocker.payload}\n[END WORKER MESSAGE]`,
        };
    }
    // 2.5: Long-running tasks — claimed beyond threshold without completion
    const longRunning = db.prepare(`
    SELECT t.*, a.pane_index FROM tasks t
    LEFT JOIN agents a ON t.owner = a.id
    WHERE t.status = 'claimed'
      AND t.claimed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' seconds')
    ORDER BY t.claimed_at ASC LIMIT 1
  `).get(`-${CLAIMED_DURATION_WARNING_SECONDS}`);
    if (longRunning) {
        const claimedMinutes = Math.round((Date.now() - new Date(longRunning.claimed_at).getTime()) / 60000);
        const paneHint = longRunning.pane_index !== null ? ` Harvest pane ${longRunning.pane_index} and check progress.` : '';
        return {
            kind: 'long_running',
            message: `Task T-${longRunning.id} (${longRunning.subject}) has been claimed for ${claimedMinutes} minutes.${paneHint}`,
        };
    }
    // 3. Recently unblocked tasks (DAG progress) — iterate through candidates
    const recentUnblocked = getRecentEvents(db, 'task_unblocked', 5);
    for (const event of recentUnblocked) {
        let payload = null;
        try {
            payload = JSON.parse(event.payload ?? '{}');
        }
        catch (err) {
            console.error(`[tmup] Warning: corrupted event payload for task_unblocked event: ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }
        const taskId = payload?.task_id;
        if (taskId && typeof taskId === 'string') {
            const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
            if (task && task.status === 'pending') {
                return {
                    kind: 'unblocked',
                    message: `Task T-${task.id} (${task.subject}) just unblocked — assign to ${task.role ?? 'any role'}.`,
                };
            }
        }
    }
    // 4. Idle panes with pending work
    const pendingCount = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'pending'").get().cnt;
    const activeAgents = getActiveAgents(db);
    const claimedTaskCount = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'claimed'").get().cnt;
    const idlePanes = paneInfo.totalPanes - activeAgents.length;
    if (pendingCount > 0 && idlePanes > 0) {
        return {
            kind: 'dispatch',
            message: `${pendingCount} pending tasks, ${idlePanes} idle panes — dispatch next highest-priority task.`,
        };
    }
    // 5. All tasks complete
    const incomplete = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status NOT IN ('completed', 'cancelled')").get().cnt;
    const totalTasks = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get().cnt;
    if (totalTasks > 0 && incomplete === 0) {
        return {
            kind: 'all_complete',
            message: `All ${totalTasks} tasks completed. Ready for teardown.`,
        };
    }
    // 6. Waiting — nothing actionable
    const blockedCount = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'blocked'").get().cnt;
    return {
        kind: 'waiting',
        message: `${claimedTaskCount} tasks in progress, ${pendingCount} pending, ${blockedCount} blocked. No action needed.`,
    };
}
//# sourceMappingURL=next-action.js.map