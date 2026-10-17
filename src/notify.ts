/**
 * Slack notifications. The drift job plans the message (elf core's
 * buildNotifyMessage + decideNotification — the same formatter as the CLI's
 * `--notify`), the notify job posts it, and notification_rules decide when.
 *
 * Dedupe is server-side: every drift run stores a fingerprint (elf core
 * driftFingerprint) and a notify only goes out when the fingerprint changes —
 * or when the project's rules say always, or a deprecation deadline passed.
 * A pending notify job carries the built message, so a retry re-posts exactly
 * what the drift run decided on (at-least-once; duplicates possible in theory,
 * never a stale message).
 */
import {
  buildNotifyMessage,
  decideNotification,
  type NotifyMessage,
  type NotifyState,
} from "elf-tokens/core";
import { importSecretsKey, openSecret } from "./db/crypto.js";
import type { Env } from "./env.js";
import type { DriftOutcome } from "./drift.js";

export type NotificationMode = "change" | "always" | "never";

export const DEFAULT_NOTIFICATION_RULES: { mode: NotificationMode; overdueAlways: boolean } = {
  mode: "change",
  overdueAlways: true,
};

export interface NotificationRules {
  mode: NotificationMode;
  overdueAlways: boolean;
}

export interface NotifyPlan {
  reason: "overdue" | "always" | "first-report" | "state-changed";
  message: NotifyMessage;
}

export async function readNotificationRules(db: D1Database, projectId: string): Promise<NotificationRules> {
  const row = await db
    .prepare("SELECT mode, overdueAlways FROM notification_rules WHERE projectId = ?")
    .bind(projectId)
    .first<{ mode: NotificationMode; overdueAlways: number }>();
  if (!row) return { ...DEFAULT_NOTIFICATION_RULES };
  return { mode: row.mode, overdueAlways: row.overdueAlways === 1 };
}

export async function writeNotificationRules(
  db: D1Database,
  projectId: string,
  rules: NotificationRules,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notification_rules (projectId, mode, overdueAlways) VALUES (?, ?, ?)
       ON CONFLICT(projectId) DO UPDATE SET mode = excluded.mode, overdueAlways = excluded.overdueAlways`,
    )
    .bind(projectId, rules.mode, rules.overdueAlways ? 1 : 0)
    .run();
}

/**
 * Decide whether the run just recorded deserves a Slack message, and build it.
 * Null means "nothing to say" — no job is enqueued at all.
 *
 * Rules: `never` silences everything except an overdue deprecation when
 * overdueAlways is set (that flag is the off switch); `always` notifies on
 * every run; `change` (default) notifies when the elf-core fingerprint moved.
 */
export async function planDriftNotification(
  db: D1Database,
  projectId: string,
  outcome: DriftOutcome,
  options: { consoleOrigin?: string } = {},
): Promise<NotifyPlan | null> {
  if (!outcome.result || !outcome.fingerprint) return null;

  const slack = await db
    .prepare("SELECT encryptedSecret FROM connections WHERE projectId = ? AND type = 'slack'")
    .bind(projectId)
    .first<{ encryptedSecret: string | null }>();
  if (!slack?.encryptedSecret) return null;

  const rules = await readNotificationRules(db, projectId);
  const previousRow = await db
    .prepare(
      `SELECT fingerprint, driftFound FROM drift_runs
       WHERE projectId = ? AND id != ? ORDER BY createdAt DESC, rowid DESC LIMIT 1`,
    )
    .bind(projectId, outcome.runId)
    .first<{ fingerprint: string | null; driftFound: number | null }>();
  const previous: NotifyState | null =
    previousRow?.fingerprint != null
      ? { fingerprint: previousRow.fingerprint, driftFound: previousRow.driftFound === 1 }
      : null;

  const overdue = (outcome.counts.deprecationOverdue ?? 0) > 0;
  let reason: NotifyPlan["reason"];
  if (overdue && rules.overdueAlways) {
    reason = "overdue";
  } else if (rules.mode === "never") {
    return null;
  } else if (rules.mode === "always") {
    reason = "always";
  } else {
    const decision = decideNotification(previous, outcome.result);
    if (!decision.send) return null;
    reason = decision.reason === "first-report" ? "first-report" : "state-changed";
  }

  const message = buildNotifyMessage(outcome.result, {
    fileKey: outcome.code?.config.figmaFileKey ?? "unknown",
    figmaSource: outcome.code?.config.figmaSource ?? "figma",
    codebaseSource: outcome.code?.config.codebaseSource ?? "codebase",
    checkedAt: outcome.createdAt,
    ...(options.consoleOrigin ? { url: `${options.consoleOrigin}/#/p/${projectId}` } : {}),
  }, "slack", previous);

  return { reason, message };
}

/** Post one built message to a Slack incoming webhook. Throws on non-2xx. */
export async function postSlackMessage(
  webhookUrl: string,
  message: NotifyMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`the Slack webhook responded ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

/**
 * Execute a notify job: load the stored message, decrypt the project's Slack
 * webhook, post. Missing payload or a connection cleared since planning are
 * silent no-ops; network/infra failures throw for the retry path.
 */
export async function runNotifyJob(
  env: Env,
  job: { projectId: string; payload: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!job.payload) return false;
  const row = await env.DB
    .prepare("SELECT encryptedSecret, iv FROM connections WHERE projectId = ? AND type = 'slack'")
    .bind(job.projectId)
    .first<{ encryptedSecret: string | null; iv: string | null }>();
  if (!row?.encryptedSecret || !row.iv) return false;
  if (!env.SECRETS_KEY) throw new Error("SECRETS_KEY is not configured on the server.");
  const key = await importSecretsKey(env.SECRETS_KEY);
  const webhookUrl = await openSecret({ ciphertext: row.encryptedSecret, iv: row.iv }, key);
  const plan = JSON.parse(job.payload) as NotifyPlan;
  await postSlackMessage(webhookUrl, plan.message, fetchImpl);
  return true;
}

/** The Connections screen's "Send test message" body — same Slack payload shape. */
export function buildSlackTestMessage(projectName: string, url?: string): NotifyMessage {
  const fallback = `elf test message: the Slack connection for “${projectName}” works.`;
  return {
    text: url ? `${fallback} · ${url}` : fallback,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "elf ↔ Slack" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Test message from the elf console. Notifications for *${projectName}* will arrive here.`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: url ? `Sent from the elf console · <${url}|Open the project>` : "Sent from the elf console",
          },
        ],
      },
    ],
  };
}
