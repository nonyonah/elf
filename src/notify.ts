/**
 * The CLI-side half of the notify flow: the dedupe state file and the webhook
 * post. Message building is pure and lives in core/notify.ts — the CLI and
 * the elf console post from the same code.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export {
  buildNotifyMessage,
  decideNotification,
  driftFingerprint,
  hasNotes,
  type NotifyDecision,
  type NotifyDecisionReason,
  type NotifyMessage,
  type NotifyMeta,
  type NotifyState,
} from "./core/notify.js";

import type { NotifyConfig } from "./core/types.js";
import type { NotifyMessage, NotifyState } from "./core/notify.js";
import { readSlackWebhook, SLACK_WEBHOOK_FILE } from "./slack.js";

/** Missing, unreadable, or pre-fingerprint state files count as a first report. */
export function readNotifyState(path: string): NotifyState | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<NotifyState>;
    if (typeof raw.fingerprint === "string" && raw.fingerprint && typeof raw.driftFound === "boolean") {
      return { fingerprint: raw.fingerprint, driftFound: raw.driftFound };
    }
  } catch {
    // No state yet or unreadable — treated as a first report.
  }
  return null;
}

export function writeNotifyState(path: string, state: NotifyState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export interface ResolvedNotifyWebhook {
  url: string;
  /** Where the URL came from, for the CLI's confirmation line. */
  source: string;
}

/**
 * The notify webhook comes from the configured env var first. If that is
 * unset, a Slack connection made through `elf connect slack` / `elf settings`
 * is the fallback — that is what makes the settings toggle enough to turn on
 * CLI notifications. Plain-text webhooks (ntfy etc.) stay env-only.
 */
export function resolveNotifyWebhook(
  notify: NotifyConfig | undefined,
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedNotifyWebhook | null {
  if (!notify) return null;
  const fromEnv = env[notify.webhookEnv]?.trim();
  if (fromEnv) return { url: fromEnv, source: notify.webhookEnv };
  if (notify.format !== "slack") return null;
  const stored = readSlackWebhook(configPath);
  return stored ? { url: stored.url, source: SLACK_WEBHOOK_FILE } : null;
}

export async function postNotification(
  webhookUrl: string,
  format: "slack" | "text",
  message: NotifyMessage,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": format === "slack" ? "application/json" : "text/plain" },
    body: format === "slack" ? JSON.stringify(message) : message.text,
  });
  if (!response.ok) {
    throw new Error(`the webhook responded ${response.status}`);
  }
}
