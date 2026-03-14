import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { sendMessage, getInbox, getUnreadCount, postCheckpoint, pruneMessages } from '../../shared/src/message-ops.js';
import { createTask } from '../../shared/src/task-ops.js';
import { claimTask } from '../../shared/src/task-lifecycle.js';
import type { Database, TaskRow, MessageRow } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('message-ops', () => {
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

  describe('sendMessage', () => {
    it('sends a direct message with correct fields', () => {
      const id = sendMessage(db, {
        from_agent: 'agent-1',
        to_agent: 'lead',
        type: 'direct',
        payload: 'Hello lead',
      });
      expect(id).toMatch(/^[0-9a-f-]+$/); // UUID format

      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow;
      expect(msg.from_agent).toBe('agent-1');
      expect(msg.to_agent).toBe('lead');
      expect(msg.type).toBe('direct');
      expect(msg.payload).toBe('Hello lead');
      expect(msg.read_at).toBeNull();
    });

    it('sends a broadcast with to_agent=null', () => {
      sendMessage(db, {
        from_agent: 'lead',
        to_agent: null,
        type: 'broadcast',
        payload: 'Attention all agents',
      });

      // Broadcasts visible to all agents
      expect(getUnreadCount(db, 'agent-1')).toBe(1);
      expect(getUnreadCount(db, 'agent-2')).toBe(1);
      expect(getUnreadCount(db, 'agent-99')).toBe(1);
    });

    it('broadcast type forces to_agent to null regardless of input', () => {
      sendMessage(db, {
        from_agent: 'lead',
        to_agent: 'agent-1', // Should be ignored for broadcast
        type: 'broadcast',
        payload: 'test',
      });
      const msg = db.prepare('SELECT to_agent FROM messages ORDER BY rowid DESC LIMIT 1').get() as { to_agent: string | null };
      expect(msg.to_agent).toBeNull();
    });

    it('rejects payload exceeding 100000 character limit', () => {
      expect(() => sendMessage(db, {
        from_agent: 'agent-1',
        to_agent: 'lead',
        type: 'direct',
        payload: 'x'.repeat(100001),
      })).toThrow('limit');
    });

    it('accepts payload at exactly the limit', () => {
      const id = sendMessage(db, {
        from_agent: 'agent-1',
        to_agent: 'lead',
        type: 'direct',
        payload: 'x'.repeat(100000),
      });
      expect(id).toBeTruthy();
    });

    it('stores task_id when provided', () => {
      createTask(db, { subject: 'Test' });
      const id = sendMessage(db, {
        from_agent: 'agent-1',
        to_agent: 'lead',
        type: 'finding',
        payload: 'Found issue',
        task_id: '001',
      });
      const msg = db.prepare('SELECT task_id FROM messages WHERE id = ?').get(id) as { task_id: string | null };
      expect(msg.task_id).toBe('001');
    });
  });

  describe('getInbox', () => {
    it('returns unread messages in chronological order', () => {
      sendMessage(db, { from_agent: 'agent-1', to_agent: 'lead', type: 'direct', payload: 'first' });
      sendMessage(db, { from_agent: 'agent-2', to_agent: 'lead', type: 'blocker', payload: 'second' });

      const inbox = getInbox(db, 'lead');
      expect(inbox).toHaveLength(2);
      expect(inbox[0].payload).toBe('first');
      expect(inbox[1].payload).toBe('second');
    });

    it('marks direct messages as read when requested', () => {
      sendMessage(db, { from_agent: 'agent-1', to_agent: 'lead', type: 'direct', payload: 'test' });

      const msgs = getInbox(db, 'lead', true);
      expect(msgs).toHaveLength(1);

      // Should be 0 unread now
      expect(getUnreadCount(db, 'lead')).toBe(0);

      // Verify read_at is set in DB
      const msg = db.prepare('SELECT read_at FROM messages WHERE id = ?').get(msgs[0].id) as { read_at: string | null };
      expect(msg.read_at).not.toBeNull();
    });

    it('without mark_read does not modify messages', () => {
      sendMessage(db, { from_agent: 'agent-1', to_agent: 'lead', type: 'direct', payload: 'test' });

      getInbox(db, 'lead', false);
      // Should still be 1 unread
      expect(getUnreadCount(db, 'lead')).toBe(1);
    });

    it('returns empty array when no unread messages', () => {
      const inbox = getInbox(db, 'lead');
      expect(inbox).toEqual([]);
    });

    it('does not return messages for other agents', () => {
      sendMessage(db, { from_agent: 'agent-1', to_agent: 'agent-2', type: 'direct', payload: 'private' });
      const inbox = getInbox(db, 'lead');
      expect(inbox).toHaveLength(0);
    });
  });

  describe('getUnreadCount', () => {
    it('returns 0 for agent with no messages', () => {
      expect(getUnreadCount(db, 'agent-1')).toBe(0);
    });

    it('counts both direct and broadcast messages', () => {
      sendMessage(db, { from_agent: 'lead', to_agent: 'agent-1', type: 'direct', payload: 'direct' });
      sendMessage(db, { from_agent: 'lead', to_agent: null, type: 'broadcast', payload: 'broadcast' });
      expect(getUnreadCount(db, 'agent-1')).toBe(2);
    });
  });

  describe('postCheckpoint', () => {
    it('creates checkpoint message and updates result_summary atomically', () => {
      const taskId = createTask(db, { subject: 'Test task' });
      claimTask(db, 'agent-1');

      postCheckpoint(db, taskId, 'agent-1', 'Found the bug');

      // Check message was created with correct fields
      const inbox = getInbox(db, 'lead');
      expect(inbox).toHaveLength(1);
      expect(inbox[0].type).toBe('checkpoint');
      expect(inbox[0].payload).toBe('Found the bug');
      expect(inbox[0].from_agent).toBe('agent-1');
      expect(inbox[0].task_id).toBe(taskId);

      // Check result_summary updated
      const task = db.prepare('SELECT result_summary FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      expect(task.result_summary).toBe('Found the bug');
    });

    it('rejects checkpoint from non-owner', () => {
      const taskId = createTask(db, { subject: 'Test task' });
      claimTask(db, 'agent-1');

      expect(() => postCheckpoint(db, taskId, 'agent-2', 'Nope'))
        .toThrow("cannot be checkpointed by 'agent-2': not the owning agent");
    });

    it('lead can checkpoint any task regardless of ownership', () => {
      const taskId = createTask(db, { subject: 'Worker task' });
      claimTask(db, 'agent-1');

      postCheckpoint(db, taskId, 'lead', 'Lead status update');

      const task = db.prepare('SELECT result_summary FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      expect(task.result_summary).toBe('Lead status update');
    });

    it('throws for non-existent task', () => {
      expect(() => postCheckpoint(db, '999', 'agent-1', 'nope')).toThrow('not found');
    });

    it('overwrites previous result_summary with latest checkpoint', () => {
      const taskId = createTask(db, { subject: 'Test' });
      claimTask(db, 'agent-1');

      postCheckpoint(db, taskId, 'agent-1', 'Progress 1');
      postCheckpoint(db, taskId, 'agent-1', 'Progress 2');

      const task = db.prepare('SELECT result_summary FROM tasks WHERE id = ?').get(taskId) as TaskRow;
      expect(task.result_summary).toBe('Progress 2');
    });
  });

  describe('broadcast isolation', () => {
    it('agent A marks read does NOT affect broadcast visibility for agent B', () => {
      sendMessage(db, {
        from_agent: 'lead',
        to_agent: null,
        type: 'broadcast',
        payload: 'Attention all',
      });

      // Agent A reads with mark_read
      const msgsA = getInbox(db, 'agent-A', true);
      expect(msgsA).toHaveLength(1);

      // Verify broadcast read_at is still NULL in DB (not marked)
      const msg = db.prepare('SELECT read_at FROM messages WHERE id = ?').get(msgsA[0].id) as { read_at: string | null };
      expect(msg.read_at).toBeNull();

      // Agent B still sees it
      expect(getUnreadCount(db, 'agent-B')).toBe(1);
      const msgsB = getInbox(db, 'agent-B');
      expect(msgsB).toHaveLength(1);
      expect(msgsB[0].payload).toBe('Attention all');
    });

    it('direct message marked read by recipient is not visible again', () => {
      sendMessage(db, { from_agent: 'agent-1', to_agent: 'lead', type: 'direct', payload: 'once' });

      getInbox(db, 'lead', true);
      expect(getUnreadCount(db, 'lead')).toBe(0);

      // Second read returns nothing
      const msgs = getInbox(db, 'lead', true);
      expect(msgs).toHaveLength(0);
    });
  });

  describe('broadcast age filtering', () => {
    it('old broadcasts are excluded from inbox and unread count', () => {
      // Insert a broadcast backdated to 2 hours ago (beyond 1h threshold)
      db.prepare(`
        INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at)
        VALUES ('old-bc', 'lead', NULL, 'broadcast', 'Old broadcast',
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7200 seconds'))
      `).run();

      // Insert a recent broadcast
      sendMessage(db, {
        from_agent: 'lead',
        to_agent: null,
        type: 'broadcast',
        payload: 'Recent broadcast',
      });

      // Only the recent broadcast should be visible
      expect(getUnreadCount(db, 'agent-1')).toBe(1);
      const inbox = getInbox(db, 'agent-1');
      expect(inbox).toHaveLength(1);
      expect(inbox[0].payload).toBe('Recent broadcast');
    });

    it('broadcast count does not grow without bound', () => {
      // Insert 10 backdated broadcasts (all older than threshold)
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at)
          VALUES (?, 'lead', NULL, 'broadcast', ?,
                  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7200 seconds'))
        `).run(`old-${i}`, `Old broadcast ${i}`);
      }

      // None of the old broadcasts should appear
      expect(getUnreadCount(db, 'agent-1')).toBe(0);
      const inbox = getInbox(db, 'agent-1');
      expect(inbox).toHaveLength(0);
    });

    it('direct messages are unaffected by broadcast age filtering', () => {
      // Direct message — age doesn't matter, only read_at
      db.prepare(`
        INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at)
        VALUES ('old-dm', 'agent-1', 'lead', 'direct', 'Old direct message',
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7200 seconds'))
      `).run();

      // Old direct messages should still be visible (they use read_at tracking)
      expect(getUnreadCount(db, 'lead')).toBe(1);
      const inbox = getInbox(db, 'lead');
      expect(inbox).toHaveLength(1);
      expect(inbox[0].payload).toBe('Old direct message');
    });
  });

  describe('pruneMessages', () => {
    it('returns 0 on empty database', () => {
      // pruneMessages imported at top
      expect(pruneMessages(db)).toBe(0);
    });

    it('prunes old read direct messages', () => {
      // pruneMessages imported at top
      // Insert a read direct message older than the max age
      db.prepare(`
        INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at, read_at)
        VALUES ('old-read', 'agent-1', 'lead', 'direct', 'Old read msg',
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90000 seconds'),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-89000 seconds'))
      `).run();

      const pruned = pruneMessages(db);
      expect(pruned).toBe(1);
    });

    it('preserves unread direct messages', () => {
      // pruneMessages imported at top
      // Insert an unread direct message older than the max age
      db.prepare(`
        INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at)
        VALUES ('old-unread', 'agent-1', 'lead', 'direct', 'Old unread msg',
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90000 seconds'))
      `).run();

      const pruned = pruneMessages(db);
      expect(pruned).toBe(0);
      // Message should still exist
      const count = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
      expect(count).toBe(1);
    });

    it('prunes old broadcasts', () => {
      // pruneMessages imported at top
      // Insert an old broadcast
      db.prepare(`
        INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at)
        VALUES ('old-bc', 'lead', NULL, 'broadcast', 'Old broadcast',
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90000 seconds'))
      `).run();

      const pruned = pruneMessages(db);
      expect(pruned).toBe(1);
    });
  });

  describe('per-agent message limit', () => {
    it('rejects messages when agent exceeds 1000 message limit', () => {
      // Insert 1000 messages directly to avoid individual validation overhead
      const stmt = db.prepare(`
        INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at)
        VALUES (?, 'spammer', 'lead', 'direct', 'msg', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `);
      const insertMany = db.transaction(() => {
        for (let i = 0; i < 1000; i++) {
          stmt.run(`limit-test-${i}`);
        }
      });
      insertMany();

      // 1001st message should fail
      expect(() => sendMessage(db, {
        from_agent: 'spammer',
        to_agent: 'lead',
        type: 'direct',
        payload: 'one too many',
      })).toThrow('message limit');
    });

    it('allows messages from a different agent when one agent is at limit', () => {
      const stmt = db.prepare(`
        INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at)
        VALUES (?, 'full-agent', 'lead', 'direct', 'msg', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `);
      const insertMany = db.transaction(() => {
        for (let i = 0; i < 1000; i++) {
          stmt.run(`isolate-test-${i}`);
        }
      });
      insertMany();

      // Different agent should still work
      expect(() => sendMessage(db, {
        from_agent: 'other-agent',
        to_agent: 'lead',
        type: 'direct',
        payload: 'this should work',
      })).not.toThrow();
    });
  });

  describe('non-broadcast null recipient rejection', () => {
    it('rejects direct message with null to_agent', () => {
      expect(() => sendMessage(db, {
        from_agent: 'agent-1',
        to_agent: null,
        type: 'direct',
        payload: 'Should fail',
      })).toThrow('must have a non-empty recipient');
    });

    it('rejects shutdown message with null to_agent', () => {
      expect(() => sendMessage(db, {
        from_agent: 'lead',
        to_agent: null,
        type: 'shutdown',
        payload: 'Should fail',
      })).toThrow('must have a non-empty recipient');
    });

    it('rejects checkpoint message with null to_agent', () => {
      expect(() => sendMessage(db, {
        from_agent: 'agent-1',
        to_agent: null,
        type: 'checkpoint',
        payload: 'Should fail',
      })).toThrow('must have a non-empty recipient');
    });

    it('rejects direct message with empty string to_agent', () => {
      expect(() => sendMessage(db, {
        from_agent: 'agent-1',
        to_agent: '',
        type: 'direct',
        payload: 'Should fail',
      })).toThrow('must have a non-empty recipient');
    });
  });
});
