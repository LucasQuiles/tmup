import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const CONTROL_BOUNDARY = path.join(PLUGIN_DIR, 'scripts/lib/control-boundary.sh');

describe('protected controller boundary', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-control-boundary-')));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it.each(['artifacts', 'locks', 'logs', 'tasks'])(
    'rejects a precreated symlinked %s child before opening artifacts',
    (child) => {
      const sessionDir = path.join(tmpHome, '.local/state/tmup-control/test-session');
      const outside = path.join(tmpHome, `outside-${child}`);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(sessionDir, child), 'dir');

      const result = runShell('tmup_control_prepare_session test-session');

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/symlink/i);
      expect(fs.readdirSync(outside)).toEqual([]);
    },
  );

  it('allows a writable project nested below the plugin root when protected code is not below it', () => {
    const pluginRoot = path.join(tmpHome, 'plugin');
    const nestedProject = path.join(pluginRoot, '.worktrees', 'project');
    const stateDir = path.join(tmpHome, '.local/state/tmup/test-session');
    fs.mkdirSync(nestedProject, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const result = runShell([
      'tmup_control_prepare_session test-session',
      `tmup_control_validate_worker_boundary ${q(nestedProject)} ${q(stateDir)} ${q(pluginRoot)} 0`,
    ].join('\n'));

    expect(result.status).toBe(0);
  });

  it('rejects controller-consumed plugin children while preserving isolated worktrees', () => {
    const pluginRoot = path.join(tmpHome, 'plugin');
    const pluginCli = path.join(pluginRoot, 'cli');
    const stateDir = path.join(tmpHome, '.local/state/tmup/test-session');
    fs.mkdirSync(pluginCli, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const result = runShell([
      'tmup_control_prepare_session test-session',
      `tmup_control_validate_worker_boundary ${q(pluginCli)} ${q(stateDir)} ${q(pluginRoot)} 0`,
    ].join('\n'));

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/controller-consumed plugin subtree/i);
  });

  it('rejects a writable root containing protected control, session, or plugin state', () => {
    const pluginRoot = path.join(tmpHome, 'plugin');
    const stateDir = path.join(tmpHome, '.local/state/tmup/test-session');
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const result = runShell([
      'tmup_control_prepare_session test-session',
      `tmup_control_validate_worker_boundary ${q(tmpHome)} ${q(stateDir)} ${q(pluginRoot)} 0`,
    ].join('\n'));

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/overlaps/i);
  });

  it('rejects sibling controller and session-state roots across sessions', () => {
    const pluginRoot = path.join(tmpHome, 'plugin');
    const stateDir = path.join(tmpHome, '.local/state/tmup/test-session');
    const siblingControl = path.join(tmpHome, '.local/state/tmup-control/other-session/work');
    const siblingState = path.join(tmpHome, '.local/state/tmup/other-session/work');
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(siblingControl, { recursive: true });
    fs.mkdirSync(siblingState, { recursive: true });

    for (const [workingDir, trusted] of [
      [siblingControl, 0],
      [siblingState, 0],
      [siblingState, 1],
    ] as const) {
      const result = runShell([
        'tmup_control_prepare_session test-session',
        `tmup_control_validate_worker_boundary ${q(workingDir)} ${q(stateDir)} ${q(pluginRoot)} ${trusted}`,
      ].join('\n'));

      expect(result.status, workingDir).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`, workingDir).toMatch(/overlaps/i);
    }
  });

  function runShell(body: string) {
    return spawnSync('bash', ['-c', `source ${q(CONTROL_BOUNDARY)}\n${body}`], {
      env: { ...process.env, HOME: tmpHome },
      encoding: 'utf-8',
    });
  }

  function q(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }
});
