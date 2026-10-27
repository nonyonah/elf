/**
 * Slack incoming-webhook installation through the hosted connection service.
 * App secrets stay on the Worker. The local client redeems a short-lived,
 * single-use grant with its own verifier and privately stores the webhook.
 * An explicit local client secret retains the developer-only direct flow.
 */
import { startSlackConnection, finishSlackConnection } from "./connection-service.js";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Legacy direct-flow client ID; overridden by ELF_SLACK_CLIENT_ID. */
export const DEFAULT_SLACK_CLIENT_ID = "10923381069686.12320909036695";

/** Scopes we request. `incoming-webhook` is the only one needed for posting messages.
 *  The confidential server-side exchange returns channel/team information. */
export const SLACK_SCOPES = "incoming-webhook";

/** Slack OAuth endpoints */
const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";

/** Stable local port for the Slack callback. */
export const DEFAULT_SLACK_CALLBACK_PORT = 3000;

/** Redirect URL to register in the Slack app. */
export const SLACK_REDIRECT_URL = `http://localhost:${DEFAULT_SLACK_CALLBACK_PORT}/callback`;

/** Build the actual callback URL for the local server's current port. */
export function getSlackRedirectUri(port: number): string {
  return `http://localhost:${port}/callback`;
}

/** Where we store the webhook locally (gitignored via .gitignore entry) */
export const SLACK_WEBHOOK_FILE = ".elf/slack-webhook.json";

export interface SlackWebhookInfo {
  url: string;
  channel: string;
  channelId: string;
  teamName: string;
  teamId: string;
  configuredAt: string;
}

export interface SlackTokenResponse {
  ok: boolean;
  access_token?: string;
  token_type?: string;
  scope?: string;
  incoming_webhook?: {
    url: string;
    channel: string;
    channel_id: string;
    configuration_url: string;
  };
  team?: {
    id: string;
    name: string;
  };
  enterprise?: {
    id: string;
    name: string;
  };
  error?: string;
  error_description?: string;
}

/** Generate a PKCE code_verifier (43-128 chars, URL-safe) */
export function generateCodeVerifier(): string {
  // 32 bytes = 43 chars base64url (no padding)
  return randomBytes(32).toString("base64url");
}

/** Generate a PKCE code_challenge (S256) from a code_verifier */
export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Start a local HTTP server for the OAuth callback. Defaults to an ephemeral
 *  port; the CLI passes the stable Slack callback port. */
export function startCallbackServer(port = 0): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      reject(
        code === "EADDRINUSE"
          ? new Error(
              `Port ${port} is already in use. Stop the process using it and run the Slack connection again.`,
            )
          : err,
      );
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve({ server, port: address.port });
      } else {
        server.close();
        reject(new Error("Failed to bind callback server"));
      }
    });
  });
}

/**
 * Build the Slack authorize URL.
 *
 * PKCE parameters are only sent when a challenge is supplied. Apps using a
 * local client secret (non-PKCE) omit them; Slack rejects bot scopes such as
 * incoming-webhook when a PKCE app redirects to localhost.
 */
export function buildAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  codeChallenge: string | null,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SLACK_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

/** Open the URL in the user's default browser */
export function openBrowser(url: string): void {
  const start = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(start, [url], { detached: true }).unref();
}

/** Wait for the OAuth callback on the local server.
 *  Returns the authorization code and state, or throws on timeout/error. */
export function waitForCallback(
  server: Server,
  expectedState: string,
  timeoutMs = 120_000,
  parameter: "code" | "grant" = "code",
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server.close();
        reject(new Error("OAuth callback timed out. No response from Slack."));
      }
    }, timeoutMs);

    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      if (resolved) return;
      const url = new URL(req.url ?? "", `http://127.0.0.1`);
      const code = url.searchParams.get(parameter);
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        resolved = true;
        clearTimeout(timeout);
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Slack OAuth error: ${error}`);
        server.close();
        reject(new Error(`Slack OAuth error: ${error}`));
        return;
      }

      if (code && state) {
        if (state !== expectedState) {
          resolved = true;
          clearTimeout(timeout);
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Invalid OAuth state parameter.");
          server.close();
          reject(new Error("Invalid OAuth state parameter — possible CSRF attempt."));
          return;
        }
        resolved = true;
        clearTimeout(timeout);
        server.close();
        // Send a friendly response to the browser
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Slack connected</title></head>
<body style="font-family:system-ui;padding:40px;text-align:center">
  <h1 style="color:#22c55e">✓ Connected to Slack</h1>
  <p>You can close this window and return to the terminal.</p>
</body>
</html>
`);
        resolve({ code, state });
      } else {
        // Not our callback — ignore
        res.writeHead(404);
        res.end("Not found");
      }
    });
  });
}

/** Exchange the authorization code for a token (and webhook URL).
 *  Uses a client secret when provided, otherwise PKCE with the verifier. */
export async function exchangeCodeForToken(
  clientId: string,
  code: string,
  redirectUri: string,
  codeVerifier: string | null,
  fetchImpl: typeof fetch = fetch,
  clientSecret?: string,
): Promise<SlackTokenResponse> {
  const params = new URLSearchParams({
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
  });
  if (clientSecret) {
    params.set("client_secret", clientSecret);
  } else if (codeVerifier) {
    params.set("code_verifier", codeVerifier);
  }

  const response = await fetchImpl(SLACK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  return (await response.json()) as SlackTokenResponse;
}

/** Read the stored webhook info, if any */
export function readSlackWebhook(configPath: string): SlackWebhookInfo | null {
  const configDir = dirname(resolve(configPath));
  const file = join(configDir, SLACK_WEBHOOK_FILE);
  try {
    assertSlackDirectory(dirname(file));
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let contents: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 ||
          (process.platform !== "win32" && stat.uid !== process.getuid?.())) return null;
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
      contents = readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
    const raw = JSON.parse(contents) as Partial<SlackWebhookInfo>;
    if (typeof raw.url === "string" && raw.url && typeof raw.channel === "string") {
      return raw as SlackWebhookInfo;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return null;
}

/** Write the webhook info to the local gitignored file */
export function writeSlackWebhook(configPath: string, info: SlackWebhookInfo): void {
  const configDir = dirname(resolve(configPath));
  const file = join(configDir, SLACK_WEBHOOK_FILE);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  assertSlackDirectory(dirname(file));
  const target = lstatSync(file, { throwIfNoEntry: false });
  if (target && (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1)) throw new Error("Slack credentials must be a regular file, not a link.");
  const temporary = join(dirname(file), `.slack-${randomBytes(12).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(info, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

function assertSlackDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform !== "win32" && ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error("Slack credentials need a directory owned by you that other users cannot modify.");
  }
}

/** Remove the stored webhook info */
export function removeSlackWebhook(configPath: string): boolean {
  const configDir = dirname(resolve(configPath));
  const file = join(configDir, SLACK_WEBHOOK_FILE);
  try {
    assertSlackDirectory(dirname(file));
    rmSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Mask a webhook URL for display (show only last 12 chars) */
export function maskWebhookUrl(url: string): string {
  if (url.length <= 16) return "••••••••••••";
  return `••••••••••••${url.slice(-12)}`;
}

/** Get the Client ID to use (env override or default) */
export function getSlackClientId(): string {
  return process.env.ELF_SLACK_CLIENT_ID ?? DEFAULT_SLACK_CLIENT_ID;
}

/** Optional client secret for a non-PKCE Slack app. Local only, never stored. */
export function getSlackClientSecret(): string | undefined {
  return process.env.ELF_SLACK_CLIENT_SECRET;
}

/** Connect Slack through the hosted service, or an explicit developer app. */
export async function connectSlackOAuth(configPath: string, fetchImpl?: typeof fetch): Promise<SlackWebhookInfo> {
  const clientId = getSlackClientId();
  const clientSecret = getSlackClientSecret();
  if (!clientSecret) {
    const {server, port} = await startCallbackServer();
    const pending = startSlackConnection(port);
    try {
      console.log("Opening Slack authorization in your browser…");
      const callback = waitForCallback(server, pending.state, 120_000, "grant");
      openBrowser(pending.url);
      const {code: grant} = await callback;
      const info = await finishSlackConnection(grant, pending.verifier, pending.origin, fetchImpl);
      writeSlackWebhook(configPath, info); return info;
    } finally {server.close();}
  }

  console.log("Slack OAuth: using the developer client secret from the environment.");
  const codeVerifier = clientSecret ? null : generateCodeVerifier();
  const codeChallenge = codeVerifier ? generateCodeChallenge(codeVerifier) : null;
  const state = randomBytes(16).toString("hex");

  const { server, port } = await startCallbackServer(DEFAULT_SLACK_CALLBACK_PORT);
  const redirectUri = getSlackRedirectUri(port);

  const authorizeUrl = buildAuthorizeUrl(clientId, redirectUri, codeChallenge, state);
  console.log("Opening Slack authorization in your browser…");
  openBrowser(authorizeUrl);

  const { code } = await waitForCallback(server, state);

  console.log("Authorization received. Exchanging code for webhook…");
  const tokenResponse = await exchangeCodeForToken(
    clientId,
    code,
    redirectUri,
    codeVerifier,
    fetchImpl,
    clientSecret,
  );

  if (!tokenResponse.ok) {
    throw new Error(`Slack token exchange failed: ${tokenResponse.error ?? "unknown error"} ${tokenResponse.error_description ?? ""}`);
  }

  const webhook = tokenResponse.incoming_webhook;
  if (!webhook?.url || !webhook.channel || !webhook.channel_id) {
    throw new Error("Slack response missing incoming webhook data");
  }

  const info: SlackWebhookInfo = {
    url: webhook.url,
    channel: webhook.channel,
    channelId: webhook.channel_id,
    teamName: tokenResponse.team?.name ?? "Unknown Team",
    teamId: tokenResponse.team?.id ?? "unknown",
    configuredAt: new Date().toISOString(),
  };

  writeSlackWebhook(configPath, info);
  return info;
}

/** Connect Slack using a manually provided webhook URL (fallback path) */
export async function connectSlackManual(configPath: string, webhookUrl: string): Promise<SlackWebhookInfo> {
  // Validate it's a Slack webhook URL format
  if (!webhookUrl.startsWith("https://hooks.slack.com/services/")) {
    throw new Error("Invalid Slack webhook URL. Must start with https://hooks.slack.com/services/");
  }
  // We can't get channel/team info from a raw webhook URL, so store what we have
  const info: SlackWebhookInfo = {
    url: webhookUrl,
    channel: "manual",
    channelId: "manual",
    teamName: "Manual Entry",
    teamId: "manual",
    configuredAt: new Date().toISOString(),
  };
  writeSlackWebhook(configPath, info);
  return info;
}

/** Disconnect Slack by removing the stored webhook */
export async function disconnectSlack(configPath: string): Promise<boolean> {
  return removeSlackWebhook(configPath);
}