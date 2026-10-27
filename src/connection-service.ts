import { createHash, randomBytes } from "node:crypto";
import type { SlackWebhookInfo } from "./slack.js";

export const DEFAULT_CONNECTION_ORIGIN = "https://elf-console.nonyonah.workers.dev";
export function connectionOrigin(): string {
  const url = new URL(process.env.ELF_CONNECTION_ORIGIN ?? DEFAULT_CONNECTION_ORIGIN);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Elf connection service must be an HTTPS origin.");
  return url.origin;
}
export function startConnection(provider: "slack" | "figma", port: number) {
  const state = randomBytes(32).toString("hex"); const verifier = randomBytes(32).toString("base64url");
  const origin = connectionOrigin();
  const url = new URL(`/api/local-connect/${provider}/start`, origin);
  url.search = new URLSearchParams({state, challenge: createHash("sha256").update(verifier).digest("base64url"), return_uri: `http://127.0.0.1:${port}/api/${provider}/broker-callback`}).toString();
  return {url: url.href, origin, state, verifier, expiresAt: Date.now() + 10 * 60_000};
}
export function startSlackConnection(port: number) {return startConnection("slack", port);}
export async function finishConnection(grant: string, verifier: string, origin: string, provider: "slack" | "figma", fetchImpl: typeof fetch = fetch): Promise<unknown> {
  if (!/^[a-f0-9]{64}$/.test(grant)) throw new Error("Invalid connection grant.");
  const response = await fetchImpl(new URL(`/api/local-connect/${provider}/exchange`, origin), {method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: {"Content-Type": "application/json"}, body: JSON.stringify({grant, verifier})});
  if (!response.ok || !response.body) throw new Error("Account connection could not be completed. Reconnect from Elf Settings.");
  return readConnectionJson(response);
}
export async function finishSlackConnection(grant: string, verifier: string, origin: string, fetchImpl: typeof fetch = fetch): Promise<SlackWebhookInfo> {
  const info = await finishConnection(grant, verifier, origin, "slack", fetchImpl) as SlackWebhookInfo;
  if (typeof info.url !== "string" || !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(info.url) || [info.channel, info.channelId, info.teamName, info.teamId, info.configuredAt].some(value => typeof value !== "string")) throw new Error("Connection service returned invalid Slack credentials.");
  return info;
}

export async function readConnectionJson(response: Response, limit = 16_384): Promise<unknown> {
  if (!response.body) throw new Error("Missing response body.");
  const reader = response.body.getReader(); let size = 0; let text = ""; const decoder = new TextDecoder();
  try { while (true) {const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error("Connection response is too large."); text += decoder.decode(value, {stream: true});} }
  finally {await reader.cancel().catch(() => {});}
  return JSON.parse(text + decoder.decode()) as unknown;
}
