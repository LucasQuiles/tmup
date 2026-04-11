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

  it('falls back to $HOME/.claude/plugins/sdlc-os when SDLC_OS_PLUGIN is unset', () => {
    // Build the fake plugin tree at the parameter-expansion default path.
    // dispatch-agent.sh uses ${SDLC_OS_PLUGIN:-$HOME/.claude/plugins/sdlc-os},
    // so with HOME=$tmpHome and SDLC_OS_PLUGIN deleted from the env, the
    // clone-manager resolves to $tmpHome/.claude/plugins/sdlc-os/colony/clone-manager.sh.
    const homePluginDir = path.join(tmpHome, '.claude/plugins/sdlc-os/colony');
    fs.mkdirSync(homePluginDir, { recursive: true });

    const callLogHome = path.join(tmuxStateDir, 'clone-manager-home.log');
    const callLogHomeQuoted = shellQuote(callLogHome);
    fs.writeFileSync(
      path.join(homePluginDir, 'clone-manager.sh'),
      `#!/bin/bash
colony_clone_create() {
  local src="$1" session="$2" agent_id="$3"
  local dst="${cloneRoot}/\${session}-\${agent_id}-home"
  mkdir -p "$dst"
  echo "create src=$src session=$session agent=$agent_id dst=$dst" >> ${callLogHomeQuoted}
  echo "$dst"
}
colony_clone_verify() {
  local dst="$1"
  echo "verify $dst" >> ${callLogHomeQuoted}
  [[ -d "$dst" ]]
}
`
    );

    // Construct an env that OMITS SDLC_OS_PLUGIN entirely. Setting it to
    // `undefined` serializes as the literal string "undefined" in some
    // environments; `delete` is the only portable way to unset.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmpHome,
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    };
    delete env.SDLC_OS_PLUGIN;

    const output = execFileSync('bash', [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'HOME fallback verification',
      '--agent-id', 'agent-home',
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', PLUGIN_DIR,
      '--pane-index', '1',
      '--clone-isolation',
    ], {
      env,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // CLONE_DIR was emitted from the HOME-fallback clone-manager
    expect(output).toMatch(/^CLONE_DIR=.+-home$/m);
    const cloneMatch = output.match(/^CLONE_DIR=(.+)$/m);
    expect(cloneMatch).not.toBeNull();
    expect(cloneMatch![1]).toContain(cloneRoot);
    expect(cloneMatch![1]).toContain('agent-home');

    // The HOME-fallback clone-manager's call log exists and records both ops
    expect(fs.existsSync(callLogHome)).toBe(true);
    const homeLog = fs.readFileSync(callLogHome, 'utf-8');
    expect(homeLog).toContain('create src=');
    expect(homeLog).toContain(`session=${sessionName}`);
    expect(homeLog).toContain('agent=agent-home');
    expect(homeLog).toContain('verify ');

    // The SDLC_OS_PLUGIN-pointed call log from beforeEach was NOT touched
    expect(fs.existsSync(path.join(tmuxStateDir, 'clone-manager.log'))).toBe(false);
  });

  it('fails closed when colony_clone_create exits non-zero', () => {
    // Overwrite beforeEach's clone-manager with a create-fails variant.
    // Verify is still defined but must never run.
    const callLogFailCreate = shellQuote(path.join(tmuxStateDir, 'clone-manager-fail-create.log'));
    fs.writeFileSync(
      path.join(sdlcOsPlugin, 'colony/clone-manager.sh'),
      `#!/bin/bash
colony_clone_create() {
  echo "create called and failing" >> ${callLogFailCreate}
  return 1
}
colony_clone_verify() {
  echo "verify should never run" >> ${callLogFailCreate}
  return 0
}
`
    );

    let failure: { status?: number; stderr?: Buffer | string } | undefined;
    try {
      execFileSync('bash', [
        DISPATCH_AGENT_SH,
        '--session', sessionName,
        '--role', 'tester',
        '--prompt', 'create failure',
        '--agent-id', 'agent-fail-create',
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
    const stderr = String(failure?.stderr ?? '');
    expect(stderr).toContain('Failed to create isolated clone');
    // Must die BEFORE the verify step — guard against the wrong die firing
    expect(stderr).not.toContain('Clone verification failed');

    // Log shows create was called; verify was NOT
    const log = fs.readFileSync(path.join(tmuxStateDir, 'clone-manager-fail-create.log'), 'utf-8');
    expect(log).toContain('create called and failing');
    expect(log).not.toContain('verify should never run');
  });

  it('fails closed when colony_clone_verify exits non-zero after a successful create', () => {
    // Overwrite beforeEach's clone-manager with a verify-fails variant.
    // Create succeeds normally so the dispatcher reaches the verify step.
    const callLogFailVerify = shellQuote(path.join(tmuxStateDir, 'clone-manager-fail-verify.log'));
    fs.writeFileSync(
      path.join(sdlcOsPlugin, 'colony/clone-manager.sh'),
      `#!/bin/bash
colony_clone_create() {
  local src="$1" session="$2" agent_id="$3"
  local dst="${cloneRoot}/\${session}-\${agent_id}-verify-fail"
  mkdir -p "$dst"
  echo "create ok src=$src dst=$dst" >> ${callLogFailVerify}
  echo "$dst"
}
colony_clone_verify() {
  echo "verify failing for $1" >> ${callLogFailVerify}
  return 1
}
`
    );

    let failure: { status?: number; stderr?: Buffer | string } | undefined;
    try {
      execFileSync('bash', [
        DISPATCH_AGENT_SH,
        '--session', sessionName,
        '--role', 'tester',
        '--prompt', 'verify failure',
        '--agent-id', 'agent-fail-verify',
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
    const stderr = String(failure?.stderr ?? '');
    expect(stderr).toContain('Clone verification failed');
    // Must NOT report create failure — the die fires at the correct step
    expect(stderr).not.toContain('Failed to create isolated clone');

    // Log shows BOTH create and verify ran (proves the dispatcher reached verify)
    const log = fs.readFileSync(path.join(tmuxStateDir, 'clone-manager-fail-verify.log'), 'utf-8');
    expect(log).toContain('create ok src=');
    expect(log).toContain('verify failing for');
  });

  it('fails closed when colony_clone_create exits 0 but emits nothing to stdout', () => {
    // Defensive guard against the latent fail-open hole: if a
    // (buggy / future-refactored / third-party-shimmed) clone-manager exits
    // zero but emits empty stdout, WORKING_DIR would be the empty string
    // and control would fall through to colony_clone_verify. The dispatcher
    // must now short-circuit with an explicit named error that blames the
    // real culprit (colony_clone_create), not the downstream verify step.
    const callLogSilent = shellQuote(path.join(tmuxStateDir, 'clone-manager-silent.log'));
    fs.writeFileSync(
      path.join(sdlcOsPlugin, 'colony/clone-manager.sh'),
      `#!/bin/bash
colony_clone_create() {
  echo "create exited 0 with empty stdout" >> ${callLogSilent}
  return 0
}
colony_clone_verify() {
  echo "verify should never run" >> ${callLogSilent}
  return 0
}
`
    );

    let failure: { status?: number; stderr?: Buffer | string } | undefined;
    try {
      execFileSync('bash', [
        DISPATCH_AGENT_SH,
        '--session', sessionName,
        '--role', 'tester',
        '--prompt', 'empty stdout guard verification',
        '--agent-id', 'agent-silent-create',
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
    const stderr = String(failure?.stderr ?? '');

    // The new explicit guard fires with a message that names the real culprit.
    // Message is "empty or whitespace-only" so it covers both the empty-stdout
    // case (this test) and the whitespace-only case (next test).
    expect(stderr).toContain('colony_clone_create returned empty or whitespace-only clone path');

    // Negative guards: downstream error paths must NOT be reached
    expect(stderr).not.toContain('Clone verification failed');
    expect(stderr).not.toContain('Failed to create isolated clone');
    expect(stderr).not.toContain('colony_clone_verify: clone_dir required');

    // Log shows create was called; verify was never reached
    const log = fs.readFileSync(path.join(tmuxStateDir, 'clone-manager-silent.log'), 'utf-8');
    expect(log).toContain('create exited 0 with empty stdout');
    expect(log).not.toContain('verify should never run');
  });

  it('fails closed when colony_clone_create exits 0 but emits whitespace-only stdout', () => {
    // Tighter guard on the same fail-open path: whitespace-only output also
    // bypasses a naive `[[ -n "$WORKING_DIR" ]]` check. The upgraded guard
    // uses `${WORKING_DIR//[[:space:]]/}` to strip all whitespace characters
    // (space, tab, newline) before the non-empty check. A clone-manager that
    // emits only spaces must still fail closed with the explicit named error.
    const callLogWs = shellQuote(path.join(tmuxStateDir, 'clone-manager-whitespace.log'));
    fs.writeFileSync(
      path.join(sdlcOsPlugin, 'colony/clone-manager.sh'),
      `#!/bin/bash
colony_clone_create() {
  echo "create emitted whitespace-only stdout" >> ${callLogWs}
  # Three literal spaces, then newline. Command substitution strips the
  # trailing newline; the surviving value is three spaces.
  echo "   "
  return 0
}
colony_clone_verify() {
  echo "verify should never run" >> ${callLogWs}
  return 0
}
`
    );

    let failure: { status?: number; stderr?: Buffer | string } | undefined;
    try {
      execFileSync('bash', [
        DISPATCH_AGENT_SH,
        '--session', sessionName,
        '--role', 'tester',
        '--prompt', 'whitespace-only stdout guard verification',
        '--agent-id', 'agent-ws-create',
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
    const stderr = String(failure?.stderr ?? '');
    expect(stderr).toContain('colony_clone_create returned empty or whitespace-only clone path');
    expect(stderr).not.toContain('Clone verification failed');
    expect(stderr).not.toContain('Failed to create isolated clone');

    const log = fs.readFileSync(path.join(tmuxStateDir, 'clone-manager-whitespace.log'), 'utf-8');
    expect(log).toContain('create emitted whitespace-only stdout');
    expect(log).not.toContain('verify should never run');
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
