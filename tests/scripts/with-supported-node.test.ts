import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..');
const WRAPPER = path.join(PLUGIN_ROOT, 'scripts/with-supported-node.sh');

function writeFakeNode(directory: string, abi: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, 'node');
  fs.writeFileSync(executable, `#!/bin/sh
case "$2" in
  process.versions.modules) printf '%s\\n' '${abi}' ;;
  process.execPath) printf '%s\\n' "$0" ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });
  return executable;
}

describe('with-supported-node.sh', () => {
  it('selects a verified explicit Node 20 bin directory before running the command', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-node-wrapper-'));
    try {
      const currentBin = path.join(root, 'current');
      const supportedBin = path.join(root, 'supported');
      writeFakeNode(currentBin, '999');
      const expectedNode = writeFakeNode(supportedBin, '115');

      const output = execFileSync('/bin/bash', [
        WRAPPER,
        '/usr/bin/env', 'node', '-p', 'process.execPath',
      ], {
        env: {
          ...process.env,
          PATH: `${currentBin}:/usr/bin:/bin`,
          TMUP_NODE20_BIN: supportedBin,
        },
        encoding: 'utf-8',
      }).trim();

      expect(fs.realpathSync(output)).toBe(fs.realpathSync(expectedNode));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an explicit Node 20 bin directory is relative', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-node-wrapper-'));
    try {
      const currentBin = path.join(root, 'current');
      writeFakeNode(currentBin, '999');

      const result = spawnSync('/bin/bash', [WRAPPER, '/usr/bin/true'], {
        env: {
          ...process.env,
          PATH: `${currentBin}:/usr/bin:/bin`,
          TMUP_NODE20_BIN: 'relative/bin',
        },
        encoding: 'utf-8',
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/TMUP_NODE20_BIN.*absolute/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
