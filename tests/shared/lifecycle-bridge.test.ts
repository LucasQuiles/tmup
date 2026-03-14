import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import {
  logLifecycleEvent,
  getLifecycleEvents,
  pruneLifecycleEvents,
} from '../../shared/src/lifecycle-bridge.js';
import type { Database, LifecycleEventRow } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('lifecycle-bridge', () => {
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

  describe('logLifecycleEvent', () => {
    it('creates event with correct type and payload', () => {
      logLifecycleEvent(db, {
        event_type: 'claude_session_start',
        payload: { project_dir: '/tmp/myproject' },
      });

      const rows = getLifecycleEvents(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe('claude_session_start');
      expect(rows[0].timestamp).toBeTruthy();
      expect(rows[0].id).toBeGreaterThan(0);

      const payload = JSON.parse(rows[0].payload!);
      expect(payload.project_dir).toBe('/tmp/myproject');
    });

    it('stores session_id when provided', () => {
      logLifecycleEvent(db, {
        event_type: 'claude_session_start',
        session_id: 'sess-abc-123',
        payload: { reason: 'init' },
      });

      const rows = getLifecycleEvents(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe('sess-abc-123');
    });

    it('works without optional session_id', () => {
      logLifecycleEvent(db, {
        event_type: 'claude_precompact',
      });

      const rows = getLifecycleEvents(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe('claude_precompact');
      expect(rows[0].session_id).toBeNull();
      expect(rows[0].agent_id).toBeNull();
      expect(rows[0].payload).toBeNull();
    });
  });

  describe('getLifecycleEvents', () => {
    it('returns all events ordered by id desc', () => {
      logLifecycleEvent(db, { event_type: 'claude_session_start', payload: { i: 0 } });
      logLifecycleEvent(db, { event_type: 'claude_precompact', payload: { i: 1 } });
      logLifecycleEvent(db, { event_type: 'claude_session_end', payload: { i: 2 } });

      const rows = getLifecycleEvents(db);
      expect(rows).toHaveLength(3);
      // Most recent first (highest id)
      expect(rows[0].id).toBeGreaterThan(rows[1].id);
      expect(rows[1].id).toBeGreaterThan(rows[2].id);
      // Verify ordering matches insertion order reversed
      const indices = rows.map(r => JSON.parse(r.payload!).i);
      expect(indices).toEqual([2, 1, 0]);
    });

    it('filters by event type', () => {
      logLifecycleEvent(db, { event_type: 'claude_session_start' });
      logLifecycleEvent(db, { event_type: 'claude_precompact' });
      logLifecycleEvent(db, { event_type: 'claude_session_start' });
      logLifecycleEvent(db, { event_type: 'claude_task_completed' });

      const all = getLifecycleEvents(db);
      expect(all).toHaveLength(4);

      const starts = getLifecycleEvents(db, 'claude_session_start');
      expect(starts).toHaveLength(2);
      for (const e of starts) {
        expect(e.event_type).toBe('claude_session_start');
      }

      const compacts = getLifecycleEvents(db, 'claude_precompact');
      expect(compacts).toHaveLength(1);
      expect(compacts[0].event_type).toBe('claude_precompact');

      const completed = getLifecycleEvents(db, 'claude_task_completed');
      expect(completed).toHaveLength(1);

      const stops = getLifecycleEvents(db, 'claude_subagent_stop');
      expect(stops).toEqual([]);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        logLifecycleEvent(db, { event_type: 'claude_session_start', payload: { i } });
      }

      const limited = getLifecycleEvents(db, undefined, 3);
      expect(limited).toHaveLength(3);
      // Most recent first
      expect(limited[0].id).toBeGreaterThan(limited[1].id);
      expect(limited[1].id).toBeGreaterThan(limited[2].id);
      // Should be the last 3 events inserted
      const indices = limited.map(r => JSON.parse(r.payload!).i);
      expect(indices).toEqual([9, 8, 7]);
    });

    it('returns empty array when no events exist', () => {
      const rows = getLifecycleEvents(db);
      expect(rows).toEqual([]);
    });

    it('returns empty array for non-matching event type filter', () => {
      logLifecycleEvent(db, { event_type: 'claude_session_start' });
      const rows = getLifecycleEvents(db, 'claude_session_end');
      expect(rows).toEqual([]);
    });
  });

  describe('pruneLifecycleEvents', () => {
    it('removes events older than maxAge', () => {
      // Insert a backdated event
      db.prepare(
        "INSERT INTO lifecycle_events (event_type, timestamp) VALUES ('claude_session_start', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds'))"
      ).run();
      // Insert a recent event
      logLifecycleEvent(db, { event_type: 'claude_session_end' });

      const before = getLifecycleEvents(db);
      expect(before).toHaveLength(2);

      const pruned = pruneLifecycleEvents(db, 300);
      expect(pruned).toBe(1);

      const after = getLifecycleEvents(db);
      expect(after).toHaveLength(1);
      expect(after[0].event_type).toBe('claude_session_end');
    });

    it('keeps events newer than maxAge', () => {
      // Insert three recent events
      logLifecycleEvent(db, { event_type: 'claude_session_start', payload: { i: 0 } });
      logLifecycleEvent(db, { event_type: 'claude_precompact', payload: { i: 1 } });
      logLifecycleEvent(db, { event_type: 'claude_session_end', payload: { i: 2 } });

      const pruned = pruneLifecycleEvents(db, 300);
      expect(pruned).toBe(0);

      const after = getLifecycleEvents(db);
      expect(after).toHaveLength(3);
    });

    it('returns count of deleted rows', () => {
      // Insert 5 backdated events
      const insert = db.prepare(
        "INSERT INTO lifecycle_events (event_type, timestamp) VALUES ('claude_session_start', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds'))"
      );
      for (let i = 0; i < 5; i++) insert.run();

      // Insert 2 recent events
      logLifecycleEvent(db, { event_type: 'claude_session_start' });
      logLifecycleEvent(db, { event_type: 'claude_session_end' });

      const deleted = pruneLifecycleEvents(db, 300);
      expect(deleted).toBe(5);

      const remaining = getLifecycleEvents(db);
      expect(remaining).toHaveLength(2);
    });

    it('returns 0 when nothing to prune', () => {
      logLifecycleEvent(db, { event_type: 'claude_session_start' });
      const deleted = pruneLifecycleEvents(db, 300);
      expect(deleted).toBe(0);
    });

    it('is bounded — deletes at most 1000 rows per call', () => {
      const insert = db.prepare(
        "INSERT INTO lifecycle_events (event_type, timestamp) VALUES ('claude_session_start', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds'))"
      );
      for (let i = 0; i < 1500; i++) insert.run();

      const first = pruneLifecycleEvents(db, 300);
      expect(first).toBe(1000);

      const second = pruneLifecycleEvents(db, 300);
      expect(second).toBe(500);
    });
  });
});
