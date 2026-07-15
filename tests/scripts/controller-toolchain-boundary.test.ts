import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const BOOTSTRAP = path.join(PLUGIN_DIR, 'scripts/lib/controller-bootstrap.sh');
const CONFIG = path.join(PLUGIN_DIR, 'scripts/lib/config.sh');
const DISPATCH = path.join(PLUGIN_DIR, 'scripts/dispatch-agent.sh');
const REPROMPT = path.join(PLUGIN_DIR, 'scripts/reprompt-agent.sh');
const SETUP = path.join(PLUGIN_DIR, 'scripts/grid-setup.sh');
const TEARDOWN = path.join(PLUGIN_DIR, 'scripts/grid-teardown.sh');

describe('trusted controller toolchain boundary', () => {
  let tmpHome: string;
  let repoA: string;
  let repoB: string;
  let poisonBin: string;
  let marker: string;

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-controller-tools-')));
    repoA = path.join(tmpHome, 'repo-a');
    repoB = path.join(tmpHome, 'repo-b');
    poisonBin = path.join(repoA, '.venv/bin');
    marker = path.join(tmpHome, 'poison-executed');
    fs.mkdirSync(poisonBin, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.local/state/tmup'), { recursive: true });
    for (const tool of ['dirname', 'yq', 'tmux']) writeMarkerTool(path.join(poisonBin, tool));
  });

  afterEach(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  it.each([
    ['cross-root', () => poisonBin],
    ['literal glob', () => path.join(tmpHome, '*', '.venv/bin')],
  ])('does not retain %s ambient PATH entries', (_label, pathValue) => {
    const result = runBootstrap(repoB, { PATH: pathValue() });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(repoA);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('fails before config when the requested worker root does not exist', () => {
    const missing = path.join(tmpHome, 'missing-worker');
    const result = spawnSync('/bin/bash', ['-p', DISPATCH,
      '--session', 'test-session', '--role', 'tester', '--prompt', 'x',
      '--agent-id', 'agent-missing-root', '--db-path', path.join(tmpHome, 'tmup.db'),
      '--working-dir', missing,
    ], { env: { ...process.env, HOME: tmpHome, PATH: poisonBin }, encoding: 'utf-8' });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/working-dir.*absolute existing/i);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('rejects a test tool whose final symlink target enters the worker root', () => {
    const toolDir = path.join(tmpHome, 'controller-tools');
    const evilYq = path.join(repoB, 'evil-yq');
    fs.mkdirSync(toolDir);
    writeMarkerTool(evilYq);
    fs.symlinkSync(evilYq, path.join(toolDir, 'yq'));

    const result = runBootstrap(repoB, {
      TMUP_TEST_CONTROLLER_OVERRIDE: '1',
      TMUP_TEST_CONTROLLER_TOOL_DIRS: toolDir,
    });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    'bash',
    'basename',
    'du',
    'git',
    'gnome-terminal',
    'id',
    'node',
    'od',
    'realpath',
    'wc',
  ])('rejects an audited %s executable whose final target enters the worker root', (tool) => {
    const toolDir = path.join(tmpHome, `controller-tools-${tool}`);
    const workerTool = path.join(repoB, `worker-${tool}`);
    fs.mkdirSync(toolDir);
    writeMarkerTool(workerTool);
    fs.symlinkSync(workerTool, path.join(toolDir, tool));

    const result = runBootstrap(repoB, {
      TMUP_TEST_CONTROLLER_OVERRIDE: '1',
      TMUP_TEST_CONTROLLER_TOOL_DIRS: toolDir,
    });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('rejects ambient test-tool overrides outside a Vitest worker parent', () => {
    const toolDir = path.join(tmpHome, 'ambient-controller-tools');
    fs.mkdirSync(toolDir);
    writeMarkerTool(path.join(toolDir, 'yq'));
    const inner = [
      'set -euo pipefail',
      `source ${q(BOOTSTRAP)}`,
      `tmup_controller_establish_toolchain ${q(repoB)} ${q(PLUGIN_DIR)}`,
    ].join('\n');

    const outer = `/bin/bash -p -c ${q(inner)}; status=$?; :; exit $status`;
    const result = spawnSync('/bin/bash', ['-p', '-c', outer], {
      env: {
        ...process.env,
        HOME: tmpHome,
        TMUP_TEST_CONTROLLER_OVERRIDE: '1',
        TMUP_TEST_CONTROLLER_TOOL_DIRS: toolDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('ignores an inherited internal test-tool directory without the public gate', () => {
    const toolDir = path.join(tmpHome, 'internal-bypass-tools');
    fs.mkdirSync(toolDir);
    writeMarkerTool(path.join(toolDir, 'yq'));

    const result = runBootstrap(repoB, {
      _TMUP_CONTROLLER_TEST_DIR_PHYSICAL: toolDir,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(toolDir);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('supports a second controller validation after config loads shared state-root helpers', () => {
    const result = spawnSync('/bin/bash', ['-p', '-c', [
      'set -euo pipefail',
      `source ${q(BOOTSTRAP)}`,
      `tmup_controller_establish_toolchain ${q(repoB)} ${q(PLUGIN_DIR)}`,
      `source ${q(CONFIG)}`,
      `tmup_controller_establish_toolchain ${q(repoB)} ${q(PLUGIN_DIR)}`,
    ].join('\n')], {
      env: { ...process.env, HOME: tmpHome },
      encoding: 'utf-8',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it.each([
    ['reprompt', REPROMPT, ['--session', 'boundary-session', '--pane', '0', '--prompt', 'x']],
    ['teardown', TEARDOWN, ['--force']],
  ])('%s ignores poisoned ambient dirname/yq/tmux', (_name, script, args) => {
    const result = spawnSync('/bin/bash', ['-p', script, ...args], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PATH: poisonBin,
        TMUP_SESSION_NAME: 'boundary-session',
      },
      encoding: 'utf-8',
    });

    expect(result.status === 0 || result.status === 1).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('grid setup ignores poisoned ambient dirname/yq/tmux', () => {
    const installedAgents = path.join(tmpHome, '.codex/agents');
    fs.mkdirSync(installedAgents, { recursive: true });
    fs.writeFileSync(path.join(installedAgents, 'tmup-tier1.toml'), 'disabled fixture\n');
    const result = spawnSync('/bin/bash', ['-p', SETUP,
      '--project-dir', repoB,
      '--session', 'boundary-session',
    ], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PATH: poisonBin,
      },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  function runBootstrap(workerRoot: string, extraEnv: NodeJS.ProcessEnv = {}) {
    return spawnSync('/bin/bash', ['-p', '-c', [
      'set -euo pipefail',
      `source ${q(BOOTSTRAP)}`,
      `tmup_controller_establish_toolchain ${q(workerRoot)} ${q(PLUGIN_DIR)}`,
      'printf "%s\\n" "$PATH"',
    ].join('\n')], {
      env: { ...process.env, HOME: tmpHome, ...extraEnv },
      encoding: 'utf-8',
    });
  }

  function writeMarkerTool(file: string): void {
    fs.writeFileSync(file, `#!/bin/bash\nprintf 'executed\\n' >> ${q(marker)}\nexit 99\n`);
    fs.chmodSync(file, 0o755);
  }

  function q(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }
});
