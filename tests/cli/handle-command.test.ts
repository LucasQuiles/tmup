import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { createTask } from '../../shared/src/task-ops.js';
import { claimTask } from '../../shared/src/task-lifecycle.js';
import { registerAgent } from '../../shared/src/agent-ops.js';
import { handleCommand } from '../../cli/src/commands/index.js';
import type { Database, TaskRow } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('CLI handleCommand', () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  describe('actor identity enforcement', () => {
    it('complete requires TMUP_AGENT_ID', async () => {
      await expect(
        handleCommand(db, 'complete', ['done'], { agentId: undefined })
      ).rejects.toThrow('TMUP_AGENT_ID not set');
    });

    it('complete with --task-id rejects non-owner', async () => {
      const taskId = createTask(db, { subject: 'Test ownership' });
      registerAgent(db, 'agent-A', 0);
      db.prepare("UPDATE tasks SET status = 'claimed', owner = 'agent-A' WHERE id = ?").run(taskId);

      await expect(
        handleCommand(db, 'complete', ['hijacked', '--task-id', taskId], {
          agentId: 'agent-B',
        })
      ).rejects.toThrow('not the owning agent');
    });

    it('complete with --task-id succeeds for owner', async () => {
      const taskId = createTask(db, { subject: 'Test ownership pass' });
      registerAgent(db, 'agent-A', 0);
      db.prepare("UPDATE tasks SET status = 'claimed', owner = 'agent-A' WHERE id = ?").run(taskId);

      const result = await handleCommand(db, 'complete', ['done right', '--task-id', taskId], {
        agentId: 'agent-A',
      });
      expect(result.ok).toBe(true);
    });

    it('fail with --task-id rejects non-owner', async () => {
      const taskId = createTask(db, { subject: 'Test fail ownership' });
      registerAgent(db, 'agent-A', 0);
      db.prepare("UPDATE tasks SET status = 'claimed', owner = 'agent-A' WHERE id = ?").run(taskId);

      await expect(
        handleCommand(db, 'fail', ['error msg', '--reason', 'crash', '--task-id', taskId], {
          agentId: 'agent-B',
        })
      ).rejects.toThrow('not the owning agent');
    });

    it('fail with --task-id succeeds for owner', async () => {
      const taskId = createTask(db, { subject: 'Test fail ownership pass' });
      registerAgent(db, 'agent-A', 0);
      db.prepare("UPDATE tasks SET status = 'claimed', owner = 'agent-A' WHERE id = ?").run(taskId);

      const result = await handleCommand(db, 'fail', ['error msg', '--reason', 'crash', '--task-id', taskId], {
        agentId: 'agent-A',
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('fail validation', () => {
    it('fail requires --reason flag', async () => {
      await expect(
        handleCommand(db, 'fail', ['some message'], {
          agentId: 'agent-A',
          taskId: '001',
        })
      ).rejects.toThrow('--reason required');
    });

    it('fail rejects invalid reason', async () => {
      await expect(
        handleCommand(db, 'fail', ['error', '--reason', 'invalid_reason'], {
          agentId: 'agent-A',
          taskId: '001',
        })
      ).rejects.toThrow('Invalid reason');
    });

    it('fail rejects missing failure message when no args', async () => {
      // With only flag args where all non-flag values start with --, positional returns undefined
      await expect(
        handleCommand(db, 'fail', [], {
          agentId: 'agent-A',
          taskId: '001',
        })
      ).rejects.toThrow('--reason required');
    });
  });

  describe('exit code semantics', () => {
    it('unknown command throws error', async () => {
      await expect(
        handleCommand(db, 'nonexistent', [], { agentId: 'test' })
      ).rejects.toThrow('Unknown command');
    });

    it('claim returns structured result even when no tasks', async () => {
      const result = await handleCommand(db, 'claim', [], { agentId: 'test-agent' });
      expect(result.ok).toBe(true);
      expect(result.task).toBeNull();
    });
  });

  describe('checkpoint contract', () => {
    it('checkpoint with --task-id rejects non-owner', async () => {
      // Create a task owned by agent-A
      const taskId = createTask(db, { subject: 'Checkpoint test' });
      registerAgent(db, 'agent-A', 0);
      db.prepare("UPDATE tasks SET status = 'claimed', owner = 'agent-A' WHERE id = ?").run(taskId);

      // Agent-B checkpointing agent-A's task is correctly rejected
      await expect(
        handleCommand(db, 'checkpoint', ['progress update', '--task-id', taskId], {
          agentId: 'agent-B',
        })
      ).rejects.toThrow('not the owning agent');
    });

    it('checkpoint requires a message argument', async () => {
      await expect(
        handleCommand(db, 'checkpoint', [], { agentId: 'test-agent' })
      ).rejects.toThrow('Checkpoint message required');
    });

    it('checkpoint with flags before message works correctly', async () => {
      const taskId = createTask(db, { subject: 'Flag order test' });
      registerAgent(db, 'agent-C', 0);
      db.prepare("UPDATE tasks SET status = 'claimed', owner = 'agent-C' WHERE id = ?").run(taskId);

      // Flags before positional message — previously broken
      const result = await handleCommand(db, 'checkpoint', ['--task-id', taskId, 'making progress'], {
        agentId: 'agent-C',
      });
      expect(result.ok).toBe(true);

      // Verify the checkpoint message was stored correctly
      const task = db.prepare('SELECT result_summary FROM tasks WHERE id = ?').get(taskId) as { result_summary: string };
      expect(task.result_summary).toBe('making progress');
    });

    it('checkpoint uses env taskId when --task-id not provided', async () => {
      const taskId = createTask(db, { subject: 'Env task test' });
      registerAgent(db, 'agent-D', 0);
      db.prepare("UPDATE tasks SET status = 'claimed', owner = 'agent-D' WHERE id = ?").run(taskId);

      const result = await handleCommand(db, 'checkpoint', ['env checkpoint msg'], {
        agentId: 'agent-D',
        taskId,
      });
      expect(result.ok).toBe(true);

      // Verify the env taskId was actually used — checkpoint stored on the right task
      const task = db.prepare('SELECT result_summary FROM tasks WHERE id = ?').get(taskId) as { result_summary: string };
      expect(task.result_summary).toBe('env checkpoint msg');
    });

    it('checkpoint with only flag args (no message) throws correctly', async () => {
      const taskId = createTask(db, { subject: 'Flags-only test' });
      await expect(
        handleCommand(db, 'checkpoint', ['--task-id', taskId], {
          agentId: 'agent-E',
        })
      ).rejects.toThrow('Checkpoint message required');
    });
  });

  describe('message type validation', () => {
    it('rejects invalid --type value', async () => {
      await expect(
        handleCommand(db, 'message', ['hello', '--type', 'invalid_type'], {
          agentId: 'test-agent',
        })
      ).rejects.toThrow("Invalid message type 'invalid_type'");
    });

    it('accepts valid --type values and stores messages with correct type', async () => {
      for (const type of ['direct', 'finding', 'blocker']) {
        const result = await handleCommand(db, 'message', [`msg-${type}`, '--type', type, '--to', 'lead'], {
          agentId: 'test-agent',
        });
        expect(result.ok).toBe(true);
      }

      // Verify all 3 messages were stored with correct types
      const msgs = db.prepare(
        "SELECT type, payload FROM messages WHERE from_agent = 'test-agent' ORDER BY created_at"
      ).all() as Array<{ type: string; payload: string }>;
      expect(msgs).toHaveLength(3);
      expect(msgs.map(m => m.type)).toEqual(['direct', 'finding', 'blocker']);
    });
  });

  describe('message routing', () => {
    it('non-broadcast message with no --to defaults to lead', async () => {
      const result = await handleCommand(db, 'message', ['hello world'], {
        agentId: 'test-agent',
      });

      expect(result.ok).toBe(true);

      // Verify the message was stored with to_agent = 'lead'
      const msg = db.prepare('SELECT to_agent, type FROM messages ORDER BY created_at DESC LIMIT 1')
        .get() as { to_agent: string | null; type: string };
      expect(msg.to_agent).toBe('lead');
      expect(msg.type).toBe('direct');
    });

    it('broadcast message sets to_agent null', async () => {
      const result = await handleCommand(db, 'message', ['hello all', '--broadcast'], {
        agentId: 'test-agent',
      });

      expect(result.ok).toBe(true);
      const msg = db.prepare('SELECT to_agent, type FROM messages ORDER BY created_at DESC LIMIT 1')
        .get() as { to_agent: string | null; type: string };
      expect(msg.to_agent).toBeNull();
      expect(msg.type).toBe('broadcast');
    });
  });

  describe('heartbeat validation', () => {
    it('rejects malformed codex-session-id', async () => {
      await expect(
        handleCommand(db, 'heartbeat', ['--codex-session-id', '../escape'], {
          agentId: 'test-agent',
          paneIndex: '0',
        })
      ).rejects.toThrow('Invalid codex session ID format');
    });

    it('rejects non-numeric TMUP_PANE_INDEX', async () => {
      await expect(
        handleCommand(db, 'heartbeat', [], {
          agentId: 'new-agent',
          paneIndex: 'abc',
        })
      ).rejects.toThrow('Invalid TMUP_PANE_INDEX');
    });

    it('rejects negative TMUP_PANE_INDEX', async () => {
      await expect(
        handleCommand(db, 'heartbeat', [], {
          agentId: 'new-agent',
          paneIndex: '-1',
        })
      ).rejects.toThrow('Invalid TMUP_PANE_INDEX');
    });

    it('registers agent on first heartbeat', async () => {
      const result = await handleCommand(db, 'heartbeat', [], {
        agentId: 'new-agent',
        paneIndex: '3',
      });

      expect(result.ok).toBe(true);
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get('new-agent') as { id: string; pane_index: number } | undefined;
      expect(agent).toBeDefined();
      expect(agent!.pane_index).toBe(3);
    });

    it('rejects out-of-range pane index when session dir exists but grid state missing', async () => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const tmpSession = fs.mkdtempSync(os.tmpdir() + '/tmup-heartbeat-test-');
      try {
        // pane index 8 is out of range for default 8-pane grid
        await expect(
          handleCommand(db, 'heartbeat', [], {
            agentId: 'bound-agent',
            paneIndex: '8',
            sessionDir: tmpSession,
          })
        ).rejects.toThrow('Invalid TMUP_PANE_INDEX');
      } finally {
        fs.rmSync(tmpSession, { recursive: true });
      }
    });
  });

  describe('events command', () => {
    it('returns events with default limit', async () => {
      const { logEvent } = await import('../../shared/src/event-ops.js');
      logEvent(db, 'lead', 'session_init', { test: true });
      logEvent(db, 'agent-1', 'task_claimed', {});

      const result = await handleCommand(db, 'events', [], { agentId: 'test' });
      expect(result.ok).toBe(true);
      expect(Array.isArray(result.events)).toBe(true);
      expect((result.events as unknown[]).length).toBe(2);
    });

    it('respects --limit flag', async () => {
      const { logEvent } = await import('../../shared/src/event-ops.js');
      for (let i = 0; i < 10; i++) logEvent(db, 'lead', 'session_init', { i });

      const result = await handleCommand(db, 'events', ['--limit', '3'], { agentId: 'test' });
      expect(result.ok).toBe(true);
      expect((result.events as unknown[]).length).toBe(3);
    });

    it('respects --type filter', async () => {
      const { logEvent } = await import('../../shared/src/event-ops.js');
      logEvent(db, 'lead', 'session_init', {});
      logEvent(db, 'agent-1', 'task_claimed', {});
      logEvent(db, 'agent-2', 'task_claimed', {});

      const result = await handleCommand(db, 'events', ['--type', 'task_claimed'], { agentId: 'test' });
      expect(result.ok).toBe(true);
      expect((result.events as unknown[]).length).toBe(2);
    });

    it('rejects invalid --limit', async () => {
      await expect(
        handleCommand(db, 'events', ['--limit', '0'], { agentId: 'test' })
      ).rejects.toThrow('Invalid --limit');

      await expect(
        handleCommand(db, 'events', ['--limit', 'abc'], { agentId: 'test' })
      ).rejects.toThrow('Invalid --limit');

      await expect(
        handleCommand(db, 'events', ['--limit', '-5'], { agentId: 'test' })
      ).rejects.toThrow('Invalid --limit');
    });

    it('rejects invalid --type', async () => {
      await expect(
        handleCommand(db, 'events', ['--type', 'nonexistent'], { agentId: 'test' })
      ).rejects.toThrow("Invalid --type 'nonexistent'");
    });

    it('returns empty array when no events', async () => {
      const result = await handleCommand(db, 'events', [], { agentId: 'test' });
      expect(result.ok).toBe(true);
      expect(result.events).toEqual([]);
    });

    it('events command does not break neighboring commands', async () => {
      // Verify claim still works after adding events to the command dispatch
      const result = await handleCommand(db, 'claim', [], { agentId: 'test-agent' });
      expect(result.ok).toBe(true);
    });
  });
});
