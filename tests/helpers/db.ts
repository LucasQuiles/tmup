import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/** Generate a unique temporary DB path for tests. */
export function tmpDbPath(): string {
  return path.join(os.tmpdir(), `tmup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** Clean up a SQLite database and its WAL/SHM files. */
export function cleanupDb(dbPath: string): void {
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
  try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
}
