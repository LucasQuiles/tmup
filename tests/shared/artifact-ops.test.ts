import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import {
  createArtifact, publishArtifact, verifyArtifact,
  linkTaskArtifact, computeChecksum, findArtifactByName,
  validateArtifactPath,
} from '../../shared/src/artifact-ops.js';
import { createTask } from '../../shared/src/task-ops.js';
import type { Database } from '../../shared/src/types.js';
import { MAX_ARTIFACT_SIZE_BYTES } from '../../shared/src/constants.js';

import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('artifact-ops', () => {
  let db: Database;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-art-'));
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it('creates an artifact with pending status', () => {
    const id = createArtifact(db, 'schema.sql', '/tmp/schema.sql');
    expect(id).toBeTruthy();
    const art = findArtifactByName(db, 'schema.sql');
    expect(art).toBeTruthy();
    expect(art!.status).toBe('pending');
    expect(art!.path).toBe('/tmp/schema.sql');
  });

  it('publishes an artifact with path and checksum', () => {
    const id = createArtifact(db, 'output.json', '');
    const filePath = path.join(tmpDir, 'output.json');
    fs.writeFileSync(filePath, '{"ok":true}');
    const checksum = computeChecksum(filePath);

    publishArtifact(db, id, filePath, checksum);
    const art = findArtifactByName(db, 'output.json');
    expect(art!.status).toBe('published');
    expect(art!.checksum).toBe(checksum);
  });

  it('publishArtifact throws for nonexistent artifact', () => {
    expect(() => publishArtifact(db, 'nonexistent', '/tmp/x', 'abc')).toThrow('not found');
  });

  it('verifyArtifact returns pending for unpublished', () => {
    const id = createArtifact(db, 'pending-art', '');
    expect(verifyArtifact(db, id)).toBe('pending');
  });

  it('verifyArtifact returns available for valid file', () => {
    const id = createArtifact(db, 'valid-art', '');
    const filePath = path.join(tmpDir, 'valid.txt');
    fs.writeFileSync(filePath, 'hello');
    const checksum = computeChecksum(filePath);
    publishArtifact(db, id, filePath, checksum);

    expect(verifyArtifact(db, id)).toBe('available');
  });

  it('verifyArtifact returns missing when file deleted', () => {
    const id = createArtifact(db, 'gone-art', '');
    const filePath = path.join(tmpDir, 'gone.txt');
    fs.writeFileSync(filePath, 'temp');
    publishArtifact(db, id, filePath, computeChecksum(filePath));
    fs.unlinkSync(filePath);

    expect(verifyArtifact(db, id)).toBe('missing');
  });

  it('verifyArtifact returns stale when checksum changes', () => {
    const id = createArtifact(db, 'stale-art', '');
    const filePath = path.join(tmpDir, 'stale.txt');
    fs.writeFileSync(filePath, 'original');
    publishArtifact(db, id, filePath, computeChecksum(filePath));

    // Modify file after publish
    fs.writeFileSync(filePath, 'modified');
    expect(verifyArtifact(db, id)).toBe('stale');
  });

  it('verifyArtifact throws for nonexistent artifact', () => {
    expect(() => verifyArtifact(db, 'nonexistent')).toThrow('not found');
  });

  it('links artifact to task', () => {
    createTask(db, { subject: 'Test task' });
    const artId = createArtifact(db, 'linked', '');
    linkTaskArtifact(db, '001', artId, 'requires');

    const row = db.prepare(
      'SELECT * FROM task_artifacts WHERE task_id = ? AND artifact_id = ?'
    ).get('001', artId) as { direction: string };
    expect(row.direction).toBe('requires');
  });

  it('linkTaskArtifact is idempotent (INSERT OR IGNORE)', () => {
    createTask(db, { subject: 'Test task' });
    const artId = createArtifact(db, 'dup', '');
    linkTaskArtifact(db, '001', artId, 'produces');
    linkTaskArtifact(db, '001', artId, 'produces'); // no throw
    const count = db.prepare(
      'SELECT COUNT(*) as cnt FROM task_artifacts WHERE task_id = ? AND artifact_id = ?'
    ).get('001', artId) as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('computeChecksum produces consistent SHA-256', () => {
    const filePath = path.join(tmpDir, 'checksum.txt');
    fs.writeFileSync(filePath, 'deterministic');
    const c1 = computeChecksum(filePath);
    const c2 = computeChecksum(filePath);
    expect(c1).toBe(c2);
    expect(c1).toHaveLength(64); // SHA-256 hex
  });

  it('findArtifactByName returns undefined for missing', () => {
    expect(findArtifactByName(db, 'nope')).toBeUndefined();
  });

  // validateArtifactPath tests
  it('validates path within project dir', () => {
    const result = validateArtifactPath(path.join(tmpDir, 'sub/file.txt'), tmpDir);
    expect(result).toBe(path.resolve(tmpDir, 'sub/file.txt'));
  });

  it('rejects path outside project dir', () => {
    expect(() => validateArtifactPath('/etc/passwd', tmpDir)).toThrow('must be within project directory');
  });

  it('rejects path traversal via ..', () => {
    expect(() => validateArtifactPath(path.join(tmpDir, '..', 'escape'), tmpDir)).toThrow('must be within project directory');
  });

  it('allows exact project dir path', () => {
    const result = validateArtifactPath(tmpDir, tmpDir);
    expect(result).toBe(path.resolve(tmpDir));
  });

  // Phase 2 hardening tests — symlink and file-type defenses
  describe('symlink containment', () => {
    it('rejects symlinks that escape project directory', () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-outside-'));
      try {
        const outsideFile = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(outsideFile, 'outside data');

        const symlinkPath = path.join(tmpDir, 'sneaky-link.txt');
        fs.symlinkSync(outsideFile, symlinkPath);

        // After hardening: validateArtifactPath should resolve symlinks
        // and reject if real path is outside projectDir
        expect(() => validateArtifactPath(symlinkPath, tmpDir)).toThrow('must be within project directory');
      } finally {
        try { fs.rmSync(outsideDir, { recursive: true }); } catch {}
      }
    });

    it('allows symlinks that stay within project directory', () => {
      const realFile = path.join(tmpDir, 'real.txt');
      fs.writeFileSync(realFile, 'real content');
      const linkPath = path.join(tmpDir, 'link.txt');
      fs.symlinkSync(realFile, linkPath);

      // Symlink within project dir should be allowed
      const result = validateArtifactPath(linkPath, tmpDir);
      expect(result).toBeTruthy();
    });
  });

  describe('file-type guards', () => {
    it('rejects directories in computeChecksum', () => {
      expect(() => computeChecksum(tmpDir)).toThrow('Cannot checksum non-regular file');
    });

    it('rejects device files in computeChecksum', () => {
      // /dev/null is a device file, not a regular file
      expect(() => computeChecksum('/dev/null')).toThrow();
    });
  });

  describe('checksum size cap', () => {
    it('rejects files exceeding MAX_ARTIFACT_SIZE_BYTES using sparse file metadata', () => {
      const largePath = path.join(tmpDir, 'large.bin');
      const fd = fs.openSync(largePath, 'w');
      try {
        fs.ftruncateSync(fd, MAX_ARTIFACT_SIZE_BYTES + 1);
      } finally {
        fs.closeSync(fd);
      }

      expect(() => computeChecksum(largePath)).toThrow(
        `Artifact file exceeds size limit (${MAX_ARTIFACT_SIZE_BYTES + 1} > ${MAX_ARTIFACT_SIZE_BYTES} bytes)`
      );
    });
  });

  describe('verifyArtifact transaction semantics', () => {
    it('holds an IMMEDIATE transaction so concurrent publish cannot clobber a stale update mid-check', () => {
      const id = createArtifact(db, 'contention-art', '');
      const filePath = path.join(tmpDir, 'contention.txt');
      fs.writeFileSync(filePath, 'original');
      publishArtifact(db, id, filePath, computeChecksum(filePath));

      fs.writeFileSync(filePath, 'modified');

      const originalReadFileSync = fs.readFileSync.bind(fs);
      let childStatus: number | null = null;
      let childStderr = '';
      let spawned = false;

      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
        if (!spawned && typeof target === 'string' && target === filePath) {
          spawned = true;
          const child = spawnSync(
            process.execPath,
            [
              '-e',
              `
                const BetterSqlite3 = require('better-sqlite3');
                const db = new BetterSqlite3(process.argv[1]);
                db.pragma('busy_timeout = 1');
                try {
                  db.prepare("UPDATE artifacts SET status = 'published', path = ?, checksum = ? WHERE id = ?")
                    .run(process.argv[3], 'child-checksum', process.argv[2]);
                  process.exit(0);
                } catch (err) {
                  console.error(err instanceof Error ? err.message : String(err));
                  process.exit(1);
                } finally {
                  db.close();
                }
              `,
              dbPath,
              id,
              filePath,
            ],
            { encoding: 'utf-8', cwd: path.resolve('.') }
          );
          childStatus = child.status;
          childStderr = child.stderr;
        }

        return originalReadFileSync(target, options as never);
      }) as typeof fs.readFileSync);

      try {
        expect(verifyArtifact(db, id)).toBe('stale');
      } finally {
        readSpy.mockRestore();
      }

      expect(childStatus).toBe(1);
      expect(childStderr).toMatch(/database is locked/i);

      const art = findArtifactByName(db, 'contention-art');
      expect(art?.status).toBe('stale');
      expect(art?.checksum).toBe(computeChecksum(filePath));
    });
  });
});
