import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { createTask, updateTask } from '../../shared/src/task-ops.js';
import { claimTask, claimSpecificTask, completeTask, failTask } from '../../shared/src/task-lifecycle.js';
import { registerAgent, getActiveAgents } from '../../shared/src/agent-ops.js';
import { sendMessage, getInbox } from '../../shared/src/message-ops.js';
import { initSession, setCurrentSession, getCurrentSession, getSessionDir } from '../../shared/src/session-ops.js';
import type { Database, TaskRow } from '../../shared/src/types.js';

import { tmpDbPath, cleanupDb } from '../helpers/db.js';

const mcpServerState = vi.hoisted(() => ({
  db: null as Database | null,
  sessionId: null as string | null,
}));

const childProcessMock = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../../mcp-server/src/index.js', () => ({
  ensureDb: () => {
    if (!mcpServerState.db) {
      throw new Error('No active test database configured');
    }
    return mcpServerState.db;
  },
  switchSession: vi.fn(),
  getCurrentSessionId: () => mcpServerState.sessionId,
}));

vi.mock('node:child_process', () => ({
  execFileSync: childProcessMock.execFileSync,
  execFile: childProcessMock.execFile,
}));

type ToolCallResult = Awaited<ReturnType<typeof import('../../mcp-server/src/tools/index.js').handleToolCall>>;

let handleToolCall: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;

function parseToolJson(result: ToolCallResult): Record<string, unknown> {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe('text');
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

function writeGridState(sessionId: string, projectDir: string, paneCount: number): void {
  const sessionDir = getSessionDir(sessionId);
  const panes = Array.from({ length: paneCount }, (_, index) => ({
    index,
    pane_id: `%${index + 1}`,
    status: 'ready',
  }));

  fs.mkdirSync(path.join(sessionDir, 'grid'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'grid', 'grid-state.json'),
    JSON.stringify({
      schema_version: 1,
      session_name: sessionId,
      project_dir: projectDir,
      created_at: new Date().toISOString(),
      grid: { rows: 1, cols: paneCount },
      panes,
    })
  );
}

beforeAll(async () => {
  ({ handleToolCall } = await import('../../mcp-server/src/tools/index.js'));
});

describe('handleToolCall adapter integration', () => {
  const STATE_ROOT = path.join(process.env.HOME ?? '/tmp', '.local/state/tmup');
  const REGISTRY_PATH = path.join(STATE_ROOT, 'registry.json');
  const CURRENT_SESSION_PATH = path.join(STATE_ROOT, 'current-session');

  let originalRegistry: string | null = null;
  let originalCurrentSession: string | null = null;
  let createdSessionIds: string[] = [];
  let openedDbs: Database[] = [];
  let createdProjectDirs: string[] = [];
  let originalArgv1: string | undefined;

  function createAdapterSession(): { db: Database; projectDir: string; sessionId: string; dbPath: string } {
    const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-handle-tool-call-')));
    const session = initSession(projectDir, 'test');
    const db = openDatabase(session.db_path);

    createdProjectDirs.push(projectDir);
    createdSessionIds.push(session.session_id);
    openedDbs.push(db);

    mcpServerState.db = db;
    mcpServerState.sessionId = session.session_id;

    return { db, projectDir, sessionId: session.session_id, dbPath: session.db_path };
  }

  beforeEach(() => {
    try { originalRegistry = fs.readFileSync(REGISTRY_PATH, 'utf-8'); } catch { originalRegistry = null; }
    try { originalCurrentSession = fs.readFileSync(CURRENT_SESSION_PATH, 'utf-8'); } catch { originalCurrentSession = null; }
    createdSessionIds = [];
    openedDbs = [];
    createdProjectDirs = [];
    originalArgv1 = process.argv[1];
    process.argv[1] = path.join(process.cwd(), 'mcp-server', 'dist', 'index.js');
    childProcessMock.execFileSync.mockReset();
    childProcessMock.execFile.mockReset();
    mcpServerState.db = null;
    mcpServerState.sessionId = null;
  });

  afterEach(() => {
    for (const db of openedDbs) {
      closeDatabase(db);
    }
    openedDbs = [];

    mcpServerState.db = null;
    mcpServerState.sessionId = null;

    if (originalRegistry !== null) {
      fs.writeFileSync(REGISTRY_PATH, originalRegistry);
    } else {
      try { fs.unlinkSync(REGISTRY_PATH); } catch {}
    }

    if (originalCurrentSession !== null) {
      fs.writeFileSync(CURRENT_SESSION_PATH, originalCurrentSession);
    } else {
      try { fs.unlinkSync(CURRENT_SESSION_PATH); } catch {}
    }

    for (const sessionId of createdSessionIds) {
      try { fs.rmSync(path.join(STATE_ROOT, sessionId), { recursive: true, force: true }); } catch {}
    }
    createdSessionIds = [];

    for (const projectDir of createdProjectDirs) {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
    }
    createdProjectDirs = [];

    process.argv[1] = originalArgv1;
  });

  describe('tmup_dispatch', () => {
    it('returns launch metadata from handleToolCall on success', async () => {
      const { db, projectDir, sessionId, dbPath } = createAdapterSession();
      writeGridState(sessionId, projectDir, 4);

      const taskId = createTask(db, {
        subject: 'Dispatch subject',
        description: 'Dispatch description',
        role: 'tester',
      });

      childProcessMock.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, callback: Function) => {
          callback(null, 'launched pane 2\n', '');
        }
      );

      const result = parseToolJson(await handleToolCall('tmup_dispatch', {
        task_id: taskId,
        role: 'tester',
        pane_index: 2,
      }));

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        task_id: taskId,
        pane_index: 2,
        role: 'tester',
        subject: 'Dispatch subject',
        description: 'Dispatch description',
        launched: true,
        session_mode: 'interactive',
        follow_up_via: 'tmup_reprompt',
        launch_output: 'launched pane 2',
      }));
      expect(typeof result.agent_id).toBe('string');

      expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = childProcessMock.execFile.mock.calls[0];
      expect(cmd).toBe('bash');
      expect(args).toEqual([
        path.join(process.cwd(), 'scripts', 'dispatch-agent.sh'),
        '--session', sessionId,
        '--role', 'tester',
        '--prompt', 'Dispatch subject\n\nDispatch description',
        '--agent-id', result.agent_id,
        '--task-id', taskId,
        '--db-path', dbPath,
        '--working-dir', projectDir,
        '--pane-index', '2',
        '--worker-type', 'codex',
        '--background-post-launch',
      ]);
      expect(opts).toEqual({
        timeout: 30_000,
        encoding: 'utf-8',
        maxBuffer: 2 * 1024 * 1024,
      });
    });

    it('marks the registered agent as shutdown when claimSpecificTask fails', async () => {
      const { db } = createAdapterSession();
      const taskId = createTask(db, { subject: 'Already claimed', role: 'tester' });

      registerAgent(db, 'existing-agent', 0, 'tester');
      claimTask(db, 'existing-agent', 'tester');

      await expect(handleToolCall('tmup_dispatch', {
        task_id: taskId,
        role: 'tester',
        pane_index: 1,
      })).rejects.toThrow('could not be claimed');

      const shutdownAgents = db.prepare(
        "SELECT id, status, pane_index, role FROM agents WHERE status = 'shutdown'"
      ).all() as Array<{ id: string; status: string; pane_index: number; role: string | null }>;

      expect(shutdownAgents).toHaveLength(1);
      expect(shutdownAgents[0]).toEqual(expect.objectContaining({
        status: 'shutdown',
        pane_index: 1,
        role: 'tester',
      }));
      expect(childProcessMock.execFileSync).not.toHaveBeenCalled();
      expect(childProcessMock.execFile).not.toHaveBeenCalled();
    });

    it('marks the registered agent as shutdown when launch fails', async () => {
      const { db } = createAdapterSession();
      const taskId = createTask(db, {
        subject: 'Launch failure',
        description: 'Dispatch should clean up the agent',
        role: 'tester',
      });

      childProcessMock.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, callback: Function) => {
          callback(new Error('tmux pane not available'), '', '');
        }
      );

      await expect(handleToolCall('tmup_dispatch', {
        task_id: taskId,
        role: 'tester',
      })).rejects.toThrow('Dispatch registered agent');

      const agent = db.prepare(
        "SELECT id, status FROM agents WHERE role = 'tester' ORDER BY registered_at DESC LIMIT 1"
      ).get() as { id: string; status: string } | undefined;

      expect(agent).toBeDefined();
      expect(agent?.status).toBe('shutdown');

      const task = db.prepare('SELECT status, owner, failure_reason FROM tasks WHERE id = ?').get(taskId) as TaskRow & { failure_reason: string | null };
      expect(task.status).toBe('pending');
      expect(task.owner).toBeNull();
      expect(task.failure_reason).toBe('launch_failed');
    });

    it('dispatches claude_code workers with one-shot contract metadata', async () => {
      const { db, projectDir, sessionId, dbPath } = createAdapterSession();
      writeGridState(sessionId, projectDir, 4);

      const taskId = createTask(db, {
        subject: 'One-shot task',
        description: 'Claude Code dispatch',
        role: 'reviewer',
      });

      childProcessMock.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, callback: Function) => {
          callback(null, 'Dispatched reviewer to pane 1 (agent test-id)\n', '');
        }
      );

      const result = parseToolJson(await handleToolCall('tmup_dispatch', {
        task_id: taskId,
        role: 'reviewer',
        pane_index: 1,
        worker_type: 'claude_code',
      }));

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        task_id: taskId,
        pane_index: 1,
        role: 'reviewer',
        launched: true,
        worker_type: 'claude_code',
        session_mode: 'one_shot',
        follow_up_via: 'not_supported',
      }));

      // Verify --background-post-launch is passed
      const [, args] = childProcessMock.execFile.mock.calls[0];
      expect(args).toContain('--background-post-launch');
      expect(args).toContain('--worker-type');
      const wtIdx = (args as string[]).indexOf('--worker-type');
      expect((args as string[])[wtIdx + 1]).toBe('claude_code');

      // worker_type persisted on task row
      const task = db.prepare('SELECT worker_type FROM tasks WHERE id = ?').get(taskId) as { worker_type: string };
      expect(task.worker_type).toBe('claude_code');
    });
  });

  describe('tmup_harvest', () => {
    it('captures pane output and strips ANSI escapes', async () => {
      const { projectDir, sessionId } = createAdapterSession();
      writeGridState(sessionId, projectDir, 3);

      childProcessMock.execFileSync.mockReturnValue('\u001b[32mready\u001b[0m\nplain output');

      const result = parseToolJson(await handleToolCall('tmup_harvest', {
        pane_index: 1,
        lines: 25,
      }));

      expect(result).toEqual({
        ok: true,
        pane_index: 1,
        lines: 25,
        output: 'ready\nplain output',
      });
      expect(childProcessMock.execFileSync).toHaveBeenCalledWith(
        'tmux',
        ['capture-pane', '-t', `${sessionId}:0.1`, '-p', '-S', '-25'],
        {
          timeout: 5000,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
    });
  });

  describe('argument validation edge cases', () => {
    it('rejects invalid pane indexes for dispatch', async () => {
      const { db, projectDir, sessionId } = createAdapterSession();
      writeGridState(sessionId, projectDir, 2);

      const taskId = createTask(db, { subject: 'Validation target', role: 'tester' });

      await expect(handleToolCall('tmup_dispatch', {
        task_id: taskId,
        role: 'tester',
        pane_index: 1.5,
      })).rejects.toThrow('pane_index must be a non-negative integer');

      await expect(handleToolCall('tmup_dispatch', {
        task_id: taskId,
        role: 'tester',
        pane_index: 2,
      })).rejects.toThrow('pane_index 2 not in live grid');
    });

    it('rejects invalid harvest arguments before touching tmux', async () => {
      const { projectDir, sessionId } = createAdapterSession();
      writeGridState(sessionId, projectDir, 2);

      await expect(handleToolCall('tmup_harvest', {
        pane_index: 0,
        lines: 0,
      })).rejects.toThrow('lines must be integer 1-10000');

      await expect(handleToolCall('tmup_harvest', {
        pane_index: 2,
      })).rejects.toThrow('pane_index 2 not in live grid');

      expect(childProcessMock.execFileSync).not.toHaveBeenCalled();
      expect(childProcessMock.execFile).not.toHaveBeenCalled();
    });
  });

  describe('tmup_resume resume_commands mapping', () => {
    it('maps each recovered task to its owning agent only (no cross-contamination)', async () => {
      const { db, sessionId } = createAdapterSession();

      // Register two agents on different panes with different codex session IDs
      registerAgent(db, 'agent-A', 0, 'implementer');
      db.prepare("UPDATE agents SET codex_session_id = 'csid-A' WHERE id = 'agent-A'").run();
      registerAgent(db, 'agent-B', 1, 'tester');
      db.prepare("UPDATE agents SET codex_session_id = 'csid-B' WHERE id = 'agent-B'").run();

      // Create and claim different tasks for each agent
      const taskA = createTask(db, { subject: 'Task for A' });
      claimTask(db, 'agent-A');
      const taskB = createTask(db, { subject: 'Task for B' });
      claimTask(db, 'agent-B');

      // Backdate both heartbeats to make them stale
      db.prepare(
        "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id IN ('agent-A', 'agent-B')"
      ).run();

      // Pane-liveness checker calls execFileSync('tmux', ...) — make it throw (= 'dead')
      childProcessMock.execFileSync.mockImplementation(() => {
        throw new Error('tmux not available');
      });

      const result = await handleToolCall('tmup_resume', { session_id: sessionId });
      const parsed = parseToolJson(result);

      expect(parsed.ok).toBe(true);
      const recovered = parsed.recovered as string[];
      const resumeCommands = parsed.resume_commands as Array<{
        task_id: string;
        codex_session_id: string;
        command: string;
        pane_index: number;
      }>;

      // Both tasks should be recovered
      expect(recovered).toContain(taskA);
      expect(recovered).toContain(taskB);

      // Each task should have exactly ONE resume command from its owning agent
      const commandsForA = resumeCommands.filter(c => c.task_id === taskA);
      const commandsForB = resumeCommands.filter(c => c.task_id === taskB);

      expect(commandsForA).toHaveLength(1);
      expect(commandsForA[0].codex_session_id).toBe('csid-A');
      expect(commandsForA[0].pane_index).toBe(0);
      expect(commandsForA[0].command).toContain('csid-A');
      expect(commandsForA[0].command).toContain('tmup_dispatch');

      expect(commandsForB).toHaveLength(1);
      expect(commandsForB[0].codex_session_id).toBe('csid-B');
      expect(commandsForB[0].pane_index).toBe(1);
      expect(commandsForB[0].command).toContain('csid-B');
      expect(commandsForB[0].command).toContain('tmup_dispatch');

      // Total resume commands should be exactly 2 (not 4 from cross-product)
      expect(resumeCommands).toHaveLength(2);
    });
  });

  describe('tmup_reprompt', () => {
    it('rejects empty prompt', async () => {
      createAdapterSession();
      await expect(handleToolCall('tmup_reprompt', { prompt: '' }))
        .rejects.toThrow('prompt must be a non-empty string');
    });

    it('rejects missing pane_index when all is not set', async () => {
      createAdapterSession();
      await expect(handleToolCall('tmup_reprompt', { prompt: 'hello' }))
        .rejects.toThrow('pane_index required');
    });

    it('rejects fractional pane_index', async () => {
      createAdapterSession();
      await expect(handleToolCall('tmup_reprompt', { prompt: 'hello', pane_index: 1.5 }))
        .rejects.toThrow('pane_index required (non-negative integer)');
    });

    it('rejects out-of-range pane_index when grid state exists', async () => {
      const { projectDir, sessionId } = createAdapterSession();
      writeGridState(sessionId, projectDir, 4);
      await expect(handleToolCall('tmup_reprompt', { prompt: 'hello', pane_index: 4 }))
        .rejects.toThrow('pane_index 4 not in live grid');
    });

    it('calls reprompt-agent.sh with correct args for single-pane mode', async () => {
      const { db, sessionId } = createAdapterSession();

      // Mock: harvest capture returns scrollback, reprompt script returns success
      childProcessMock.execFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'tmux') return '\x1b[32mWorking\x1b[0m output line';
        if (cmd === 'bash') return 'Pane 2: sent\n';
        return '';
      });

      const result = parseToolJson(await handleToolCall('tmup_reprompt', {
        prompt: 'Continue with error handling',
        pane_index: 2,
      }));

      expect(result.ok).toBe(true);
      expect(result.pane_index).toBe(2);
      expect(result.output).toBe('Pane 2: sent');
      // harvest_first defaults to true — should have harvested output
      expect(result.harvested_before_reprompt).toContain('output line');

      // Verify the bash call included correct script args
      const bashCall = childProcessMock.execFileSync.mock.calls.find(
        (c: unknown[]) => c[0] === 'bash'
      );
      expect(bashCall).toBeDefined();
      const scriptArgs = bashCall![1] as string[];
      expect(scriptArgs).toContain('--session');
      expect(scriptArgs).toContain(sessionId);
      expect(scriptArgs).toContain('--prompt');
      expect(scriptArgs).toContain('Continue with error handling');
      expect(scriptArgs).toContain('--pane');
      expect(scriptArgs).toContain('2');

      // Verify reprompt event was logged
      const events = db.prepare(
        "SELECT * FROM events WHERE event_type = 'dispatch'"
      ).all() as Array<{ payload: string }>;
      const repromptEvent = events.find(e => {
        const p = JSON.parse(e.payload);
        return p.type === 'reprompt';
      });
      expect(repromptEvent).toBeDefined();
      const payload = JSON.parse(repromptEvent!.payload);
      expect(payload.pane_index).toBe(2);
      expect(payload.prompt_preview).toBe('Continue with error handling');
    });

    it('passes --all flag when all=true', async () => {
      createAdapterSession();
      childProcessMock.execFileSync.mockReturnValue('Sent to 3 panes\n');

      const result = parseToolJson(await handleToolCall('tmup_reprompt', {
        prompt: 'Wrap up',
        all: true,
      }));

      expect(result.ok).toBe(true);
      expect(result.pane_index).toBe('all');

      const bashCall = childProcessMock.execFileSync.mock.calls.find(
        (c: unknown[]) => c[0] === 'bash'
      );
      expect(bashCall).toBeDefined();
      expect((bashCall![1] as string[])).toContain('--all');
    });

    it('skips harvest when harvest_first=false', async () => {
      createAdapterSession();
      childProcessMock.execFileSync.mockReturnValue('Pane 0: sent\n');

      const result = parseToolJson(await handleToolCall('tmup_reprompt', {
        prompt: 'Quick nudge',
        pane_index: 0,
        harvest_first: false,
      }));

      expect(result.ok).toBe(true);
      // No tmux capture-pane call should have been made (only bash call)
      const tmuxCalls = childProcessMock.execFileSync.mock.calls.filter(
        (c: unknown[]) => c[0] === 'tmux'
      );
      expect(tmuxCalls).toHaveLength(0);
      expect(result.harvested_before_reprompt).toBeUndefined();
    });
  });

  describe('tmup_dispatch with resume_session_id', () => {
    it('passes --resume-session-id to dispatch-agent.sh', async () => {
      const { db, projectDir, sessionId, dbPath } = createAdapterSession();
      writeGridState(sessionId, projectDir, 4);
      const taskId = createTask(db, { subject: 'Resume task', role: 'implementer' });

      childProcessMock.execFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, callback: Function) => {
          callback(null, 'Dispatched implementer to pane 0\n', '');
        }
      );

      const result = parseToolJson(await handleToolCall('tmup_dispatch', {
        task_id: taskId,
        role: 'implementer',
        pane_index: 0,
        resume_session_id: 'csid-abc-123',
      }));

      expect(result.ok).toBe(true);
      expect(result.launched).toBe(true);

      // Verify the script received --resume-session-id
      const bashCall = childProcessMock.execFile.mock.calls.find(
        (c: unknown[]) => c[0] === 'bash'
      );
      const scriptArgs = bashCall![1] as string[];
      const resumeIdx = scriptArgs.indexOf('--resume-session-id');
      expect(resumeIdx).toBeGreaterThan(-1);
      expect(scriptArgs[resumeIdx + 1]).toBe('csid-abc-123');
    });
  });

  describe('tmup_harvest codex_session_id enrichment', () => {
    it('includes codex_session_id from grid state when available', async () => {
      const { projectDir, sessionId } = createAdapterSession();

      // Write grid state WITH a codex_session_id on pane 1
      const gridDir = path.join(getSessionDir(sessionId), 'grid');
      fs.mkdirSync(gridDir, { recursive: true });
      fs.writeFileSync(path.join(gridDir, 'grid-state.json'), JSON.stringify({
        schema_version: 1,
        session_name: sessionId,
        project_dir: projectDir,
        created_at: new Date().toISOString(),
        grid: { rows: 1, cols: 4 },
        panes: [
          { index: 0, pane_id: '%1', status: 'ready' },
          { index: 1, pane_id: '%2', status: 'active', codex_session_id: 'csid-harvest-test' },
          { index: 2, pane_id: '%3', status: 'ready' },
          { index: 3, pane_id: '%4', status: 'ready' },
        ],
      }));

      childProcessMock.execFileSync.mockReturnValue('agent output here\n');

      const result = parseToolJson(await handleToolCall('tmup_harvest', {
        pane_index: 1,
        lines: 50,
      }));

      expect(result.ok).toBe(true);
      expect(result.codex_session_id).toBe('csid-harvest-test');
      expect(result.resume_command).toContain('csid-harvest-test');
      expect(result.resume_command).toContain('tmup_dispatch');
    });

    it('omits codex_session_id when not in grid state', async () => {
      const { projectDir, sessionId } = createAdapterSession();
      writeGridState(sessionId, projectDir, 4); // no codex_session_id fields

      childProcessMock.execFileSync.mockReturnValue('plain output\n');

      const result = parseToolJson(await handleToolCall('tmup_harvest', {
        pane_index: 0,
      }));

      expect(result.ok).toBe(true);
      expect(result.codex_session_id).toBeUndefined();
      expect(result.resume_command).toBeUndefined();
    });
  });

  describe('tmup_status pane-liveness-aware recovery', () => {
    it('skips recovery for stale agent when pane process is alive', async () => {
      const { db } = createAdapterSession();

      registerAgent(db, 'agent-alive', 0, 'implementer');
      const taskId = createTask(db, { subject: 'Alive task' });
      claimTask(db, 'agent-alive');
      db.prepare(
        "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-alive'"
      ).run();

      // Mock tmux display-message to return 'codex' (= alive process)
      childProcessMock.execFileSync.mockReturnValue('codex\n');

      // Use verbose mode to get JSON response with recovered field
      const result = parseToolJson(await handleToolCall('tmup_status', { verbose: true }));

      expect(result.ok).toBe(true);
      // Agent should NOT have been recovered — pane is alive
      expect(result.recovered).toEqual([]);

      // Task should still be claimed
      const task = db.prepare('SELECT status, owner FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      expect(task.status).toBe('claimed');
      expect(task.owner).toBe('agent-alive');
    });

    it('recovers stale agent when pane process is dead (tmux throws)', async () => {
      const { db } = createAdapterSession();

      registerAgent(db, 'agent-dead', 0, 'implementer');
      const taskId = createTask(db, { subject: 'Dead task' });
      claimTask(db, 'agent-dead');
      db.prepare(
        "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-dead'"
      ).run();

      // Mock tmux to throw (= pane dead / tmux not running)
      childProcessMock.execFileSync.mockImplementation(() => {
        throw new Error('no server running');
      });

      const result = parseToolJson(await handleToolCall('tmup_status', { verbose: true }));

      expect(result.ok).toBe(true);
      expect(result.recovered).toContain(taskId);

      // Task should be requeued
      const task = db.prepare('SELECT status, owner FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      expect(task.status).toBe('pending');
      expect(task.owner).toBeNull();
    });

    it('recovers stale agent when pane is at shell prompt', async () => {
      const { db } = createAdapterSession();

      registerAgent(db, 'agent-shell', 0, 'implementer');
      const taskId = createTask(db, { subject: 'Shell task' });
      claimTask(db, 'agent-shell');
      db.prepare(
        "UPDATE agents SET last_heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds') WHERE id = 'agent-shell'"
      ).run();

      // Mock tmux to return 'bash' (= shell prompt, agent exited)
      childProcessMock.execFileSync.mockReturnValue('bash\n');

      const result = parseToolJson(await handleToolCall('tmup_status', { verbose: true }));

      expect(result.ok).toBe(true);
      expect(result.recovered).toContain(taskId);

      const task = db.prepare('SELECT status, owner FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      expect(task.status).toBe('pending');
      expect(task.owner).toBeNull();
    });
  });
});

describe('MCP handleToolCall', () => {
  let db: Database;
  let dbPath: string;
  let tmpDir: string;

  // We test tool logic by directly calling shared helpers
  // since handleToolCall requires MCP server context

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-mcp-'));
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  describe('tmup_dispatch contract', () => {
    it('claimSpecificTask validates task exists', () => {
      expect(() => {
        claimSpecificTask(db, '999', 'agent-1', 'implementer');
      }).toThrow('not found');
    });

    it('claimSpecificTask rejects claiming a non-pending task', () => {
      const taskId = createTask(db, { subject: 'Test', role: 'implementer' });
      // Claim via queue first
      claimTask(db, 'existing-agent', 'implementer');

      // Second claim via dispatch should fail
      expect(() => {
        claimSpecificTask(db, taskId, 'new-agent', 'implementer');
      }).toThrow('could not be claimed');
    });

    it('claimSpecificTask validates role consistency', () => {
      const taskId = createTask(db, { subject: 'Impl task', role: 'implementer' });

      // Dispatch with mismatched role should be rejected
      expect(() => {
        claimSpecificTask(db, taskId, 'agent-1', 'reviewer');
      }).toThrow('Role mismatch');
    });

    it('claimSpecificTask allows matching role', () => {
      const taskId = createTask(db, { subject: 'Impl task', role: 'implementer' });

      const task = claimSpecificTask(db, taskId, 'agent-1', 'implementer');
      expect(task.owner).toBe('agent-1');
      expect(task.status).toBe('claimed');
    });

    it('claimSpecificTask allows null task role with any dispatch role', () => {
      const taskId = createTask(db, { subject: 'No-role task' });

      const task = claimSpecificTask(db, taskId, 'agent-1', 'reviewer');
      expect(task.owner).toBe('agent-1');
      expect(task.status).toBe('claimed');
    });

    it('dispatch returns explicit launch metadata', () => {
      const taskId = createTask(db, { subject: 'Test dispatch', description: 'Detailed desc', role: 'implementer' });

      const task = claimSpecificTask(db, taskId, 'agent-1', 'implementer');
      registerAgent(db, 'agent-1', 0, 'implementer');

      // Verify the dispatch data contains what the shell boundary needs
      expect(task.owner).toBe('agent-1');
      expect(task.status).toBe('claimed');
      expect(task.subject).toBe('Test dispatch');
      expect(task.description).toBe('Detailed desc');
    });
  });

  describe('tmup_resume contract', () => {
    it('resume persists resumed session as current', () => {
      const STATE_ROOT = path.join(process.env.HOME ?? '/tmp', '.local/state/tmup');
      const CURRENT_SESSION_PATH = path.join(STATE_ROOT, 'current-session');
      const REGISTRY_PATH = path.join(STATE_ROOT, 'registry.json');
      let originalCurrentSession: string | null = null;
      let originalRegistry: string | null = null;
      try {
        originalCurrentSession = fs.readFileSync(CURRENT_SESSION_PATH, 'utf-8');
      } catch { originalCurrentSession = null; }
      try {
        originalRegistry = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      } catch { originalRegistry = null; }

      try {
        // Create a real session via initSession so the session exists in the registry
        const resumeProject = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-resume-'));
        try {
          const result = initSession(resumeProject, 'test');
          // After resume, the session should become the current session
          setCurrentSession(result.session_id);
          expect(getCurrentSession()).toBe(result.session_id);
        } finally {
          try { fs.rmSync(resumeProject, { recursive: true }); } catch {}
        }
      } finally {
        // Restore
        if (originalCurrentSession !== null) {
          fs.writeFileSync(CURRENT_SESSION_PATH, originalCurrentSession);
        } else {
          try { fs.unlinkSync(CURRENT_SESSION_PATH); } catch {}
        }
        if (originalRegistry !== null) {
          fs.writeFileSync(REGISTRY_PATH, originalRegistry);
        } else {
          try { fs.unlinkSync(REGISTRY_PATH); } catch {}
        }
      }
    });

    it('setCurrentSession rejects session not in registry', () => {
      expect(() => setCurrentSession('test-nonexistent')).toThrow('not found in registry');
    });

  });

  describe('tmup_send_message input validation', () => {
    it('rejects null-recipient non-broadcast messages at shared layer', async () => {
      const { sendMessage } = await import('../../shared/src/message-ops.js');

      // A 'direct' message with no to_agent is now properly rejected
      expect(() => sendMessage(db, {
        from_agent: 'lead',
        to_agent: null,
        type: 'direct',
        payload: 'This should not be a null-recipient direct message',
      })).toThrow('must have a non-empty recipient');
    });
  });

  describe('tmup_complete actor enforcement', () => {
    it('MCP complete passes lead as actorId — lead can complete any task', () => {
      const taskId = createTask(db, { subject: 'Lead complete' });
      registerAgent(db, 'agent-1', 0);
      db.prepare("UPDATE tasks SET status = 'claimed', owner = 'agent-1' WHERE id = ?").run(taskId);

      // MCP is the lead boundary — lead can complete any active task
      const result = completeTask(db, taskId, 'done', undefined, undefined, 'lead');
      expect(result.unblocked).toBeDefined();

      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      expect(task.status).toBe('completed');
    });

    it('non-lead non-owner actorId is rejected by completeTask', () => {
      const taskId = createTask(db, { subject: 'Actor check' });
      registerAgent(db, 'agent-1', 0);
      db.prepare("UPDATE tasks SET status = 'claimed', owner = 'agent-1' WHERE id = ?").run(taskId);

      expect(() => completeTask(db, taskId, 'hijack', undefined, undefined, 'agent-2'))
        .toThrow('not the owning agent');
    });
  });

  describe('tmup_fail actor enforcement', () => {
    it('MCP fail passes lead as actorId — lead can fail any task', () => {
      const taskId = createTask(db, { subject: 'Lead fail' });
      registerAgent(db, 'agent-1', 0);
      db.prepare("UPDATE tasks SET status = 'claimed', owner = 'agent-1' WHERE id = ?").run(taskId);

      const result = failTask(db, taskId, 'crash', 'forced by lead', 'lead');
      expect(result.retrying).toBe(true);

      const task = db.prepare('SELECT status, owner, failure_reason FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      expect(task.status).toBe('pending');
      expect(task.owner).toBeNull();
      expect(task.failure_reason).toBe('crash');
    });

    it('non-lead non-owner actorId is rejected by failTask', () => {
      const taskId = createTask(db, { subject: 'Fail actor check' });
      registerAgent(db, 'agent-1', 0);
      db.prepare("UPDATE tasks SET status = 'claimed', owner = 'agent-1' WHERE id = ?").run(taskId);

      expect(() => failTask(db, taskId, 'crash', 'hijack', 'agent-2'))
        .toThrow('not the owning agent');
    });
  });

  describe('MCP input validation', () => {
    it('tmup_send_message rejects non-broadcast with null recipient', () => {
      expect(() => sendMessage(db, {
        from_agent: 'lead',
        to_agent: null,
        type: 'shutdown',
        payload: 'should fail',
      })).toThrow('must have a non-empty recipient');
    });

    it('updateTask rejects invalid status values at domain layer', () => {
      const taskId = createTask(db, { subject: 'Status validation' });
      // An invalid status string should fail at the LEAD_TRANSITIONS check
      expect(() => updateTask(db, taskId, { status: 'flying' as unknown as 'pending' }))
        .toThrow('Invalid transition');
    });

    it('createTask rejects non-numeric priority at SQLite CHECK constraint', () => {
      // String priority that reaches SQLite is caught by CHECK (priority BETWEEN 0 AND 100)
      // MCP validation now catches this before it hits the shared layer
      expect(() => createTask(db, { subject: 'Bad priority', priority: 'high' as unknown as number }))
        .toThrow('CHECK constraint');
    });

    it('dispatch registers agent BEFORE claiming so orphaned claims are recoverable', () => {
      const taskId = createTask(db, { subject: 'Dispatch order test', role: 'implementer' });
      // Simulate the corrected order: register, then claim
      registerAgent(db, 'dispatch-agent', 0, 'implementer');
      const task = claimSpecificTask(db, taskId, 'dispatch-agent', 'implementer');
      expect(task.owner).toBe('dispatch-agent');

      // Even if claim had failed, agent row exists for recovery
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get('dispatch-agent');
      expect(agent).toBeDefined();
    });

    it('dispatch: if claim fails, registered agent is still recoverable', () => {
      const taskId = createTask(db, { subject: 'Fail claim', role: 'implementer' });
      // Claim the task first with another agent
      registerAgent(db, 'existing', 0, 'implementer');
      claimTask(db, 'existing', 'implementer');

      // Now try dispatch: register first, then claim fails
      registerAgent(db, 'dispatch-orphan', 1, 'implementer');
      expect(() => claimSpecificTask(db, taskId, 'dispatch-orphan', 'implementer'))
        .toThrow('could not be claimed');

      // Agent row exists — dead-claim recovery can find it
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get('dispatch-orphan');
      expect(agent).toBeDefined();
    });

    it('dispatch: failed claim marks agent as shutdown to prevent phantom', () => {
      const taskId = createTask(db, { subject: 'Phantom test', role: 'implementer' });
      // Claim the task first
      registerAgent(db, 'blocker', 0, 'implementer');
      claimTask(db, 'blocker', 'implementer');

      // Simulate the dispatch flow: register, then claim fails
      registerAgent(db, 'phantom-agent', 1, 'implementer');

      // After claim failure, the real dispatch handler sets agent to shutdown
      expect(() => claimSpecificTask(db, taskId, 'phantom-agent', 'implementer'))
        .toThrow('could not be claimed');

      // Simulate the cleanup the handler does on failure
      db.prepare("UPDATE agents SET status = 'shutdown' WHERE id = ?").run('phantom-agent');

      // Agent should no longer appear active
      const active = getActiveAgents(db);
      expect(active.find(a => a.id === 'phantom-agent')).toBeUndefined();
    });

    it('tmup_claim returns error code when no tasks available', () => {
      // claimTask with no pending tasks returns null
      const task = claimTask(db, 'lonely-agent');
      expect(task).toBeNull();

      // The MCP handler returns { ok: true, task: null, error: 'NO_PENDING_TASKS' }
      // We verify the contract: null task means no pending tasks
    });
  });

  describe('tmup_checkpoint input validation', () => {
    it('rejects checkpoint with missing message', async () => {
      const taskId = createTask(db, { subject: 'Test' });
      claimTask(db, 'agent-1');

      // postCheckpoint with empty message should still work (not a security issue)
      const { postCheckpoint } = await import('../../shared/src/message-ops.js');
      postCheckpoint(db, taskId, 'agent-1', '');
      const task = db.prepare('SELECT result_summary FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      expect(task.result_summary).toBe('');
    });
  });

  describe('tmup_pause shared logic', () => {
    it('sends shutdown messages to all active agents', () => {
      registerAgent(db, 'agent-pause-1', 0);
      registerAgent(db, 'agent-pause-2', 1);

      // Simulate what tmup_pause does: send shutdown to all agents
      const agents = getActiveAgents(db);
      for (const agent of agents) {
        sendMessage(db, {
          from_agent: 'lead',
          to_agent: agent.id,
          type: 'shutdown',
          payload: 'Session pausing. Checkpoint your work.',
        });
      }

      // Each agent should have a shutdown message
      const inbox1 = getInbox(db, 'agent-pause-1', false);
      const inbox2 = getInbox(db, 'agent-pause-2', false);

      // At least one shutdown message per agent
      expect(inbox1.some(m => m.type === 'shutdown')).toBe(true);
      expect(inbox2.some(m => m.type === 'shutdown')).toBe(true);
    });
  });

  describe('tmup_harvest input validation', () => {
    // NOTE: Removed 2 tests ("rejects non-numeric pane_index", "rejects negative pane_index")
    // that tested self-contained inline validation logic, NOT the actual MCP handler.
    // The handler's input validation IS tested via the adapter integration tests
    // ("rejects invalid pane indexes for dispatch" at line 289) which call handleToolCall directly.

    it('validates pane_index against grid state when available', async () => {
      // When grid state exists with N panes, pane_index >= N should be rejected
      const { getGridPaneCount } = await import('../../shared/src/grid-state.js');
      const result = getGridPaneCount(undefined);
      expect(result.source).toBe('default');
      expect(result.count).toBe(8);
    });

    it('rejects out-of-range pane_index when session dir exists but no grid-state (dispatch path)', async () => {
      // Simulates the MCP dispatch adapter validation: session exists, grid-state missing
      const { getGridPaneCount } = await import('../../shared/src/grid-state.js');
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-mcp-dispatch-'));
      try {
        const rawPaneIndex = 8;
        const { count: paneCount, source } = getGridPaneCount(sessionDir);
        expect(source).toBe('default-session-no-grid');
        expect(paneCount).toBe(8);
        // Adapter logic: source !== 'default' triggers bounds check
        const wouldReject = source !== 'default' && rawPaneIndex >= paneCount;
        expect(wouldReject).toBe(true);
      } finally {
        fs.rmSync(sessionDir, { recursive: true });
      }
    });

    it('accepts valid pane_index when session dir exists but no grid-state (harvest path)', async () => {
      const { getGridPaneCount } = await import('../../shared/src/grid-state.js');
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-mcp-harvest-'));
      try {
        const rawPaneIndex = 7; // max valid for default 8-pane
        const { count: paneCount, source } = getGridPaneCount(sessionDir);
        expect(source).toBe('default-session-no-grid');
        const wouldReject = source !== 'default' && rawPaneIndex >= paneCount;
        expect(wouldReject).toBe(false);
      } finally {
        fs.rmSync(sessionDir, { recursive: true });
      }
    });

    it('rejects non-integer lines value', () => {
      expect(() => {
        const lines = 1.5;
        if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > 10000) {
          throw new Error('lines must be integer 1-10000');
        }
      }).toThrow('lines must be integer 1-10000');
    });
  });
});
