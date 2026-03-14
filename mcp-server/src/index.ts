#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  openDatabase,
  closeDatabase,
  getCurrentSession,
  getSessionDbPath,
  runMaintenance,
} from '@tmup/shared';
import type { Database } from '@tmup/shared';

import { toolDefinitions, handleToolCall } from './tools/index.js';

// Crash resilience: low threshold for stateful SQLite server.
// Uncaught exceptions leave process in undefined state — shut down quickly.
let uncaughtCount = 0;
const MAX_UNCAUGHT = 3;

process.on('uncaughtException', (err) => {
  console.error('[tmup-mcp] Uncaught exception:', err);
  uncaughtCount++;
  if (uncaughtCount >= MAX_UNCAUGHT) {
    console.error(`[tmup-mcp] ${MAX_UNCAUGHT} uncaught exceptions — shutting down to protect database integrity`);
    shutdown('uncaughtException');
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[tmup-mcp] Unhandled rejection:', reason);
  uncaughtCount++;
  if (uncaughtCount >= MAX_UNCAUGHT) {
    console.error(`[tmup-mcp] ${MAX_UNCAUGHT} unhandled rejections — shutting down to protect database integrity`);
    shutdown('unhandledRejection');
  }
});

// Lazy DB connection
let db: Database | null = null;
let currentSessionId: string | null = null;
let walCheckpointTimer: ReturnType<typeof setInterval> | null = null;

const MAINTENANCE_INTERVAL_MS = 60000;  // 60s

let consecutiveMaintenanceFailures = 0;

function startMaintenanceTimer(): void {
  if (walCheckpointTimer) clearInterval(walCheckpointTimer);
  consecutiveMaintenanceFailures = 0;
  walCheckpointTimer = setInterval(() => {
    if (!db) return;
    const result = runMaintenance(db);
    for (const warn of result.warnings) {
      console.error(`[tmup-mcp] Maintenance warning: ${warn}`);
    }
    if (result.errors.length > 0) {
      consecutiveMaintenanceFailures++;
      for (const err of result.errors) {
        console.error(`[tmup-mcp] Maintenance error: ${err}`);
      }
      if (consecutiveMaintenanceFailures === 5) {
        console.error(`[tmup-mcp] Maintenance has failed 5 consecutive times — potential persistent issue`);
      }
    } else {
      consecutiveMaintenanceFailures = 0;
    }
  }, MAINTENANCE_INTERVAL_MS);
}

export function getDb(): Database | null {
  return db;
}

export function ensureDb(): Database {
  if (db) return db;

  const sessionId = getCurrentSession();
  if (!sessionId) {
    throw new Error('No active tmup session. Call tmup_init first.');
  }

  const dbPath = getSessionDbPath(sessionId);
  if (!dbPath) {
    throw new Error(`Session ${sessionId} not found in registry`);
  }

  db = openDatabase(dbPath);
  currentSessionId = sessionId;
  startMaintenanceTimer();

  return db;
}

export function switchSession(sessionId: string, dbPath: string): void {
  if (db) {
    if (walCheckpointTimer) clearInterval(walCheckpointTimer);
    closeDatabase(db);
    db = null;
    walCheckpointTimer = null;
    currentSessionId = null;
  }

  try {
    db = openDatabase(dbPath);
  } catch (err) {
    db = null;
    currentSessionId = null;
    walCheckpointTimer = null;
    throw new Error(`Failed to open database for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  currentSessionId = sessionId;
  startMaintenanceTimer();
}

export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

// Create MCP Server
const server = new Server(
  { name: 'tmup', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: toolDefinitions };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await handleToolCall(request.params.name, request.params.arguments ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tmup-mcp] Tool ${request.params.name} error: ${message}`);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Graceful shutdown — ensure WAL checkpoint and cleanup
function shutdown(signal: string) {
  console.error(`[tmup-mcp] Received ${signal}, shutting down`);
  if (walCheckpointTimer) clearInterval(walCheckpointTimer);
  if (db) {
    try {
      db.pragma('wal_checkpoint(PASSIVE)');
    } catch (err) {
      console.error('[tmup-mcp] WAL checkpoint on shutdown failed:', err instanceof Error ? err.message : String(err));
    }
    closeDatabase(db);
    db = null;
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Main
async function main() {
  console.error('[tmup-mcp] Starting tmup MCP server');
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[tmup-mcp] Server error:', error);
  process.exit(1);
});
