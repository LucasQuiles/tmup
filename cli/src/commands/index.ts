import type { Database } from '@tmup/shared';
import {
  claimTask, completeTask, failTask,
  sendMessage, getInbox, getUnreadCount, postCheckpoint,
  registerAgent, updateHeartbeat, getAgent,
  getActiveTaskForAgent, getRecentEvents, getGridPaneCount,
  FAILURE_REASONS, MESSAGE_TYPES, EVENT_TYPES,
} from '@tmup/shared';
import type { FailureReason, EventType } from '@tmup/shared';

interface EnvContext {
  agentId?: string;
  paneIndex?: string;
  sessionName?: string;
  sessionDir?: string;
  taskId?: string;
  projectDir?: string;
}

function requireAgentId(env: EnvContext): string {
  if (!env.agentId) throw new Error('TMUP_AGENT_ID not set');
  return env.agentId;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Flags that consume a following value argument. */
const FLAGS_WITH_VALUES = new Set([
  '--role', '--reason', '--task-id', '--to', '--type',
  '--artifact', '--codex-session-id', '--limit',
]);

function positional(args: string[]): string | undefined {
  const skip = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (FLAGS_WITH_VALUES.has(args[i])) {
      skip.add(i);
      skip.add(i + 1);
      i++; // skip the value too
    } else if (args[i].startsWith('--')) {
      skip.add(i); // boolean flags like --broadcast, --mark-read
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (!skip.has(i)) return args[i];
  }
  return undefined;
}

export async function handleCommand(
  db: Database,
  command: string,
  args: string[],
  env: EnvContext
): Promise<Record<string, unknown>> {
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
      if (!resultSummary) throw new Error('Result summary required');

      // Parse --artifact name:path pairs
      const artifacts: Array<{ name: string; path: string }> = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--artifact' && i + 1 < args.length) {
          const parts = args[i + 1].split(':');
          if (parts.length < 2) throw new Error(`Invalid artifact format: ${args[i + 1]} (expected name:path)`);
          const name = parts[0];
          const path = parts.slice(1).join(':'); // Handle colons in paths
          artifacts.push({ name, path });
          i++;
        }
      }

      // Determine task ID
      const taskId = parseFlag(args, '--task-id') ?? env.taskId;
      if (!taskId) {
        const task = getActiveTaskForAgent(db, agentId);
        if (!task) throw new Error('No active task. Specify --task-id');
        const result = completeTask(db, task.id, resultSummary, artifacts.length > 0 ? artifacts : undefined, env.projectDir, agentId);
        const unread = getUnreadCount(db, agentId);
        return { ok: true, task_id: task.id, unblocked: result.unblocked, unread };
      }

      const result = completeTask(db, taskId, resultSummary, artifacts.length > 0 ? artifacts : undefined, env.projectDir, agentId);
      const unread = getUnreadCount(db, agentId);
      return { ok: true, task_id: taskId, unblocked: result.unblocked, unread };
    }

    case 'fail': {
      const agentId = requireAgentId(env);
      const reasonStr = parseFlag(args, '--reason');
      if (!reasonStr) throw new Error(`--reason required (${FAILURE_REASONS.join(', ')})`);
      if (!(FAILURE_REASONS as readonly string[]).includes(reasonStr)) throw new Error(`Invalid reason: ${reasonStr}. Valid: ${FAILURE_REASONS.join(', ')}`);
      const reason = reasonStr as FailureReason;
      const message = positional(args);
      if (!message) throw new Error('Failure message required');

      const taskId = parseFlag(args, '--task-id') ?? env.taskId;
      if (!taskId) {
        const task = getActiveTaskForAgent(db, agentId);
        if (!task) throw new Error('No active task');
        const result = failTask(db, task.id, reason, message, agentId);
        return { ok: true, task_id: task.id, ...result };
      }

      const result = failTask(db, taskId, reason, message, agentId);
      return { ok: true, task_id: taskId, ...result };
    }

    case 'checkpoint': {
      const agentId = requireAgentId(env);
      const checkpointMessage = positional(args);
      if (!checkpointMessage) throw new Error('Checkpoint message required');

      const taskId = parseFlag(args, '--task-id') ?? env.taskId;
      let resolvedTaskId: string;
      if (taskId) {
        resolvedTaskId = taskId;
      } else {
        const task = getActiveTaskForAgent(db, agentId);
        if (!task) throw new Error('No active task. Specify --task-id');
        resolvedTaskId = task.id;
      }

      postCheckpoint(db, resolvedTaskId, agentId, checkpointMessage);
      return { ok: true };
    }

    case 'message': {
      const agentId = requireAgentId(env);
      const to = parseFlag(args, '--to');
      const isBroadcast = hasFlag(args, '--broadcast');
      const msgType = parseFlag(args, '--type') ?? (isBroadcast ? 'broadcast' : 'direct');
      if (!(MESSAGE_TYPES as readonly string[]).includes(msgType)) {
        throw new Error(`Invalid message type '${msgType}'. Valid: ${MESSAGE_TYPES.join(', ')}`);
      }
      const payload = positional(args);
      if (!payload) throw new Error('Message payload required');

      sendMessage(db, {
        from_agent: agentId,
        to_agent: isBroadcast ? null : (to ?? 'lead'),
        type: msgType as typeof MESSAGE_TYPES[number],
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

      // Parse pane_index once — used for both registration and heartbeat correction
      const rawPaneIndex = env.paneIndex ?? '0';
      const paneIndex = parseInt(rawPaneIndex, 10);
      if (isNaN(paneIndex) || paneIndex < 0) {
        throw new Error(`Invalid TMUP_PANE_INDEX: '${rawPaneIndex}' (must be a non-negative integer)`);
      }

      const existing = getAgent(db, agentId);
      if (!existing) {
        const { count: gridPanes, source: gridSource } = getGridPaneCount(env.sessionDir);
        if (gridSource !== 'default' && paneIndex >= gridPanes) {
          throw new Error(`Invalid TMUP_PANE_INDEX: '${rawPaneIndex}' (grid has ${gridPanes} panes, max index: ${gridPanes - 1})`);
        }
        registerAgent(db, agentId, paneIndex);
      }

      // Pass pane_index so auto-selected panes (-1 at registration) get corrected
      updateHeartbeat(db, agentId, codexSessionId, paneIndex);
      return { ok: true };
    }

    case 'status': {
      const agentId = requireAgentId(env);
      const agent = getAgent(db, agentId);
      const currentTask = getActiveTaskForAgent(db, agentId);
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

    case 'events': {
      const rawLimit = parseFlag(args, '--limit');
      let limit = 50;
      if (rawLimit !== undefined) {
        const parsed = parseInt(rawLimit, 10);
        if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`Invalid --limit: '${rawLimit}' (must be a positive integer)`);
        }
        limit = parsed;
      }
      const rawType = parseFlag(args, '--type');
      let eventType: EventType | undefined;
      if (rawType !== undefined) {
        if (!(EVENT_TYPES as readonly string[]).includes(rawType)) {
          throw new Error(`Invalid --type '${rawType}'. Valid: ${EVENT_TYPES.join(', ')}`);
        }
        eventType = rawType as EventType;
      }
      const events = getRecentEvents(db, eventType, limit);
      return { ok: true, events };
    }

    default:
      throw new Error(`Unknown command: ${command}. Valid: claim, complete, fail, checkpoint, message, inbox, heartbeat, status, events`);
  }
}
