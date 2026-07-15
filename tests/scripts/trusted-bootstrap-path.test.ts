import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');

describe('trusted shell entrypoint bootstrap', () => {
  let tmpHome: string;
  let maliciousRoot: string;
  let marker: string;

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-bootstrap-')));
    maliciousRoot = path.join(tmpHome, 'attacker-controlled');
    marker = path.join(tmpHome, 'malicious-library-sourced');
    fs.mkdirSync(path.join(maliciousRoot, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.local/state/tmup'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it.each([
    ['dispatch-agent.sh', 'common.sh', /Cannot dispatch — policy\.yaml|--role required|--working-dir must be an absolute existing directory/],
    ['grid-setup.sh', 'config.sh', /project-dir must be an absolute existing directory/],
    ['grid-teardown.sh', 'config.sh', /No active session/],
  ])('resolves the physical %s target before sourcing sibling libraries', (script, library, expectedError) => {
    const symlink = path.join(maliciousRoot, script);
    fs.symlinkSync(path.join(PLUGIN_DIR, 'scripts', script), symlink);
    fs.writeFileSync(
      path.join(maliciousRoot, 'lib', library),
      `#!/bin/bash\nprintf 'sourced\\n' > ${shellQuote(marker)}\n`,
    );

    let stderr = '';
    try {
      execFileSync('/bin/bash', [symlink], {
        env: {
          ...process.env,
          HOME: tmpHome,
          TMUP_SESSION_NAME: '',
        },
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      // Both entrypoints are expected to fail later because required runtime
      // arguments or an active session are intentionally absent.
      stderr = String(error?.stderr ?? '');
    }

    expect(fs.existsSync(marker)).toBe(false);
    expect(stderr).toMatch(expectedError);
  });

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }
});
