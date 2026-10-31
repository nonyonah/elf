/**
 * Local settings web page server for `elf settings`.
 *
 * Starts a tiny HTTP server on 127.0.0.1:3000, serves the pre-built Next.js
 * static settings page from dist/settings, and provides API endpoints for
 * config and the Slack OAuth connect/disconnect flow.
 *
 * The server runs until Ctrl+C. Running the page's own dev server is not
 * enough: it has no /api routes and will show a 404.
 */
import { startConnection, startSlackConnection, finishSlackConnection, finishConnection } from "./connection-service.js";
import { readFigmaAccount, writeFigmaAccount, removeFigmaAccount, validateAccount, beginFigmaAuthorization, figmaAuthorizationCurrent } from "./figma/account.js";
import { readVerificationLimit } from './figma/verification-limit.js';
import { SETTINGS_API_VERSION } from "./settings-protocol.js";
import { readDriftReport } from "./reports.js";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { resolve as resolvePath, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { loadWatchEnv } from "../watch/src/bridge.js";
import { dirname } from "node:path";
import { loadRuntimeBridgeConfig } from "../mcp/src/config.js";
import { BridgeClient } from '../mcp/src/client.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { postNotification } from "./notify.js";
import { loadConfig } from "./config.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generateCodeChallenge,
  generateCodeVerifier,
  getSlackClientId,
  getSlackClientSecret,
  getSlackRedirectUri,
  readSlackWebhook,
  removeSlackWebhook,
  writeSlackWebhook,
  type SlackWebhookInfo,
} from "./slack.js";
import { spawn } from "node:child_process";
import { writeProjectConfig, type OnboardingController } from "./onboarding.js";

/** Path to the built Next.js static settings page, resolved from this package. */
const DEFAULT_SETTINGS_DIST_PATH = fileURLToPath(new URL("../dist/settings", import.meta.url));

/** Stable local port so the Slack redirect URL stays the same across runs. */
export const DEFAULT_SETTINGS_PORT = 3000;

/** How long a pending Slack OAuth install remains valid. */
const SLACK_OAUTH_TTL_MS = 10 * 60 * 1000;

/** MIME types for static files */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function serveStaticFile(res: ServerResponse, distPath: string, filePath: string): boolean {
  try {
    const fullPath = resolvePath(distPath, filePath);
    if (fullPath !== distPath && !fullPath.startsWith(distPath + sep)) {
      return false;
    }
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      return false;
    }
    const content = readFileSync(fullPath);
    res.writeHead(200, { "Content-Type": getMimeType(fullPath) });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024) throw new Error("Request body is too large.");
    body += chunk;
  }
  return body;
}

export interface SettingsServerOptions {
  identityToken?: string;
  /** MCP uses the existing OAuth callback without exposing project Settings. */
  figmaConnectionOnly?: boolean;
  onboarding?: OnboardingController;
  /** Folder holding the built Next.js settings page. Defaults to the package's dist/settings. */
  distPath?: string;
  /** Port to listen on. Defaults to 0 (ephemeral) for tests. */
  port?: number;
}

export interface SettingsServerHandle {
  server: Server;
  port: number;
  url: string;
  publicUrl: string;
  close: () => Promise<void>;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

/** Create the settings HTTP server without opening a browser. Useful for tests. */
export async function createSettingsServer(
  configPath: string,
  options: SettingsServerOptions = {},
): Promise<SettingsServerHandle> {
  const distPath = resolvePath(options.distPath ?? DEFAULT_SETTINGS_DIST_PATH);
  const serverInstance = randomBytes(32).toString("hex");
  const bootstrapTokens = new Map<string, number>();
  const sessions = new Set<string>();
  const usedOpenNonces = new Set<string>();
  const issueBootstrap = (): string => {
    for (const [token, expiry] of bootstrapTokens) if (expiry < Date.now()) bootstrapTokens.delete(token);
    if (bootstrapTokens.size >= 32) bootstrapTokens.delete(bootstrapTokens.keys().next().value!);
    const token = randomBytes(32).toString("hex"); bootstrapTokens.set(token, Date.now() + 60_000); return token;
  };
  const initialBootstrap = issueBootstrap();
  const nativeSession = randomBytes(32).toString("hex"); sessions.add(nativeSession);
  const canonicalPath = (): string => { try { return realpathSync(configPath); } catch { return resolvePath(configPath); } };
  const validProof = (supplied: unknown, expected: Buffer): boolean => typeof supplied === "string" && /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(expected, Buffer.from(supplied, "hex"));
  let figmaGeneration = 0; let slackGeneration = 0;
  let pendingFigma: (ReturnType<typeof startConnection> & {generation:string}) | null = null;
  let pendingBroker: ReturnType<typeof startSlackConnection> | null = null;
  let pendingSlack: {
    state: string;
    verifier: string | null;
    redirectUri: string;
    expiresAt: number;
  } | null = null;

  const requestHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const path = url.pathname;

    const port = req.socket.localPort;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const origin = req.headers.origin;
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    if (!allowedHosts.has(req.headers.host ?? "") || (origin && !allowedOrigins.has(origin)) ||
        (path.startsWith("/api/") && path !== "/api/slack/callback" && path !== "/api/slack/broker-callback" && path !== "/api/figma/broker-callback" && req.headers["sec-fetch-site"] === "cross-site")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Open Elf settings from its local address." }));
      return;
    }
    if (!["GET", "HEAD"].includes(req.method ?? "") && req.headers["x-elf-request"] !== "1") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "This action must come from Elf settings." }));
      return;
    }
    if(options.figmaConnectionOnly&&!['/api/figma/account','/api/figma/connect','/api/figma/disconnect','/api/figma/broker-callback'].includes(path)){
      res.writeHead(404,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'This endpoint serves Figma account connection only.'}));return;
    }
    if (path === "/api/identity" && req.method === "GET") {
      const challenge = req.headers["x-elf-challenge"];
      if (options.identityToken && typeof challenge === "string" && /^[a-f0-9]{64}$/.test(challenge)) {
        res.setHeader("X-Elf-Instance", serverInstance);
        res.setHeader("X-Elf-Server-Proof", createHmac("sha256", options.identityToken).update("identity\n" + challenge + "\n" + canonicalPath() + "\n" + serverInstance).digest("hex"));
        res.writeHead(200); res.end("{}");
      } else { res.writeHead(401); res.end("{}"); }
      return;
    }
    if (path === "/api/session/open" && req.method === "POST") {
      const nonce = req.headers["x-elf-challenge"];
      if (!options.identityToken || typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce) || usedOpenNonces.has(nonce) ||
          !validProof(req.headers["x-elf-machine-proof"], createHmac("sha256", options.identityToken).update("open\n" + nonce + "\n" + canonicalPath() + "\n" + serverInstance).digest())) {
        res.writeHead(401); res.end("{}"); return;
      }
      if (usedOpenNonces.size >= 1000) { res.writeHead(429); res.end("{}"); return; }
      usedOpenNonces.add(nonce);
      const token = issueBootstrap();
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ url: `http://127.0.0.1:${port}/#elf=${token}` })); return;
    }
    if (path === "/api/session" && req.method === "POST") {
      const token = req.headers["x-elf-bootstrap"];
      const expiry = typeof token === "string" ? bootstrapTokens.get(token) : undefined;
      if (!expiry || expiry < Date.now()) { res.writeHead(401); res.end("{}"); return; }
      bootstrapTokens.delete(String(token));
      if (sessions.size >= 64) sessions.delete([...sessions][1]);
      const session = randomBytes(32).toString("hex"); sessions.add(session);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ session })); return;
    }
    const callback = (path === "/callback" || path === "/api/slack/callback" || path === "/api/slack/broker-callback" || path === "/api/figma/broker-callback") && req.method === "GET";
    if (path.startsWith("/api/") && !callback && (typeof req.headers["x-elf-session"] !== "string" || !sessions.has(req.headers["x-elf-session"]))) {
      res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Open the private Settings link from your terminal." })); return;
    }

    if (path === "/api/runtime" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ apiVersion: SETTINGS_API_VERSION, managed: Boolean(options.onboarding?.projectAction) })); return;
    }

    if (path === "/api/report" && req.method === "GET") {
      try {
        const report = readDriftReport(configPath);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(report));
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        res.writeHead(missing ? 404 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: missing ? "No drift report yet. Run a drift check first." : "The drift report could not be read safely." }));
      }
      return;
    }

    if (path.startsWith("/api/project/") && !options.onboarding?.projectAction) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Project actions require elf start. Stop this settings-only server and run elf start in your project." })); return;
    }

    if (path.startsWith("/api/project/") && req.method === "POST" && options.onboarding?.projectAction) {
      try {
        const body = await readBody(req);
        const result = await options.onboarding.projectAction(path.slice("/api/project/".length), body ? JSON.parse(body) : {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }
    if (path === "/api/onboarding" && options.onboarding) {
      try {
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(options.onboarding.status()));
        } else if (req.method === "POST") {
          options.onboarding.save(JSON.parse(await readBody(req)));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else { res.writeHead(405); res.end(); }
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }
    if (path === "/api/onboarding/validate" && req.method === "POST" && options.onboarding?.validate) {
      try {
        options.onboarding.validate(JSON.parse(await readBody(req)));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }
    if (path === "/api/onboarding/pairing" && req.method === "POST" && options.onboarding?.requestPairingCode) {
      try {
        await options.onboarding.requestPairingCode();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Could not request a new code. Check the elf terminal." }));
      }
      return;
    }
    if (path === "/api/onboarding/start" && req.method === "POST" && options.onboarding) {
      try {
        await options.onboarding.start();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }

    if (path === '/api/mcp-status' && req.method === 'GET') {
      let client: BridgeClient | null = null;
      try {
        if (!process.env.ELF_MCP_TOKEN && !existsSync(join(homedir(), '.elf', 'bridge-secret'))) {
          res.writeHead(200, {'Content-Type':'application/json'});res.end(JSON.stringify({connected:false,count:0,available:true}));return;
        }
        client = await BridgeClient.connect(loadRuntimeBridgeConfig());
        const status = await client.call<{connected:boolean;count:number}>('__elf_mcp_status',{}, {timeoutMs:1000});
        res.writeHead(200, {'Content-Type':'application/json'});res.end(JSON.stringify({...status,available:true}));
      } catch {
        res.writeHead(200, {'Content-Type':'application/json'});res.end(JSON.stringify({connected:false,count:0,available:false}));
      } finally { await client?.close(); }
      return;
    }

    if (path === "/api/config" && req.method === "GET") {
      try {
        const config = existsSync(configPath) ? loadConfig(configPath) : null;
        const slack = readSlackWebhook(configPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          project: {
            configPath: resolvePath(configPath),
            fileKey: config?.figma.fileKey ?? "",
          },
          onboarding: options.onboarding?.status() ?? null,
          notify: config?.notify ? {
            webhookEnv: config.notify.webhookEnv,
            format: config.notify.format,
            enabled: !!config.notify.webhookEnv,
            onlyOnChange: config.notify.onlyOnChange !== false,
          } : null,
          slack: slack ? { connected: true, teamName: slack.teamName, channel: slack.channel } : { connected: false },
        }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (path === "/api/config" && req.method === "PATCH") {
      try {
        const patch = JSON.parse(await readBody(req));
        const config = loadConfig(configPath);
        if (patch.notify) {
          const base = config.notify ?? { webhookEnv: "SLACK_WEBHOOK_URL", format: "slack" as const };
          const next = {
            ...base,
            ...(patch.notify.enabled !== undefined
              ? { webhookEnv: patch.notify.enabled ? base.webhookEnv || "SLACK_WEBHOOK_URL" : "" }
              : {}),
            ...(patch.notify.onlyOnChange !== undefined
              ? { onlyOnChange: Boolean(patch.notify.onlyOnChange) }
              : {}),
          };
          if (next.webhookEnv) {
            config.notify = next;
          } else {
            delete config.notify;
          }
        }

        const configFile = resolvePath(configPath);
        const parsed = JSON.parse(readFileSync(configFile, "utf8"));
        if (config.notify) {
          parsed.notify = { ...(parsed.notify ?? {}), ...config.notify };
        } else {
          delete parsed.notify;
        }
        writeProjectConfig(configFile, parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (path === "/api/figma/account" && req.method === "GET") {
      const account = readFigmaAccount();
      const fileKey = existsSync(configPath) ? loadConfig(configPath).figma.fileKey : null;
      const verificationLimit = fileKey ? readVerificationLimit(fileKey) : null;
      res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify({connected: Boolean(account), expiresAt: account?.expiresAt ?? null, verificationLimit})); return;
    }
    if (path === "/api/figma/connect" && req.method === "POST") {
      figmaGeneration++;
      pendingFigma = {...startConnection("figma", req.socket.localPort!),generation:beginFigmaAuthorization()};
      res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify({url: pendingFigma.url, authorizationOrigin: pendingFigma.origin})); return;
    }
    if (path === "/api/figma/disconnect" && req.method === "POST") {
      figmaGeneration++; pendingFigma = null; removeFigmaAccount();
      res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify({ok: true})); return;
    }
    if (path === "/api/figma/broker-callback" && req.method === "GET") {
      const generation = figmaGeneration;
      const pending = pendingFigma; let status = "error"; let reason = "expired_session";
      if (pending && pending.expiresAt > Date.now() && url.searchParams.get("state") === pending.state) {
        pendingFigma = null; const grant = url.searchParams.get("grant");
        const supplied = url.searchParams.get("reason") ?? "";
        reason = ["access_denied", "invalid_client", "invalid_grant", "invalid_scope", "redirect_uri_mismatch", "unauthorized_client", "missing_code", "provider_rejected", "service_error", "credential_storage"].includes(supplied) ? supplied : "service_error";
        if (grant && !url.searchParams.has("error")) {
          try {const account = validateAccount(await finishConnection(grant, pending.verifier, pending.origin, "figma"), pending.origin); if (generation !== figmaGeneration || !figmaAuthorizationCurrent(pending.generation)) throw new Error("Connection canceled"); writeFigmaAccount(account); status = "connected";}
          catch {reason = "local_exchange"; console.error("Figma account connection failed. Reconnect from Elf Settings.");}
        }
      }
      if(options.figmaConnectionOnly){
        res.writeHead(status==='connected'?200:400,{'Content-Type':'text/plain; charset=utf-8','Content-Security-Policy':"default-src 'none'"});
        res.end(status==='connected'?'Figma connected. Return to your coding assistant and check Elf onboarding status.':'Figma connection was not completed. Return to your assistant and request a new sign-in link.');return;
      }
      res.writeHead(302, {Location: `http://127.0.0.1:${req.socket.localPort}/?figma=${status}${status === "error" ? `&figma_reason=${reason}` : ""}`}); res.end(); return;
    }

    if (path === "/api/slack/connect" && req.method === "POST") {
      slackGeneration++;
      const port = req.socket.localPort;
      if (!port) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Could not determine the local settings port." }));
        return;
      }
      if (!getSlackClientSecret()) {
        pendingBroker = startSlackConnection(port);
        pendingSlack = null;
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({url: pendingBroker.url, authorizationOrigin: pendingBroker.origin})); return;
      }
      pendingBroker = null;
      const redirectUri = getSlackRedirectUri(port);
      const state = randomBytes(16).toString("hex");
      const clientSecret = getSlackClientSecret();
      console.log(
        clientSecret
          ? "Slack OAuth: using the client secret from the environment."
          : "Slack OAuth: ELF_SLACK_CLIENT_SECRET is not set; using PKCE.",
      );
      const verifier = clientSecret ? null : generateCodeVerifier();
      pendingSlack = {
        state,
        verifier,
        redirectUri,
        expiresAt: Date.now() + SLACK_OAUTH_TTL_MS,
      };
      const url = buildAuthorizeUrl(
        getSlackClientId(),
        redirectUri,
        verifier ? generateCodeChallenge(verifier) : null,
        state,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url, authorizationOrigin: "https://slack.com" }));
      return;
    }

    if (path === "/api/slack/broker-callback" && req.method === "GET") {
      const generation = slackGeneration;
      const pending = pendingBroker;
      let status = "error";
      if (pending && pending.expiresAt > Date.now() && url.searchParams.get("state") === pending.state) {
        pendingBroker = null;
        const grant = url.searchParams.get("grant");
        if (grant && !url.searchParams.has("error")) {
          try {const info = await finishSlackConnection(grant, pending.verifier, pending.origin); if (generation !== slackGeneration) throw new Error("Connection canceled"); writeSlackWebhook(configPath, info); status = "connected";}
          catch { console.error("Slack connection failed. Reconnect from Elf Settings."); }
        }
      }
      res.writeHead(302, {Location: `http://127.0.0.1:${req.socket.localPort}/?slack=${status}`}); res.end(); return;
    }

    if ((path === "/callback" || path === "/api/slack/callback") && req.method === "GET") {
      const finish = (status: "connected" | "error"): void => {
        res.writeHead(302, { Location: `http://127.0.0.1:${req.socket.localPort}/?slack=${status}` });
        res.end();
      };
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      const slackError = url.searchParams.get("error");
      const generation = slackGeneration;
      const pending = pendingSlack;

      if (
        slackError ||
        !code ||
        !pending ||
        pending.state !== state ||
        pending.expiresAt < Date.now()
      ) {
        if (slackError) console.error(`Slack OAuth failed: ${slackError}`);
        if (pending && pending.expiresAt < Date.now()) pendingSlack = null;
        finish("error");
        return;
      }
      pendingSlack = null;

      try {
        const token = await exchangeCodeForToken(
          getSlackClientId(),
          code,
          pending.redirectUri,
          pending.verifier,
          fetch,
          getSlackClientSecret(),
        );
        const webhook = token.incoming_webhook;
        if (!token.ok || !webhook?.url || !webhook.channel || !webhook.channel_id) {
          throw new Error(token.error ?? "Slack did not return an incoming webhook.");
        }
        const info: SlackWebhookInfo = {
          url: webhook.url,
          channel: webhook.channel,
          channelId: webhook.channel_id,
          teamName: token.team?.name ?? "Unknown Team",
          teamId: token.team?.id ?? "unknown",
          configuredAt: new Date().toISOString(),
        };
        if (generation !== slackGeneration) throw new Error("Connection canceled");
        writeSlackWebhook(configPath, info);
        finish("connected");
      } catch (error) {
        console.error(`Slack OAuth failed: ${(error as Error).message}`);
        finish("error");
      }
      return;
    }

    if (path === "/api/slack/test" && req.method === "POST") {
      try {
        const webhook = readSlackWebhook(configPath);
        if (!webhook) throw new Error("Connect Slack before sending a test message.");
        await postNotification(webhook.url, "slack", { text: "Elf is connected. Drift alerts for this project will appear here." });
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Could not send the test message. Check your Slack connection and try again." }));
      }
      return;
    }
    if (path === "/api/slack/disconnect" && req.method === "POST") {
      slackGeneration++; pendingBroker = null; pendingSlack = null;
      try {
        removeSlackWebhook(configPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    let filePath = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    if (serveStaticFile(res, distPath, filePath)) {
      return;
    }

    if (!filePath.endsWith(".html") && !path.startsWith("/api/") && serveStaticFile(res, distPath, "index.html")) {
      return;
    }

    if (path.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "This local API route is unavailable. Restart Elf to load the latest version." })); return;
    }
    res.writeHead(404);
    res.end("Not found");
  };

  const server = createServer((req, res) => {
    void requestHandler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "The local request could not be completed." }));
    });
  });

  await new Promise<void>((fulfill, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      fulfill();
    });
  });

  const address = server.address();
  if (!address || typeof address !== "object") {
    server.close();
    throw new Error("Failed to bind settings server");
  }

  const close = (): Promise<void> =>
    new Promise<void>((fulfill) => {
      figmaGeneration++;pendingFigma=null;
      if (!server.listening) {
        fulfill();
        return;
      }
      server.close(() => fulfill());
    });

  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    publicUrl: `http://127.0.0.1:${address.port}/#elf=${initialBootstrap}`,
    fetch: (path, init = {}) => {
      const target = new URL(path, `http://127.0.0.1:${address.port}`);
      if (target.origin !== `http://127.0.0.1:${address.port}`) throw new Error("Settings requests must use the local server origin.");
      const headers = new Headers(init.headers); headers.set("X-Elf-Session", nativeSession);
      return fetch(target.href, { ...init, headers });
    },
    close,
  };
}

/** Start the settings server and open the browser. Runs until Ctrl+C. */
export async function runSettingsServer(configPath: string): Promise<void> {
  const distPath = DEFAULT_SETTINGS_DIST_PATH;
  if (!existsSync(distPath)) {
    console.error(
      `Settings build not found at ${distPath}. Run 'npm run build' in settings-next first.`,
    );
    process.exit(1);
  }

  loadWatchEnv(dirname(resolvePath(configPath)));
  const identity = loadRuntimeBridgeConfig();
  let handle: SettingsServerHandle;
  try {
    handle = await createSettingsServer(configPath, {
      distPath,
      port: DEFAULT_SETTINGS_PORT,
      identityToken: identity.token,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      const existing = `http://127.0.0.1:${DEFAULT_SETTINGS_PORT}`;
      const reopen = await reopenCompatibleSettingsServer(existing, configPath, identity.token);
      if (reopen) {
        console.log(`Settings page: ${reopen}`);
        if (process.env.ELF_SETTINGS_NO_OPEN !== "1") openSettingsBrowser(reopen);
        return;
      }
      throw new Error(
        `Port ${DEFAULT_SETTINGS_PORT} is already in use. Stop the other process (often "next dev") and run the settings page again.`,
      );
    }
    throw error;
  }
  const { server, publicUrl } = handle;

  console.log(`Settings page: ${publicUrl}`);
  console.log("Project:", configPath);
  console.log("Press Ctrl+C to close.");

  if (process.env.ELF_SETTINGS_NO_OPEN !== "1") {
    openSettingsBrowser(publicUrl);
  }

  await new Promise<void>((fulfill) => {
    server.on("close", () => fulfill());
  });
}

/** Open without a shell; a missing desktop opener must not terminate the runtime. */
export function openSettingsBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => console.error(`Open settings in your browser: ${url}`));
  child.unref();
}

/** Reusing a local port requires proof of the same machine identity and project. */
async function settingsIdentity(url: string, configPath: string, token: string): Promise<string | null> {
  try {
    const challenge = randomBytes(32).toString("hex");
    const response = await fetch(`${url}/api/identity`, { headers: { "X-Elf-Challenge": challenge }, signal: AbortSignal.timeout(2000) });
    const proof = response.headers.get("x-elf-server-proof");
    const instance = response.headers.get("x-elf-instance");
    if (!response.ok || !proof || !/^[a-f0-9]{64}$/.test(proof) || !instance || !/^[a-f0-9]{64}$/.test(instance)) return null;
    let path: string; try { path = realpathSync(configPath); } catch { path = resolvePath(configPath); }
    const expected = createHmac("sha256", token).update("identity\n" + challenge + "\n" + path + "\n" + instance).digest();
    return timingSafeEqual(expected, Buffer.from(proof, "hex")) ? instance : null;
  } catch { return null; }
}

export async function verifySettingsServer(url: string, configPath: string, token: string): Promise<boolean> {
  return Boolean(await settingsIdentity(url, configPath, token));
}

export async function reopenSettingsServer(url: string, configPath: string, token: string): Promise<string | null> {
  const instance = await settingsIdentity(url, configPath, token);
  if (!instance) return null;
  try {
    const challenge = randomBytes(32).toString("hex");
    let path: string; try { path = realpathSync(configPath); } catch { path = resolvePath(configPath); }
    const proof = createHmac("sha256", token).update("open\n" + challenge + "\n" + path + "\n" + instance).digest("hex");
    const response = await fetch(`${url}/api/session/open`, { method: "POST", headers: { "X-Elf-Request": "1", "X-Elf-Challenge": challenge, "X-Elf-Machine-Proof": proof }, signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const result = await response.json();
    const target = new URL(result.url);
    return target.origin === new URL(url).origin && /^#elf=[a-f0-9]{64}$/.test(target.hash) ? target.href : null;
  } catch { return null; }
}


/** Do not silently reopen an older process that cannot serve the installed UI. */
export async function reopenCompatibleSettingsServer(url: string, configPath: string, token: string, managed = false): Promise<string | null> {
  const link = await reopenSettingsServer(url, configPath, token);
  if (!link) return null;
  const restart = "An older or incompatible Elf server is already running. Stop it with Ctrl+C, then run elf start again (or node bin/elf-tokens.js start in this repo).";
  try {
    const bootstrap = new URLSearchParams(new URL(link).hash.slice(1)).get("elf")!;
    const opened = await fetch(`${url}/api/session`, {method: "POST", headers: {"X-Elf-Request": "1", "X-Elf-Bootstrap": bootstrap}, signal: AbortSignal.timeout(2000)});
    if (!opened.ok) throw new Error(restart);
    const { session } = await opened.json();
    const response = await fetch(`${url}/api/runtime`, {headers: {"X-Elf-Session": session}, signal: AbortSignal.timeout(2000)});
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error(restart);
    const status = await response.json();
    if (typeof status.apiVersion !== "number" || status.apiVersion < SETTINGS_API_VERSION || (managed && !status.managed)) throw new Error(restart);
  } catch { throw new Error(restart); }
  return reopenSettingsServer(url, configPath, token);
}
