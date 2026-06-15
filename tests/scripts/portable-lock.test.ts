import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const PORTABLE_LOCK_SH = path.join(PLUGIN_DIR, 'scripts/lib/portable-lock.sh');
const PORTABLE_SYSTEM_SH = path.join(PLUGIN_DIR, 'scripts/lib/portable-system.sh');

describe('portable-lock.sh', () => {
  it('uses mkdir fallback when flock is absent from PATH', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-portable-lock-'));
    try {
      const output = runWithoutFlock(tmp, `
        source "${PORTABLE_LOCK_SH}"
        lock="$1/grid-state.lock"
        command -v flock >/dev/null && exit 9
        tmup_lock_acquire "$lock" 1 9
        test -d "$lock.d"
        test -f "$lock.d/owner"
        tmup_lock_release "$lock" 9
        test ! -d "$lock.d"
        printf 'fallback-ok\\n'
      `);

      expect(output).toContain('fallback-ok');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('times out when a mkdir fallback lock is already held', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-portable-lock-'));
    try {
      const output = runWithoutFlock(tmp, `
        source "${PORTABLE_LOCK_SH}"
        lock="$1/grid-state.lock"
        tmup_lock_acquire "$lock" 1 9
        if /bin/bash -c 'PATH="$1"; source "$2"; tmup_lock_acquire "$3" 1 8' bash "$PATH" "${PORTABLE_LOCK_SH}" "$lock"; then
          exit 10
        fi
        tmup_lock_release "$lock" 9
        printf 'contention-ok\\n'
      `);

      expect(output).toContain('contention-ok');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not let a non-owner release a mkdir fallback lock', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-portable-lock-'));
    try {
      const output = runWithoutFlock(tmp, `
        source "${PORTABLE_LOCK_SH}"
        lock="$1/grid-state.lock"
        tmup_lock_acquire "$lock" 1 9
        /bin/bash -c 'PATH="$1"; source "$2"; tmup_lock_release "$3" 8' bash "$PATH" "${PORTABLE_LOCK_SH}" "$lock"
        test -d "$lock.d"
        tmup_lock_release "$lock" 9
        test ! -d "$lock.d"
        printf 'owner-release-ok\\n'
      `);

      expect(output).toContain('owner-release-ok');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('recovers stale mkdir fallback locks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-portable-lock-'));
    try {
      const output = runWithoutFlock(tmp, `
        source "${PORTABLE_LOCK_SH}"
        lock="$1/grid-state.lock"
        command -p mkdir "$lock.d"
        printf 'pid=1\\n' > "$lock.d/owner"
        command -p sleep 1
        TMUP_LOCK_STALE_SECONDS=0 tmup_lock_acquire "$lock" 1 9
        tmup_lock_release "$lock" 9
        test ! -d "$lock.d"
        printf 'stale-ok\\n'
      `);

      expect(output).toContain('stale-ok');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function runWithoutFlock(tmp: string, script: string): string {
  const fakeBin = path.join(tmp, 'fakebin');
  fs.mkdirSync(fakeBin);

  return execFileSync('/bin/bash', ['-c', script, 'bash', tmp], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: fakeBin,
    },
  });
}

describe('portable-system.sh', () => {
  it('provides GNU-free timestamp and hostname helpers under a constrained PATH', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-portable-system-'));
    try {
      const output = runWithConstrainedPath(tmp, `
        source "${PORTABLE_SYSTEM_SH}"
        ts="$(tmup_iso_timestamp)"
        host="$(tmup_hostname_short)"
        expected_range=$'0\\n1\\n2\\n3'
        [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
        [[ -n "$host" ]]
        [[ "$(tmup_index_range 4)" == "$expected_range" ]]
        printf 'system-ok\\n'
      `);

      expect(output).toContain('system-ok');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('canonicalizes directories without requiring realpath on PATH', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-portable-system-'));
    const realDir = path.join(tmp, 'real');
    const symlink = path.join(tmp, 'link');
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, symlink);

    try {
      const output = runWithConstrainedPath(tmp, `
        source "${PORTABLE_SYSTEM_SH}"
        command -v realpath >/dev/null && exit 9
        resolved="$(tmup_realpath_dir "$1/link")"
        [[ "$resolved" == "$1/real" ]]
        printf 'realpath-fallback-ok\\n'
      `);

      expect(output).toContain('realpath-fallback-ok');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function runWithConstrainedPath(tmp: string, script: string): string {
  const fakeBin = path.join(tmp, 'fakebin');
  fs.mkdirSync(fakeBin);

  return execFileSync('/bin/bash', ['-c', script, 'bash', tmp], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: fakeBin,
    },
  });
}
