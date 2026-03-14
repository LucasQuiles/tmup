/** Well-known capabilities that targets can declare. */
export const KNOWN_CAPABILITIES = [
    'repo_rw', 'test', 'network', 'long_running', 'interactive',
];
/**
 * Create an execution target.
 */
export function createExecutionTarget(db, targetId, input) {
    const capabilities = JSON.stringify(input.capabilities ?? []);
    db.prepare(`
    INSERT INTO execution_targets (id, type, label, pane_index, capabilities)
    VALUES (?, ?, ?, ?, ?)
  `).run(targetId, input.type, input.label ?? null, input.pane_index ?? null, capabilities);
    return db.prepare('SELECT * FROM execution_targets WHERE id = ?').get(targetId);
}
/**
 * Get an execution target by ID.
 */
export function getExecutionTarget(db, targetId) {
    return db.prepare('SELECT * FROM execution_targets WHERE id = ?').get(targetId);
}
/**
 * List execution targets, optionally filtered by type.
 */
export function listExecutionTargets(db, type) {
    if (type) {
        return db.prepare('SELECT * FROM execution_targets WHERE type = ?').all(type);
    }
    return db.prepare('SELECT * FROM execution_targets').all();
}
/**
 * Find a tmux pane target by its pane index (backward compatibility).
 */
export function findTargetByPaneIndex(db, paneIndex) {
    return db.prepare("SELECT * FROM execution_targets WHERE type = 'tmux_pane' AND pane_index = ?").get(paneIndex);
}
/**
 * Get parsed capabilities for a target.
 */
export function getTargetCapabilities(target) {
    try {
        const parsed = JSON.parse(target.capabilities);
        return Array.isArray(parsed) ? parsed.filter((c) => KNOWN_CAPABILITIES.includes(c)) : [];
    }
    catch {
        return [];
    }
}
/**
 * Check if a target has a specific capability.
 */
export function targetHasCapability(target, capability) {
    return getTargetCapabilities(target).includes(capability);
}
/**
 * Create a tmux pane target from legacy pane_index (migration helper).
 * Returns existing target if one already exists for this pane.
 */
export function ensureTmuxPaneTarget(db, targetId, paneIndex) {
    const existing = findTargetByPaneIndex(db, paneIndex);
    if (existing)
        return existing;
    return createExecutionTarget(db, targetId, {
        type: 'tmux_pane',
        label: `pane-${paneIndex}`,
        pane_index: paneIndex,
        capabilities: ['repo_rw', 'test', 'network', 'long_running', 'interactive'],
    });
}
//# sourceMappingURL=execution-target-ops.js.map