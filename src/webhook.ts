import { randomBytes } from "node:crypto";
import type { DriftConfig } from "./types.js";

export const DEFAULT_EVENT_TYPES = [
  "FILE_VARIABLES_UPDATE",
  "FILE_VARIABLES_CREATE",
  "FILE_VARIABLES_REMOVE",
];

export const DEFAULT_PASSCODE_ENV = "FIGMA_WEBHOOK_PASSCODE";

interface FigmaWebhook {
  id: string;
  event_type: string;
  endpoint: string;
  status?: string;
}

async function figmaRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.figma.com${path}`, {
    ...init,
    headers: {
      "X-Figma-Token": token,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 400);
    throw new Error(`Figma API returned ${response.status} for ${path}: ${body}`);
  }
  return (await response.json()) as T;
}

export async function listWebhooks(fileKey: string, token: string): Promise<FigmaWebhook[]> {
  const data = await figmaRequest<{ webhooks?: FigmaWebhook[] }>(
    `/v2/webhooks?context=file&context_id=${encodeURIComponent(fileKey)}`,
    token,
  );
  return data.webhooks ?? [];
}

export async function registerWebhooks(
  config: DriftConfig,
  token: string,
  endpoint: string,
  passcode: string,
): Promise<string[]> {
  const eventTypes =
    config.webhook?.eventTypes && config.webhook.eventTypes.length > 0
      ? config.webhook.eventTypes
      : DEFAULT_EVENT_TYPES;

  const existing = await listWebhooks(config.figma.fileKey, token);
  const results: string[] = [];

  for (const eventType of eventTypes) {
    const found = existing.find((webhook) => webhook.event_type === eventType);

    if (found && found.endpoint === endpoint) {
      results.push(`${eventType}: already registered (${found.id})`);
    } else if (found) {
      await figmaRequest(`/v2/webhooks/${found.id}`, token, {
        method: "PUT",
        body: JSON.stringify({ event_type: eventType, endpoint, passcode }),
      });
      results.push(`${eventType}: endpoint updated (${found.id})`);
    } else {
      const created = await figmaRequest<{ id: string }>("/v2/webhooks", token, {
        method: "POST",
        body: JSON.stringify({
          event_type: eventType,
          context: "file",
          context_id: config.figma.fileKey,
          endpoint,
          passcode,
          description: "elf-tokens design drift watcher",
        }),
      });
      results.push(`${eventType}: created (${created.id})`);
    }
  }

  return results;
}

export function generatePasscode(): string {
  return randomBytes(24).toString("hex");
}
