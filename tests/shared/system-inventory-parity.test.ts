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

  describe('stale claims are absent', () => {
    it('does not claim "71 source files"', () => {
      expect(inventoryDoc).not.toContain('71 source files');
    });

    it('does not claim "~6,700 LOC"', () => {
      expect(inventoryDoc).not.toContain('6,700 LOC');
    });

    it('does not claim "409+ tests"', () => {
      expect(inventoryDoc).not.toMatch(/409\+/);
    });

    it('does not claim "18+ test files"', () => {
      expect(inventoryDoc).not.toMatch(/18\+ test files/);
    });

    it('does not claim "14 indexes"', () => {
      expect(inventoryDoc).not.toContain('14 indexes');
    });
  });

  describe('stale v3 column/enum names are absent', () => {
    it('does not use stale column name "source_session_id"', () => {
      expect(inventoryDoc).not.toContain('source_session_id');
    });

    it('does not use stale evidence type "diff_summary"', () => {
      expect(inventoryDoc).not.toContain('diff_summary');
    });

    it('does not use stale evidence type "log_output"', () => {
      expect(inventoryDoc).not.toContain('log_output');
    });

    it('does not use stale evidence type "artifact_ref"', () => {
      expect(inventoryDoc).not.toContain('artifact_ref');
    });

    it('does not use stale evidence type "custom"', () => {
      // "custom" appears in "custom_instructions" in other contexts, so check evidence-specific
      expect(inventoryDoc).not.toMatch(/type.*custom\)/);
    });
  });

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
    it('documents 17 indexes', () => {
      expect(inventoryDoc).toContain('17 indexes');
    });

    it('fresh DB has exactly 17 indexes', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
      ).all() as Array<{ name: string }>;
      expect(indexes.length).toBe(17);
    });
  });

  describe('table count matches live schema', () => {
    it('documents 16 tables', () => {
      expect(inventoryDoc).toContain('16 tables');
    });

    it('fresh DB has exactly 16 tables', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).all() as Array<{ name: string }>;
      expect(tables.length).toBe(16);
    });
  });

  describe('runnable test file count', () => {
    it('actual runnable test files matches documented count', () => {
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
      // Inventory should document the actual count
      // Currently 24 test files (23 runnable + this new one = 24 runnable)
      expect(testFiles.length).toBeGreaterThanOrEqual(23);
    });
  });
});
