import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const DISPATCH_AGENT_SH = path.join(PLUGIN_DIR, 'scripts/dispatch-agent.sh');

type PaneState = {
  index: number;
  pane_id: string;
  status: string;
  role?: string;
  agent_id?: string;
};

describe('dispatch-agent.sh trap cleanup', () => {
  let tmpHome: string;
  let sessionName: string;
  let stateDir: string;
  let gridDir: string;
  let gridStatePath: string;
  let fakeBin: string;
  let tmuxStateDir: string;
  let workingDir: string;
  let controlArtifactDir: string;
  let spawnedChildren: ChildProcess[];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-dispatch-trap-'));
    sessionName = 'test-session';
    stateDir = path.join(tmpHome, '.local/state/tmup', sessionName);
    gridDir = path.join(stateDir, 'grid');
    gridStatePath = path.join(gridDir, 'grid-state.json');
    fakeBin = path.join(tmpHome, 'fakebin');
    tmuxStateDir = path.join(tmpHome, 'tmux-state');
    workingDir = path.join(tmpHome, 'workspace');
    controlArtifactDir = path.join(
      tmpHome,
      '.local/state/tmup-control',
      sessionName,
      'artifacts',
    );
    spawnedChildren = [];
    process.env.TMUP_TEST_CONTROLLER_OVERRIDE = '1';
    process.env.TMUP_TEST_CONTROLLER_TOOL_DIRS = fakeBin;

    fs.mkdirSync(gridDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(tmuxStateDir, { recursive: true });
    fs.mkdirSync(workingDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tmup.db'), '');

    writeExecutable('flock', `#!/bin/bash
if [[ "\${TMUX_FAKE_FLOCK_FAIL_FD8:-0}" == "1" && "\${*: -1}" == "8" ]]; then
  exit 57
fi
exit 0
`);
    writeExecutable('ps', "#!/bin/bash\nprintf '100 1 100 100 S /bin/bash\\n'\n");
    writeExecutable('sleep', '#!/bin/bash\nexit 0\n');
    writeExecutable('yq', '#!/bin/bash\nprintf \'null\\n\'\n');
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');

    for (const commandName of [
      'awk',
      'cat',
      'chmod',
      'dirname',
      'grep',
      'jq',
      'mktemp',
      'mv',
      'perl',
      'rm',
      'sed',
      'tail',
      'touch',
    ]) {
      linkSystemBinary(commandName);
    }

    writeGridState([
      { index: 1, pane_id: '%1', status: 'available' },
    ]);
  });

  afterEach(async () => {
    delete process.env.TMUP_TEST_CONTROLLER_OVERRIDE;
    delete process.env.TMUP_TEST_CONTROLLER_TOOL_DIRS;
    for (const child of spawnedChildren) {
      await terminateProcessGroup(child);
    }
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('uses the EXIT trap to release reservations and remove temp files on pre-commit failure', () => {
    writeTmuxStub();
    writeFailingSleepStub();

    const agentId = 'agent-exit';
    const promptPath = promptFilePath(agentId);
    const launcherPath = launcherFilePath(agentId);

    let failure: { status?: number } | undefined;
    try {
      execFileSync('bash', dispatchArgs(agentId), {
        env: shellEnv(),
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(42);
    expect(fs.existsSync(promptPath)).toBe(false);
    expect(fs.existsSync(launcherPath)).toBe(false);
    expect(readPaneState()).toEqual({
      index: 1,
      pane_id: '%1',
      status: 'available',
    });
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'releases reservations and removes temp files on %s before dispatch commit',
    async (signalName, expectedExitCode) => {
      writeTmuxStub();

      const agentId = signalName === 'SIGINT' ? 'agent-int' : 'agent-term';
      const promptPath = promptFilePath(agentId);
      const launcherPath = launcherFilePath(agentId);

      const child = spawn('bash', dispatchArgs(agentId), {
        env: shellEnv({ TMUX_FAKE_BLOCK_LAUNCH: '1' }),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      spawnedChildren.push(child);

      await waitForFile(path.join(tmuxStateDir, 'launch-blocked'));

      expect(fs.existsSync(promptPath)).toBe(true);
      expect(fs.existsSync(launcherPath)).toBe(true);
      expect(fs.statSync(promptPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(launcherPath).mode & 0o777).toBe(0o700);
      expect(readPaneState()).toEqual({
        index: 1,
        pane_id: '%1',
        status: 'reserved',
        role: 'tester',
        agent_id: agentId,
      });

      process.kill(-child.pid!, signalName);

      const [exitCode, exitSignal] = await once(child, 'exit') as [
        number | null,
        NodeJS.Signals | null,
      ];

      expect(exitCode).toBe(expectedExitCode);
      expect(exitSignal).toBeNull();
      expect(fs.existsSync(promptPath)).toBe(false);
      expect(fs.existsSync(launcherPath)).toBe(false);
      expect(readPaneState()).toEqual({
        index: 1,
        pane_id: '%1',
        status: 'available',
      });
    },
    30000,
  );

  it('rolls back a signal delivered immediately after a successful asynchronous launch send', () => {
    writeTmuxStub();
    const agentId = 'agent-post-send-signal';

    let failure: { status?: number; stdout?: Buffer | string } | undefined;
    try {
      execFileSync('bash', dispatchArgs(agentId), {
        env: shellEnv({ TMUP_TEST_SIGNAL_AFTER_LAUNCH_SEND: '1' }),
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(143);
    expect(String(failure?.stdout ?? '')).toContain('TMUP_DISPATCH_ROLLBACK=released');
    expect(fs.existsSync(promptFilePath(agentId))).toBe(false);
    expect(fs.existsSync(launcherFilePath(agentId))).toBe(false);
    expect(readPaneState()).toEqual({ index: 1, pane_id: '%1', status: 'available' });
  });

  it('retains reservation and recovery artifacts when launch delivery is ambiguous and respawn fails', () => {
    writeTmuxStub();
    const agentId = 'agent-ambiguous-send';

    let failure: { status?: number; stdout?: Buffer | string; stderr?: Buffer | string } | undefined;
    try {
      execFileSync('bash', dispatchArgs(agentId), {
        env: shellEnv({ TMUX_FAKE_LAUNCH_FAIL: '1', TMUX_FAKE_RESPAWN_FAIL: '1' }),
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain('delivery is ambiguous');
    expect(String(failure?.stdout ?? '')).toContain('TMUP_DISPATCH_ROLLBACK=retained');
    expect(fs.existsSync(promptFilePath(agentId))).toBe(true);
    expect(fs.existsSync(launcherFilePath(agentId))).toBe(true);
    const taskRoot = path.join(tmpHome, '.local/state/tmup-control', sessionName, 'tasks');
    expect(fs.readdirSync(taskRoot).some((entry) => entry.startsWith('task-tmp-1-'))).toBe(true);
    expect(readPaneState()).toEqual({
      index: 1,
      pane_id: '%1',
      status: 'reserved',
      role: 'tester',
      agent_id: agentId,
    });
  });

  it('retains recovery artifacts when pane stop succeeds but reservation release cannot lock state', () => {
    writeTmuxStub();
    const agentId = 'agent-release-lock-fail';

    let failure: { status?: number; stdout?: Buffer | string; stderr?: Buffer | string } | undefined;
    try {
      execFileSync('bash', dispatchArgs(agentId), {
        env: shellEnv({ TMUX_FAKE_LAUNCH_FAIL: '1', TMUX_FAKE_FLOCK_FAIL_FD8: '1' }),
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stdout ?? '')).toContain('TMUP_DISPATCH_ROLLBACK=retained');
    expect(String(failure?.stderr ?? '')).toContain('reservation release could not be positively verified');
    expect(fs.existsSync(promptFilePath(agentId))).toBe(true);
    expect(fs.existsSync(launcherFilePath(agentId))).toBe(true);
    expect(readPaneState()).toEqual({
      index: 1,
      pane_id: '%1',
      status: 'reserved',
      role: 'tester',
      agent_id: agentId,
    });
  });

  function dispatchArgs(agentId: string): string[] {
    return [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'Trap cleanup verification',
      '--agent-id', agentId,
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', workingDir,
      '--pane-index', '1',
    ];
  }

  function launcherFilePath(agentId: string): string {
    return path.join(controlArtifactDir, `launcher-1-${agentId}.sh`);
  }

  function promptFilePath(agentId: string): string {
    return path.join(controlArtifactDir, `prompt-1-${agentId}.txt`);
  }

  function readPaneState(): PaneState {
    const state = JSON.parse(fs.readFileSync(gridStatePath, 'utf-8')) as { panes: PaneState[] };
    return state.panes[0];
  }

  function shellEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: tmpHome,
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      ...overrides,
    };
  }

  async function waitForFile(filePath: string): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (fs.existsSync(filePath)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Timed out waiting for ${filePath}`);
  }

  async function terminateProcessGroup(child: ChildProcess): Promise<void> {
    if (!child.pid || !processGroupExists(child.pid)) {
      return;
    }

    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    await waitForProcessGroupExit(child.pid, 1000);
    if (processGroupExists(child.pid)) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      await waitForProcessGroupExit(child.pid, 1000);
    }
    if (processGroupExists(child.pid)) {
      throw new Error(`Leaked test process group ${child.pid}`);
    }
  }

  function processGroupExists(processGroupId: number): boolean {
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error: any) {
      return error?.code !== 'ESRCH';
    }
  }

  async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (processGroupExists(processGroupId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function writeExecutable(fileName: string, contents: string): void {
    const filePath = path.join(fakeBin, fileName);
    fs.writeFileSync(filePath, contents);
    fs.chmodSync(filePath, 0o755);
  }

  function writeGridState(panes: PaneState[]): void {
    fs.writeFileSync(gridStatePath, JSON.stringify({ panes }, null, 2));
  }

  function writeTmuxStub(): void {
    const countFile = shellQuote(path.join(tmuxStateDir, 'send-keys-count'));
    const logFile = shellQuote(path.join(tmuxStateDir, 'send-keys.log'));
    const blockedFile = shellQuote(path.join(tmuxStateDir, 'launch-blocked'));

    writeExecutable('tmux', `#!/bin/bash
set -euo pipefail
cmd="\${1:-}"
shift || true

case "$cmd" in
  list-panes)
    [[ "$*" == *'-s -t =test-session'* ]] || exit 1
    printf '1 %%1\n'
    ;;
  display-message)
    if [[ "$*" == *'pane_pid'* ]]; then
      printf '100\\n'
    else
      printf 'bash\\n'
    fi
    ;;
  send-keys)
    count=0
    if [[ -f ${countFile} ]]; then
      count=$(cat ${countFile})
    fi
    count=$((count + 1))
    printf '%s' "$count" > ${countFile}
    printf '%s\\n' "$*" >> ${logFile}
    if [[ "$count" -eq 3 && "\${TMUX_FAKE_BLOCK_LAUNCH:-0}" == "1" ]]; then
      touch ${blockedFile}
      trap 'exit 0' INT TERM
      exec /usr/bin/tail -f /dev/null
    fi
    if [[ "$count" -eq 3 && "\${TMUX_FAKE_LAUNCH_FAIL:-0}" == "1" ]]; then
      exit 55
    fi
    ;;
  respawn-pane)
    [[ "\${TMUX_FAKE_RESPAWN_FAIL:-0}" != "1" ]] || exit 56
    ;;
  capture-pane)
    ;;
  *)
    printf 'unexpected tmux command: %s\\n' "$cmd" >&2
    exit 1
    ;;
esac
`);
  }

  function writeFailingSleepStub(): void {
    const markerFile = shellQuote(path.join(tmpHome, 'sleep-failed'));

    writeExecutable('sleep', `#!/bin/bash
set -euo pipefail
if [[ ! -f ${markerFile} ]]; then
  touch ${markerFile}
  exit 42
fi
exec /usr/bin/sleep "$@"
`);
  }

  function linkSystemBinary(_fileName: string): void {}

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }
});
