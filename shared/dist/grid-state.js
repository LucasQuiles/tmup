import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PANE_COUNT } from './constants.js';
/**
 * Read and parse grid-state.json from a session directory.
 * Returns null on ENOENT (grid not yet created) or invalid structure.
 * Propagates warnings for non-ENOENT read failures.
 */
export function readGridState(sessionDir) {
    try {
        const gridPath = path.join(sessionDir, 'grid', 'grid-state.json');
        const raw = fs.readFileSync(gridPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.panes)) {
            return parsed;
        }
        return null;
    }
    catch (err) {
        const code = err.code;
        if (code !== 'ENOENT') {
            console.error(`[tmup] Warning: failed to read grid state: ${err instanceof Error ? err.message : String(err)}`);
        }
        return null;
    }
}
/**
 * Resolve total pane count from grid-state.json if available, otherwise use default.
 * Accepts a session directory path (not a session ID) so both MCP and CLI can use it.
 *
 * Returns `source`:
 * - 'grid-state': read from grid-state.json (authoritative)
 * - 'default': no session dir provided
 * - 'default-session-no-grid': session dir exists but grid state not found or unreadable
 *   (callers should use DEFAULT_PANE_COUNT as fallback but may enforce stricter validation)
 */
export function getGridPaneCount(sessionDir) {
    if (!sessionDir) {
        return { count: DEFAULT_PANE_COUNT, source: 'default' };
    }
    const gridState = readGridState(sessionDir);
    if (gridState) {
        return { count: gridState.panes.length, source: 'grid-state' };
    }
    return { count: DEFAULT_PANE_COUNT, source: 'default-session-no-grid' };
}
/**
 * Validate that a pane index corresponds to a real pane in the live grid.
 * Prefers grid-state.json as authoritative (checks specific index existence,
 * supports non-contiguous/sparse grids), falls back to count-based range check
 * against DEFAULT_PANE_COUNT when no grid state is available.
 *
 * Matches the semantics of scripts/lib/validators.sh:validate_pane_index so
 * shell and TypeScript entry points agree on what "valid" means.
 */
export function validatePaneIndexExists(sessionDir, paneIndex) {
    if (!Number.isInteger(paneIndex) || paneIndex < 0) {
        return { valid: false, reason: `pane_index must be a non-negative integer, got: ${paneIndex}` };
    }
    if (sessionDir) {
        const grid = readGridState(sessionDir);
        if (grid && Array.isArray(grid.panes) && grid.panes.length > 0) {
            const found = grid.panes.some(p => p.index === paneIndex);
            if (found)
                return { valid: true };
            return {
                valid: false,
                reason: `pane_index ${paneIndex} not in live grid`,
                validIndexes: grid.panes.map(p => p.index).sort((a, b) => a - b),
            };
        }
    }
    // No grid state — fall back to default count range
    if (paneIndex >= DEFAULT_PANE_COUNT) {
        return {
            valid: false,
            reason: `pane_index ${paneIndex} out of range (max ${DEFAULT_PANE_COUNT - 1}, source: default)`,
        };
    }
    return { valid: true };
}
//# sourceMappingURL=grid-state.js.map