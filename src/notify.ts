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

import type { NotifyMessage, NotifyState } from "./core/notify.js";

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
