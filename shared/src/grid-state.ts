import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PANE_COUNT } from './constants.js';

export interface GridState {
  schema_version: number;
  session_name: string;
  project_dir: string;
  created_at: string;
  grid: { rows: number; cols: number };
  panes: Array<{ index: number; pane_id: string; status: string }>;
}

/**
 * Read and parse grid-state.json from a session directory.
 * Returns null on ENOENT (grid not yet created) or invalid structure.
 * Propagates warnings for non-ENOENT read failures.
 */
export function readGridState(sessionDir: string): GridState | null {
  try {
    const gridPath = path.join(sessionDir, 'grid', 'grid-state.json');
    const raw = fs.readFileSync(gridPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.panes)) {
      return parsed as GridState;
    }
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
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
export function getGridPaneCount(sessionDir?: string): { count: number; source: 'grid-state' | 'default' | 'default-session-no-grid' } {
  if (!sessionDir) {
    return { count: DEFAULT_PANE_COUNT, source: 'default' };
  }
  const gridState = readGridState(sessionDir);
  if (gridState) {
    return { count: gridState.panes.length, source: 'grid-state' };
  }
  return { count: DEFAULT_PANE_COUNT, source: 'default-session-no-grid' };
}
