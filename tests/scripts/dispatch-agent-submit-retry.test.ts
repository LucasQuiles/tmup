import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const DISPATCH_AGENT_SH = path.join(PLUGIN_DIR, 'scripts/dispatch-agent.sh');

describe('dispatch-agent.sh Codex submit verification', () => {
  let tmpHome: string;
  let sessionName: string;
  let stateDir: string;
  let gridDir: string;
  let fakeBin: string;
  let tmuxStateDir: string;
  let captureSequencePath: string;
  let sendLogPath: string;
  let workingDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-dispatch-submit-'));
    sessionName = `${'s'.repeat(64)}-abcdef`;
    stateDir = path.join(tmpHome, '.local/state/tmup', sessionName);
    gridDir = path.join(stateDir, 'grid');
    fakeBin = path.join(tmpHome, 'fakebin');
    tmuxStateDir = path.join(tmpHome, 'tmux-state');
    captureSequencePath = path.join(tmuxStateDir, 'capture-sequence.txt');
    sendLogPath = path.join(tmuxStateDir, 'send-keys.log');
    workingDir = path.join(tmpHome, 'workspace');
    process.env.TMUP_TEST_CONTROLLER_OVERRIDE = '1';
    process.env.TMUP_TEST_CONTROLLER_TOOL_DIRS = fakeBin;

    fs.mkdirSync(gridDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(tmuxStateDir, { recursive: true });
    fs.mkdirSync(workingDir, { recursive: true });

    fs.writeFileSync(
      path.join(gridDir, 'grid-state.json'),
      JSON.stringify({
        panes: [{ index: 1, pane_id: '%1', status: 'available' }],
      }, null, 2)
    );
    fs.writeFileSync(path.join(stateDir, 'tmup.db'), '');

    writeTmuxStub();
    writeExecutable('ps', "#!/bin/bash\nprintf '100 1 100 100 S /bin/bash\\n'\n");
    writeExecutable('sleep', '#!/bin/bash\nexit 0\n');
    writeExecutable('yq', '#!/bin/bash\nprintf \'null\\n\'\n');
    // Keep dispatch tests independent from the host lock implementation.
    writeExecutable('flock', '#!/bin/bash\nexit 0\n');
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
  });

  afterEach(() => {
    delete process.env.TMUP_TEST_CONTROLLER_OVERRIDE;
    delete process.env.TMUP_TEST_CONTROLLER_TOOL_DIRS;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('toggles plan mode and retries Enter when Codex does not confirm the first submit', () => {
    writeCaptureSequence([
      'Working (boot)\\n',
      '❯\\n',
      '❯ still idle\\n',
      '❯ still idle\\n',
      '❯ still idle\\n',
      'Working (tool call)\\n',
    ]);

    execFileSync('/bin/bash', dispatchArgs('agent-shift-tab'), {
      env: shellEnv(),
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const sendLog = readSendLog();
    expect(sendLog.some((line) => line.includes('/bin/bash -p '))).toBe(true);
    expect(sendLog.filter((line) => line.includes(' S-Tab'))).toHaveLength(1);
    expect(sendLog.filter((line) => line.includes(' Enter'))).toHaveLength(3);
    expect(sendLog.filter((line) => line.startsWith('-l ') || line.includes(' -l '))).toHaveLength(1);
  });

  it('interrupts and re-sends the full prompt, then fails after three exhausted retries', () => {
    writeCaptureSequence([
      'Working (boot)\\n',
      '❯\\n',
      ...Array.from({ length: 18 }, () => '❯ still idle\\n'),
    ]);

    let failure: { status?: number; stdout?: Buffer | string; stderr?: Buffer | string } | undefined;
    try {
      execFileSync('/bin/bash', dispatchArgs('agent-full-retry-failure'), {
        env: shellEnv(),
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain('failed to confirm Codex accepted the initial prompt');
    expect(String(failure?.stdout ?? '')).toContain('TMUP_DISPATCH_ROLLBACK=released');

    const gridState = JSON.parse(fs.readFileSync(path.join(gridDir, 'grid-state.json'), 'utf-8'));
    expect(gridState.panes[0]).toEqual({ index: 1, pane_id: '%1', status: 'available' });

    const sendLog = readSendLog();
    expect(sendLog.filter((line) => line.startsWith('-l ') || line.includes(' -l '))).toHaveLength(3);
    expect(sendLog.filter((line) => line.includes(' C-c')).length).toBeGreaterThanOrEqual(3);
  });

  // Invariant: submit confirmation must distinguish echoed prompt text from
  // real Codex work — a prompt containing `update_plan` / `apply_patch` /
  // etc. must not trip the tool-name fallback regex. Requires the active
  // Working marker or a tool-call line that is NOT a substring of the prompt.
  it('does not false-positive when echoed prompt contains tool names (C-1 regression)', () => {
    // Every capture returns an idle `❯` line echoing a prompt with tool
    // names — no Working (...), no tool-call output.
    writeCaptureSequence([
      'Working (boot)\\n',
      ...Array.from(
        { length: 19 },
        () => '❯ call update_plan when done and apply_patch the README\\n',
      ),
    ]);

    let failure: { status?: number; stdout?: Buffer | string; stderr?: Buffer | string } | undefined;
    try {
      execFileSync('/bin/bash', dispatchArgsWithPrompt(
        'agent-c1-regression',
        'call update_plan when done and apply_patch the README'
      ), {
        env: shellEnv(),
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain('failed to confirm Codex accepted the initial prompt');

    const sendLog = readSendLog();
    expect(sendLog.filter((line) => line.startsWith('-l ') || line.includes(' -l '))).toHaveLength(3);
  });

  function dispatchArgs(agentId: string): string[] {
    return dispatchArgsWithPrompt(agentId, 'Dispatch retry verification');
  }

  function dispatchArgsWithPrompt(agentId: string, prompt: string): string[] {
    return [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', prompt,
      '--agent-id', agentId,
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', workingDir,
      '--pane-index', '1',
    ];
  }

  function shellEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: tmpHome,
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      TMUX_FAKE_CAPTURE_FILE: captureSequencePath,
      TMUX_FAKE_SEND_LOG: sendLogPath,
    };
  }

  function readSendLog(): string[] {
    return fs.readFileSync(sendLogPath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function writeCaptureSequence(lines: string[]): void {
    fs.writeFileSync(captureSequencePath, `${lines.join('\n')}\n`);
  }

  function writeExecutable(fileName: string, contents: string): void {
    const filePath = path.join(fakeBin, fileName);
    fs.writeFileSync(filePath, contents);
    fs.chmodSync(filePath, 0o755);
  }

  function writeTmuxStub(): void {
    const captureSequence = shellQuote(captureSequencePath);
    const captureCountFile = shellQuote(path.join(tmuxStateDir, 'capture-count'));
    const sendLogFile = shellQuote(sendLogPath);

    writeExecutable('tmux', `#!/bin/bash
set -euo pipefail
cmd="\${1:-}"
shift || true

case "$cmd" in
  list-panes)
    [[ "$*" == *'-s -t =${sessionName}'* ]] || exit 1
    printf '1 %%1\\n'
    ;;
  display-message)
    if [[ "$*" == *'pane_pid'* ]]; then
      printf '100\\n'
    else
      printf 'bash\\n'
    fi
    ;;
  send-keys)
    printf '%s\\n' "$*" >> ${sendLogFile}
    ;;
  capture-pane)
    count=0
    if [[ -f ${captureCountFile} ]]; then
      count=$(cat ${captureCountFile})
    fi
    count=$((count + 1))
    printf '%s' "$count" > ${captureCountFile}
    line=$(sed -n "\${count}p" ${captureSequence} 2>/dev/null || true)
    printf '%b' "$line"
    ;;
  respawn-pane)
    ;;
  *)
    printf 'unexpected tmux command: %s\\n' "$cmd" >&2
    exit 1
    ;;
esac
`);
  }

  function linkSystemBinary(_fileName: string): void {}

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }
});
