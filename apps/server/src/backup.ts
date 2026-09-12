import {
  agent,
  approval,
  artifact,
  channel,
  company,
  db,
  kgEdge,
  kgNode,
  message,
  project,
  projectRepo,
  providerConfig,
  run,
  runStep,
  secret,
  task,
  team,
  toolConfig,
  wikiPage,
} from '@katnor/db';
import { listPages, readPage } from '@katnor/knowledge';

const BACKUP_VERSION = 1;

/**
 * A point-in-time export of everything an owner would need to stand
 * Katnor back up elsewhere (PLAN.md Phase 5's "backups/export", downloadable
 * from Settings). Deliberately NOT a ../trpc/routers/settings.ts procedure:
 * a multi-megabyte JSON blob doesn't belong going through tRPC's normal
 * request/response path - see src/index.ts's `/export/backup` route, the
 * one caller of `buildBackupExport` below.
 *
 * Deliberately excludes:
 * - `event`: an append-only, unboundedly-growing fan-out log for the live
 *   WebSocket feed (src/ws.ts) - every event it carries is already
 *   reconstructable from the row it was raised about (a `run` row for
 *   `run.started`/`run.finished`, a `message` row for `message.created`,
 *   ...), so it's derived data, not a second source of truth worth
 *   doubling the export size for.
 * - Actual artifact file bytes: `artifact` rows (below) carry `storage_key`
 *   pointers into @katnor/artifacts' storage backend (local disk or MinIO),
 *   but not the bytes themselves - restoring those would mean also
 *   snapshotting whichever backend is configured, which is out of scope
 *   for a single JSON file.
 * - Secret/API-key material in cleartext: `provider_config.api_key_encrypted`
 *   and `secret.value_encrypted` are both AES-256-GCM ciphertext (see
 *   @katnor/db's crypto.ts) that only decrypts with this deployment's
 *   `SETTINGS_ENCRYPTION_KEY` - even so, this export replaces them with a
 *   plain `hasKey`/presence boolean rather than including the ciphertext,
 *   so a leaked backup file alone is never enough to recover a real key.
 *
 * No pagination/streaming: every table is read in full into memory and
 * serialized as one JSON object. Fine for the run/run_step/message volumes
 * a self-hosted single-company v1 deployment is expected to have; a
 * long-lived company with a very large `run_step` trace history is the
 * first place this would need revisiting.
 */
export interface BackupExport {
  version: number;
  exported_at: string;
  tables: Record<string, unknown[]>;
  wiki_files: Record<string, Record<string, string>>;
}

type ProviderConfigRow = typeof providerConfig.$inferSelect;
type SecretRow = typeof secret.$inferSelect;

/**
 * Same redaction `../trpc/routers/settings.ts`'s `toPublicProvider` applies
 * for the Settings UI - never the ciphertext, just whether a key is set.
 */
function redactProviderConfig(row: ProviderConfigRow) {
  const { api_key_encrypted, ...rest } = row;
  return { ...rest, has_key: api_key_encrypted !== null };
}

/**
 * Keeps the secret's name (needed to understand what
 * `tool_config.env_secret_refs` refers to) but never its ciphertext.
 */
function redactSecret(row: SecretRow) {
  const { value_encrypted: _valueEncrypted, ...rest } = row;
  return rest;
}

/**
 * Every project's wiki files (@katnor/knowledge's git-backed storage),
 * keyed by project id then relative path.
 */
async function collectWikiFiles(): Promise<Record<string, Record<string, string>>> {
  const projects = await projectRepo.list();
  const result: Record<string, Record<string, string>> = {};
  for (const proj of projects) {
    const pages = await listPages(proj.id);
    if (pages.length === 0) continue;
    const files: Record<string, string> = {};
    for (const relativePath of pages) {
      const content = await readPage(proj.id, relativePath);
      if (content !== null) files[relativePath] = content;
    }
    result[proj.id] = files;
  }
  return result;
}

export async function buildBackupExport(): Promise<BackupExport> {
  const [
    companyRows,
    teamRows,
    agentRows,
    projectRows,
    taskRows,
    runRows,
    runStepRows,
    channelRows,
    messageRows,
    artifactRows,
    toolConfigRows,
    providerConfigRows,
    approvalRows,
    kgNodeRows,
    kgEdgeRows,
    wikiPageRows,
    secretRows,
    wikiFiles,
  ] = await Promise.all([
    db.select().from(company),
    db.select().from(team),
    db.select().from(agent),
    db.select().from(project),
    db.select().from(task),
    db.select().from(run),
    db.select().from(runStep),
    db.select().from(channel),
    db.select().from(message),
    db.select().from(artifact),
    db.select().from(toolConfig),
    db.select().from(providerConfig),
    db.select().from(approval),
    db.select().from(kgNode),
    db.select().from(kgEdge),
    db.select().from(wikiPage),
    db.select().from(secret),
    collectWikiFiles(),
  ]);

  return {
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    tables: {
      companies: companyRows,
      teams: teamRows,
      agents: agentRows,
      projects: projectRows,
      tasks: taskRows,
      runs: runRows,
      run_steps: runStepRows,
      channels: channelRows,
      messages: messageRows,
      artifacts: artifactRows,
      tool_configs: toolConfigRows,
      provider_configs: providerConfigRows.map(redactProviderConfig),
      approvals: approvalRows,
      kg_nodes: kgNodeRows,
      kg_edges: kgEdgeRows,
      wiki_pages: wikiPageRows,
      secrets: secretRows.map(redactSecret),
    },
    wiki_files: wikiFiles,
  };
}
