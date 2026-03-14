/**
 * Execution target operations: abstraction layer between agents and where they run.
 *
 * P5.4: decouples agent identity from tmux panes. Current tmux behavior is preserved
 * as the default backend. Non-tmux targets (local_shell, codex_cloud) are
 * available but not yet routed.
 *
 * Capability surface per target:
 *   repo_rw       - can read/write the project repo
 *   test          - can run tests
 *   network       - has network access
 *   long_running  - supports long-lived processes
 *   interactive   - supports interactive CLI tools
 */
import type {
  Database,
  ExecutionTargetRow, ExecutionTargetType,
  CreateExecutionTargetInput,
} from './types.js';

/** Well-known capabilities that targets can declare. */
export const KNOWN_CAPABILITIES = [
  'repo_rw', 'test', 'network', 'long_running', 'interactive',
] as const;

export type Capability = typeof KNOWN_CAPABILITIES[number];

/**
 * Create an execution target.
 */
export function createExecutionTarget(
  db: Database,
  targetId: string,
  input: CreateExecutionTargetInput
): ExecutionTargetRow {
  const capabilities = JSON.stringify(input.capabilities ?? []);

  db.prepare(`
    INSERT INTO execution_targets (id, type, label, pane_index, capabilities)
    VALUES (?, ?, ?, ?, ?)
  `).run(targetId, input.type, input.label ?? null, input.pane_index ?? null, capabilities);

  return db.prepare('SELECT * FROM execution_targets WHERE id = ?').get(targetId) as ExecutionTargetRow;
}

/**
 * Get an execution target by ID.
 */
export function getExecutionTarget(db: Database, targetId: string): ExecutionTargetRow | undefined {
  return db.prepare('SELECT * FROM execution_targets WHERE id = ?').get(targetId) as ExecutionTargetRow | undefined;
}

/**
 * List execution targets, optionally filtered by type.
 */
export function listExecutionTargets(db: Database, type?: ExecutionTargetType): ExecutionTargetRow[] {
  if (type) {
    return db.prepare('SELECT * FROM execution_targets WHERE type = ?').all(type) as ExecutionTargetRow[];
  }
  return db.prepare('SELECT * FROM execution_targets').all() as ExecutionTargetRow[];
}

/**
 * Find a tmux pane target by its pane index (backward compatibility).
 */
export function findTargetByPaneIndex(db: Database, paneIndex: number): ExecutionTargetRow | undefined {
  return db.prepare(
    "SELECT * FROM execution_targets WHERE type = 'tmux_pane' AND pane_index = ?"
  ).get(paneIndex) as ExecutionTargetRow | undefined;
}

/**
 * Get parsed capabilities for a target.
 */
export function getTargetCapabilities(target: ExecutionTargetRow): Capability[] {
  try {
    const parsed = JSON.parse(target.capabilities);
    return Array.isArray(parsed) ? parsed.filter((c: string) =>
      (KNOWN_CAPABILITIES as readonly string[]).includes(c)
    ) as Capability[] : [];
  } catch {
    return [];
  }
}

/**
 * Check if a target has a specific capability.
 */
export function targetHasCapability(target: ExecutionTargetRow, capability: Capability): boolean {
  return getTargetCapabilities(target).includes(capability);
}

/**
 * Create a tmux pane target from legacy pane_index (migration helper).
 * Returns existing target if one already exists for this pane.
 */
export function ensureTmuxPaneTarget(
  db: Database,
  targetId: string,
  paneIndex: number
): ExecutionTargetRow {
  const existing = findTargetByPaneIndex(db, paneIndex);
  if (existing) return existing;

  return createExecutionTarget(db, targetId, {
    type: 'tmux_pane',
    label: `pane-${paneIndex}`,
    pane_index: paneIndex,
    capabilities: ['repo_rw', 'test', 'network', 'long_running', 'interactive'],
  });
}
