/**
 * The CLI-side half of the notify flow: the dedupe state file and the webhook
 * post. Message building is pure and lives in core/notify.ts — the CLI and
 * the elf console post from the same code.
 */
import { closeSync, constants, fstatSync, openSync, mkdirSync, readFileSync, writeFileSync, lstatSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export {
  notificationItems,
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

import type { DashboardConfig, NotifyConfig } from "./core/types.js";
import type { NotifyMessage, NotifyState } from "./core/notify.js";
import { readSlackWebhook, SLACK_WEBHOOK_FILE } from "./slack.js";

/** Missing, unreadable, or pre-fingerprint state files count as a first report. */
export function readNotifyState(path: string): NotifyState | null {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: Partial<NotifyState>;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) return null;
      raw = JSON.parse(readFileSync(fd, "utf8")) as Partial<NotifyState>;
    } finally { closeSync(fd); }
    if (typeof raw.fingerprint === "string" && raw.fingerprint && typeof raw.driftFound === "boolean") {
      return { fingerprint: raw.fingerprint, driftFound: raw.driftFound, ...(Array.isArray(raw.items) ? {items: raw.items.filter(item => item && typeof item.key === "string" && typeof item.signature === "string" && typeof item.text === "string").slice(0, 5000)} : {}) };
    }
  } catch {
    // No state yet or unreadable — treated as a first report.
  }
  return null;
}

export function writeNotifyState(path: string, state: NotifyState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directory = lstatSync(dirname(path)); const existing = lstatSync(path, {throwIfNoEntry: false});
  if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== "win32" && ((directory.mode & 0o022) !== 0 || directory.uid !== process.getuid?.())) || (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1))) throw new Error("Notification state must use a regular file, not a link.");
  const temporary = join(dirname(path), `.notify-${randomBytes(12).toString("hex")}.tmp`);
  try {writeFileSync(temporary, `${JSON.stringify(state)}\n`, {flag: "wx", mode: 0o600}); renameSync(temporary, path);}
  finally {rmSync(temporary, {force: true});}
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

/** Resolve the link Slack uses for the full report: explicit config, then the console project page. */
export function resolveReportUrl(config: {
  notify?: NotifyConfig;
  dashboard?: DashboardConfig;
}): string | undefined {
  const explicit = config.notify?.reportUrl?.trim();
  if (explicit) return explicit;
  const projectId = config.dashboard?.projectId?.trim();
  if (!projectId) return undefined;
  const base = (config.dashboard?.url ?? "").replace(/\/+$/, "");
  return base ? `${base}/#/p/${encodeURIComponent(projectId)}` : undefined;
}

export async function postNotification(
  webhookUrl: string,
  format: "slack" | "text",
  message: NotifyMessage,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": format === "slack" ? "application/json" : "text/plain" },
    body: format === "slack" ? JSON.stringify(message) : message.text,
  });
  if (!response.ok) {
    throw new Error(`the webhook responded ${response.status}`);
  }
}
