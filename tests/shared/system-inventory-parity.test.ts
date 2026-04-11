import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import type { Database } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

/**
 * Inventory parity guard — ensures SYSTEM-INVENTORY.md stays in sync
 * with the live schema, constants, and repo structure.
 */
describe('system-inventory-parity', () => {
  let inventoryDoc: string;
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    const inventoryPath = path.resolve(__dirname, '../../SYSTEM-INVENTORY.md');
    inventoryDoc = fs.readFileSync(inventoryPath, 'utf-8');
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  // NOTE: Removed 5 "stale claims are absent" tests (71 files, 6700 LOC, 409+ tests,
  // 18+ test files, 14 indexes). These were backward-looking guards against specific
  // stale values that were removed long ago. They can never fail and provide zero signal.

  // NOTE: Removed 5 "stale v3 column/enum names are absent" tests. Same issue as
  // stale claims — these guard against specific strings that were removed long ago
  // and can never fail again.

  describe('v3 table names are documented', () => {
    const v3Tables = [
      'plans', 'plan_reviews', 'research_packets', 'plan_tasks',
      'task_attempts', 'evidence_packets', 'execution_targets', 'lifecycle_events',
    ];

    for (const table of v3Tables) {
      it(`documents the "${table}" table`, () => {
        expect(inventoryDoc).toContain(`\`${table}\``);
      });
    }
  });

  describe('correct evidence types are documented', () => {
    const evidenceTypes = [
      'diff', 'test_result', 'build_log', 'screenshot',
      'review_comment', 'artifact_checksum',
    ];

    for (const etype of evidenceTypes) {
      it(`documents evidence type "${etype}"`, () => {
        expect(inventoryDoc).toContain(etype);
      });
    }
  });

  describe('index count matches live schema', () => {
    it('documents 19 indexes', () => {
      expect(inventoryDoc).toContain('19 indexes');
    });

    it('fresh DB has exactly 19 indexes', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
      ).all() as Array<{ name: string }>;
      expect(indexes.length).toBe(19);
    });
  });

  describe('table count matches live schema', () => {
    it('documents 17 tables', () => {
      expect(inventoryDoc).toContain('17 tables');
    });

    it('fresh DB has exactly 17 tables', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).all() as Array<{ name: string }>;
      expect(tables.length).toBe(17);
    });
  });

  describe('runnable test file count', () => {
    it('inventory documents the exact test file count', () => {
      const testsDir = path.resolve(__dirname, '..');
      const testFiles: string[] = [];

      function findTestFiles(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            findTestFiles(full);
          } else if (entry.name.endsWith('.test.ts')) {
            testFiles.push(full);
          }
        }
      }

      findTestFiles(testsDir);
      // Extract documented count from inventory (e.g. "28 test files")
      const countMatch = inventoryDoc.match(/(\d+)\s+test files/);
      expect(countMatch).not.toBeNull();
      const documentedCount = parseInt(countMatch![1], 10);
      expect(testFiles.length).toBe(documentedCount);
    });
  });
});
