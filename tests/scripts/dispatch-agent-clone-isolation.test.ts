import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const DISPATCH_AGENT_SH = path.join(PLUGIN_DIR, 'scripts/dispatch-agent.sh');

describe('dispatch-agent.sh clone isolation', () => {
  let tmpHome: string;
  let sessionName: string;
  let stateDir: string;
  let gridDir: string;
  let fakeBin: string;
  let tmuxStateDir: string;
  let sdlcOsPlugin: string;
  let cloneRoot: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-clone-iso-'));
    sessionName = 'test-session';
    stateDir = path.join(tmpHome, '.local/state/tmup', sessionName);
    gridDir = path.join(stateDir, 'grid');
    fakeBin = path.join(tmpHome, 'fakebin');
    tmuxStateDir = path.join(tmpHome, 'tmux-state');
    sdlcOsPlugin = path.join(tmpHome, 'fake-sdlc-os');
    cloneRoot = path.join(tmpHome, 'clones');

    fs.mkdirSync(gridDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(tmuxStateDir, { recursive: true });
    fs.mkdirSync(path.join(sdlcOsPlugin, 'colony'), { recursive: true });
    fs.mkdirSync(cloneRoot, { recursive: true });

    fs.writeFileSync(
      path.join(gridDir, 'grid-state.json'),
      JSON.stringify({
        panes: [{ index: 1, pane_id: '%1', status: 'available' }],
      }, null, 2)
    );

    // Fake sdlc-os clone-manager.sh — creates a tmpdir per call and logs invocations
    const callLog = path.join(tmuxStateDir, 'clone-manager.log');
    const cloneRootQuoted = shellQuote(cloneRoot);
    const callLogQuoted = shellQuote(callLog);
    fs.writeFileSync(
      path.join(sdlcOsPlugin, 'colony/clone-manager.sh'),
      `#!/bin/bash
# Fake colony clone manager for tests
colony_clone_create() {
  local src="$1" session="$2" agent_id="$3"
  local dst="${cloneRoot}/\${session}-\${agent_id}"
  mkdir -p "$dst"
  echo "create src=$src session=$session agent=$agent_id dst=$dst" >> ${callLogQuoted}
  echo "$dst"
}
colony_clone_verify() {
  local dst="$1"
  echo "verify $dst" >> ${callLogQuoted}
  [[ -d "$dst" ]]
}
`
    );

    writeTmuxStub();
    writeExecutable('sleep', '#!/bin/bash\nexit 0\n');
    writeExecutable('flock', '#!/bin/bash\nexit 0\n');
    writeExecutable('yq', "#!/bin/bash\nprintf 'null\\n'\n");
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('sources clone-manager.sh and emits CLONE_DIR with rewritten working dir', () => {
    const output = execFileSync('bash', [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'Clone isolation verification',
      '--agent-id', 'agent-clone',
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', PLUGIN_DIR,
      '--pane-index', '1',
      '--clone-isolation',
    ], {
      env: {
        ...process.env,
        HOME: tmpHome,
        SDLC_OS_PLUGIN: sdlcOsPlugin,
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // F1a: dispatch-agent.sh emits structured CLONE_DIR=<path>
    expect(output).toMatch(/^CLONE_DIR=.+$/m);
    const cloneMatch = output.match(/^CLONE_DIR=(.+)$/m);
    expect(cloneMatch).not.toBeNull();
    const emittedClonePath = cloneMatch![1].trim();
    expect(emittedClonePath).toContain(cloneRoot);
    expect(emittedClonePath).toContain(sessionName);
    expect(emittedClonePath).toContain('agent-clone');

    // Clone directory was actually created by the fake manager
    expect(fs.existsSync(emittedClonePath)).toBe(true);

    // Verify colony_clone_create and colony_clone_verify were both called
    const callLog = fs.readFileSync(path.join(tmuxStateDir, 'clone-manager.log'), 'utf-8');
    expect(callLog).toContain('create src=');
    expect(callLog).toContain(`session=${sessionName}`);
    expect(callLog).toContain('agent=agent-clone');
    expect(callLog).toContain('verify ');

    // Dispatch reserved the pane with agent metadata
    const gridState = JSON.parse(fs.readFileSync(path.join(gridDir, 'grid-state.json'), 'utf-8'));
    expect(gridState.panes[0].role).toBe('tester');
    expect(gridState.panes[0].agent_id).toBe('agent-clone');
  });

  it('fails closed when clone-manager.sh is missing', () => {
    fs.rmSync(path.join(sdlcOsPlugin, 'colony/clone-manager.sh'));

    let failure: { status?: number; stderr?: Buffer | string } | undefined;
    try {
      execFileSync('bash', [
        DISPATCH_AGENT_SH,
        '--session', sessionName,
        '--role', 'tester',
        '--prompt', 'Clone isolation verification',
        '--agent-id', 'agent-missing-manager',
        '--db-path', path.join(stateDir, 'tmup.db'),
        '--working-dir', PLUGIN_DIR,
        '--pane-index', '1',
        '--clone-isolation',
      ], {
        env: {
          ...process.env,
          HOME: tmpHome,
          SDLC_OS_PLUGIN: sdlcOsPlugin,
          PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        },
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).not.toBe(0);
    expect(String(failure?.stderr ?? '')).toContain('clone-manager.sh not found');
  });

  it('does not emit CLONE_DIR when --clone-isolation flag is omitted', () => {
    const output = execFileSync('bash', [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'No clone isolation',
      '--agent-id', 'agent-no-clone',
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', PLUGIN_DIR,
      '--pane-index', '1',
    ], {
      env: {
        ...process.env,
        HOME: tmpHome,
        SDLC_OS_PLUGIN: sdlcOsPlugin,
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(output).not.toMatch(/^CLONE_DIR=/m);
    expect(fs.existsSync(path.join(tmuxStateDir, 'clone-manager.log'))).toBe(false);
  });

  function writeTmuxStub(): void {
    const sendKeysLog = shellQuote(path.join(tmuxStateDir, 'send-keys.log'));
    writeExecutable('tmux', `#!/bin/bash
set -euo pipefail
cmd="\${1:-}"
shift || true

case "$cmd" in
  display-message)
    printf 'bash\\n'
    ;;
  send-keys)
    printf '%s\\n' "$*" >> ${sendKeysLog}
    ;;
  capture-pane)
    printf 'Working (fake)\\n\u276f\\n'
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
