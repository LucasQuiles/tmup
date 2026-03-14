import crypto from 'node:crypto';
import type { Database } from './types.js';

export function nextTaskId(db: Database): string {
  const row = db.prepare('SELECT MAX(CAST(id AS INTEGER)) as max_id FROM tasks').get() as { max_id: number | null } | undefined;
  const next = (row?.max_id ?? 0) + 1;
  return String(next).padStart(3, '0');
}

export function generateAgentId(): string {
  return crypto.randomUUID();
}

export function generateMessageId(): string {
  return crypto.randomUUID();
}

export function generateArtifactId(): string {
  return crypto.randomUUID();
}
