import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-dispatch-trap-'));
    sessionName = 'test-session';
    stateDir = path.join(tmpHome, '.local/state/tmup', sessionName);
    gridDir = path.join(stateDir, 'grid');
    gridStatePath = path.join(gridDir, 'grid-state.json');
    fakeBin = path.join(tmpHome, 'fakebin');
    tmuxStateDir = path.join(tmpHome, 'tmux-state');

    fs.mkdirSync(gridDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(tmuxStateDir, { recursive: true });

    writeGridState([
      { index: 1, pane_id: '%1', status: 'available' },
    ]);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('uses the EXIT trap to release reservations and remove temp files on pre-commit failure', () => {
    writeTmuxStub();
    writeFailingSleepStub();

    const agentId = 'agent-exit';
    const promptPath = promptFilePath(agentId);
    const launcherPath = launcherFilePath();

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
      const launcherPath = launcherFilePath();

      const child = spawn('bash', dispatchArgs(agentId), {
        env: shellEnv({ TMUX_FAKE_BLOCK_LAUNCH: '1' }),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      await waitForFile(path.join(tmuxStateDir, 'launch-blocked'));

      expect(fs.existsSync(promptPath)).toBe(true);
      expect(fs.existsSync(launcherPath)).toBe(true);
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
    }
  );

  function dispatchArgs(agentId: string): string[] {
    return [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'Trap cleanup verification',
      '--agent-id', agentId,
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', PLUGIN_DIR,
      '--pane-index', '1',
    ];
  }

  function launcherFilePath(): string {
    return path.join(stateDir, 'launcher-1.sh');
  }

  function promptFilePath(agentId: string): string {
    return path.join(stateDir, `prompt-1-${agentId}.txt`);
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
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (fs.existsSync(filePath)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Timed out waiting for ${filePath}`);
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
  display-message)
    printf 'bash\\n'
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
      while :; do /usr/bin/sleep 1; done
    fi
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

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }
});
