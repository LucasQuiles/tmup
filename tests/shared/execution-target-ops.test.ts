import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import {
  createExecutionTarget,
  getExecutionTarget,
  listExecutionTargets,
  findTargetByPaneIndex,
  getTargetCapabilities,
  targetHasCapability,
  ensureTmuxPaneTarget,
  KNOWN_CAPABILITIES,
} from '../../shared/src/execution-target-ops.js';
import type { Database, ExecutionTargetRow } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

describe('execution-target-ops', () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  // --- createExecutionTarget ---

  it('creates target with correct type, label, and capabilities', () => {
    const target = createExecutionTarget(db, 'tgt-1', {
      type: 'tmux_pane',
      label: 'my-pane',
      pane_index: 3,
      capabilities: ['repo_rw', 'test'],
    });
    expect(target.id).toBe('tgt-1');
    expect(target.type).toBe('tmux_pane');
    expect(target.label).toBe('my-pane');
    expect(target.pane_index).toBe(3);
    expect(JSON.parse(target.capabilities)).toEqual(['repo_rw', 'test']);
    expect(target.created_at).toBeTruthy();
  });

  it('handles optional fields — null pane_index and null label', () => {
    const target = createExecutionTarget(db, 'tgt-2', {
      type: 'local_shell',
    });
    expect(target.id).toBe('tgt-2');
    expect(target.type).toBe('local_shell');
    expect(target.label).toBeNull();
    expect(target.pane_index).toBeNull();
    expect(JSON.parse(target.capabilities)).toEqual([]);
  });

  it('stores capabilities as JSON string in the row', () => {
    const target = createExecutionTarget(db, 'tgt-3', {
      type: 'codex_cloud',
      capabilities: ['network', 'long_running'],
    });
    expect(typeof target.capabilities).toBe('string');
    expect(JSON.parse(target.capabilities)).toEqual(['network', 'long_running']);
  });

  // --- getExecutionTarget ---

  it('returns target by ID', () => {
    createExecutionTarget(db, 'tgt-10', {
      type: 'tmux_pane',
      label: 'pane-0',
      pane_index: 0,
    });
    const fetched = getExecutionTarget(db, 'tgt-10');
    expect(fetched).not.toBeUndefined();
    expect(fetched!.id).toBe('tgt-10');
    expect(fetched!.type).toBe('tmux_pane');
    expect(fetched!.label).toBe('pane-0');
  });

  it('returns undefined for non-existent ID', () => {
    const result = getExecutionTarget(db, 'does-not-exist');
    expect(result).toBeUndefined();
  });

  // --- listExecutionTargets ---

  it('returns all targets when no type filter', () => {
    createExecutionTarget(db, 'tgt-a', { type: 'tmux_pane', pane_index: 0 });
    createExecutionTarget(db, 'tgt-b', { type: 'local_shell' });
    createExecutionTarget(db, 'tgt-c', { type: 'codex_cloud' });

    const all = listExecutionTargets(db);
    expect(all).toHaveLength(3);
    const ids = all.map(t => t.id).sort();
    expect(ids).toEqual(['tgt-a', 'tgt-b', 'tgt-c']);
  });

  it('filters by type', () => {
    createExecutionTarget(db, 'tgt-a', { type: 'tmux_pane', pane_index: 0 });
    createExecutionTarget(db, 'tgt-b', { type: 'local_shell' });
    createExecutionTarget(db, 'tgt-c', { type: 'tmux_pane', pane_index: 1 });

    const panes = listExecutionTargets(db, 'tmux_pane');
    expect(panes).toHaveLength(2);
    expect(panes.every(t => t.type === 'tmux_pane')).toBe(true);

    const shells = listExecutionTargets(db, 'local_shell');
    expect(shells).toHaveLength(1);
    expect(shells[0].id).toBe('tgt-b');

    const cloud = listExecutionTargets(db, 'codex_cloud');
    expect(cloud).toHaveLength(0);
  });

  it('returns empty array when no targets exist', () => {
    const all = listExecutionTargets(db);
    expect(all).toEqual([]);
  });

  // --- findTargetByPaneIndex ---

  it('finds tmux_pane target by pane index', () => {
    createExecutionTarget(db, 'tgt-p0', { type: 'tmux_pane', pane_index: 0 });
    createExecutionTarget(db, 'tgt-p5', { type: 'tmux_pane', pane_index: 5 });

    const found = findTargetByPaneIndex(db, 5);
    expect(found).not.toBeUndefined();
    expect(found!.id).toBe('tgt-p5');
    expect(found!.pane_index).toBe(5);
  });

  it('returns undefined when no match for pane index', () => {
    createExecutionTarget(db, 'tgt-p0', { type: 'tmux_pane', pane_index: 0 });
    const result = findTargetByPaneIndex(db, 99);
    expect(result).toBeUndefined();
  });

  it('does not match local_shell targets even if they have a pane_index', () => {
    // local_shell with pane_index should not be returned by findTargetByPaneIndex
    createExecutionTarget(db, 'tgt-ls', { type: 'local_shell', pane_index: 7 });
    const result = findTargetByPaneIndex(db, 7);
    expect(result).toBeUndefined();
  });

  // --- getTargetCapabilities ---

  it('parses capabilities JSON correctly', () => {
    const target = createExecutionTarget(db, 'tgt-cap', {
      type: 'tmux_pane',
      pane_index: 0,
      capabilities: ['repo_rw', 'test', 'network'],
    });
    const caps = getTargetCapabilities(target);
    expect(caps).toEqual(['repo_rw', 'test', 'network']);
  });

  it('returns empty array for malformed JSON', () => {
    // Manually insert a row with invalid JSON in capabilities
    db.prepare(`
      INSERT INTO execution_targets (id, type, label, pane_index, capabilities)
      VALUES (?, ?, ?, ?, ?)
    `).run('tgt-bad', 'tmux_pane', null, 0, '{not valid json');

    const row = db.prepare('SELECT * FROM execution_targets WHERE id = ?').get('tgt-bad') as ExecutionTargetRow;
    const caps = getTargetCapabilities(row);
    expect(caps).toEqual([]);
  });

  it('filters out unknown capabilities', () => {
    // Insert a target with a mix of known and unknown capabilities
    db.prepare(`
      INSERT INTO execution_targets (id, type, label, pane_index, capabilities)
      VALUES (?, ?, ?, ?, ?)
    `).run('tgt-mixed', 'local_shell', null, null, JSON.stringify(['repo_rw', 'fly_to_moon', 'test', 'hack_nasa']));

    const row = db.prepare('SELECT * FROM execution_targets WHERE id = ?').get('tgt-mixed') as ExecutionTargetRow;
    const caps = getTargetCapabilities(row);
    expect(caps).toEqual(['repo_rw', 'test']);
  });

  it('returns empty array when capabilities is a JSON object instead of array', () => {
    db.prepare(`
      INSERT INTO execution_targets (id, type, label, pane_index, capabilities)
      VALUES (?, ?, ?, ?, ?)
    `).run('tgt-obj', 'local_shell', null, null, JSON.stringify({ repo_rw: true }));

    const row = db.prepare('SELECT * FROM execution_targets WHERE id = ?').get('tgt-obj') as ExecutionTargetRow;
    const caps = getTargetCapabilities(row);
    expect(caps).toEqual([]);
  });

  it('returns empty array for empty capabilities', () => {
    const target = createExecutionTarget(db, 'tgt-empty', {
      type: 'local_shell',
    });
    const caps = getTargetCapabilities(target);
    expect(caps).toEqual([]);
  });

  // --- targetHasCapability ---

  it('returns true when target has the capability', () => {
    const target = createExecutionTarget(db, 'tgt-has', {
      type: 'tmux_pane',
      pane_index: 0,
      capabilities: ['repo_rw', 'test', 'network'],
    });
    expect(targetHasCapability(target, 'repo_rw')).toBe(true);
    expect(targetHasCapability(target, 'test')).toBe(true);
    expect(targetHasCapability(target, 'network')).toBe(true);
  });

  it('returns false when target lacks the capability', () => {
    const target = createExecutionTarget(db, 'tgt-lack', {
      type: 'local_shell',
      capabilities: ['repo_rw'],
    });
    expect(targetHasCapability(target, 'test')).toBe(false);
    expect(targetHasCapability(target, 'network')).toBe(false);
    expect(targetHasCapability(target, 'long_running')).toBe(false);
    expect(targetHasCapability(target, 'interactive')).toBe(false);
  });

  it('returns false for target with no capabilities', () => {
    const target = createExecutionTarget(db, 'tgt-none', {
      type: 'local_shell',
    });
    expect(targetHasCapability(target, 'repo_rw')).toBe(false);
  });

  // --- ensureTmuxPaneTarget ---

  it('creates new target for new pane', () => {
    const target = ensureTmuxPaneTarget(db, 'tgt-new', 4);
    expect(target.id).toBe('tgt-new');
    expect(target.type).toBe('tmux_pane');
    expect(target.label).toBe('pane-4');
    expect(target.pane_index).toBe(4);

    const caps = getTargetCapabilities(target);
    expect(caps).toEqual(['repo_rw', 'test', 'network', 'long_running', 'interactive']);
  });

  it('returns existing target for existing pane', () => {
    const first = ensureTmuxPaneTarget(db, 'tgt-first', 2);
    const second = ensureTmuxPaneTarget(db, 'tgt-second', 2);

    // Should return the existing one, not create a new one
    expect(second.id).toBe('tgt-first');
    expect(second.pane_index).toBe(2);

    // Should only be one target with pane_index 2
    const all = listExecutionTargets(db, 'tmux_pane');
    const pane2 = all.filter(t => t.pane_index === 2);
    expect(pane2).toHaveLength(1);
  });

  it('creates distinct targets for different pane indices', () => {
    ensureTmuxPaneTarget(db, 'tgt-p0', 0);
    ensureTmuxPaneTarget(db, 'tgt-p1', 1);
    ensureTmuxPaneTarget(db, 'tgt-p2', 2);

    const all = listExecutionTargets(db, 'tmux_pane');
    expect(all).toHaveLength(3);
  });

  // --- KNOWN_CAPABILITIES constant ---

  it('exports the expected set of known capabilities', () => {
    expect(KNOWN_CAPABILITIES).toEqual([
      'repo_rw', 'test', 'network', 'long_running', 'interactive',
    ]);
  });
});
