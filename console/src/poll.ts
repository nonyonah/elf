/**
 * The 15-minute Figma sweep: for every project with a Figma connection, ask
 * the REST Files endpoint (never the Variables endpoints — plan-gated) for the
 * file's current version. A newer version than the last snapshot marks the
 * project stale (`figma_sources.figmaDirtyAt`) so the UI asks the designer to
 * open the file with the bridge plugin, which can push a fresh snapshot.
 *
 * Permission/plan errors are terminal for the poll: the message lands on the
 * connection (`statusMessage`) and nothing retries until the next sweep.
 * A successful poll clears a previous error.
 */
import { importSecretsKey, openSecret } from "./db/crypto.js";
import type { Env } from "./env.js";

export const POLL_CRON = "*/15 * * * *";
export const POLL_MIN_INTERVAL_MS = 14 * 60 * 1000;
const FIGMA_FILES_API = "https://api.figma.com/v1/files";

interface PollRow {
  projectId: string;
  fileKey: string;
  lastVersion: string | null;
  lastPolledAt: string | null;
  encryptedSecret: string | null;
  iv: string | null;
  status: string;
}

export interface PollOutcome {
  polled: number;
  changed: number;
  failed: number;
}

function figmaErrorMessage(status: number): string {
  if (status === 401) return "Figma rejected the token — check it in Settings → Integrations.";
  if (status === 403) return "Figma denied access to this file — check the token's scopes and file permissions.";
  if (status === 404) return "Figma could not find this file — check the file key in Settings → Integrations.";
  return `Figma returned ${status}.`;
}

export async function pollFigmaSources(
  env: Env,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<PollOutcome> {
  const outcome: PollOutcome = { polled: 0, changed: 0, failed: 0 };
  if (!env.SECRETS_KEY) return outcome;

  const rows = await env.DB.prepare(
    `SELECT fs.projectId AS projectId, fs.fileKey AS fileKey, fs.lastVersion AS lastVersion,
            fs.lastPolledAt AS lastPolledAt, c.encryptedSecret AS encryptedSecret, c.iv AS iv, c.status AS status
     FROM figma_sources fs
     JOIN connections c ON c.projectId = fs.projectId AND c.type = 'figma'
     WHERE c.encryptedSecret IS NOT NULL AND c.iv IS NOT NULL`,
  ).all<PollRow>();
  if (rows.results.length === 0) return outcome;

  const key = await importSecretsKey(env.SECRETS_KEY);
  const nowIso = now.toISOString();

  for (const row of rows.results) {
    if (row.lastPolledAt && now.getTime() - Date.parse(row.lastPolledAt) < POLL_MIN_INTERVAL_MS) continue;

    let token: string;
    try {
      token = await openSecret({ ciphertext: row.encryptedSecret ?? "", iv: row.iv ?? "" }, key);
    } catch {
      outcome.failed += 1;
      continue;
    }

    let response: Response;
    try {
      response = await fetchImpl(`${FIGMA_FILES_API}/${encodeURIComponent(row.fileKey)}?depth=1`, {
        headers: { "X-Figma-Token": token },
      });
    } catch {
      // Network/outage — leave state untouched; the next sweep tries again.
      outcome.failed += 1;
      continue;
    }

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        await env.DB
          .prepare(
            "UPDATE connections SET status = 'error', statusMessage = ?, updatedAt = ? WHERE projectId = ? AND type = 'figma'",
          )
          .bind(figmaErrorMessage(response.status), nowIso, row.projectId)
          .run();
      }
      outcome.failed += 1;
      continue;
    }

    const file = (await response.json().catch(() => null)) as { version?: string; lastModified?: string; name?: string } | null;
    if (!file?.version) {
      outcome.failed += 1;
      continue;
    }

    const changed = row.lastVersion !== null && file.version !== row.lastVersion;
    if (changed) {
      await env.DB
        .prepare(
          `UPDATE figma_sources
           SET lastVersion = ?, lastModifiedAt = ?, lastPolledAt = ?, figmaDirtyAt = ?,
               fileName = COALESCE(?, fileName)
           WHERE projectId = ?`,
        )
        .bind(file.version, file.lastModified ?? null, nowIso, nowIso, file.name ?? null, row.projectId)
        .run();
    } else {
      await env.DB
        .prepare(
          `UPDATE figma_sources
           SET lastVersion = ?, lastModifiedAt = ?, lastPolledAt = ?, fileName = COALESCE(?, fileName)
           WHERE projectId = ?`,
        )
        .bind(file.version, file.lastModified ?? null, nowIso, file.name ?? null, row.projectId)
        .run();
    }

    if (row.status === "error") {
      await env.DB
        .prepare(
          "UPDATE connections SET status = 'configured', statusMessage = NULL, updatedAt = ? WHERE projectId = ? AND type = 'figma'",
        )
        .bind(nowIso, row.projectId)
        .run();
    }

    outcome.polled += 1;
    if (changed) outcome.changed += 1;
  }

  return outcome;
}
