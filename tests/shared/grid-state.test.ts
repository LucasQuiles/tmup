import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readGridState, getGridPaneCount } from '../../shared/src/grid-state.js';
import { DEFAULT_PANE_COUNT } from '../../shared/src/constants.js';

describe('grid-state', () => {
  const tmpDirs: string[] = [];

  function makeTmpSessionDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-grid-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  function writeGridState(sessionDir: string, paneCount: number, rows: number, cols: number): void {
    const gridDir = path.join(sessionDir, 'grid');
    fs.mkdirSync(gridDir, { recursive: true });
    const panes = Array.from({ length: paneCount }, (_, i) => ({
      index: i,
      pane_id: `%${i}`,
      status: 'available',
    }));
    const gridState = {
      schema_version: 2,
      session_name: 'test-session',
      project_dir: '/tmp/test',
      created_at: new Date().toISOString(),
      grid: { rows, cols },
      panes,
    };
    fs.writeFileSync(path.join(gridDir, 'grid-state.json'), JSON.stringify(gridState));
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  describe('readGridState', () => {
    it('reads valid grid-state.json', () => {
      const dir = makeTmpSessionDir();
      writeGridState(dir, 8, 2, 4);
      const state = readGridState(dir);
      expect(state).not.toBeNull();
      expect(state!.panes.length).toBe(8);
      expect(state!.grid.rows).toBe(2);
      expect(state!.grid.cols).toBe(4);
    });

    it('returns null for missing grid-state.json (ENOENT)', () => {
      const dir = makeTmpSessionDir();
      const state = readGridState(dir);
      expect(state).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const dir = makeTmpSessionDir();
      const gridDir = path.join(dir, 'grid');
      fs.mkdirSync(gridDir, { recursive: true });
      fs.writeFileSync(path.join(gridDir, 'grid-state.json'), 'not-json');
      const state = readGridState(dir);
      expect(state).toBeNull();
    });

    it('returns null when panes is not an array', () => {
      const dir = makeTmpSessionDir();
      const gridDir = path.join(dir, 'grid');
      fs.mkdirSync(gridDir, { recursive: true });
      fs.writeFileSync(path.join(gridDir, 'grid-state.json'), JSON.stringify({ panes: 'bad' }));
      const state = readGridState(dir);
      expect(state).toBeNull();
    });

    it('reads non-default grid dimensions (3x3)', () => {
      const dir = makeTmpSessionDir();
      writeGridState(dir, 9, 3, 3);
      const state = readGridState(dir);
      expect(state).not.toBeNull();
      expect(state!.panes.length).toBe(9);
      expect(state!.grid.rows).toBe(3);
      expect(state!.grid.cols).toBe(3);
    });

    it('reads single-pane grid (1x1)', () => {
      const dir = makeTmpSessionDir();
      writeGridState(dir, 1, 1, 1);
      const state = readGridState(dir);
      expect(state).not.toBeNull();
      expect(state!.panes.length).toBe(1);
    });
  });

  describe('getGridPaneCount', () => {
    it('returns default when no session dir', () => {
      const result = getGridPaneCount(undefined);
      expect(result.count).toBe(DEFAULT_PANE_COUNT);
      expect(result.source).toBe('default');
    });

    it('returns default-session-no-grid when session dir has no grid state', () => {
      const dir = makeTmpSessionDir();
      const result = getGridPaneCount(dir);
      expect(result.count).toBe(DEFAULT_PANE_COUNT);
      expect(result.source).toBe('default-session-no-grid');
    });

    it.each([
      [8, 2, 4],
      [9, 3, 3],
      [1, 1, 1],
      [4, 1, 4],
    ] as const)('returns pane count %i from grid-state (%ix%i)', (panes, rows, cols) => {
      const dir = makeTmpSessionDir();
      writeGridState(dir, panes, rows, cols);
      const result = getGridPaneCount(dir);
      expect(result.count).toBe(panes);
      expect(result.source).toBe('grid-state');
    });

    it('returns default-session-no-grid when grid-state.json is invalid JSON', () => {
      const dir = makeTmpSessionDir();
      const gridDir = path.join(dir, 'grid');
      fs.mkdirSync(gridDir, { recursive: true });
      fs.writeFileSync(path.join(gridDir, 'grid-state.json'), 'not-json');
      const result = getGridPaneCount(dir);
      expect(result.count).toBe(DEFAULT_PANE_COUNT);
      expect(result.source).toBe('default-session-no-grid');
    });

    it('returns default-session-no-grid when grid-state.json has wrong structure', () => {
      const dir = makeTmpSessionDir();
      const gridDir = path.join(dir, 'grid');
      fs.mkdirSync(gridDir, { recursive: true });
      fs.writeFileSync(path.join(gridDir, 'grid-state.json'), JSON.stringify({ panes: 'bad' }));
      const result = getGridPaneCount(dir);
      expect(result.count).toBe(DEFAULT_PANE_COUNT);
      expect(result.source).toBe('default-session-no-grid');
    });
  });
});
