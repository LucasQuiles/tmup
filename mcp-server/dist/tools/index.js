import { ensureDb, switchSession, getCurrentSessionId } from '../index.js';
import { initSession, getSessionDbPath, createTask, createTaskBatch, updateTask, claimTask, completeTask, failTask, cancelTask, sendMessage, getInbox, getUnreadCount, postCheckpoint, registerAgent, getStaleAgents, recoverDeadClaim, getActiveAgents, getRecentEvents, logEvent, } from '@tmup/shared';
// --- Tool definitions ---
export const toolDefinitions = [
    {
        name: 'tmup_init',
        description: 'Initialize or reattach to a tmup session for a project directory. Creates SQLite DB, tmux grid, and session registry entry.',
        inputSchema: {
            type: 'object',
            properties: {
                project_dir: { type: 'string', description: 'Absolute path to the project directory' },
                session_name: { type: 'string', description: 'Optional session name prefix (default: tmup)' },
            },
            required: ['project_dir'],
        },
    },
    {
        name: 'tmup_status',
        description: 'Get session status summary. Side-effect: runs dead-claim recovery for stale agents.',
        inputSchema: {
            type: 'object',
            properties: {
                verbose: { type: 'boolean', description: 'If true, return full DAG details instead of summary' },
            },
        },
    },
    {
        name: 'tmup_next_action',
        description: 'Get a single synthesized recommendation for what to do next based on DAG state.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'tmup_task_create',
        description: 'Create a single task in the DAG.',
        inputSchema: {
            type: 'object',
            properties: {
                subject: { type: 'string', description: 'Task title (max 500 chars)' },
                description: { type: 'string', description: 'Task description' },
                role: { type: 'string', description: 'Required role (implementer, tester, reviewer, etc.)' },
                priority: { type: 'number', description: 'Priority 0-100 (default 50, higher=more urgent)' },
                max_retries: { type: 'number', description: 'Max retry attempts (default 3)' },
                deps: { type: 'array', items: { type: 'string' }, description: 'Task IDs this depends on' },
                requires: { type: 'array', items: { type: 'string' }, description: 'Artifact names this task requires' },
                produces: { type: 'array', items: { type: 'string' }, description: 'Artifact names this task produces' },
            },
            required: ['subject'],
        },
    },
    {
        name: 'tmup_task_batch',
        description: 'Create multiple tasks atomically. Intra-batch dependencies allowed (tasks inserted in array order).',
        inputSchema: {
            type: 'object',
            properties: {
                tasks: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            subject: { type: 'string' },
                            description: { type: 'string' },
                            role: { type: 'string' },
                            priority: { type: 'number' },
                            max_retries: { type: 'number' },
                            deps: { type: 'array', items: { type: 'string' } },
                            requires: { type: 'array', items: { type: 'string' } },
                            produces: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['subject'],
                    },
                    description: 'Array of task definitions',
                },
            },
            required: ['tasks'],
        },
    },
    {
        name: 'tmup_task_update',
        description: 'Update a task (lead-only). Valid transitions: needs_review->pending, pending->cancelled, blocked->pending.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Task ID to update' },
                status: { type: 'string', description: 'New status' },
                priority: { type: 'number', description: 'New priority' },
                role: { type: 'string', description: 'New role requirement' },
                description: { type: 'string', description: 'Updated description' },
                max_retries: { type: 'number', description: 'New max retries' },
            },
            required: ['task_id'],
        },
    },
    {
        name: 'tmup_claim',
        description: 'Claim the next available pending task for an agent.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Agent UUID' },
                role: { type: 'string', description: 'Optional role filter' },
            },
            required: ['agent_id'],
        },
    },
    {
        name: 'tmup_complete',
        description: 'Mark a task as completed. Triggers dependency cascade to unblock dependent tasks.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Task ID' },
                result_summary: { type: 'string', description: 'Summary of what was accomplished' },
                artifacts: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            path: { type: 'string' },
                        },
                        required: ['name', 'path'],
                    },
                    description: 'Artifacts produced',
                },
            },
            required: ['task_id', 'result_summary'],
        },
    },
    {
        name: 'tmup_fail',
        description: 'Mark a task as failed. Retriable reasons (crash, timeout) auto-retry with backoff.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Task ID' },
                reason: { type: 'string', enum: ['crash', 'timeout', 'logic_error', 'artifact_missing', 'dependency_invalid'], description: 'Failure reason' },
                message: { type: 'string', description: 'Error details' },
            },
            required: ['task_id', 'reason', 'message'],
        },
    },
    {
        name: 'tmup_cancel',
        description: 'Cancel a task. With cascade=true, cancels all transitive dependents.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Task ID' },
                cascade: { type: 'boolean', description: 'If true, cancel all dependents (default false)' },
            },
            required: ['task_id'],
        },
    },
    {
        name: 'tmup_checkpoint',
        description: 'Post a progress checkpoint for a task. Updates result_summary and messages lead.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Task ID' },
                message: { type: 'string', description: 'Checkpoint message' },
            },
            required: ['task_id', 'message'],
        },
    },
    {
        name: 'tmup_send_message',
        description: 'Send a message between agents. From lead to workers or between workers.',
        inputSchema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Recipient agent ID, or null for broadcast' },
                type: { type: 'string', enum: ['direct', 'broadcast', 'finding', 'blocker', 'checkpoint', 'shutdown'], description: 'Message type' },
                payload: { type: 'string', description: 'Message content' },
                task_id: { type: 'string', description: 'Optional related task ID' },
            },
            required: ['type', 'payload'],
        },
    },
    {
        name: 'tmup_inbox',
        description: 'Check inbox for unread messages. Without mark_read, returns count only.',
        inputSchema: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: 'Agent ID (omit for lead inbox)' },
                mark_read: { type: 'boolean', description: 'If true, return and mark messages as read' },
            },
        },
    },
    {
        name: 'tmup_dispatch',
        description: 'Dispatch a Codex worker to a tmux pane with a task assignment.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Task to assign' },
                role: { type: 'string', description: 'Agent role' },
                pane_index: { type: 'number', description: 'Specific pane (auto-select if omitted)' },
                working_dir: { type: 'string', description: 'Working directory (defaults to project_dir)' },
            },
            required: ['task_id', 'role'],
        },
    },
    {
        name: 'tmup_harvest',
        description: 'Capture terminal scrollback from a pane (ANSI stripped). Fallback monitoring.',
        inputSchema: {
            type: 'object',
            properties: {
                pane_index: { type: 'number', description: 'Pane index to capture' },
                lines: { type: 'number', description: 'Lines to capture (default from policy)' },
            },
            required: ['pane_index'],
        },
    },
    {
        name: 'tmup_pause',
        description: 'Pause the session: broadcast shutdown, wait for checkpoints, archive grid.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'tmup_resume',
        description: 'Resume a paused session: recreate grid, re-dispatch in-progress tasks.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Session to resume (default: current)' },
            },
        },
    },
    {
        name: 'tmup_teardown',
        description: 'Shut down the session: grace period, harvest all, kill tmux, keep DB.',
        inputSchema: {
            type: 'object',
            properties: {
                force: { type: 'boolean', description: 'Skip grace period' },
            },
        },
    },
];
// --- Tool handler dispatch ---
export async function handleToolCall(name, args) {
    const text = (s) => ({ content: [{ type: 'text', text: s }] });
    const json = (obj) => text(JSON.stringify(obj));
    switch (name) {
        case 'tmup_init': {
            const projectDir = args.project_dir;
            const sessionName = args.session_name;
            const result = initSession(projectDir, sessionName);
            // Switch the MCP server's DB connection to the new session
            switchSession(result.session_id, result.db_path);
            logEvent(ensureDb(), null, 'session_init', { project_dir: projectDir, session_id: result.session_id });
            return json({ ok: true, session_id: result.session_id, reattached: result.reattached });
        }
        case 'tmup_status': {
            const db = ensureDb();
            const verbose = args.verbose === true;
            // Side-effect: dead-claim recovery
            const staleAgents = getStaleAgents(db, 300);
            const recovered = [];
            for (const agent of staleAgents) {
                recovered.push(...recoverDeadClaim(db, agent.id));
            }
            if (verbose) {
                const tasks = db.prepare('SELECT * FROM tasks ORDER BY CAST(id AS INTEGER)').all();
                const agents = getActiveAgents(db);
                const unread = getUnreadCount(db, 'lead');
                return json({ ok: true, tasks, agents, unread, recovered });
            }
            // Summary mode
            const counts = db.prepare(`
        SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status
      `).all();
            const statusMap = {};
            for (const c of counts)
                statusMap[c.status] = c.cnt;
            const unread = getUnreadCount(db, 'lead');
            const total = Object.values(statusMap).reduce((a, b) => a + b, 0);
            const summary = [
                `${statusMap['pending'] ?? 0} pending`,
                `${statusMap['blocked'] ?? 0} blocked`,
                `${statusMap['claimed'] ?? 0} claimed`,
                `${statusMap['in_progress'] ?? 0} in_progress`,
                `${statusMap['completed'] ?? 0} completed`,
                `${statusMap['failed'] ?? 0} failed`,
                `${statusMap['cancelled'] ?? 0} cancelled`,
                `${statusMap['needs_review'] ?? 0} needs_review`,
            ].filter(s => !s.startsWith('0 ')).join(', ');
            return text(`${total} tasks: ${summary || 'none'}. ${unread} unread messages.${recovered.length ? ` Recovered ${recovered.length} dead-claimed tasks.` : ''}`);
        }
        case 'tmup_next_action': {
            const db = ensureDb();
            // 1. Failed tasks needing review
            const needsReview = db.prepare("SELECT * FROM tasks WHERE status = 'needs_review' ORDER BY priority DESC LIMIT 1").get();
            if (needsReview) {
                return text(`Task T-${needsReview.id} (${needsReview.subject}) needs review — ${needsReview.failure_reason ?? 'unknown reason'}. Review and reset or cancel.`);
            }
            // 2. Unread blocker messages
            const blocker = db.prepare("SELECT * FROM messages WHERE type = 'blocker' AND read_at IS NULL ORDER BY created_at ASC LIMIT 1").get();
            if (blocker) {
                return text(`Blocker from ${blocker.from_agent}${blocker.task_id ? ` on T-${blocker.task_id}` : ''}: \n[WORKER MESSAGE from ${blocker.from_agent}, type=blocker${blocker.task_id ? `, task=${blocker.task_id}` : ''}]:\n${blocker.payload}\n[END WORKER MESSAGE]`);
            }
            // 3. Recently unblocked tasks
            const recentUnblocked = getRecentEvents(db, 'task_unblocked', 5);
            if (recentUnblocked.length > 0) {
                const payload = JSON.parse(recentUnblocked[0].payload ?? '{}');
                const taskId = payload.task_id;
                if (taskId) {
                    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
                    if (task && task.status === 'pending') {
                        return text(`Task T-${task.id} (${task.subject}) just unblocked — assign to ${task.role ?? 'any role'}.`);
                    }
                }
            }
            // 4. Idle panes with pending tasks
            const pendingCount = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'pending'").get().cnt;
            const activeAgents = getActiveAgents(db);
            const claimedTaskCount = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status IN ('claimed', 'in_progress')").get().cnt;
            const totalPanes = 8; // 2x4 grid
            const idlePanes = totalPanes - activeAgents.length;
            if (pendingCount > 0 && idlePanes > 0) {
                return text(`${pendingCount} pending tasks, ${idlePanes} idle panes — dispatch next highest-priority task.`);
            }
            // 5. All tasks complete
            const incomplete = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status NOT IN ('completed', 'cancelled')").get().cnt;
            const totalTasks = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get().cnt;
            if (totalTasks > 0 && incomplete === 0) {
                return text(`All ${totalTasks} tasks completed. Ready for teardown.`);
            }
            // 6. Waiting
            return text(`${claimedTaskCount} tasks in progress, ${pendingCount} pending, ${db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'blocked'").get().cnt} blocked. No action needed.`);
        }
        case 'tmup_task_create': {
            const db = ensureDb();
            const taskId = createTask(db, {
                subject: args.subject,
                description: args.description,
                role: args.role,
                priority: args.priority,
                max_retries: args.max_retries,
                deps: args.deps,
                requires: args.requires,
                produces: args.produces,
            });
            return json({ ok: true, task_id: taskId });
        }
        case 'tmup_task_batch': {
            const db = ensureDb();
            const tasks = args.tasks;
            const ids = createTaskBatch(db, tasks.map(t => ({
                subject: t.subject,
                description: t.description,
                role: t.role,
                priority: t.priority,
                max_retries: t.max_retries,
                deps: t.deps,
                requires: t.requires,
                produces: t.produces,
            })));
            return json({ ok: true, task_ids: ids });
        }
        case 'tmup_task_update': {
            const db = ensureDb();
            const result = updateTask(db, args.task_id, {
                status: args.status,
                priority: args.priority,
                role: args.role,
                description: args.description,
                max_retries: args.max_retries,
            });
            return json(result);
        }
        case 'tmup_claim': {
            const db = ensureDb();
            const task = claimTask(db, args.agent_id, args.role);
            if (!task)
                return json({ ok: true, task: null });
            return json({ ok: true, task_id: task.id, subject: task.subject, description: task.description });
        }
        case 'tmup_complete': {
            const db = ensureDb();
            const result = completeTask(db, args.task_id, args.result_summary, args.artifacts);
            return json({ ok: true, unblocked: result.unblocked });
        }
        case 'tmup_fail': {
            const db = ensureDb();
            const result = failTask(db, args.task_id, args.reason, args.message);
            return json({ ok: true, ...result });
        }
        case 'tmup_cancel': {
            const db = ensureDb();
            const result = cancelTask(db, args.task_id, args.cascade === true);
            return json({ ok: true, cancelled: result.cancelled });
        }
        case 'tmup_checkpoint': {
            const db = ensureDb();
            // For MCP calls, we need agent context — use 'lead' as the agent
            // since checkpoints from MCP are lead-initiated status updates
            const agentId = args.agent_id ?? 'lead';
            postCheckpoint(db, args.task_id, agentId, args.message);
            return json({ ok: true });
        }
        case 'tmup_send_message': {
            const db = ensureDb();
            sendMessage(db, {
                from_agent: 'lead',
                to_agent: args.to ?? null,
                type: args.type,
                payload: args.payload,
                task_id: args.task_id,
            });
            return json({ ok: true });
        }
        case 'tmup_inbox': {
            const db = ensureDb();
            const agentId = args.agent_id ?? 'lead';
            const markRead = args.mark_read === true;
            if (!markRead) {
                const count = getUnreadCount(db, agentId);
                return json({ ok: true, unread: count });
            }
            const messages = getInbox(db, agentId, true);
            // Content framing for worker-sourced messages
            const framed = messages.map(m => ({
                id: m.id,
                from: m.from_agent,
                type: m.type,
                task_id: m.task_id,
                created_at: m.created_at,
                payload_framed: `[WORKER MESSAGE from ${m.from_agent}, type=${m.type}${m.task_id ? `, task=${m.task_id}` : ''}]:\n${m.payload}\n[END WORKER MESSAGE]`,
            }));
            return json({ ok: true, messages: framed });
        }
        case 'tmup_dispatch': {
            const db = ensureDb();
            // Dispatch is a complex operation involving bash scripts
            // For now, return the info needed; the actual tmux operations
            // are handled by the grid scripts called from here
            const taskId = args.task_id;
            const role = args.role;
            const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
            if (!task)
                throw new Error(`Task ${taskId} not found`);
            const { generateAgentId } = await import('@tmup/shared');
            const agentId = generateAgentId();
            const paneIndex = args.pane_index;
            // Pre-claim the task for the new agent
            db.prepare("UPDATE tasks SET status = 'claimed', owner = ?, claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending'").run(agentId, taskId);
            // Register the agent
            registerAgent(db, agentId, paneIndex ?? -1, role);
            logEvent(db, 'lead', 'dispatch', {
                task_id: taskId,
                agent_id: agentId,
                role,
                pane_index: paneIndex,
            });
            // The actual tmux dispatch is done by calling the bash script
            // from the skill/command layer which has shell access
            return json({
                ok: true,
                agent_id: agentId,
                task_id: taskId,
                pane_index: paneIndex ?? 'auto',
                role,
                subject: task.subject,
            });
        }
        case 'tmup_harvest': {
            // Harvest requires shell access — return instruction for the caller
            return json({
                ok: true,
                instruction: `Run: tmux capture-pane -t "$(tmux list-panes -F '#{pane_id}' | sed -n '${args.pane_index + 1}p')" -p -S -${args.lines ?? 500} | sed 's/\\x1b\\[[0-9;]*m//g'`,
            });
        }
        case 'tmup_pause': {
            const db = ensureDb();
            // Broadcast shutdown to all agents
            const agents = getActiveAgents(db);
            for (const agent of agents) {
                sendMessage(db, {
                    from_agent: 'lead',
                    to_agent: agent.id,
                    type: 'shutdown',
                    payload: 'Session pausing. Checkpoint your work.',
                });
            }
            logEvent(db, 'lead', 'session_pause', { agent_count: agents.length });
            return json({ ok: true, agents_notified: agents.length });
        }
        case 'tmup_resume': {
            const sessionId = args.session_id ?? getCurrentSessionId();
            if (!sessionId)
                throw new Error('No session to resume');
            const dbPath = getSessionDbPath(sessionId);
            if (!dbPath)
                throw new Error(`Session ${sessionId} not found`);
            switchSession(sessionId, dbPath);
            const db = ensureDb();
            // Dead-claim recovery
            const stale = getStaleAgents(db, 300);
            const recovered = [];
            for (const agent of stale) {
                recovered.push(...recoverDeadClaim(db, agent.id));
            }
            logEvent(db, 'lead', 'session_resume', { recovered });
            return json({ ok: true, session_id: sessionId, recovered });
        }
        case 'tmup_teardown': {
            const db = ensureDb();
            const agents = getActiveAgents(db);
            if (!(args.force === true) && agents.length > 0) {
                // Send shutdown messages
                for (const agent of agents) {
                    sendMessage(db, {
                        from_agent: 'lead',
                        to_agent: agent.id,
                        type: 'shutdown',
                        payload: 'Session tearing down.',
                    });
                }
            }
            logEvent(db, 'lead', 'session_teardown', { force: args.force === true });
            return json({ ok: true, agents_notified: agents.length });
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
//# sourceMappingURL=index.js.map