import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const GRID_TEARDOWN_SH = path.join(PLUGIN_DIR, 'scripts/grid-teardown.sh');

describe('grid-teardown.sh pane cleanup', () => {
  let tmpHome: string;
  let sessionName: string;
  let fakeBin: string;
  let tmuxStateDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-grid-teardown-'));
    sessionName = 'test-session';
    fakeBin = path.join(tmpHome, 'fakebin');
    tmuxStateDir = path.join(tmpHome, 'tmux-state');
    process.env.TMUP_TEST_CONTROLLER_OVERRIDE = '1';
    process.env.TMUP_TEST_CONTROLLER_TOOL_DIRS = fakeBin;

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(tmuxStateDir, { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.local/state/tmup'), { recursive: true });

    fs.writeFileSync(path.join(tmpHome, '.local/state/tmup/current-session'), `${sessionName}\n`);
    writeCompleteReceipt();
    writeTmuxStub();
    writeExecutable('sleep', `#!/bin/bash
exit 0
`);
  });

  afterEach(() => {
    delete process.env.TMUP_TEST_CONTROLLER_OVERRIDE;
    delete process.env.TMUP_TEST_CONTROLLER_TOOL_DIRS;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('respawns panes with stale agent processes before killing the tmux session', () => {
    const controlSession = path.join(tmpHome, '.local/state/tmup-control', sessionName);
    fs.mkdirSync(path.join(controlSession, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(controlSession, 'artifacts', 'stale-prompt.txt'), 'stale\n');

    execFileSync('bash', [GRID_TEARDOWN_SH], {
      env: {
        ...process.env,
        HOME: tmpHome,
        TMUP_SESSION_NAME: sessionName,
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const respawnLog = fs.readFileSync(path.join(tmuxStateDir, 'respawn.log'), 'utf-8');
    expect(respawnLog).toContain('-k -t %1');
    expect(respawnLog).not.toContain('%99');

    const killLog = fs.readFileSync(path.join(tmuxStateDir, 'kill-session.log'), 'utf-8');
    expect(killLog.trim()).toBe('-t $1');
    const targetLog = fs.readFileSync(path.join(tmuxStateDir, 'targets.log'), 'utf-8');
    expect(targetLog).toContain('has-session -t $1');
    expect(targetLog).toContain('list-panes -s -t $1');
    expect(targetLog).not.toContain(' -a ');
    expect(fs.existsSync(path.join(tmpHome, '.local/state/tmup/current-session'))).toBe(false);
    expect(fs.existsSync(controlSession)).toBe(false);
  });

  it('refuses to follow a symlinked controller session during teardown', () => {
    const outside = path.join(tmpHome, 'outside-controller-state');
    const controlRoot = path.join(tmpHome, '.local/state/tmup-control');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(controlRoot, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep\n');
    fs.symlinkSync(outside, path.join(controlRoot, sessionName), 'dir');

    expect(() => execFileSync('bash', [GRID_TEARDOWN_SH], {
      env: {
        ...process.env,
        HOME: tmpHome,
        TMUP_SESSION_NAME: sessionName,
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow();
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf-8')).toBe('keep\n');
  });

  it('retains protected control artifacts when tmux kill fails and the session remains live', () => {
    const controlSession = path.join(tmpHome, '.local/state/tmup-control', sessionName);
    const artifact = path.join(controlSession, 'artifacts', 'active-launcher.sh');
    const taskTemp = path.join(controlSession, 'tasks', 'task-tmp-active');
    const log = path.join(controlSession, 'logs', 'active.log');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.mkdirSync(taskTemp, { recursive: true });
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(artifact, 'active\n');
    fs.writeFileSync(path.join(taskTemp, 'canary'), 'active\n');
    fs.writeFileSync(log, 'active\n');

    expect(() => execFileSync('bash', [GRID_TEARDOWN_SH], {
      env: {
        ...process.env,
        HOME: tmpHome,
        TMUP_SESSION_NAME: sessionName,
        TMUX_FAKE_KILL_FAIL: '1',
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow();

    expect(fs.readFileSync(artifact, 'utf-8')).toBe('active\n');
    expect(fs.readFileSync(path.join(taskTemp, 'canary'), 'utf-8')).toBe('active\n');
    expect(fs.readFileSync(log, 'utf-8')).toBe('active\n');
    expect(fs.readFileSync(path.join(tmpHome, '.local/state/tmup/current-session'), 'utf-8')).toBe(`${sessionName}\n`);
  });

  it('retains protected control artifacts when tmux cannot prove the session is absent', () => {
    const controlSession = path.join(tmpHome, '.local/state/tmup-control', sessionName);
    const artifact = path.join(controlSession, 'artifacts', 'uncertain-launcher.sh');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, 'uncertain\n');

    expect(() => execFileSync('bash', [GRID_TEARDOWN_SH], {
      env: {
        ...process.env,
        HOME: tmpHome,
        TMUP_SESSION_NAME: sessionName,
        TMUX_FAKE_SESSION_UNKNOWN: '1',
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow();

    expect(fs.readFileSync(artifact, 'utf-8')).toBe('uncertain\n');
  });

  it('refuses normal teardown when the identity receipt is missing', () => {
    fs.rmSync(path.join(tmpHome, '.local/state/tmup', sessionName, 'grid-identity.json'));

    expect(() => execFileSync('bash', [GRID_TEARDOWN_SH], {
      env: shellEnv(),
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow(/complete matching live grid receipt/i);

    expect(fs.existsSync(path.join(tmuxStateDir, 'kill-session.log'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.local/state/tmup/current-session'))).toBe(true);
  });

  it('refuses a same-name replacement whose tmux identity no longer matches', () => {
    expect(() => execFileSync('bash', [GRID_TEARDOWN_SH], {
      env: shellEnv({ TMUX_FAKE_SESSION_ID: '$2' }),
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow(/complete matching live grid receipt/i);

    expect(fs.existsSync(path.join(tmuxStateDir, 'kill-session.log'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.local/state/tmup/current-session'))).toBe(true);
  });

  function shellEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: tmpHome,
      TMUP_SESSION_NAME: sessionName,
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      ...extra,
    };
  }

  function writeCompleteReceipt(): void {
    const stateRoot = path.join(tmpHome, '.local/state/tmup');
    const stateDir = path.join(stateRoot, sessionName);
    const projectDir = path.join(tmpHome, 'project');
    fs.mkdirSync(path.join(stateDir, 'grid'), { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tmup.db'), '');
    fs.writeFileSync(path.join(stateDir, 'grid', 'grid-state.json'), JSON.stringify({
      schema_version: 2,
      session_name: sessionName,
      project_dir: projectDir,
      tmux_session_id: '$1',
      tmux_session_created: 1700000001,
      created_at: '2026-01-01T00:00:00Z',
      grid: { rows: 1, cols: 2 },
      panes: [
        { index: 0, pane_id: '%0', status: 'available' },
        { index: 1, pane_id: '%1', status: 'available' },
      ],
    }));
    fs.writeFileSync(path.join(stateDir, 'grid-identity.json'), JSON.stringify({
      grid_id: sessionName,
      creator_pid: 99999999,
      creator_session: 'test',
      created_at: '2026-01-01T00:00:00Z',
      hostname: 'test-host',
    }));
    fs.writeFileSync(path.join(stateRoot, 'registry.json'), JSON.stringify({
      sessions: {
        [sessionName]: {
          session_id: sessionName,
          project_dir: projectDir,
          db_path: path.join(stateDir, 'tmup.db'),
          created_at: '2026-01-01T00:00:00Z',
        },
      },
    }));
  }

  function writeTmuxStub(): void {
    const respawnLog = shellQuote(path.join(tmuxStateDir, 'respawn.log'));
    const killLog = shellQuote(path.join(tmuxStateDir, 'kill-session.log'));
    const killedMarker = shellQuote(path.join(tmuxStateDir, 'killed'));
    const targetsLog = shellQuote(path.join(tmuxStateDir, 'targets.log'));

    writeExecutable('tmux', `#!/bin/bash
set -euo pipefail
cmd="\${1:-}"
shift || true

case "$cmd" in
  display-message)
    target=""; format=""; previous=""
    for argument in "$@"; do
      [[ "$previous" != '-t' ]] || target="$argument"
      [[ "$previous" != '-p' ]] || format="$argument"
      previous="$argument"
    done
    live_id="\${TMUX_FAKE_SESSION_ID:-\\$1}"
    [[ "$target" == '=test-session' || "$target" == "$live_id" ]] || exit 42
    case "$format" in
      '#{session_id}') printf '%s\\n' "$live_id" ;;
      '#{session_name}') printf 'test-session\\n' ;;
      '#{session_created}') printf '1700000001\\n' ;;
      *) exit 43 ;;
    esac
    ;;
  has-session)
    printf 'has-session %s\n' "$*" >> ${targetsLog}
    [[ "$*" == '-t =test-session' || "$*" == '-t $1' ]] || exit 42
    if [[ "\${TMUX_FAKE_SESSION_UNKNOWN:-0}" == "1" ]]; then
      exit 1
    fi
    [[ ! -f ${killedMarker} ]]
    ;;
  list-sessions)
    if [[ "\${TMUX_FAKE_SESSION_UNKNOWN:-0}" == "1" ]]; then
      printf 'permission denied while inspecting tmux socket\n' >&2
      exit 1
    fi
    [[ -f ${killedMarker} ]] || printf 'test-session\n'
    printf 'test-session-long\n'
    ;;
  list-panes)
    printf 'list-panes %s\n' "$*" >> ${targetsLog}
    if [[ "$*" == '-s -t $1 -F #{pane_index} #{pane_id}' ]]; then
      printf '0 %%0\\n'
      printf '1 %%1\\n'
    elif [[ "$*" == '-s -t $1 -F #{pane_id}\\t#{pane_current_command}' ]]; then
      printf '%%0\\tbash\\n'
      printf '%%1\\tnode\\n'
    else
      printf '%%99\\tnode\\n'
    fi
    ;;
  respawn-pane)
    printf '%s\\n' "$*" >> ${respawnLog}
    ;;
  kill-session)
    printf '%s\\n' "$*" >> ${killLog}
    [[ "$*" == '-t $1' || "$*" == '-t =test-session' ]] || exit 42
    if [[ "\${TMUX_FAKE_KILL_FAIL:-0}" == "1" ]]; then
      exit 1
    fi
    touch ${killedMarker}
    ;;
  *)
    printf 'unexpected tmux command: %s\\n' "$cmd" >&2
    exit 1
    ;;
esac
`);
  }

  function writeExecutable(fileName: string, contents: string): void {
    const filePath = path.join(fakeBin, fileName);
    fs.writeFileSync(filePath, contents);
    fs.chmodSync(filePath, 0o755);
  }

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }
});
