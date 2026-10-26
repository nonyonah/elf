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
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve as resolvePath, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
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
  for await (const chunk of req) body += chunk;
  return body;
}

export interface SettingsServerOptions {
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
}

/** Create the settings HTTP server without opening a browser. Useful for tests. */
export async function createSettingsServer(
  configPath: string,
  options: SettingsServerOptions = {},
): Promise<SettingsServerHandle> {
  const distPath = resolvePath(options.distPath ?? DEFAULT_SETTINGS_DIST_PATH);
  let pendingSlack: {
    state: string;
    verifier: string | null;
    redirectUri: string;
    expiresAt: number;
  } | null = null;

  const requestHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const path = url.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (path === "/api/config" && req.method === "GET") {
      try {
        const config = loadConfig(configPath);
        const slack = readSlackWebhook(configPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          project: {
            configPath: resolvePath(configPath),
            fileKey: config.figma.fileKey,
          },
          notify: config.notify ? {
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
        writeFileSync(configFile, `${JSON.stringify(parsed, null, 2)}\n`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (path === "/api/slack/connect" && req.method === "POST") {
      const port = req.socket.localPort;
      if (!port) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Could not determine the local settings port." }));
        return;
      }
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
      res.end(JSON.stringify({ url }));
      return;
    }

    if ((path === "/callback" || path === "/api/slack/callback") && req.method === "GET") {
      const finish = (status: "connected" | "error"): void => {
        res.writeHead(302, { Location: `/?slack=${status}` });
        res.end();
      };
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      const slackError = url.searchParams.get("error");
      const pending = pendingSlack;
      pendingSlack = null;

      if (
        slackError ||
        !code ||
        !pending ||
        pending.state !== state ||
        pending.expiresAt < Date.now()
      ) {
        if (slackError) console.error(`Slack OAuth failed: ${slackError}`);
        finish("error");
        return;
      }

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
        writeSlackWebhook(configPath, info);
        finish("connected");
      } catch (error) {
        console.error(`Slack OAuth failed: ${(error as Error).message}`);
        finish("error");
      }
      return;
    }

    if (path === "/api/slack/disconnect" && req.method === "POST") {
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

    res.writeHead(404);
    res.end("Not found");
  };

  const server = createServer((req, res) => {
    void requestHandler(req, res);
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
    publicUrl: `http://localhost:${address.port}`,
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

  let handle: SettingsServerHandle;
  try {
    handle = await createSettingsServer(configPath, {
      distPath,
      port: DEFAULT_SETTINGS_PORT,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
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
    const start = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(start, [publicUrl], { detached: true }).unref();
  }

  await new Promise<void>((fulfill) => {
    server.on("close", () => fulfill());
  });
}
