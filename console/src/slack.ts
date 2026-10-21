/**
 * Slack "Add to Slack" install flow (OAuth v2 + incoming webhooks).
 *
 * The user flips the switch in Settings, Slack asks which channel to post to,
 * and the callback stores the generated incoming-webhook URL (sealed with
 * SECRETS_KEY) as the project's Slack connection. The existing notify job then
 * posts drift digests through it, so no bot-token plumbing is needed.
 *
 * The OAuth state is a signed, expiring payload — the callback is public, so
 * it must not trust anything else from the query string.
 */
import type { Env } from "./env.js";

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const ACCESS_URL = "https://slack.com/api/oauth.v2.access";
const STATE_TTL_MS = 10 * 60 * 1000;
const SCOPES = "incoming-webhook";

export interface SlackInstallState {
  projectId: string;
  workspaceId: string;
  userId: string;
  expiresAt: number;
}

export interface SlackInstallation {
  webhookUrl: string;
  teamName: string | null;
  channelName: string | null;
}

export function slackOAuthConfigured(env: Env): boolean {
  return Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SECRETS_KEY);
}

export function slackRedirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/api/slack/oauth/callback`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function hmacSignature(secret: string, payload: string): Promise<string> {
  const raw = fromBase64Url(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return toBase64Url(new Uint8Array(signature));
}

function signatureMatches(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

export async function signSlackState(
  env: Env,
  state: Omit<SlackInstallState, "expiresAt">,
): Promise<string | null> {
  if (!env.SECRETS_KEY) return null;
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ ...state, expiresAt: Date.now() + STATE_TTL_MS }),
    ),
  );
  return `${payload}.${await hmacSignature(env.SECRETS_KEY, payload)}`;
}

export async function verifySlackState(
  env: Env,
  value: string,
): Promise<SlackInstallState | null> {
  if (!env.SECRETS_KEY) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = await hmacSignature(env.SECRETS_KEY, payload);
  if (!signatureMatches(signature, expected)) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as
      Partial<SlackInstallState>;
    if (
      typeof parsed.projectId !== "string" ||
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt < Date.now()
    ) {
      return null;
    }
    return {
      projectId: parsed.projectId,
      workspaceId: parsed.workspaceId,
      userId: parsed.userId,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export function slackAuthorizeUrl(
  env: Env,
  state: string,
  redirectUri: string,
): string | null {
  if (!slackOAuthConfigured(env)) return null;
  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID ?? "",
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeSlackCode(
  env: Env,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackInstallation | null> {
  if (!slackOAuthConfigured(env)) return null;
  const body = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID ?? "",
    client_secret: env.SLACK_CLIENT_SECRET ?? "",
    code,
    redirect_uri: redirectUri,
  });
  try {
    const response = await fetchImpl(ACCESS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as {
      ok?: unknown;
      team?: { name?: unknown };
      incoming_webhook?: { url?: unknown; channel?: unknown };
    } | null;
    if (!payload?.ok || typeof payload.incoming_webhook?.url !== "string") {
      return null;
    }
    return {
      webhookUrl: payload.incoming_webhook.url,
      teamName:
        typeof payload.team?.name === "string" ? payload.team.name : null,
      channelName:
        typeof payload.incoming_webhook.channel === "string"
          ? payload.incoming_webhook.channel
          : null,
    };
  } catch {
    return null;
  }
}
