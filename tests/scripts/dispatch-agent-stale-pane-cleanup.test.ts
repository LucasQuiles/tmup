import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const DISPATCH_AGENT_SH = path.join(PLUGIN_DIR, 'scripts/dispatch-agent.sh');

describe('dispatch-agent.sh stale pane cleanup', () => {
  let tmpHome: string;
  let sessionName: string;
  let stateDir: string;
  let gridDir: string;
  let gridStatePath: string;
  let fakeBin: string;
  let tmuxStateDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-dispatch-stale-'));
    sessionName = 'test-session';
    stateDir = path.join(tmpHome, '.local/state/tmup', sessionName);
    gridDir = path.join(stateDir, 'grid');
    gridStatePath = path.join(gridDir, 'grid-state.json');
    fakeBin = path.join(tmpHome, 'fakebin');
    tmuxStateDir = path.join(tmpHome, 'tmux-state');

    fs.mkdirSync(gridDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(tmuxStateDir, { recursive: true });

    fs.writeFileSync(
      gridStatePath,
      JSON.stringify({
        panes: [{ index: 1, pane_id: '%1', status: 'available' }],
      }, null, 2)
    );

    writeTmuxStub();
    writeExecutable('sleep', `#!/bin/bash
exit 0
`);
    // flock is Linux-only — stub it for cross-platform tests
    writeExecutable('flock', `#!/bin/bash
exit 0
`);
    writeExecutable('yq', `#!/bin/bash
printf 'null\n'
`);
    writeExecutable('codex', `#!/bin/bash
exit 0
`);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('respawns an available pane before dispatch when tmux still reports a stale agent process', () => {
    execFileSync('bash', [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'Stale pane cleanup verification',
      '--agent-id', 'agent-stale',
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', PLUGIN_DIR,
      '--pane-index', '1',
    ], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const respawnLog = fs.readFileSync(path.join(tmuxStateDir, 'respawn.log'), 'utf-8');
    expect(respawnLog).toContain('-k -t test-session:0.1');

    const state = JSON.parse(fs.readFileSync(gridStatePath, 'utf-8')) as {
      panes: Array<{ index: number; pane_id: string; status: string; role?: string; agent_id?: string }>;
    };
    expect(state.panes[0]).toEqual({
      index: 1,
      pane_id: '%1',
      status: 'reserved',
      role: 'tester',
      agent_id: 'agent-stale',
    });
  });

  function writeTmuxStub(): void {
    const resetMarker = shellQuote(path.join(tmuxStateDir, 'pane-reset'));
    const respawnLog = shellQuote(path.join(tmuxStateDir, 'respawn.log'));
    const sendKeysLog = shellQuote(path.join(tmuxStateDir, 'send-keys.log'));

    writeExecutable('tmux', `#!/bin/bash
set -euo pipefail
cmd="\${1:-}"
shift || true

case "$cmd" in
  display-message)
    if [[ -f ${resetMarker} ]]; then
      printf 'bash\\n'
    else
      printf 'node\\n'
    fi
    ;;
  respawn-pane)
    printf '%s\\n' "$*" >> ${respawnLog}
    touch ${resetMarker}
    ;;
  send-keys)
    printf '%s\\n' "$*" >> ${sendKeysLog}
    ;;
  capture-pane)
    printf 'Working (fake)\\n❯\\n'
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
