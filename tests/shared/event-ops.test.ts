import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { logEvent, pruneEvents, getRecentEvents } from '../../shared/src/event-ops.js';
import { runMaintenance } from '../../shared/src/maintenance.js';
import { sendMessage, pruneMessages } from '../../shared/src/message-ops.js';
import type { Database, EventRow } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';
import fs from 'node:fs';

describe('event-ops', () => {
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

  it('logEvent inserts a row with correct fields', () => {
    logEvent(db, 'lead', 'session_init', { project_dir: '/tmp/test' });
    const events = getRecentEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('session_init');
    expect(events[0].actor).toBe('lead');
    expect(events[0].timestamp).toBeTruthy();
    // Verify payload is stored as JSON and retrievable
    const payload = JSON.parse(events[0].payload!);
    expect(payload.project_dir).toBe('/tmp/test');
  });

  it('logEvent with null actor stores correctly', () => {
    logEvent(db, null, 'task_created', { task_id: '001' });
    const events = getRecentEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBeNull();
    expect(events[0].event_type).toBe('task_created');
  });

  it('logEvent with no payload stores null', () => {
    logEvent(db, 'lead', 'session_init');
    const events = getRecentEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toBeNull();
  });

  it('getRecentEvents filters by type accurately', () => {
    logEvent(db, 'lead', 'session_init', {});
    logEvent(db, 'agent1', 'task_claimed', {});
    logEvent(db, 'agent2', 'task_claimed', {});
    logEvent(db, 'agent1', 'task_completed', {});

    const all = getRecentEvents(db);
    expect(all).toHaveLength(4);

    const claimed = getRecentEvents(db, 'task_claimed');
    expect(claimed).toHaveLength(2);
    // Verify ALL returned events match the filter
    for (const e of claimed) {
      expect(e.event_type).toBe('task_claimed');
    }

    const completed = getRecentEvents(db, 'task_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].actor).toBe('agent1');
  });

  it('getRecentEvents respects limit and returns most recent first', () => {
    for (let i = 0; i < 10; i++) {
      logEvent(db, 'lead', 'session_init', { i });
    }
    const limited = getRecentEvents(db, undefined, 3);
    expect(limited).toHaveLength(3);
    // Most recent first (highest id)
    expect(limited[0].id).toBeGreaterThan(limited[1].id);
    expect(limited[1].id).toBeGreaterThan(limited[2].id);
    // Verify it's the last 3 events
    const payloads = limited.map(e => JSON.parse(e.payload!).i);
    expect(payloads).toEqual([9, 8, 7]);
  });

  it('pruneEvents removes only old entries', () => {
    // Insert a backdated event
    db.prepare(
      "INSERT INTO events (actor, event_type, timestamp) VALUES ('lead', 'session_init', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds'))"
    ).run();
    // Insert a recent event
    logEvent(db, 'lead', 'session_init', {});

    const before = getRecentEvents(db);
    expect(before).toHaveLength(2);

    const pruned = pruneEvents(db, 300);
    expect(pruned).toBe(1);

    const after = getRecentEvents(db);
    expect(after).toHaveLength(1);
    // The surviving event should be the recent one (has a payload)
    expect(after[0].payload).not.toBeNull();
  });

  it('pruneEvents with 0 seconds removes events strictly older than now', () => {
    // Backdate an event well into the past to avoid timing races
    db.prepare(
      "INSERT INTO events (actor, event_type, timestamp) VALUES ('lead', 'session_init', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 seconds'))"
    ).run();
    // Insert a "future" event that cannot be pruned by 0-second threshold
    db.prepare(
      "INSERT INTO events (actor, event_type, timestamp) VALUES ('agent-1', 'task_claimed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 seconds'))"
    ).run();

    const pruned = pruneEvents(db, 0);
    // The backdated event is pruned; the future event survives
    expect(pruned).toBe(1);
    expect(getRecentEvents(db)).toHaveLength(1);
  });

  it('getRecentEvents returns empty array when no events', () => {
    const events = getRecentEvents(db);
    expect(events).toEqual([]);
  });

  it('getRecentEvents returns empty array for non-existent event type', () => {
    logEvent(db, 'lead', 'session_init', {});
    const events = getRecentEvents(db, 'task_claimed');
    expect(events).toEqual([]);
  });

  it('pruneEvents is bounded — deletes at most 1000 rows per call', () => {
    // Insert 1500 backdated events
    const insert = db.prepare(
      "INSERT INTO events (actor, event_type, timestamp) VALUES ('lead', 'session_init', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-600 seconds'))"
    );
    for (let i = 0; i < 1500; i++) insert.run();

    // First prune should delete exactly 1000 (batch limit)
    const first = pruneEvents(db, 300);
    expect(first).toBe(1000);

    // Second prune should delete the remaining 500
    const second = pruneEvents(db, 300);
    expect(second).toBe(500);
  });

  describe('runMaintenance', () => {
    it('runs all maintenance operations and returns structured result', () => {
      // Insert old events and messages
      db.prepare(
        "INSERT INTO events (actor, event_type, timestamp) VALUES ('lead', 'session_init', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-172800 seconds'))"
      ).run();

      sendMessage(db, { from_agent: 'lead', to_agent: null, type: 'broadcast', payload: 'old' });
      // Backdate to make prunable
      db.prepare(
        "UPDATE messages SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-172800 seconds')"
      ).run();

      const result = runMaintenance(db);
      expect(result.walCheckpoint).toBe(true);
      expect(result.eventsPruned).toBe(1);
      expect(result.messagesPruned).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it('collects errors into result.errors instead of throwing', () => {
      // Close the live DB to force maintenance operations to fail
      closeDatabase(db);

      // Run maintenance on the closed handle — should not throw
      const result = runMaintenance(db);

      // At least one operation should have produced an error
      expect(result.errors.length).toBeGreaterThan(0);
      // Errors should contain meaningful descriptions, not empty strings
      for (const err of result.errors) {
        expect(err.length).toBeGreaterThan(0);
      }

      // Re-open for afterEach cleanup
      db = openDatabase(dbPath);
    });

    it('maintenance with nothing to prune returns zeros', () => {
      const result = runMaintenance(db);
      expect(result.eventsPruned).toBe(0);
      expect(result.messagesPruned).toBe(0);
      expect(result.walCheckpoint).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('warns when event pruning hits batch limit', () => {
      // Insert 1001 backdated events (batch limit is 1000)
      const insert = db.prepare(
        "INSERT INTO events (actor, event_type, timestamp) VALUES ('lead', 'session_init', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-172800 seconds'))"
      );
      for (let i = 0; i < 1001; i++) insert.run();

      const result = runMaintenance(db);
      expect(result.eventsPruned).toBe(1000);
      expect(result.warnings.some(w => w.includes('Event pruning hit batch limit'))).toBe(true);
    });

    it('warns when message pruning hits batch limit', () => {
      // Insert 501 backdated broadcast messages (batch limit is 500)
      const insert = db.prepare(
        "INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at) VALUES (?, 'lead', NULL, 'broadcast', 'old', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-172800 seconds'))"
      );
      for (let i = 0; i < 501; i++) insert.run(`msg-batch-${i}`);

      const result = runMaintenance(db);
      expect(result.messagesPruned).toBe(500);
      expect(result.warnings.some(w => w.includes('Message pruning hit batch limit'))).toBe(true);
    });
  });
});
