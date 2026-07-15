import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const DISPATCH_AGENT_SH = path.join(PLUGIN_DIR, 'scripts/dispatch-agent.sh');

describe('dispatch-agent.sh pane occupancy containment', () => {
  let tmpHome: string;
  let sessionName: string;
  let stateDir: string;
  let gridDir: string;
  let gridStatePath: string;
  let fakeBin: string;
  let tmuxStateDir: string;
  let workingDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-dispatch-occupancy-'));
    sessionName = 'test-session';
    stateDir = path.join(tmpHome, '.local/state/tmup', sessionName);
    gridDir = path.join(stateDir, 'grid');
    gridStatePath = path.join(gridDir, 'grid-state.json');
    fakeBin = path.join(tmpHome, 'fakebin');
    tmuxStateDir = path.join(tmpHome, 'tmux-state');
    workingDir = path.join(tmpHome, 'workspace');
    process.env.TMUP_TEST_CONTROLLER_OVERRIDE = '1';
    process.env.TMUP_TEST_CONTROLLER_TOOL_DIRS = fakeBin;

    fs.mkdirSync(gridDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(tmuxStateDir, { recursive: true });
    fs.mkdirSync(workingDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tmup.db'), '');

    writeGridState({ index: 1, pane_id: '%1', status: 'available' });
    writeTmuxStub();
    writePsStub();
    writeExecutable('sleep', '#!/bin/bash\nexit 0\n');
    writeExecutable('flock', '#!/bin/bash\nexit 0\n');
    writeExecutable('yq', "#!/bin/bash\nprintf 'null\\n'\n");
    writeExecutable('codex', '#!/bin/bash\nexit 0\n');
  });

  afterEach(() => {
    delete process.env.TMUP_TEST_CONTROLLER_OVERRIDE;
    delete process.env.TMUP_TEST_CONTROLLER_TOOL_DIRS;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('refuses an available pane with a directly reported running command without respawning it', () => {
    const failure = runDispatch('agent-direct', { TMUX_FAKE_PANE_COMMAND: 'codex' });

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain(
      'Pane 1 is marked available but occupied by codex; refusing to dispatch'
    );
    expectUntouchedAvailablePane();
  });

  it('walks the full descendant tree and reports the deepest foreground process', () => {
    writePsStub([
      '100 1 100 145 S /bin/bash',
      '120 100 145 145 S /bin/bash',
      '145 120 145 145 S /opt/homebrew/bin/node',
    ]);

    const failure = runDispatch('agent-hidden-worker', { TMUX_FAKE_PANE_COMMAND: 'bash' });

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain(
      'Pane 1 is marked available but occupied by node; refusing to dispatch'
    );
    expectUntouchedAvailablePane();
  });

  it('accepts a valid macOS ucomm containing spaces and reports the full command', () => {
    writePsStub([
      '100 1 100 145 S /bin/bash',
      '145 100 145 145 S Google Chrome',
    ]);

    const failure = runDispatch('agent-spaced-command', {
      TMUX_FAKE_PANE_COMMAND: 'bash',
    });

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain(
      'Pane 1 is marked available but occupied by Google Chrome; refusing to dispatch'
    );
    expectUntouchedAvailablePane();
  });

  it.each(['bash', 'zsh'])(
    'treats a nested foreground %s shell as occupied',
    (nestedShell) => {
      writePsStub([
        '100 1 100 120 S /bin/bash',
        `120 100 120 120 S /bin/${nestedShell}`,
      ]);

      const failure = runDispatch(`agent-nested-${nestedShell}`, {
        TMUX_FAKE_PANE_COMMAND: 'bash',
      });

      expect(failure?.status).toBe(1);
      expect(String(failure?.stderr ?? '')).toContain(
        `Pane 1 is marked available but occupied by ${nestedShell}; refusing to dispatch`
      );
      expectUntouchedAvailablePane();
    }
  );

  it('allows an idle root shell when its nested shell is in a background process group', () => {
    writePsStub([
      '100 1 100 100 S /bin/bash',
      '120 100 120 100 S /bin/bash',
    ]);

    const failure = runDispatch('agent-background-shell', {
      TMUX_FAKE_PANE_COMMAND: 'bash',
    });

    expect(failure).toBeUndefined();
    expect(fs.existsSync(path.join(tmuxStateDir, 'respawn.log'))).toBe(false);
    expect(fs.existsSync(path.join(tmuxStateDir, 'send-keys.log'))).toBe(true);
    expect(readPaneState()).toEqual({
      index: 1,
      pane_id: '%1',
      status: 'reserved',
      role: 'tester',
      agent_id: 'agent-background-shell',
    });
  });

  it.each([
    ['pane command lookup failure', { TMUX_FAKE_DISPLAY_FAIL: '1' }],
    ['pane root lookup failure', { TMUX_FAKE_PANE_PID_FAIL: '1' }],
    ['ps failure', { TMUX_FAKE_PS_MODE: 'fail' }],
    ['malformed ps row', { TMUX_FAKE_PS_MODE: 'malformed' }],
    ['missing pane root', { TMUX_FAKE_PS_MODE: 'missing-root' }],
  ])('fails closed on %s', (_caseName, extraEnv) => {
    const failure = runDispatch('agent-unknown', {
      TMUX_FAKE_PANE_COMMAND: 'bash',
      ...extraEnv,
    });

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain(
      'Could not verify occupancy for pane 1'
    );
    expectUntouchedAvailablePane();
  });

  it('never overwrites a non-available pane reservation', () => {
    writeGridState({
      index: 1,
      pane_id: '%1',
      status: 'reserved',
      role: 'reviewer',
      agent_id: 'existing-agent',
    });

    const failure = runDispatch('agent-must-not-overwrite', {
      TMUX_FAKE_PANE_COMMAND: 'bash',
    });

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain(
      "Pane 1 is not available (status 'reserved')"
    );
    expect(fs.existsSync(path.join(tmuxStateDir, 'send-keys.log'))).toBe(false);
    expect(readPaneState()).toEqual({
      index: 1,
      pane_id: '%1',
      status: 'reserved',
      role: 'reviewer',
      agent_id: 'existing-agent',
    });
  });

  function runDispatch(agentId: string, extraEnv: Record<string, string>) {
    try {
      execFileSync('bash', [
        DISPATCH_AGENT_SH,
        '--session', sessionName,
        '--role', 'tester',
        '--prompt', 'Pane occupancy verification',
        '--agent-id', agentId,
        '--db-path', path.join(stateDir, 'tmup.db'),
        '--working-dir', workingDir,
        '--pane-index', '1',
      ], {
        env: {
          ...process.env,
          HOME: tmpHome,
          PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          ...extraEnv,
        },
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return undefined;
    } catch (error: any) {
      return error as { status?: number; stderr?: Buffer | string };
    }
  }

  function expectUntouchedAvailablePane(): void {
    expect(fs.existsSync(path.join(tmuxStateDir, 'respawn.log'))).toBe(false);
    expect(fs.existsSync(path.join(tmuxStateDir, 'send-keys.log'))).toBe(false);
    expect(readPaneState()).toEqual({
      index: 1,
      pane_id: '%1',
      status: 'available',
    });
  }

  function readPaneState(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(gridStatePath, 'utf-8')).panes[0];
  }

  function writeGridState(pane: Record<string, unknown>): void {
    fs.writeFileSync(gridStatePath, JSON.stringify({ panes: [pane] }, null, 2));
  }

  function writeTmuxStub(): void {
    const respawnLog = shellQuote(path.join(tmuxStateDir, 'respawn.log'));
    const sendKeysLog = shellQuote(path.join(tmuxStateDir, 'send-keys.log'));

    writeExecutable('tmux', `#!/bin/bash
set -euo pipefail
cmd="\${1:-}"
shift || true

case "$cmd" in
  list-panes)
    [[ "$*" == *'-s -t =test-session'* ]] || exit 1
    printf '1 %%1\\n'
    ;;
  display-message)
    if [[ "\${TMUX_FAKE_DISPLAY_FAIL:-0}" == "1" ]]; then exit 1; fi
    if [[ "$*" == *'pane_pid'* ]]; then
      if [[ "\${TMUX_FAKE_PANE_PID_FAIL:-0}" == "1" ]]; then exit 1; fi
      printf '100\\n'
    else
      printf '%s\\n' "\${TMUX_FAKE_PANE_COMMAND:-codex}"
    fi
    ;;
  respawn-pane)
    printf '%s\\n' "$*" >> ${respawnLog}
    ;;
  send-keys)
    printf '%s\\n' "$*" >> ${sendKeysLog}
    ;;
  capture-pane)
    count_file="$HOME/.tmup-test-capture-count"
    count=0
    [[ ! -f "$count_file" ]] || count=$(cat "$count_file")
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    printf 'Working (fake-%s)\\n❯\\n' "$count"
    ;;
  *)
    printf 'unexpected tmux command: %s\\n' "$cmd" >&2
    exit 1
    ;;
esac
`);
  }

  function writePsStub(rows?: string[]): void {
    const defaultRows = rows ?? [
      '100 1 100 145 S /bin/bash',
      '145 100 145 145 S /opt/homebrew/bin/codex',
    ];
    const rowOutput = defaultRows.map((row) => `printf '%s\\n' ${shellQuote(row)}`).join('\n');

    writeExecutable('ps', `#!/bin/bash
case "\${TMUX_FAKE_PS_MODE:-ok}" in
  fail) exit 1 ;;
  malformed) printf 'not-a-process-row\\n'; exit 0 ;;
  missing-root) printf '145 999 145 145 S /opt/homebrew/bin/codex\\n'; exit 0 ;;
  ok) ${rowOutput} ;;
  *) exit 1 ;;
esac
`);
  }

  function writeExecutable(fileName: string, contents: string): void {
    const filePath = path.join(fakeBin, fileName);
    fs.writeFileSync(filePath, contents);
    fs.chmodSync(filePath, 0o755);
  }

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }
});
