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
import type { Database, ExecutionTargetRow, ExecutionTargetType, CreateExecutionTargetInput } from './types.js';
/** Well-known capabilities that targets can declare. */
export declare const KNOWN_CAPABILITIES: readonly ["repo_rw", "test", "network", "long_running", "interactive"];
export type Capability = typeof KNOWN_CAPABILITIES[number];
/**
 * Create an execution target.
 */
export declare function createExecutionTarget(db: Database, targetId: string, input: CreateExecutionTargetInput): ExecutionTargetRow;
/**
 * Get an execution target by ID.
 */
export declare function getExecutionTarget(db: Database, targetId: string): ExecutionTargetRow | undefined;
/**
 * List execution targets, optionally filtered by type.
 */
export declare function listExecutionTargets(db: Database, type?: ExecutionTargetType): ExecutionTargetRow[];
/**
 * Find a tmux pane target by its pane index (backward compatibility).
 */
export declare function findTargetByPaneIndex(db: Database, paneIndex: number): ExecutionTargetRow | undefined;
/**
 * Get parsed capabilities for a target.
 */
export declare function getTargetCapabilities(target: ExecutionTargetRow): Capability[];
/**
 * Check if a target has a specific capability.
 */
export declare function targetHasCapability(target: ExecutionTargetRow, capability: Capability): boolean;
/**
 * Create a tmux pane target from legacy pane_index (migration helper).
 * Returns existing target if one already exists for this pane.
 */
export declare function ensureTmuxPaneTarget(db: Database, targetId: string, paneIndex: number): ExecutionTargetRow;
//# sourceMappingURL=execution-target-ops.d.ts.map