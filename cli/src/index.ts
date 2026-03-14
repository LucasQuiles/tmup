#!/usr/bin/env node
import { openDatabase, closeDatabase } from '@tmup/shared';
import type { Database } from '@tmup/shared';
import { handleCommand } from './commands/index.js';

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

function getEnv(name: string): string | undefined {
  return process.env[name];
}

function output(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    throw new CliError('Usage: tmup-cli <command> [args...]\nCommands: claim, complete, fail, checkpoint, message, inbox, heartbeat, status, events');
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  // DB path from env
  const dbPath = getEnv('TMUP_DB');
  if (!dbPath) {
    throw new CliError('TMUP_DB not set');
  }

  let db: Database | null = null;
  try {
    db = openDatabase(dbPath);
    const result = await handleCommand(db, command, commandArgs, {
      agentId: getEnv('TMUP_AGENT_ID'),
      paneIndex: getEnv('TMUP_PANE_INDEX'),
      sessionName: getEnv('TMUP_SESSION_NAME'),
      sessionDir: getEnv('TMUP_SESSION_DIR'),
      taskId: getEnv('TMUP_TASK_ID'),
      projectDir: getEnv('TMUP_PROJECT_DIR') ?? getEnv('TMUP_WORKING_DIR'),
    });
    output(result);
  } catch (error) {
    if (error instanceof CliError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    output({ ok: false, error: 'COMMAND_ERROR', message });
    process.exit(1);
  } finally {
    if (db) closeDatabase(db);
  }
}

main().catch((error) => {
  if (error instanceof CliError) {
    output({ ok: false, error: 'CLI_ERROR', message: error.message });
    process.exit(1);
  }
  console.error(JSON.stringify({ ok: false, error: 'SYSTEM_ERROR', message: String(error) }));
  process.exit(2);
});
