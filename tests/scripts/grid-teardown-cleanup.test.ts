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

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(tmuxStateDir, { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.local/state/tmup'), { recursive: true });

    fs.writeFileSync(path.join(tmpHome, '.local/state/tmup/current-session'), `${sessionName}\n`);
    writeTmuxStub();
    writeExecutable('sleep', `#!/bin/bash
exit 0
`);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('respawns panes with stale agent processes before killing the tmux session', () => {
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
    expect(respawnLog).toContain('-k -t test-session:0.1');

    const killLog = fs.readFileSync(path.join(tmuxStateDir, 'kill-session.log'), 'utf-8');
    expect(killLog).toContain('-t test-session');
    expect(fs.existsSync(path.join(tmpHome, '.local/state/tmup/current-session'))).toBe(false);
  });

  function writeTmuxStub(): void {
    const respawnLog = shellQuote(path.join(tmuxStateDir, 'respawn.log'));
    const killLog = shellQuote(path.join(tmuxStateDir, 'kill-session.log'));

    writeExecutable('tmux', `#!/bin/bash
set -euo pipefail
cmd="\${1:-}"
shift || true

case "$cmd" in
  has-session)
    exit 0
    ;;
  list-panes)
    printf 'test-session:0.0\\tbash\\n'
    printf 'test-session:0.1\\tnode\\n'
    ;;
  respawn-pane)
    printf '%s\\n' "$*" >> ${respawnLog}
    ;;
  kill-session)
    printf '%s\\n' "$*" >> ${killLog}
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
