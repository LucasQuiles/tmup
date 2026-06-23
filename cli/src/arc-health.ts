import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Database } from '@tmup/shared';
import { getSchemaVersion } from '@tmup/shared';

export const TMUP_COMMAND_NAMESPACE = [
  'claim',
  'complete',
  'fail',
  'checkpoint',
  'message',
  'inbox',
  'heartbeat',
  'status',
  'events',
  'arc-health',
] as const;

interface ArcHealthEnv {
  agentId?: string;
  paneIndex?: string;
  sessionName?: string;
  sessionDir?: string;
  projectDir?: string;
  dbPath?: string;
  cwd?: string;
}

interface InstalledArcBinding {
  consumer: string;
  arc_version: string;
  modules: string[];
  emits: string[];
  binding: string;
  payload_sha: string;
}

function parseStringField(text: string, name: string): string {
  const match = text.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
  if (!match) throw new Error(`ARC binding field missing: ${name}`);
  return match[1];
}

function parseStringArrayField(text: string, name: string): string[] {
  const match = text.match(new RegExp(`^${name}\\s*=\\s*\\[([^\\]]*)\\]\\s*$`, 'm'));
  if (!match) throw new Error(`ARC binding array missing: ${name}`);
  return [...match[1].matchAll(/"([^"]*)"/g)].map((item) => item[1]);
}

function readInstalledBinding(pluginRoot: string): InstalledArcBinding {
  const arcToml = join(pluginRoot, '.arc', 'arc.toml');
  const stat = lstatSync(arcToml);
  if (stat.isSymbolicLink()) {
    throw new Error(`ARC binding must not be a symlink: ${arcToml}`);
  }
  const text = readFileSync(arcToml, 'utf8');
  return {
    consumer: parseStringField(text, 'consumer'),
    arc_version: parseStringField(text, 'arc_version'),
    modules: parseStringArrayField(text, 'modules'),
    emits: parseStringArrayField(text, 'emits'),
    binding: parseStringField(text, 'binding'),
    payload_sha: parseStringField(text, 'payload_sha'),
  };
}

export function buildArcHealth(
  db: Database,
  pluginRootArg: string | undefined,
  env: ArcHealthEnv
): Record<string, unknown> {
  const pluginRoot = resolve(pluginRootArg ?? env.cwd ?? process.cwd());
  const binding = readInstalledBinding(pluginRoot);
  if (binding.consumer !== 'tmup') {
    throw new Error(`installed ARC binding consumer mismatch: expected tmup, got ${binding.consumer}`);
  }

  return {
    ok: true,
    consumer: 'tmup',
    proof_surface: 'runtime-health:tmup',
    binding,
    runtime: {
      surface: 'tmup-cli',
      command: 'arc-health',
      plugin_root: pluginRoot,
      cwd: env.cwd ?? null,
      project_dir: env.projectDir ?? null,
    },
    db: {
      configured: Boolean(env.dbPath),
      opened: true,
      schema_version: getSchemaVersion(db),
    },
    session: {
      name: env.sessionName ?? null,
      dir: env.sessionDir ?? null,
      agent_id_present: Boolean(env.agentId),
      pane_index: env.paneIndex ?? null,
    },
    command_namespace: [...TMUP_COMMAND_NAMESPACE],
    limitations: [
      'proves tmup CLI runtime can observe its installed ARC binding',
      'does not prove worker task success',
      'does not prove prompt adherence',
    ],
  };
}
