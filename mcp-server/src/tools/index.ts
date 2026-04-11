import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { ensureDb, switchSession, getCurrentSessionId } from '../index.js';
import {
  initSession, setCurrentSession, getSessionDbPath, getSessionDir, getSessionProjectDir,
  createTask, createTaskBatch, updateTask,
  claimTask, claimSpecificTask, completeTask, failTask, cancelTask,
  sendMessage, getInbox, getUnreadCount, postCheckpoint,
  registerAgent, updateHeartbeat, getStaleAgents, recoverDeadClaim, getActiveAgents, getAgentByPaneIndex,
  logEvent, getNextAction, getGridPaneCount, readGridState,
  STALE_AGENT_THRESHOLD_SECONDS, MIN_PRIORITY, MAX_PRIORITY, TASK_STATUSES, FAILURE_REASONS, MESSAGE_TYPES,
} from '@tmup/shared';
import type { Database, TaskRow, TaskStatus } from '@tmup/shared';

// --- Local input validators (adapter boundary only — shape/range, not domain rules) ---

function validateTaskFields(input: Record<string, unknown>, prefix: string = ''): void {
  if (!input.subject || typeof input.subject !== 'string') {
    throw new Error(`${prefix}subject must be a non-empty string`);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new Error(`${prefix}description must be a string`);
  }
  if (input.role !== undefined && typeof input.role !== 'string') {
    throw new Error(`${prefix}role must be a string`);
  }
  if (input.priority !== undefined && (typeof input.priority !== 'number' || !Number.isFinite(input.priority) || input.priority < MIN_PRIORITY || input.priority > MAX_PRIORITY)) {
    throw new Error(`${prefix}priority must be a number ${MIN_PRIORITY}-${MAX_PRIORITY}`);
  }
  if (input.max_retries !== undefined && (typeof input.max_retries !== 'number' || !Number.isInteger(input.max_retries) || input.max_retries < 0)) {
    throw new Error(`${prefix}max_retries must be a non-negative integer`);
  }
  if (input.deps !== undefined && (!Array.isArray(input.deps) || !input.deps.every((d: unknown) => typeof d === 'string'))) {
    throw new Error(`${prefix}deps must be an array of strings`);
  }
  if (input.requires !== undefined && (!Array.isArray(input.requires) || !input.requires.every((r: unknown) => typeof r === 'string'))) {
    throw new Error(`${prefix}requires must be an array of strings`);
  }
  if (input.produces !== undefined && (!Array.isArray(input.produces) || !input.produces.every((p: unknown) => typeof p === 'string'))) {
    throw new Error(`${prefix}produces must be an array of strings`);
  }
}

// --- Tool definitions ---

export const toolDefinitions = [
  {
    name: 'tmup_init',
    description: 'Initialize or reattach to a tmup session for a project directory. Creates SQLite DB, session directory, and registry entry. Does not create tmux panes — use grid-setup.sh for grid creation.',
    inputSchema: {
      type: 'object' as const,
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
      type: 'object' as const,
      properties: {
        verbose: { type: 'boolean', description: 'If true, return full DAG details instead of summary' },
      },
    },
  },
  {
    name: 'tmup_next_action',
    description: 'Get a single synthesized recommendation for what to do next based on DAG state.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'tmup_task_create',
    description: 'Create a single task in the DAG.',
    inputSchema: {
      type: 'object' as const,
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
      type: 'object' as const,
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
      type: 'object' as const,
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
      type: 'object' as const,
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
      type: 'object' as const,
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
      type: 'object' as const,
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
      type: 'object' as const,
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
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
        message: { type: 'string', description: 'Checkpoint message' },
        agent_id: { type: 'string', description: 'Agent ID posting the checkpoint (defaults to lead)' },
      },
      required: ['task_id', 'message'],
    },
  },
  {
    name: 'tmup_send_message',
    description: 'Send a message between agents. From lead to workers or between workers.',
    inputSchema: {
      type: 'object' as const,
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
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Agent ID (omit for lead inbox)' },
        mark_read: { type: 'boolean', description: 'If true, return and mark messages as read' },
      },
    },
  },
  {
    name: 'tmup_dispatch',
    description: 'Dispatch a worker to a tmux pane. Two worker types: (1) codex (default) — interactive session that persists until process exits, supports tmup_reprompt and tmup_harvest as follow-up channels; (2) claude_code — one-shot execution, stdin/stdout, NO reprompt or harvest support. For interactive codex workers, if a pane already has the right live context, prefer tmup_harvest plus tmup_reprompt over redispatch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'Task to assign' },
        role: { type: 'string', description: 'Agent role' },
        pane_index: { type: 'number', description: 'Specific pane (auto-select if omitted)' },
        working_dir: { type: 'string', description: 'Working directory (defaults to project_dir)' },
        resume_session_id: { type: 'string', description: 'Codex session ID to resume instead of fresh launch (codex workers only — rejected for worker_type=claude_code, which is always fresh one-shot)' },
        worker_type: { type: 'string', enum: ['codex','claude_code'], description: 'Worker type' },
        clone_isolation: { type: 'boolean', description: 'If true, dispatch worker into an isolated git clone (colony clone isolation)' },
      },
      required: ['task_id', 'role'],
    },
  },
  {
    name: 'tmup_harvest',
    description: 'Capture terminal scrollback from a pane (ANSI stripped). Use this to inspect a live interactive worker lane before deciding whether to reprompt, wait, or resume. Only supported for codex workers — claude_code workers are one-shot and emit output to session-output-<agent_id>.json in the working directory instead of a persistent pane.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pane_index: { type: 'number', description: 'Pane index to capture' },
        lines: { type: 'number', description: 'Lines to capture (default from policy)' },
      },
      required: ['pane_index'],
    },
  },
  {
    name: 'tmup_pause',
    description: 'Pause the session: broadcasts shutdown messages to all active agents and logs a session_pause event. Does NOT wait for checkpoints, archive the grid, or stop processes — the caller must orchestrate those steps.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'tmup_resume',
    description: 'Resume a paused session: switches to the target session, detects stale agents via heartbeat timeout, runs dead-claim recovery to release stranded tasks, and returns resume metadata with session IDs. Does NOT recreate the grid or re-dispatch tasks — the caller must issue tmup_dispatch calls using the returned resume_session_id values.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'Session to resume (default: current)' },
      },
    },
  },
  {
    name: 'tmup_teardown',
    description: 'Shut down the session: broadcasts shutdown messages to all active agents and logs a session_teardown event. Does NOT harvest panes, kill tmux, or enforce a grace period — the caller must orchestrate those steps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        force: { type: 'boolean', description: 'Skip grace period' },
      },
    },
  },
  {
    name: 'tmup_reprompt',
    description: 'Send follow-up text into a running interactive Codex session via tmux send-keys (literal mode). Guarded: agent must be idle or queueable, pane must host a session (not bare shell). This is the supervisory control path for an existing worker lane and the only way to send text into the worker pane. Structured messaging uses tmup_send_message separately.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pane_index: { type: 'number', description: 'Pane index to reprompt (required unless all=true)' },
        prompt: { type: 'string', description: 'Follow-up prompt text to send' },
        all: { type: 'boolean', description: 'Send to all idle or queueable agent panes (ignores pane_index)' },
        harvest_first: { type: 'boolean', description: 'Capture scrollback before sending new prompt (default: true)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'tmup_heartbeat',
    description: 'Register agent liveness heartbeat. Returns next heartbeat deadline.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Agent UUID' },
        codex_session_id: { type: 'string', description: 'Optional Codex session ID to store' },
        pane_index: { type: 'number', description: 'Actual pane index (corrects auto-selected -1 values)' },
      },
      required: ['agent_id'],
    },
  },
];

// --- Helpers ---

function createPaneLivenessChecker(sessionName: string): (paneIndex: number) => 'alive' | 'shell' | 'dead' {
  return (paneIndex: number) => {
    try {
      const cmd = execFileSync('tmux', [
        'display-message', '-t', `${sessionName}:0.${paneIndex}`, '-p', '#{pane_current_command}'
      ], { timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (['codex', 'node', 'npm', 'npx'].includes(cmd)) return 'alive' as const;
      if (['bash', 'zsh', 'sh', 'fish', ''].includes(cmd)) return 'shell' as const;
      return 'alive' as const; // Conservative: unknown process = assume alive
    } catch {
      return 'dead' as const;
    }
  };
}

// --- Tool handler dispatch ---

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
  const json = (obj: unknown) => text(JSON.stringify(obj));

  switch (name) {
    case 'tmup_init': {
      if (!args.project_dir || typeof args.project_dir !== 'string') {
        throw new Error('project_dir must be a non-empty string');
      }
      const projectDir = args.project_dir;
      const sessionName = typeof args.session_name === 'string' && args.session_name ? args.session_name : undefined;
      const result = initSession(projectDir, sessionName);

      // Switch the MCP server's DB connection to the new session
      switchSession(result.session_id, result.db_path);
      logEvent(ensureDb(), null, 'session_init', { project_dir: projectDir, session_id: result.session_id });

      return json({ ok: true, session_id: result.session_id, reattached: result.reattached });
    }

    case 'tmup_status': {
      const db = ensureDb();
      const verbose = args.verbose === true;

      // Side-effect: dead-claim recovery with pane-liveness check
      const sessionName = getCurrentSessionId() ?? 'tmup';
      const paneLivenessCheck = createPaneLivenessChecker(sessionName);
      const staleAgents = getStaleAgents(db, STALE_AGENT_THRESHOLD_SECONDS);
      const recovered: string[] = [];
      for (const agent of staleAgents) {
        recovered.push(...recoverDeadClaim(db, agent.id, STALE_AGENT_THRESHOLD_SECONDS, paneLivenessCheck));
      }

      if (verbose) {
        const tasks = db.prepare('SELECT * FROM tasks ORDER BY CAST(id AS INTEGER)').all() as TaskRow[];
        const agents = getActiveAgents(db);
        const unread = getUnreadCount(db, 'lead');
        return json({ ok: true, tasks, agents, unread, recovered });
      }

      // Summary mode
      const counts = db.prepare(`
        SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status
      `).all() as Array<{ status: string; cnt: number }>;
      const statusMap: Record<string, number> = {};
      for (const c of counts) statusMap[c.status] = c.cnt;
      const unread = getUnreadCount(db, 'lead');
      const total = Object.values(statusMap).reduce((a, b) => a + b, 0);

      const summary = [
        `${statusMap['pending'] ?? 0} pending`,
        `${statusMap['blocked'] ?? 0} blocked`,
        `${statusMap['claimed'] ?? 0} claimed`,
        `${statusMap['completed'] ?? 0} completed`,
        `${statusMap['cancelled'] ?? 0} cancelled`,
        `${statusMap['needs_review'] ?? 0} needs_review`,
      ].filter(s => !s.startsWith('0 ')).join(', ');

      return text(`${total} tasks: ${summary || 'none'}. ${unread} unread messages.${recovered.length ? ` Recovered ${recovered.length} dead-claimed tasks.` : ''}`);
    }

    case 'tmup_next_action': {
      const db = ensureDb();

      // Resolve pane count from grid state via shared helper
      const sessionId = getCurrentSessionId();
      const sessionDir = sessionId ? getSessionDir(sessionId) : undefined;
      const { count: totalPanes, source: paneSource } = getGridPaneCount(sessionDir);

      const action = getNextAction(db, { totalPanes });
      let suffix = '';
      if (paneSource === 'default') {
        suffix = `\n(Note: using default ${totalPanes}-pane estimate — no active session)`;
      } else if (paneSource === 'default-session-no-grid') {
        suffix = `\n(Note: using default ${totalPanes}-pane estimate — grid state unreadable or not yet created)`;
      }
      return text(action.message + suffix);
    }

    case 'tmup_task_create': {
      const db = ensureDb();
      validateTaskFields(args as Record<string, unknown>);
      const taskId = createTask(db, {
        subject: args.subject as string,
        description: args.description as string | undefined,
        role: args.role as string | undefined,
        priority: args.priority as number | undefined,
        max_retries: args.max_retries as number | undefined,
        deps: args.deps as string[] | undefined,
        requires: args.requires as string[] | undefined,
        produces: args.produces as string[] | undefined,
      });
      return json({ ok: true, task_id: taskId });
    }

    case 'tmup_task_batch': {
      const db = ensureDb();
      if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
        throw new Error('tasks must be a non-empty array');
      }
      const tasks = args.tasks as Array<Record<string, unknown>>;
      for (let i = 0; i < tasks.length; i++) {
        validateTaskFields(tasks[i], `tasks[${i}].`);
      }
      const ids = createTaskBatch(db, tasks.map(t => ({
        subject: t.subject as string,
        description: t.description as string | undefined,
        role: t.role as string | undefined,
        priority: t.priority as number | undefined,
        max_retries: t.max_retries as number | undefined,
        deps: t.deps as string[] | undefined,
        requires: t.requires as string[] | undefined,
        produces: t.produces as string[] | undefined,
      })));
      return json({ ok: true, task_ids: ids });
    }

    case 'tmup_task_update': {
      const db = ensureDb();
      if (!args.task_id || typeof args.task_id !== 'string') {
        throw new Error('task_id must be a non-empty string');
      }
      // Validate optional typed fields
      if (args.status !== undefined) {
        if (typeof args.status !== 'string') throw new Error('status must be a string');
        if (!(TASK_STATUSES as readonly string[]).includes(args.status)) {
          throw new Error(`Invalid status '${args.status}'. Valid: ${TASK_STATUSES.join(', ')}`);
        }
      }
      if (args.priority !== undefined && (typeof args.priority !== 'number' || !Number.isFinite(args.priority) || args.priority < MIN_PRIORITY || args.priority > MAX_PRIORITY)) {
        throw new Error(`priority must be a number ${MIN_PRIORITY}-${MAX_PRIORITY}`);
      }
      if (args.role !== undefined && typeof args.role !== 'string') {
        throw new Error('role must be a string');
      }
      if (args.description !== undefined && typeof args.description !== 'string') {
        throw new Error('description must be a string');
      }
      if (args.max_retries !== undefined && (typeof args.max_retries !== 'number' || !Number.isInteger(args.max_retries) || args.max_retries < 0)) {
        throw new Error('max_retries must be a non-negative integer');
      }
      const result = updateTask(db, args.task_id, {
        status: args.status as TaskStatus | undefined,
        priority: args.priority as number | undefined,
        role: args.role as string | undefined,
        description: args.description as string | undefined,
        max_retries: args.max_retries as number | undefined,
      });
      return json(result);
    }

    case 'tmup_claim': {
      const db = ensureDb();
      if (!args.agent_id || typeof args.agent_id !== 'string') {
        throw new Error('agent_id must be a non-empty string');
      }
      if (args.role !== undefined && typeof args.role !== 'string') {
        throw new Error('role must be a string');
      }
      const task = claimTask(db, args.agent_id, args.role as string | undefined);
      if (!task) return json({ ok: true, task: null, error: 'NO_PENDING_TASKS' });
      return json({ ok: true, task_id: task.id, subject: task.subject, description: task.description });
    }

    case 'tmup_complete': {
      const db = ensureDb();
      if (!args.task_id || typeof args.task_id !== 'string') {
        throw new Error('task_id must be a non-empty string');
      }
      if (typeof args.result_summary !== 'string') {
        throw new Error('result_summary must be a string');
      }
      // Validate artifacts array structure if provided
      let validatedArtifacts: Array<{ name: string; path: string }> | undefined;
      if (args.artifacts !== undefined) {
        if (!Array.isArray(args.artifacts)) {
          throw new Error('artifacts must be an array');
        }
        validatedArtifacts = [];
        for (let i = 0; i < args.artifacts.length; i++) {
          const art = args.artifacts[i] as Record<string, unknown>;
          if (!art || typeof art !== 'object') {
            throw new Error(`artifacts[${i}] must be an object with name and path`);
          }
          if (typeof art.name !== 'string' || !art.name) {
            throw new Error(`artifacts[${i}].name must be a non-empty string`);
          }
          if (typeof art.path !== 'string' || !art.path) {
            throw new Error(`artifacts[${i}].path must be a non-empty string`);
          }
          validatedArtifacts.push({ name: art.name, path: art.path });
        }
        if (validatedArtifacts.length === 0) validatedArtifacts = undefined;
      }
      const projectDir = getSessionProjectDir(getCurrentSessionId() ?? undefined) ?? undefined;
      const result = completeTask(
        db,
        args.task_id,
        args.result_summary,
        validatedArtifacts,
        projectDir,
        'lead'
      );
      return json({ ok: true, unblocked: result.unblocked });
    }

    case 'tmup_fail': {
      const db = ensureDb();
      if (!args.task_id || typeof args.task_id !== 'string') {
        throw new Error('task_id must be a non-empty string');
      }
      if (!args.reason || typeof args.reason !== 'string') {
        throw new Error('reason must be a non-empty string');
      }
      if (!(FAILURE_REASONS as readonly string[]).includes(args.reason)) {
        throw new Error(`Invalid reason '${args.reason}'. Valid: ${FAILURE_REASONS.join(', ')}`);
      }
      if (typeof args.message !== 'string') {
        throw new Error('message must be a string');
      }
      const result = failTask(
        db,
        args.task_id,
        args.reason as typeof FAILURE_REASONS[number],
        args.message,
        'lead'
      );
      return json({ ok: true, ...result });
    }

    case 'tmup_cancel': {
      const db = ensureDb();
      if (!args.task_id || typeof args.task_id !== 'string') {
        throw new Error('task_id must be a non-empty string');
      }
      const result = cancelTask(db, args.task_id, args.cascade === true, 'lead');
      return json({ ok: true, cancelled: result.cancelled });
    }

    case 'tmup_checkpoint': {
      const db = ensureDb();
      if (!args.task_id || typeof args.task_id !== 'string') {
        throw new Error('task_id must be a non-empty string');
      }
      if (typeof args.message !== 'string') {
        throw new Error('message must be a string');
      }
      // For MCP calls, default to 'lead' since checkpoints from MCP are lead-initiated
      const agentId = typeof args.agent_id === 'string' && args.agent_id ? args.agent_id : 'lead';
      postCheckpoint(db, args.task_id, agentId, args.message);
      return json({ ok: true });
    }

    case 'tmup_send_message': {
      const db = ensureDb();
      if (!args.type || typeof args.type !== 'string') {
        throw new Error('type must be a non-empty string');
      }
      if (!(MESSAGE_TYPES as readonly string[]).includes(args.type)) {
        throw new Error(`Invalid message type '${args.type}'. Valid: ${MESSAGE_TYPES.join(', ')}`);
      }
      if (!args.payload || typeof args.payload !== 'string') {
        throw new Error('payload must be a non-empty string');
      }
      if (args.to !== undefined && (typeof args.to !== 'string' || !args.to)) {
        throw new Error('to must be a non-empty string');
      }
      if (args.task_id !== undefined && typeof args.task_id !== 'string') {
        throw new Error('task_id must be a string');
      }
      sendMessage(db, {
        from_agent: 'lead',
        to_agent: args.to as string | undefined ?? null,
        type: args.type as typeof MESSAGE_TYPES[number],
        payload: args.payload,
        task_id: args.task_id as string | undefined,
      });
      return json({ ok: true });
    }

    case 'tmup_inbox': {
      const db = ensureDb();
      if (args.agent_id !== undefined && (typeof args.agent_id !== 'string' || !args.agent_id)) {
        throw new Error('agent_id must be a non-empty string');
      }
      const agentId = (args.agent_id as string | undefined) ?? 'lead';
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


    case 'tmup_heartbeat': {
      const db = ensureDb();
      if (!args.agent_id || typeof args.agent_id !== 'string') {
        throw new Error('agent_id must be a non-empty string');
      }
      const hbAgentId = args.agent_id;
      const hbCodexSessionId = typeof args.codex_session_id === 'string' ? args.codex_session_id : undefined;

      // Validate pane_index: reject invalid values explicitly (don't silently drop)
      let hbPaneIndex: number | undefined;
      if (args.pane_index !== undefined) {
        if (typeof args.pane_index !== 'number' || !Number.isInteger(args.pane_index) || args.pane_index < 0) {
          throw new Error(`pane_index must be a non-negative integer, got: ${JSON.stringify(args.pane_index)}`);
        }
        // Grid bounds check — matches CLI heartbeat validation
        const hbSessionId = getCurrentSessionId();
        if (hbSessionId) {
          const hbSessionDir = getSessionDir(hbSessionId);
          if (hbSessionDir) {
            const { count: hbGridPanes, source: hbGridSource } = getGridPaneCount(hbSessionDir);
            if (hbGridSource !== 'default' && args.pane_index >= hbGridPanes) {
              throw new Error(`pane_index ${args.pane_index} out of bounds (grid has ${hbGridPanes} panes)`);
            }
          }
        }
        hbPaneIndex = args.pane_index;
      }

      // Retry up to 3 times with 500ms backoff on SQLITE_BUSY
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          updateHeartbeat(db, hbAgentId, hbCodexSessionId, hbPaneIndex);
          const now = Date.now();
          const nextDue = now + (STALE_AGENT_THRESHOLD_SECONDS * 1000 / 3);
          return json({ ok: true, next_heartbeat_due: new Date(nextDue).toISOString() });
        } catch (err: unknown) {
          lastErr = err;
          if (err instanceof Error && err.message.includes('SQLITE_BUSY') && attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    }

    case 'tmup_dispatch': {
      const db = ensureDb();

      // Input validation
      const taskId = args.task_id;
      if (!taskId || typeof taskId !== 'string') {
        throw new Error('task_id must be a non-empty string');
      }
      const role = args.role;
      if (!role || typeof role !== 'string') {
        throw new Error('role must be a non-empty string');
      }
      const rawPaneIndex = args.pane_index;
      let paneIndex: number | undefined;
      if (rawPaneIndex !== undefined) {
        if (typeof rawPaneIndex !== 'number' || !Number.isInteger(rawPaneIndex) || rawPaneIndex < 0) {
          throw new Error('pane_index must be a non-negative integer');
        }
        // Validate against actual grid size when session exists
        const dispatchSessionId = getCurrentSessionId();
        const dispatchSessionDir = dispatchSessionId ? getSessionDir(dispatchSessionId) : undefined;
        const { count: dispatchPaneCount, source: dispatchSource } = getGridPaneCount(dispatchSessionDir);
        if (dispatchSource !== 'default' && rawPaneIndex >= dispatchPaneCount) {
          throw new Error(`pane_index ${rawPaneIndex} out of range (grid has ${dispatchPaneCount} panes, max index: ${dispatchPaneCount - 1})`);
        }
        paneIndex = rawPaneIndex;
      }

      const { generateAgentId } = await import('@tmup/shared');
      const agentId = generateAgentId();

      // Register agent BEFORE claiming — if crash between register and claim,
      // dead-claim recovery can find the agent row. Reverse order would orphan the claim.
      registerAgent(db, agentId, paneIndex ?? -1, role);

      // Use shared claim logic with role validation.
      // If claim fails, mark agent shutdown so it doesn't linger as a phantom active agent.
      let task: { id: string; subject: string; description: string | null };
      try {
        task = claimSpecificTask(db, taskId, agentId, role);
      } catch (err) {
        try {
          db.prepare("UPDATE agents SET status = 'shutdown' WHERE id = ?").run(agentId);
        } catch (cleanupErr) {
          console.error(`[tmup-mcp] Failed to mark orphaned agent ${agentId} as shutdown: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }
        throw err;
      }

      logEvent(db, 'lead', 'dispatch', {
        task_id: taskId,
        agent_id: agentId,
        role,
        pane_index: paneIndex,
      });

      // Launch the Codex worker via dispatch-agent.sh
      // MCP servers can't rely on the caller to do shell boundary work —
      // dispatch must be atomic: DB claim + process launch in one call.
      const workingDir = args.working_dir ?? getSessionProjectDir(getCurrentSessionId()!);
      const sessionId = getCurrentSessionId()!;
      const dbPath = getSessionDbPath(sessionId)!;
      const pluginRoot = resolve(dirname(process.argv[1] || ''), '../..');
      const scriptPath = join(pluginRoot, 'scripts', 'dispatch-agent.sh');

      const prompt = `${task.subject}${task.description ? '\n\n' + task.description : ''}`;

      const dispatchArgs = [
        scriptPath,
        '--session', sessionId,
        '--role', role,
        '--prompt', prompt,
        '--agent-id', agentId,
        '--task-id', taskId,
        '--db-path', dbPath,
        '--working-dir', workingDir as string,
      ];
      if (paneIndex !== undefined) {
        dispatchArgs.push('--pane-index', String(paneIndex));
      }
      const workerType = typeof args.worker_type === 'string' ? args.worker_type : 'codex';

      // Reject resume_session_id + claude_code combination.
      // The claude_code launcher branch has no resume handling — it always
      // runs as a fresh one-shot. Silently accepting resume_session_id would
      // violate the public contract and produce unexpected fresh executions.
      if (args.resume_session_id && typeof args.resume_session_id === 'string') {
        if (workerType === 'claude_code') {
          throw new Error(`resume_session_id is not supported for worker_type='claude_code' (one-shot workers cannot resume). Omit resume_session_id or use worker_type='codex'.`);
        }
        dispatchArgs.push('--resume-session-id', args.resume_session_id);
      }
      dispatchArgs.push('--worker-type', workerType);

      // Always persist worker_type on the task row (not only non-default).
      // A task re-dispatched from claude_code back to codex must clear the
      // stale claude_code value, otherwise tmup_reprompt/tmup_harvest gating
      // will incorrectly reject the live interactive lane.
      db.prepare("UPDATE tasks SET worker_type = ? WHERE id = ?").run(workerType, taskId);
      if (args.clone_isolation === true) {
        dispatchArgs.push('--clone-isolation');
      }

      let launchResult: string;
      try {
        const output = execFileSync('bash', dispatchArgs, {
          timeout: 30000,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        launchResult = output.trim();
      } catch (launchErr: unknown) {
        const msg = launchErr instanceof Error ? launchErr.message : String(launchErr);
        // Agent is registered and task is claimed but launch failed.
        // Mark agent shutdown AND release the claimed task back to pending.
        // Without the task unclaim, dead-claim recovery only scans active
        // stale agents — a shutdown agent's claimed task has no recovery path.
        try {
          db.prepare("UPDATE agents SET status = 'shutdown' WHERE id = ?").run(agentId);
          db.prepare("UPDATE tasks SET status = 'pending', owner = NULL, failure_reason = 'launch_failed' WHERE id = ? AND owner = ?").run(taskId, agentId);
          logEvent(db, agentId, 'task_unclaimed_on_launch_failure', { task_id: taskId });
        } catch (_) { /* best effort */ }
        throw new Error(`Dispatch registered agent ${agentId} but launch failed: ${msg}`);
      }

      // Extract resolved metadata from dispatch output and persist:
      // (a) actual pane_index — auto-selected workers register with -1,
      //     so writing the real pane here closes the correction window
      //     that previously depended on heartbeat (which claude_code
      //     workers don't call with pane_index);
      // (b) clone_dir when clone_isolation was requested — the schema
      //     has a tasks.clone_dir column specifically for this purpose.
      let resolvedPane: number | string = paneIndex ?? 'auto';
      if (resolvedPane === 'auto') {
        const paneMatch = launchResult.match(/to pane (\d+)/);
        if (paneMatch) resolvedPane = parseInt(paneMatch[1], 10);
      }
      // Always correct the agent row's pane_index from dispatch output,
      // not just when auto-selected — dispatch output is authoritative.
      if (typeof resolvedPane === 'number') {
        db.prepare('UPDATE agents SET pane_index = ? WHERE id = ?').run(resolvedPane, agentId);
      }
      // Persist clone_dir when clone_isolation was used
      if (args.clone_isolation === true) {
        const cloneMatch = launchResult.match(/^CLONE_DIR=(.+)$/m);
        if (cloneMatch) {
          db.prepare('UPDATE tasks SET clone_dir = ? WHERE id = ?').run(cloneMatch[1].trim(), taskId);
        }
      }

      // Contract differs by worker type: codex is interactive (reprompt-capable),
      // claude_code is one-shot (no reprompt, no harvest — model calls MCP heartbeat)
      const isClaudeCode = workerType === 'claude_code';
      return json({
        ok: true,
        agent_id: agentId,
        task_id: taskId,
        pane_index: resolvedPane,
        role,
        subject: task.subject,
        description: task.description,
        launched: true,
        worker_type: workerType,
        session_mode: isClaudeCode ? 'one_shot' : 'interactive',
        follow_up_via: isClaudeCode ? 'not_supported' : 'tmup_reprompt',
        launch_output: launchResult,
      });
    }

    case 'tmup_harvest': {
      const db = ensureDb();
      // Validate inputs to prevent shell injection
      const paneIndex = args.pane_index;
      if (typeof paneIndex !== 'number' || !Number.isInteger(paneIndex) || paneIndex < 0) {
        throw new Error('pane_index must be a non-negative integer');
      }
      // Validate against actual grid size when session exists
      const harvestSessionId = getCurrentSessionId();
      const harvestSessionDir = harvestSessionId ? getSessionDir(harvestSessionId) : undefined;
      const { count: harvestPaneCount, source: harvestSource } = getGridPaneCount(harvestSessionDir);
      if (harvestSource !== 'default' && paneIndex >= harvestPaneCount) {
        throw new Error(`pane_index ${paneIndex} out of range (grid has ${harvestPaneCount} panes, max index: ${harvestPaneCount - 1})`);
      }
      const lines = args.lines ?? 500;
      if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > 10000) {
        throw new Error('lines must be integer 1-10000');
      }

      // Execute tmux capture directly — no shell boundary
      const harvestSession = harvestSessionId ?? 'tmup';
      const paneTarget = `${harvestSession}:0.${paneIndex}`;
      // Reject claude_code panes — they are one-shot workers without a
      // persistent pane to harvest. Output goes to session-output-<agent>.json.
      const harvestPaneAgent = getAgentByPaneIndex(db, paneIndex);
      if (harvestPaneAgent) {
        const harvestOwnedTask = db.prepare(
          "SELECT worker_type FROM tasks WHERE owner = ? AND status = 'claimed' ORDER BY claimed_at DESC LIMIT 1"
        ).get(harvestPaneAgent.id) as { worker_type: string } | undefined;
        if (harvestOwnedTask?.worker_type === 'claude_code') {
          throw new Error(`Cannot harvest pane ${paneIndex}: claude_code workers are one-shot and do not host a persistent tmux session. Read session-output-<agent_id>.json in the working directory instead.`);
        }
      }

      try {
        const raw = execFileSync('tmux', [
          'capture-pane', '-t', paneTarget, '-p', '-S', `-${lines}`,
        ], {
          timeout: 5000,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Strip ANSI escape codes
        const cleaned = raw.replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

        // Include codex session ID from grid state for resume
        let codexSessionId: string | undefined;
        if (harvestSessionDir) {
          try {
            const gridState = readGridState(harvestSessionDir);
            const paneEntry = gridState?.panes.find(p => p.index === paneIndex);
            codexSessionId = paneEntry?.codex_session_id ?? undefined;
          } catch { /* non-fatal */ }
        }

        return json({
          ok: true,
          pane_index: paneIndex,
          lines: lines,
          output: cleaned,
          ...(codexSessionId ? {
            codex_session_id: codexSessionId,
            resume_command: `Use tmup_dispatch with resume_session_id: '${codexSessionId}' to resume with full runtime contract`,
          } : {}),
        });
      } catch (harvestErr: unknown) {
        const msg = harvestErr instanceof Error ? harvestErr.message : String(harvestErr);
        throw new Error(`Failed to capture pane ${paneIndex}: ${msg}`);
      }
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
      const rawSessionId = args.session_id;
      if (rawSessionId !== undefined && (typeof rawSessionId !== 'string' || !rawSessionId)) {
        throw new Error('session_id must be a non-empty string');
      }
      const sessionId = (rawSessionId as string | undefined) ?? getCurrentSessionId();
      if (!sessionId) throw new Error('No session to resume');
      const dbPath = getSessionDbPath(sessionId);
      if (!dbPath) throw new Error(`Session ${sessionId} not found`);

      switchSession(sessionId, dbPath);
      setCurrentSession(sessionId);

      const db = ensureDb();

      // Capture resume info BEFORE recovery (recovery clears owners).
      // Track per-agent so we can map recovered tasks → their owning agent's session.
      const stale = getStaleAgents(db, STALE_AGENT_THRESHOLD_SECONDS);
      const agentResumeInfo = new Map<string, { codex_session_id: string | null; pane_index: number }>();
      // Snapshot which tasks each agent owns BEFORE recovery clears them
      const agentOwnedTasks = new Map<string, string[]>();
      for (const agent of stale) {
        agentResumeInfo.set(agent.id, {
          codex_session_id: agent.codex_session_id,
          pane_index: agent.pane_index,
        });
        const owned = db.prepare(
          "SELECT id FROM tasks WHERE owner = ? AND status = 'claimed'"
        ).all(agent.id) as Array<{ id: string }>;
        agentOwnedTasks.set(agent.id, owned.map(t => t.id));
      }

      const paneLivenessCheck = createPaneLivenessChecker(sessionId);
      const recovered: string[] = [];
      for (const agent of stale) {
        recovered.push(...recoverDeadClaim(db, agent.id, STALE_AGENT_THRESHOLD_SECONDS, paneLivenessCheck));
      }

      // Build resume commands — map each recovered task to its owning agent's session
      const resumeCommands: Array<{ task_id: string; codex_session_id: string; command: string; pane_index: number }> = [];
      for (const taskId of recovered) {
        for (const [agentId, ownedTaskIds] of agentOwnedTasks) {
          if (ownedTaskIds.includes(taskId)) {
            const info = agentResumeInfo.get(agentId);
            if (info?.codex_session_id) {
              resumeCommands.push({
                task_id: taskId,
                codex_session_id: info.codex_session_id,
                command: `Use tmup_dispatch with resume_session_id: '${info.codex_session_id}' — do NOT run bare codex resume (bypasses runtime contract)`,
                pane_index: info.pane_index,
              });
            }
            break; // A task has exactly one owner
          }
        }
      }

      logEvent(db, 'lead', 'session_resume', { recovered, resume_commands: resumeCommands.length });
      return json({ ok: true, session_id: sessionId, recovered, resume_commands: resumeCommands });
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

    case 'tmup_reprompt': {
      const db = ensureDb();

      if (typeof args.prompt !== 'string' || !args.prompt) {
        throw new Error('prompt must be a non-empty string');
      }

      const repromptSessionId = getCurrentSessionId();
      if (!repromptSessionId) throw new Error('No active session');

      // Reject claude_code panes — they are one-shot workers without an
      // interactive session to reprompt into. Callers should dispatch a
      // new worker for follow-up work on claude_code lanes.
      // worker_type lives on tasks, so join agent → task by owner.
      if (typeof args.pane_index === 'number') {
        const paneAgent = getAgentByPaneIndex(db, args.pane_index);
        if (paneAgent) {
          const ownedTask = db.prepare(
            "SELECT worker_type FROM tasks WHERE owner = ? AND status = 'claimed' ORDER BY claimed_at DESC LIMIT 1"
          ).get(paneAgent.id) as { worker_type: string } | undefined;
          if (ownedTask?.worker_type === 'claude_code') {
            throw new Error(`Cannot reprompt pane ${args.pane_index}: claude_code workers are one-shot and do not support tmup_reprompt. Dispatch a fresh worker with the follow-up task instead.`);
          }
        }
      }

      const pluginRoot = resolve(dirname(process.argv[1] || ''), '../..');
      const scriptPath = join(pluginRoot, 'scripts', 'reprompt-agent.sh');

      // Harvest before reprompt (default: true)
      let harvestedOutput: string | undefined;
      if (args.harvest_first !== false && typeof args.pane_index === 'number') {
        try {
          const raw = execFileSync('tmux', [
            'capture-pane', '-t', `${repromptSessionId}:0.${args.pane_index}`, '-p', '-S', '-500',
          ], { timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
          harvestedOutput = raw.replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
        } catch { /* non-fatal */ }
      }

      // Record reprompt event in DB
      logEvent(db, 'lead', 'dispatch', {
        type: 'reprompt',
        pane_index: args.pane_index ?? 'all',
        prompt_preview: (args.prompt as string).slice(0, 200),
      });

      const scriptArgs = [scriptPath, '--session', repromptSessionId, '--prompt', args.prompt as string];

      if (args.all === true) {
        scriptArgs.push('--all');
      } else {
        if (typeof args.pane_index !== 'number' || !Number.isInteger(args.pane_index) || args.pane_index < 0) {
          throw new Error('pane_index required (non-negative integer) unless all=true');
        }
        const repromptSessionDir = getSessionDir(repromptSessionId);
        const { count: repromptPaneCount, source: repromptSource } = getGridPaneCount(repromptSessionDir);
        if (repromptSource !== 'default' && args.pane_index >= repromptPaneCount) {
          throw new Error(`pane_index ${args.pane_index} out of range (grid has ${repromptPaneCount} panes)`);
        }
        scriptArgs.push('--pane', String(args.pane_index));
      }

      try {
        const output = execFileSync('bash', scriptArgs, {
          timeout: 30000,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return json({
          ok: true,
          pane_index: args.pane_index ?? 'all',
          output: output.trim(),
          ...(harvestedOutput ? { harvested_before_reprompt: harvestedOutput } : {}),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Reprompt failed: ${msg}`);
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
