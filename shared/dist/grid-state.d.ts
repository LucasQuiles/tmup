export interface GridState {
    schema_version: number;
    session_name: string;
    project_dir: string;
    created_at: string;
    grid: {
        rows: number;
        cols: number;
    };
    panes: Array<{
        index: number;
        pane_id: string;
        status: string;
    }>;
}
/**
 * Read and parse grid-state.json from a session directory.
 * Returns null on ENOENT (grid not yet created) or invalid structure.
 * Propagates warnings for non-ENOENT read failures.
 */
export declare function readGridState(sessionDir: string): GridState | null;
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
export declare function getGridPaneCount(sessionDir?: string): {
    count: number;
    source: 'grid-state' | 'default' | 'default-session-no-grid';
};
//# sourceMappingURL=grid-state.d.ts.map