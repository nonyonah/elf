import { loadConfig } from "./config.js";
import { readActivity } from "./activity.js";
import { postNotification, resolveNotifyWebhook } from "./notify.js";
import { SyncAlerts } from "./sync-alerts.js";

const deliveries = new Map<string, Promise<void>>();

export async function deliverSyncNotifications(configPath: string): Promise<void> {
  const pending = deliveries.get(configPath);
  if (pending) return pending;
  const delivery = deliver(configPath);
  deliveries.set(configPath, delivery);
  try { await delivery; } finally { deliveries.delete(configPath); }
}

/** Delivery advances only after the webhook accepts the verified sync details. */
async function deliver(configPath: string): Promise<void> {
  const config = loadConfig(configPath);
  const webhook = resolveNotifyWebhook(config.notify, configPath);
  if (!config.notify || !webhook) return;
  const state = new SyncAlerts(configPath, "sync-delivery.json");
  const previous = state.current();
  const history = readActivity(configPath).reverse();
  const cursor = history.findIndex(item => item.id === previous);
  const pending = history.slice(cursor + 1).filter(item => item.changes?.length);
  if (!pending.length) return;
  const changes = pending.flatMap(item => item.changes!);
  const lines = changes.slice(0, 10).map(change => `${change.action}: ${change.name}\n${change.before ?? "Not previously present"} → ${change.after}`);
  const text = [`Elf applied ${changes.length} resource changes to Figma.`, ...lines,
    ...(changes.length > 10 ? [`${changes.length - 10} more changes. View synced resources in Elf Settings.`] : [])].join("\n");
  await state.update(pending.at(-1)!.id, () => postNotification(webhook.url, config.notify!.format, {
    text,
    ...(config.notify!.format === "slack" ? {blocks: [{type: "section", text: {type: "plain_text", text: text.slice(0, 2900)}}]} : {}),
  }));
}
