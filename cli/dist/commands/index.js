import { claimTask, completeTask, failTask, sendMessage, getInbox, getUnreadCount, postCheckpoint, registerAgent, updateHeartbeat, getAgent, } from '@tmup/shared';
function requireAgentId(env) {
    if (!env.agentId)
        throw new Error('TMUP_AGENT_ID not set');
    return env.agentId;
}
function parseFlag(args, flag) {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length)
        return undefined;
    return args[idx + 1];
}
function hasFlag(args, flag) {
    return args.includes(flag);
}
function positional(args) {
    for (const arg of args) {
        if (!arg.startsWith('--'))
            return arg;
    }
    return undefined;
}
export async function handleCommand(db, command, args, env) {
    switch (command) {
        case 'claim': {
            const agentId = requireAgentId(env);
            const role = parseFlag(args, '--role');
            const task = claimTask(db, agentId, role);
            if (!task) {
                const unread = getUnreadCount(db, agentId);
                return { ok: true, task: null, error: 'NO_PENDING_TASKS', unread };
            }
            const unread = getUnreadCount(db, agentId);
            return { ok: true, task_id: task.id, subject: task.subject, description: task.description, unread };
        }
        case 'complete': {
            const agentId = requireAgentId(env);
            const resultSummary = positional(args);
            if (!resultSummary)
                throw new Error('Result summary required');
            // Parse --artifact name:path pairs
            const artifacts = [];
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '--artifact' && i + 1 < args.length) {
                    const parts = args[i + 1].split(':');
                    if (parts.length < 2)
                        throw new Error(`Invalid artifact format: ${args[i + 1]} (expected name:path)`);
                    const name = parts[0];
                    const path = parts.slice(1).join(':'); // Handle colons in paths
                    artifacts.push({ name, path });
                    i++;
                }
            }
            // Determine task ID
            const taskId = parseFlag(args, '--task-id') ?? env.taskId;
            if (!taskId) {
                // Find the agent's current claimed task
                const task = db.prepare("SELECT id FROM tasks WHERE owner = ? AND status IN ('claimed', 'in_progress') LIMIT 1").get(agentId);
                if (!task)
                    throw new Error('No active task. Specify --task-id');
                const result = completeTask(db, task.id, resultSummary, artifacts.length > 0 ? artifacts : undefined);
                const unread = getUnreadCount(db, agentId);
                return { ok: true, task_id: task.id, unblocked: result.unblocked, unread };
            }
            const result = completeTask(db, taskId, resultSummary, artifacts.length > 0 ? artifacts : undefined);
            const unread = getUnreadCount(db, agentId);
            return { ok: true, task_id: taskId, unblocked: result.unblocked, unread };
        }
        case 'fail': {
            const agentId = requireAgentId(env);
            const reason = parseFlag(args, '--reason');
            if (!reason)
                throw new Error('--reason required (crash, timeout, logic_error, artifact_missing, dependency_invalid)');
            const message = positional(args) ?? '';
            const taskId = parseFlag(args, '--task-id') ?? env.taskId;
            if (!taskId) {
                const task = db.prepare("SELECT id FROM tasks WHERE owner = ? AND status IN ('claimed', 'in_progress') LIMIT 1").get(agentId);
                if (!task)
                    throw new Error('No active task');
                const result = failTask(db, task.id, reason, message);
                return { ok: true, task_id: task.id, ...result };
            }
            const result = failTask(db, taskId, reason, message);
            return { ok: true, task_id: taskId, ...result };
        }
        case 'checkpoint': {
            const agentId = requireAgentId(env);
            const taskId = args[0];
            const message = args[1] ?? args[0];
            // If only one arg, it's the message and we find the task
            let resolvedTaskId = taskId;
            let resolvedMessage = message;
            if (args.length === 1) {
                resolvedMessage = args[0];
                const task = db.prepare("SELECT id FROM tasks WHERE owner = ? AND status IN ('claimed', 'in_progress') LIMIT 1").get(agentId);
                if (!task)
                    throw new Error('No active task');
                resolvedTaskId = task.id;
            }
            postCheckpoint(db, resolvedTaskId, agentId, resolvedMessage);
            return { ok: true };
        }
        case 'message': {
            const agentId = requireAgentId(env);
            const to = parseFlag(args, '--to');
            const isBroadcast = hasFlag(args, '--broadcast');
            const msgType = parseFlag(args, '--type') ?? (isBroadcast ? 'broadcast' : 'direct');
            const payload = positional(args);
            if (!payload)
                throw new Error('Message payload required');
            sendMessage(db, {
                from_agent: agentId,
                to_agent: isBroadcast ? null : (to ?? 'lead'),
                type: msgType,
                payload,
            });
            return { ok: true };
        }
        case 'inbox': {
            const agentId = requireAgentId(env);
            const markRead = hasFlag(args, '--mark-read');
            if (!markRead) {
                const count = getUnreadCount(db, agentId);
                return { ok: true, unread: count };
            }
            const messages = getInbox(db, agentId, true);
            return { ok: true, messages: messages.map(m => ({
                    id: m.id,
                    from: m.from_agent,
                    type: m.type,
                    payload: m.payload,
                    task_id: m.task_id,
                    created_at: m.created_at,
                })) };
        }
        case 'heartbeat': {
            const agentId = requireAgentId(env);
            const codexSessionId = parseFlag(args, '--codex-session-id');
            // Validate codex session ID format
            if (codexSessionId && !/^[a-zA-Z0-9-]+$/.test(codexSessionId)) {
                throw new Error('Invalid codex session ID format (must be alphanumeric + hyphens)');
            }
            // Register agent if not exists
            const existing = getAgent(db, agentId);
            if (!existing) {
                const paneIndex = parseInt(env.paneIndex ?? '0', 10);
                registerAgent(db, agentId, paneIndex);
            }
            updateHeartbeat(db, agentId, codexSessionId);
            return { ok: true };
        }
        case 'status': {
            const agentId = requireAgentId(env);
            const agent = getAgent(db, agentId);
            const currentTask = db.prepare("SELECT * FROM tasks WHERE owner = ? AND status IN ('claimed', 'in_progress') LIMIT 1").get(agentId);
            const unread = getUnreadCount(db, agentId);
            return {
                ok: true,
                agent_id: agentId,
                pane_index: agent?.pane_index ?? env.paneIndex,
                current_task: currentTask ? {
                    id: currentTask.id,
                    subject: currentTask.subject,
                    status: currentTask.status,
                } : null,
                unread,
            };
        }
        default:
            throw new Error(`Unknown command: ${command}. Valid: claim, complete, fail, checkpoint, message, inbox, heartbeat, status`);
    }
}
//# sourceMappingURL=index.js.map