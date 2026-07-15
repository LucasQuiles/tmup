import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const GRID_SETUP = path.join(PLUGIN_DIR, 'scripts/grid-setup.sh');

describe('grid-setup.sh exact transactional lifecycle', () => {
  let tmpHome: string;
  let fakeBin: string;
  let fakeTmuxRoot: string;
  let stateRoot: string;
  let configDir: string;
  let projectA: string;
  let projectB: string;
  let commandLog: string;
  let wrapper: string;

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-grid-setup-')));
    fakeBin = path.join(tmpHome, 'controller-tools');
    fakeTmuxRoot = path.join(tmpHome, 'fake-tmux');
    stateRoot = path.join(tmpHome, 'state', 'tmup');
    configDir = path.join(tmpHome, 'config');
    projectA = path.join(tmpHome, 'project-a');
    projectB = path.join(tmpHome, 'project-b');
    commandLog = path.join(tmpHome, 'tmux-commands.log');
    wrapper = path.join(fakeBin, 'vitest-grid-parent');

    for (const directory of [fakeBin, fakeTmuxRoot, stateRoot, configDir, projectA, projectB]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(configDir, 'policy.yaml'), 'grid: {}\n');
    writeExecutable('node', '#!/bin/bash\nexit 0\n');
    writeExecutable('sleep', '#!/bin/bash\nexit 0\n');
    writeExecutable('yq', `#!/bin/bash
set -euo pipefail
query="\${2:-}"
case "$query" in
  '.grid.rows // empty'|'.grid.rows // 2') printf '1\n' ;;
  '.grid.cols // 4') printf '2\n' ;;
  '.grid.width // 240') printf '120\n' ;;
  '.grid.height // 55') printf '30\n' ;;
  *) printf 'null\n' ;;
esac
`);
    writeExecutable('install', `#!/bin/bash
set -euo pipefail
destination=""
for argument in "$@"; do destination="$argument"; done
if [[ "\${TMUX_FAKE_INSTALL_FAIL:-}" == "before" ]]; then exit 71; fi
/bin/cat > "$destination"
/bin/chmod 600 "$destination"
if [[ "\${TMUX_FAKE_INSTALL_FAIL:-}" == "after" ]]; then exit 72; fi
`);
    writeExecutable('tmux', tmuxStub());
    fs.writeFileSync(wrapper, '#!/bin/bash\n/bin/bash -p "$@"\n');
    fs.chmodSync(wrapper, 0o755);
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates a grid with exact pane IDs under nonzero tmux base indexes', () => {
    const result = runSetup(projectA, 'base-one');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const grid = readGrid('base-one');
    expect(grid.session_name).toBe('base-one');
    expect(grid.project_dir).toBe(projectA);
    expect(grid.grid).toEqual({ rows: 1, cols: 2 });
    expect(grid.panes).toEqual([
      { index: 1, pane_id: '%101', status: 'available' },
      { index: 2, pane_id: '%102', status: 'available' },
    ]);
    expect(fs.readFileSync(path.join(stateRoot, 'current-session'), 'utf-8').trim()).toBe('base-one');
    expect(registryEntry('base-one')).toEqual(expect.objectContaining({
      session_id: 'base-one',
      project_dir: projectA,
      db_path: path.join(stateRoot, 'base-one', 'tmup.db'),
    }));

    const log = fs.readFileSync(commandLog, 'utf-8');
    expect(log).toContain('has-session -t =base-one');
    expect(log).toContain('list-panes -s -t =base-one');
    expect(log).not.toMatch(/(?:has-session|list-panes|display-message|kill-session) .* -t (?![=%])/);
  });

  it('securely creates a missing state root on first setup', () => {
    fs.rmSync(stateRoot, { recursive: true, force: true });

    const result = runSetup(projectA, 'fresh-root');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.statSync(stateRoot).mode & 0o777).toBe(0o700);
    expect(readGrid('fresh-root').panes).toHaveLength(2);
  });

  it('does not execute a grid style hook inside the project worker root', () => {
    const styleProject = path.join(tmpHome, '.local', 'bin');
    const styleHook = path.join(styleProject, 'tmux-grid-style.sh');
    const styleMarker = path.join(tmpHome, 'style-hook-executed');
    fs.mkdirSync(styleProject, { recursive: true });
    fs.writeFileSync(styleHook, `#!/bin/bash\nprintf 'executed\\n' > ${shellQuote(styleMarker)}\n`);
    fs.chmodSync(styleHook, 0o755);

    const result = runSetup(styleProject, 'style-boundary');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(styleMarker)).toBe(false);
  });

  it('does not execute a grid style hook whose final symlink target enters the worker root', () => {
    const styleDir = path.join(tmpHome, '.local', 'bin');
    const workerHook = path.join(projectA, 'worker-style.sh');
    const styleMarker = path.join(tmpHome, 'symlinked-style-hook-executed');
    fs.mkdirSync(styleDir, { recursive: true });
    fs.writeFileSync(workerHook, `#!/bin/bash\nprintf 'executed\\n' > ${shellQuote(styleMarker)}\n`);
    fs.chmodSync(workerHook, 0o755);
    fs.symlinkSync(workerHook, path.join(styleDir, 'tmux-grid-style.sh'));

    const result = runSetup(projectA, 'style-symlink-boundary');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(styleMarker)).toBe(false);
  });

  it('still executes a resolved grid style hook outside the worker root', () => {
    const styleDir = path.join(tmpHome, '.local', 'bin');
    const styleHook = path.join(styleDir, 'tmux-grid-style.sh');
    const styleMarker = path.join(tmpHome, 'trusted-style-hook-executed');
    fs.mkdirSync(styleDir, { recursive: true });
    fs.writeFileSync(styleHook, `#!/bin/bash\nprintf '%s\\n' "$1" > ${shellQuote(styleMarker)}\n`);
    fs.chmodSync(styleHook, 0o755);

    const result = runSetup(projectA, 'trusted-style');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(styleMarker, 'utf-8').trim()).toBe('trusted-style');
  });

  it('reattaches only with a complete receipt and does not create another session', () => {
    expect(runSetup(projectA, 'receipt-grid').status).toBe(0);
    const before = fs.readFileSync(path.join(fakeTmuxRoot, 'receipt-grid', 'panes'), 'utf-8');

    const second = runSetup(projectA, 'receipt-grid');

    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(second.stdout).toContain('verified receipt');
    expect(fs.readFileSync(path.join(fakeTmuxRoot, 'receipt-grid', 'panes'), 'utf-8')).toBe(before);
    const newCalls = fs.readFileSync(commandLog, 'utf-8').split('\n')
      .filter((line) => line.startsWith('new-session '));
    expect(newCalls).toHaveLength(1);
  });

  it('switches current-session between two independently valid grids', () => {
    expect(runSetup(projectA, 'grid-alpha').status).toBe(0);
    const beta = runSetup(projectB, 'grid-beta');
    expect(beta.status, `${beta.stdout}\n${beta.stderr}`).toBe(0);
    expect(fs.readFileSync(path.join(stateRoot, 'current-session'), 'utf-8').trim()).toBe('grid-beta');

    const reattach = runSetup(projectA, 'grid-alpha');

    expect(reattach.status, `${reattach.stdout}\n${reattach.stderr}`).toBe(0);
    expect(fs.readFileSync(path.join(stateRoot, 'current-session'), 'utf-8').trim()).toBe('grid-alpha');
    expect(fs.existsSync(path.join(fakeTmuxRoot, 'grid-beta'))).toBe(true);
  });

  it('does not confuse or mutate a longer same-prefix session', () => {
    seedSession('prefix-grid-long', '1 %901 bash\n2 %902 node\n');

    const result = runSetup(projectA, 'prefix-grid');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(path.join(fakeTmuxRoot, 'prefix-grid-long', 'panes'), 'utf-8'))
      .toBe('1 %901 bash\n2 %902 node\n');
    expect(fs.existsSync(path.join(fakeTmuxRoot, 'prefix-grid'))).toBe(true);
  });

  it('refuses an existing session whose protected receipt no longer matches', () => {
    expect(runSetup(projectA, 'mismatch-grid').status).toBe(0);
    const gridPath = path.join(stateRoot, 'mismatch-grid', 'grid', 'grid-state.json');
    const grid = JSON.parse(fs.readFileSync(gridPath, 'utf-8'));
    grid.panes[0].pane_id = '%999';
    fs.writeFileSync(gridPath, JSON.stringify(grid));

    const result = runSetup(projectA, 'mismatch-grid');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/receipt.*do not match/i);
    expect(fs.existsSync(path.join(fakeTmuxRoot, 'mismatch-grid'))).toBe(true);
    expect(fs.readFileSync(gridPath, 'utf-8')).toContain('%999');
  });

  it('rolls back an early failure after session creation', () => {
    const result = runSetup(projectA, 'early-fault', { TMUX_FAKE_LIST_FAIL: '1' });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(fakeTmuxRoot, 'early-fault'))).toBe(false);
    expect(registryEntry('early-fault')).toBeUndefined();
    expect(fs.existsSync(path.join(stateRoot, 'early-fault', 'grid', 'grid-state.json'))).toBe(false);
  });

  it.each([
    ['before', 'post-register-fault'],
    ['after', 'post-pointer-fault'],
  ])('rolls back a current-session install failure (%s write)', (failureMode, session) => {
    const result = runSetup(projectA, session, { TMUX_FAKE_INSTALL_FAIL: failureMode });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(fakeTmuxRoot, session))).toBe(false);
    expect(registryEntry(session)).toBeUndefined();
    expect(fs.existsSync(path.join(stateRoot, session, 'grid', 'grid-state.json'))).toBe(false);
    const pointer = path.join(stateRoot, 'current-session');
    expect(fs.existsSync(pointer) ? fs.readFileSync(pointer, 'utf-8').trim() : '').not.toBe(session);
  });

  it('retains discovery and ownership receipts if exact session death cannot be proved', () => {
    const result = runSetup(projectA, 'kill-fault', {
      TMUX_FAKE_INSTALL_FAIL: 'after',
      TMUX_FAKE_KILL_FAIL: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/could not prove exact session death.*retaining/i);
    expect(fs.existsSync(path.join(fakeTmuxRoot, 'kill-fault'))).toBe(true);
    expect(registryEntry('kill-fault')).toBeDefined();
    expect(fs.existsSync(path.join(stateRoot, 'kill-fault', 'grid', 'grid-state.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateRoot, 'kill-fault', 'grid-identity.json'))).toBe(true);
    expect(fs.readFileSync(path.join(stateRoot, 'current-session'), 'utf-8').trim()).toBe('kill-fault');
  });

  function runSetup(project: string, session: string, extraEnv: NodeJS.ProcessEnv = {}) {
    return spawnSync(wrapper, [
      GRID_SETUP,
      '--project-dir', project,
      '--session', session,
    ], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        VITEST: 'true',
        TMUP_TEST_CONTROLLER_OVERRIDE: '1',
        TMUP_TEST_CONTROLLER_TOOL_DIRS: fakeBin,
        TMUP_STATE_ROOT: stateRoot,
        CFG_CONFIG_DIR: configDir,
        TMUP_NO_TERMINAL: '1',
        TMUP_FAKE_ROOT: fakeTmuxRoot,
        TMUP_FAKE_LOG: commandLog,
        TMUP_CODEX_AGENT_TARGET_DIR: path.join(tmpHome, '.codex', 'agents'),
        ...extraEnv,
      },
      encoding: 'utf-8',
      timeout: 30000,
    });
  }

  function readGrid(session: string): any {
    return JSON.parse(fs.readFileSync(
      path.join(stateRoot, session, 'grid', 'grid-state.json'),
      'utf-8',
    ));
  }

  function registryEntry(session: string): any | undefined {
    const registryPath = path.join(stateRoot, 'registry.json');
    if (!fs.existsSync(registryPath)) return undefined;
    return JSON.parse(fs.readFileSync(registryPath, 'utf-8')).sessions?.[session];
  }

  function seedSession(session: string, panes: string): void {
    const sessionDir = path.join(fakeTmuxRoot, session);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'panes'), panes);
  }

  function writeExecutable(name: string, source: string): void {
    const target = path.join(fakeBin, name);
    fs.writeFileSync(target, source);
    fs.chmodSync(target, 0o755);
  }

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }

  function tmuxStub(): string {
    return `#!/bin/bash
set -euo pipefail
root="\${TMUP_FAKE_ROOT:?}"
log="\${TMUP_FAKE_LOG:?}"
cmd="\${1:-}"
shift || true
printf '%s %s\n' "$cmd" "$*" >> "$log"

read_target() {
  local previous="" argument
  TARGET=""
  for argument in "$@"; do
    if [[ "$previous" == "-t" ]]; then TARGET="$argument"; break; fi
    previous="$argument"
  done
  SESSION=""
  if [[ "$TARGET" == =* ]]; then
    SESSION="\${TARGET#=}"
  elif [[ "$TARGET" == \\$* ]]; then
    for candidate in "$root"/*; do
      [[ -f "$candidate/session-id" ]] || continue
      if [[ "$(/bin/cat "$candidate/session-id")" == "$TARGET" ]]; then
        SESSION="\${candidate##*/}"
        break
      fi
    done
  fi
  [[ -n "$SESSION" ]] || exit 90
}

case "$cmd" in
  -V)
    printf 'tmux 3.4\n'
    ;;
  has-session)
    read_target "$@"
    [[ -d "$root/$SESSION" ]]
    ;;
  new-session)
    session=""
    previous=""
    for argument in "$@"; do
      if [[ "$previous" == "-s" ]]; then session="$argument"; break; fi
      previous="$argument"
    done
    [[ -n "$session" && ! -e "$root/$session" ]] || exit 1
    /bin/mkdir -p "$root/$session"
    session_counter="$root/next-session-id"
    [[ -f "$session_counter" ]] || printf '1\n' > "$session_counter"
    session_id=$(/bin/cat "$session_counter")
    printf '%s\n' "$((session_id + 1))" > "$session_counter"
    printf '$%s\n' "$session_id" > "$root/$session/session-id"
    printf '%s\n' "$((1700000000 + session_id))" > "$root/$session/session-created"
    counter="$root/next-pane-id"
    [[ -f "$counter" ]] || printf '101\n' > "$counter"
    pane_id=$(/bin/cat "$counter")
    printf '%s\n' "$((pane_id + 1))" > "$counter"
    printf '1 %%%s bash\n' "$pane_id" > "$root/$session/panes"
    ;;
  list-panes)
    read_target "$@"
    [[ "\${TMUX_FAKE_LIST_FAIL:-0}" != "1" ]] || exit 73
    panes="$root/$SESSION/panes"
    [[ -f "$panes" ]] || exit 1
    format=""
    previous=""
    for argument in "$@"; do
      if [[ "$previous" == "-F" ]]; then format="$argument"; break; fi
      previous="$argument"
    done
    case "$format" in
      '#{pane_id}') /usr/bin/awk '{print $2}' "$panes" ;;
      '#{pane_index} #{pane_id}') /usr/bin/awk '{print $1 " " $2}' "$panes" ;;
      *) exit 91 ;;
    esac
    ;;
  split-window)
    target=""
    previous=""
    for argument in "$@"; do
      if [[ "$previous" == "-t" ]]; then target="$argument"; break; fi
      previous="$argument"
    done
    session_dir=""
    for candidate in "$root"/*; do
      [[ -f "$candidate/panes" ]] || continue
      if /usr/bin/grep -Fq " $target " "$candidate/panes"; then session_dir="$candidate"; break; fi
    done
    [[ -n "$session_dir" ]] || exit 1
    next_index=$(/usr/bin/awk 'BEGIN{m=0} {if ($1>m)m=$1} END{print m+1}' "$session_dir/panes")
    counter="$root/next-pane-id"
    next_id=$(/bin/cat "$counter")
    printf '%s\n' "$((next_id + 1))" > "$counter"
    printf '%s %%%s bash\n' "$next_index" "$next_id" >> "$session_dir/panes"
    printf '%%%s\n' "$next_id"
    ;;
  send-keys)
    ;;
  display-message)
    read_target "$@"
    [[ -d "$root/$SESSION" ]] || exit 1
    format=""
    previous=""
    for argument in "$@"; do
      if [[ "$previous" == "-p" ]]; then format="$argument"; break; fi
      previous="$argument"
    done
    case "$format" in
      '#{session_id}') /bin/cat "$root/$SESSION/session-id" ;;
      '#{session_created}') /bin/cat "$root/$SESSION/session-created" ;;
      '#{session_name}') printf '%s\n' "$SESSION" ;;
      '#{session_attached}') printf '0\n' ;;
      *) exit 92 ;;
    esac
    ;;
  kill-session)
    read_target "$@"
    [[ "\${TMUX_FAKE_KILL_FAIL:-0}" != "1" ]] || exit 74
    /bin/rm -rf "$root/$SESSION"
    ;;
  list-sessions)
    found=0
    for candidate in "$root"/*; do
      [[ -d "$candidate" ]] || continue
      found=1
      printf '%s\n' "\${candidate##*/}"
    done
    if [[ "$found" -eq 0 ]]; then
      printf 'no server running on /tmp/tmux-test/default\n' >&2
      exit 1
    fi
    ;;
  *)
    printf 'unexpected tmux command: %s\n' "$cmd" >&2
    exit 92
    ;;
esac
`;
  }
});
