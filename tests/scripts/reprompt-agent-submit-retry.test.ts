import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const REPROMPT_AGENT_SH = path.join(PLUGIN_DIR, 'scripts/reprompt-agent.sh');
const TEST_SESSION = `${'s'.repeat(64)}-abcdef`;

describe('reprompt-agent.sh Codex submit verification', () => {
  let tmpHome: string;
  let fakeBin: string;
  let tmuxStateDir: string;
  let captureSequencePath: string;
  let sendLogPath: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-reprompt-submit-'));
    fakeBin = path.join(tmpHome, 'fakebin');
    tmuxStateDir = path.join(tmpHome, 'tmux-state');
    captureSequencePath = path.join(tmuxStateDir, 'capture-sequence.txt');
    sendLogPath = path.join(tmuxStateDir, 'send-keys.log');

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(tmuxStateDir, { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.local/state/tmup', TEST_SESSION, 'grid'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.local/state/tmup', TEST_SESSION, 'grid/grid-state.json'),
      JSON.stringify({
        panes: Array.from({ length: 4 }, (_, index) => ({ index, pane_id: `%${index}`, status: 'active' })),
      }),
    );

    writeTmuxStub();
    writeExecutable('vitest-test-parent', '#!/bin/bash\n/bin/bash "$@"\n');
    writeExecutable('sleep', '#!/bin/bash\nexit 0\n');
    writeExecutable('yq', '#!/bin/bash\nprintf \'null\\n\'\n');

    for (const commandName of [
      'cat',
      'chmod',
      'dirname',
      'grep',
      'mktemp',
      'rm',
      'sed',
    ]) {
      linkSystemBinary(commandName);
    }
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('submits once when Codex starts working after the first Enter', () => {
    writeCaptureSequence([
      '❯\\n',
      '❯ Follow-up verification\\n',
      'Working (accepted)\\n',
    ]);

    execFileSync(path.join(fakeBin, 'vitest-test-parent'), [
      REPROMPT_AGENT_SH,
      '--session', TEST_SESSION,
      '--pane', '2',
      '--prompt', 'Follow-up verification',
    ], {
      env: shellEnv(),
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const sendLog = readSendLog();
    expect(sendLog.filter((line) => line.includes(' Enter'))).toHaveLength(1);
    expect(sendLog.filter((line) => line.startsWith('-l ') || line.includes(' -l '))).toHaveLength(1);
  });

  it('does not treat prompt text --session as the pre-config session option', () => {
    writeCaptureSequence(['❯\\n', '❯ --session\\n', 'Working (accepted)\\n']);

    expect(() => execFileSync(path.join(fakeBin, 'vitest-test-parent'), [
      REPROMPT_AGENT_SH,
      '--session', TEST_SESSION,
      '--pane', '2',
      '--prompt', '--session',
    ], {
      env: shellEnv(),
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).not.toThrow();
  });

  it('fails after three submit attempts when Codex never starts working', () => {
    writeCaptureSequence([
      '❯\\n',
      '❯ Retry me\\n',
      '❯ still idle\\n',
      '❯ Retry me\\n',
      '❯ still idle\\n',
      '❯ Retry me\\n',
      '❯ still idle\\n',
    ]);

    let failure: { status?: number; stderr?: Buffer | string } | undefined;
    try {
      execFileSync(path.join(fakeBin, 'vitest-test-parent'), [
        REPROMPT_AGENT_SH,
        '--session', TEST_SESSION,
        '--pane', '0',
        '--prompt', 'Retry me',
      ], {
        env: shellEnv(),
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain('failed to confirm Codex accepted the reprompt');

    const sendLog = readSendLog();
    expect(sendLog.filter((line) => line.includes(' Enter'))).toHaveLength(3);
    expect(sendLog.filter((line) => line.startsWith('-l ') || line.includes(' -l '))).toHaveLength(1);
  });

  // Invariant: idle detection uses codex_scrollback_shows_active_work
  // (Working-spinner only) so echoed tool-name text from prior turns does
  // not block idleness — otherwise is_agent_idle would reject a pane that
  // is actually at `❯`.
  it('accepts idle pane whose scrollback echoes prior tool-name prompt (C-1 idle-path regression)', () => {
    writeCaptureSequence([
      // is_agent_idle: pane at `❯` with echoed prior-turn tool-name text.
      '❯ call update_plan when done and apply_patch the README\\n',
      // pre-submit baseline after literal text is typed.
      '❯ Follow-up after prior turn\\n',
      // wait_for_codex_submit_confirmation: Working marker after Enter.
      'Working (accepted)\\n',
    ]);

    execFileSync(path.join(fakeBin, 'vitest-test-parent'), [
      REPROMPT_AGENT_SH,
      '--session', TEST_SESSION,
      '--pane', '3',
      '--prompt', 'Follow-up after prior turn',
    ], {
      env: shellEnv(),
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Reprompt must have proceeded past the idle check and submitted once.
    const sendLog = readSendLog();
    expect(sendLog.filter((line) => line.includes(' Enter'))).toHaveLength(1);
    expect(sendLog.filter((line) => line.startsWith('-l ') || line.includes(' -l '))).toHaveLength(1);
  });

  it('fails --all with a structured zero-delivery receipt when every pane is busy', () => {
    writeCaptureSequence(Array.from({ length: 4 }, () => 'Working (busy)\\n'));

    let failure: { status?: number; stdout?: Buffer | string } | undefined;
    try {
      execFileSync(path.join(fakeBin, 'vitest-test-parent'), [
        REPROMPT_AGENT_SH,
        '--session', TEST_SESSION,
        '--all',
        '--prompt', 'Do not duplicate',
      ], {
        env: shellEnv(),
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stdout ?? '')).toContain('TMUP_REPROMPT_SENT=0');
    expect(String(failure?.stdout ?? '')).toContain('TMUP_REPROMPT_FAILED=0');
    expect(String(failure?.stdout ?? '')).toContain('TMUP_REPROMPT_SKIPPED=4');
  });

  it('does not receipt unchanged stale tool output from a prior turn', () => {
    const stale = 'apply_patch completed in prior turn\\n❯ still idle\\n';
    writeCaptureSequence(Array.from({ length: 7 }, () => stale));

    let failure: { status?: number; stderr?: Buffer | string } | undefined;
    try {
      execFileSync(path.join(fakeBin, 'vitest-test-parent'), [
        REPROMPT_AGENT_SH,
        '--session', TEST_SESSION,
        '--pane', '2',
        '--prompt', 'Submission that remains idle',
      ], {
        env: shellEnv(),
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain('failed to confirm Codex accepted the reprompt');
  });

  it('accepts a genuinely new Working marker even when the wider baseline has stale Working text', () => {
    writeCaptureSequence([
      '❯ idle\\n',
      'Working (old)\\n❯ typed\\n',
      'Working (old)\\nWorking (new)\\n',
    ]);

    expect(() => execFileSync(path.join(fakeBin, 'vitest-test-parent'), [
      REPROMPT_AGENT_SH,
      '--session', TEST_SESSION,
      '--pane', '2',
      '--prompt', 'Fresh activity',
    ], {
      env: shellEnv(),
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).not.toThrow();
  });

  it('fails closed before Enter when the pre-submit baseline cannot be captured', () => {
    writeCaptureSequence(['❯ idle\\n', 'unused\\n']);

    let failure: { status?: number; stderr?: Buffer | string } | undefined;
    try {
      execFileSync(path.join(fakeBin, 'vitest-test-parent'), [
        REPROMPT_AGENT_SH,
        '--session', TEST_SESSION,
        '--pane', '2',
        '--prompt', 'Needs a baseline',
      ], {
        env: { ...shellEnv(), TMUX_FAKE_CAPTURE_FAIL_AT: '2' },
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain('failed to capture a pre-submit baseline');
    const sendLog = readSendLog();
    expect(sendLog.filter((line) => line.includes(' Enter'))).toHaveLength(0);
  });

  it.each([
    ['zero-byte', ''],
    ['whitespace-only', '   \\t'],
  ])('fails closed before Enter when a successful baseline capture is %s', (_label, baseline) => {
    writeCaptureSequence([
      '❯ idle\\n',
      baseline,
      'apply_patch completed in stale scrollback\\n',
    ]);

    let failure: { status?: number; stderr?: Buffer | string } | undefined;
    try {
      execFileSync(path.join(fakeBin, 'vitest-test-parent'), [
        REPROMPT_AGENT_SH,
        '--session', TEST_SESSION,
        '--pane', '2',
        '--prompt', 'Needs a nonempty baseline',
      ], {
        env: shellEnv(),
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain('pre-submit baseline was empty');
    const sendLog = readSendLog();
    expect(sendLog.filter((line) => line.includes(' Enter'))).toHaveLength(0);
  });

  it('fails --all when every literal send fails and reports each failure', () => {
    writeCaptureSequence(Array.from({ length: 8 }, () => '❯ idle\\n'));

    let failure: { status?: number; stdout?: Buffer | string } | undefined;
    try {
      execFileSync(path.join(fakeBin, 'vitest-test-parent'), [
        REPROMPT_AGENT_SH,
        '--session', TEST_SESSION,
        '--all',
        '--prompt', 'Fail literally',
      ], {
        env: { ...shellEnv(), TMUX_FAKE_LITERAL_SEND_FAIL: '1' },
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stdout ?? '')).toContain('TMUP_REPROMPT_SENT=0');
    expect(String(failure?.stdout ?? '')).toContain('TMUP_REPROMPT_FAILED=4');
  });

  it('rejects an actively working queueable pane before typing prompt text', () => {
    writeCaptureSequence([
      'Working (busy)\\n',
      'Working (busy) — Tab to queue\\n',
    ]);

    expect(() => execFileSync(path.join(fakeBin, 'vitest-test-parent'), [
      REPROMPT_AGENT_SH,
      '--session', TEST_SESSION,
      '--pane', '2',
      '--prompt', 'Must wait',
    ], {
      env: shellEnv(),
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow();

    const sendLog = fs.existsSync(sendLogPath) ? readSendLog() : [];
    expect(sendLog.some((line) => line.includes('-l'))).toBe(false);
    expect(sendLog.some((line) => /(?:^| )Tab(?: |$)/.test(line))).toBe(false);
  });

  function shellEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: tmpHome,
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      TMUP_TEST_CONTROLLER_OVERRIDE: '1',
      TMUP_TEST_CONTROLLER_TOOL_DIRS: fakeBin,
      TMUX_FAKE_CAPTURE_FILE: captureSequencePath,
      TMUX_FAKE_SEND_LOG: sendLogPath,
      TMUX_FAKE_PANE_COMMAND: 'codex',
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
    [[ "$*" == *'-s -t =${TEST_SESSION}'* ]] || exit 1
    printf '0 %%0\n1 %%1\n2 %%2\n3 %%3\n'
    ;;
  has-session)
    [[ "$*" == *'-t =${TEST_SESSION}'* ]] || exit 1
    exit 0
    ;;
  display-message)
    printf '%s\\n' "\${TMUX_FAKE_PANE_COMMAND:-codex}"
    ;;
  send-keys)
    printf '%s\\n' "$*" >> ${sendLogFile}
    if [[ "\${TMUX_FAKE_LITERAL_SEND_FAIL:-0}" == "1" && " $* " == *' -l '* ]]; then
      exit 1
    fi
    ;;
  capture-pane)
    count=0
    if [[ -f ${captureCountFile} ]]; then
      count=$(cat ${captureCountFile})
    fi
    count=$((count + 1))
    printf '%s' "$count" > ${captureCountFile}
    if [[ -n "\${TMUX_FAKE_CAPTURE_FAIL_AT:-}" && "$count" -eq "\${TMUX_FAKE_CAPTURE_FAIL_AT}" ]]; then
      exit 1
    fi
    line=$(sed -n "\${count}p" ${captureSequence} 2>/dev/null || true)
    printf '%b' "$line"
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
