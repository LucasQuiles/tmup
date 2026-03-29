import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, closeDatabase } from '../../shared/src/db.js';
import { createTask } from '../../shared/src/task-ops.js';
import { claimTask } from '../../shared/src/task-lifecycle.js';
import { registerAgent, getAgent } from '../../shared/src/agent-ops.js';
import { sendMessage } from '../../shared/src/message-ops.js';
import { logEvent } from '../../shared/src/event-ops.js';
import type { Database } from '../../shared/src/types.js';
import { tmpDbPath, cleanupDb } from '../helpers/db.js';

const TEST_AGENT_ID = 'cli-json-agent';
const TEST_PANE_INDEX = '0';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_PATH = path.join(REPO_ROOT, 'cli/dist/tmup-cli.js');

interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

describe('tmup-cli stdout JSON contract', () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  function runCli(args: string[], envOverrides: Record<string, string | null> = {}): CliRunResult {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMUP_DB: dbPath,
      TMUP_AGENT_ID: TEST_AGENT_ID,
      TMUP_PANE_INDEX: TEST_PANE_INDEX,
      TMUP_PROJECT_DIR: REPO_ROOT,
      TMUP_WORKING_DIR: REPO_ROOT,
      TMUP_SESSION_NAME: 'tmup-cli-json-test',
    };

    delete env.TMUP_TASK_ID;
    delete env.TMUP_SESSION_DIR;

    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === null) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }

    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
    });

    expect(result.error).toBeUndefined();
    expect(result.stdout.trim().length).toBeGreaterThan(0);

    let json: Record<string, unknown> | undefined;
    expect(() => {
      json = JSON.parse(result.stdout) as Record<string, unknown>;
    }).not.toThrow();

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      json: json!,
    };
  }

  function createClaimedTask(subject: string): string {
    registerAgent(db, TEST_AGENT_ID, Number(TEST_PANE_INDEX));
    const taskId = createTask(db, { subject });
    const claimed = claimTask(db, TEST_AGENT_ID);
    expect(claimed?.id).toBe(taskId);
    return taskId;
  }

  describe('claim', () => {
    it('emits JSON for valid input', () => {
      const taskId = createTask(db, { subject: 'Claim me', role: 'tester' });

      const result = runCli(['claim', '--role', 'tester']);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({ ok: true, task_id: taskId });
    });

    it('emits JSON for invalid input', () => {
      const result = runCli(['claim'], { TMUP_AGENT_ID: null });

      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({
        ok: false,
        error: 'COMMAND_ERROR',
        message: 'TMUP_AGENT_ID not set',
      });
    });
  });

  describe('complete', () => {
    it('emits JSON for valid input', () => {
      const taskId = createClaimedTask('Complete me');

      const result = runCli(['complete', 'done']);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({ ok: true, task_id: taskId });
    });

    it('emits JSON for invalid input', () => {
      const result = runCli(['complete']);

      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({
        ok: false,
        error: 'COMMAND_ERROR',
        message: 'Result summary required',
      });
    });
  });

  describe('fail', () => {
    it('emits JSON for valid input', () => {
      const taskId = createClaimedTask('Fail me');

      const result = runCli(['fail', '--reason', 'logic_error', 'bad output']);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({
        ok: true,
        task_id: taskId,
        retrying: false,
      });
    });

    it('emits JSON for invalid input', () => {
      const result = runCli(['fail', '--reason', 'not_real', 'bad output']);

      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({
        ok: false,
        error: 'COMMAND_ERROR',
      });
      expect(String(result.json.message)).toContain('Invalid reason: not_real');
    });
  });

  describe('checkpoint', () => {
    it('emits JSON for valid input', () => {
      createClaimedTask('Checkpoint me');

      const result = runCli(['checkpoint', 'halfway there']);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({ ok: true });
    });

    it('emits JSON for invalid input', () => {
      const result = runCli(['checkpoint']);

      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({
        ok: false,
        error: 'COMMAND_ERROR',
        message: 'Checkpoint message required',
      });
    });
  });

  describe('message', () => {
    it('emits JSON for valid input', () => {
      const result = runCli(['message', '--to', 'lead', 'hello lead']);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({ ok: true });
    });

    it('emits JSON for invalid input', () => {
      const result = runCli(['message', '--type', 'not_real', 'hello lead']);

      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({
        ok: false,
        error: 'COMMAND_ERROR',
      });
      expect(String(result.json.message)).toContain("Invalid message type 'not_real'");
    });
  });

  describe('inbox', () => {
    it('emits JSON for valid input', () => {
      sendMessage(db, {
        from_agent: 'lead',
        to_agent: TEST_AGENT_ID,
        type: 'direct',
        payload: 'hello tester',
      });

      const result = runCli(['inbox', '--mark-read']);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({ ok: true });
      expect(Array.isArray(result.json.messages)).toBe(true);
      expect((result.json.messages as unknown[]).length).toBe(1);
    });

    it('emits JSON for invalid input', () => {
      const result = runCli(['inbox'], { TMUP_AGENT_ID: null });

      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({
        ok: false,
        error: 'COMMAND_ERROR',
        message: 'TMUP_AGENT_ID not set',
      });
    });
  });

  describe('heartbeat', () => {
    it('emits JSON for valid input', () => {
      const result = runCli(['heartbeat']);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({ ok: true });
      expect(getAgent(db, TEST_AGENT_ID)).toMatchObject({ id: TEST_AGENT_ID, pane_index: 0 });
    });

    it('emits JSON for invalid input', () => {
      const result = runCli(['heartbeat'], { TMUP_PANE_INDEX: 'abc' });

      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({
        ok: false,
        error: 'COMMAND_ERROR',
      });
      expect(String(result.json.message)).toContain("Invalid TMUP_PANE_INDEX: 'abc'");
    });
  });

  describe('status', () => {
    it('emits JSON for valid input', () => {
      const taskId = createClaimedTask('Status me');

      const result = runCli(['status']);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({
        ok: true,
        agent_id: TEST_AGENT_ID,
        current_task: {
          id: taskId,
          subject: 'Status me',
          status: 'claimed',
        },
      });
    });

    it('emits JSON for invalid input', () => {
      const result = runCli(['status'], { TMUP_AGENT_ID: null });

      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({
        ok: false,
        error: 'COMMAND_ERROR',
        message: 'TMUP_AGENT_ID not set',
      });
    });
  });

  describe('events', () => {
    it('emits JSON for valid input', () => {
      logEvent(db, 'lead', 'session_init', { ok: true });

      const result = runCli(['events', '--limit', '1', '--type', 'session_init']);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({ ok: true });
      expect(Array.isArray(result.json.events)).toBe(true);
      expect((result.json.events as unknown[]).length).toBe(1);
    });

    it('emits JSON for invalid input', () => {
      const result = runCli(['events', '--type', 'not_real']);

      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.json).toMatchObject({
        ok: false,
        error: 'COMMAND_ERROR',
      });
      expect(String(result.json.message)).toContain("Invalid --type 'not_real'");
    });
  });
});
