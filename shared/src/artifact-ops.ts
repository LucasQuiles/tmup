import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type { Database, ArtifactRow, ArtifactDirection } from './types.js';
import { generateArtifactId } from './id.js';
import { MAX_ARTIFACT_SIZE_BYTES } from './constants.js';

export function createArtifact(
  db: Database,
  name: string,
  artifactPath: string
): string {
  const id = generateArtifactId();
  db.prepare(
    'INSERT INTO artifacts (id, name, path, status) VALUES (?, ?, ?, ?)'
  ).run(id, name, artifactPath, 'pending');
  return id;
}

export function publishArtifact(
  db: Database,
  artifactId: string,
  artifactPath: string,
  checksum: string
): void {
  const result = db.prepare(
    "UPDATE artifacts SET status = 'published', path = ?, checksum = ? WHERE id = ?"
  ).run(artifactPath, checksum, artifactId);
  if (result.changes === 0) {
    throw new Error(`Artifact ${artifactId} not found`);
  }
}

export function verifyArtifact(
  db: Database,
  artifactId: string
): 'available' | 'stale' | 'missing' | 'pending' {
  // Wrap in IMMEDIATE transaction to prevent concurrent publish from clobbering our status update
  const verify = db.transaction(() => {
    const artifact = db.prepare(
      'SELECT * FROM artifacts WHERE id = ?'
    ).get(artifactId) as ArtifactRow | undefined;

    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);
    if (artifact.status === 'pending') return 'pending' as const;

    // Check checksum (handles TOCTOU: file may be deleted between exists check and read)
    if (artifact.checksum) {
      let currentChecksum: string;
      try {
        currentChecksum = computeChecksum(artifact.path);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          db.prepare("UPDATE artifacts SET status = 'missing' WHERE id = ?").run(artifactId);
          return 'missing' as const;
        }
        throw err;
      }
      if (currentChecksum !== artifact.checksum) {
        db.prepare(
          "UPDATE artifacts SET status = 'stale', checksum = ? WHERE id = ?"
        ).run(currentChecksum, artifactId);
        return 'stale' as const;
      }
      return 'available' as const;
    }

    // No checksum — check file existence only
    if (!fs.existsSync(artifact.path)) {
      db.prepare("UPDATE artifacts SET status = 'missing' WHERE id = ?").run(artifactId);
      return 'missing' as const;
    }

    return 'available' as const;
  });

  return verify.immediate();
}

export function linkTaskArtifact(
  db: Database,
  taskId: string,
  artifactId: string,
  direction: ArtifactDirection
): void {
  db.prepare(
    'INSERT OR IGNORE INTO task_artifacts (task_id, artifact_id, direction) VALUES (?, ?, ?)'
  ).run(taskId, artifactId, direction);
}

export function computeChecksum(filePath: string): string {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Cannot checksum non-regular file: ${filePath}`);
  }
  if (stat.size > MAX_ARTIFACT_SIZE_BYTES) {
    throw new Error(`Artifact file exceeds size limit (${stat.size} > ${MAX_ARTIFACT_SIZE_BYTES} bytes)`);
  }
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function findArtifactByName(db: Database, name: string): ArtifactRow | undefined {
  return db.prepare('SELECT * FROM artifacts WHERE name = ?').get(name) as ArtifactRow | undefined;
}

export function validateArtifactPath(artifactPath: string, projectDir: string): string {
  // Resolve the path first for basic containment check
  const resolved = path.resolve(artifactPath);
  const resolvedProject = path.resolve(projectDir);
  if (!resolved.startsWith(resolvedProject + path.sep) && resolved !== resolvedProject) {
    throw new Error(`Artifact path must be within project directory: ${artifactPath}`);
  }

  // If the path exists, resolve symlinks and re-check containment
  try {
    const realPath = fs.realpathSync(resolved);
    const realProject = fs.realpathSync(resolvedProject);
    if (!realPath.startsWith(realProject + path.sep) && realPath !== realProject) {
      throw new Error(`Artifact path must be within project directory: ${artifactPath} (resolves to ${realPath})`);
    }
    return realPath;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist yet — return the resolved path
      return resolved;
    }
    throw err;
  }
}
