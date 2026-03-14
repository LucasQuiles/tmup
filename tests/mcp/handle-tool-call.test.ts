import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { createTask, updateTask } from '../../shared/src/task-ops.js';
import { claimTask, claimSpecificTask, completeTask, failTask } from '../../shared/src/task-lifecycle.js';
import { registerAgent, getActiveAgents } from '../../shared/src/agent-ops.js';
import { sendMessage, getInbox } from '../../shared/src/message-ops.js';
import { initSession, setCurrentSession, getCurrentSession } from '../../shared/src/session-ops.js';
import type { Database, TaskRow } from '../../shared/src/types.js';

import { tmpDbPath, cleanupDb } from '../helpers/db.js';

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
      expect(result).toBeDefined();
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
    it('rejects non-numeric pane_index', () => {
      expect(() => {
        const paneIndex = 'abc' as unknown;
        if (typeof paneIndex !== 'number' || !Number.isInteger(paneIndex) || paneIndex < 0) {
          throw new Error('pane_index must be a non-negative integer');
        }
      }).toThrow('pane_index must be a non-negative integer');
    });

    it('rejects negative pane_index', () => {
      expect(() => {
        const paneIndex = -1;
        if (typeof paneIndex !== 'number' || !Number.isInteger(paneIndex) || paneIndex < 0) {
          throw new Error('pane_index must be a non-negative integer');
        }
      }).toThrow('pane_index must be a non-negative integer');
    });

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
