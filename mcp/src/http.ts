import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { silentLogger, type Logger } from "./logger.js";

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1024 * 1024;
const JSON_HEADERS = { "content-type": "application/json" };

export interface HttpTransportOptions {
  token: string;
  port: number;
  /** A fresh MCP server per request — the transport runs stateless. */
  createServer: () => McpServer;
  logger?: Logger;
}

export interface HttpTransportHandle {
  /** Bound port (port 0 picks a free one). */
  port: number;
  close(): Promise<void>;
}

function tokenMatches(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

/**
 * Extracts the shared token from `Authorization: Bearer …` or from a
 * `/t/<token>/mcp` path — web connector dialogs (Claude, Grok) can't set
 * custom headers today, so the token has to be able to live in the URL.
 * Returns null when the request carries no token at all.
 */
function tokenFromRequest(request: IncomingMessage, pathname: string): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string" && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, "").trim();
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 3 && segments[0] === "t" && segments[2] === "mcp") {
    return decodeURIComponent(segments[1]);
  }
  return null;
}

function isMcpPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return (
    (segments.length === 1 && segments[0] === "mcp") ||
    (segments.length === 3 && segments[0] === "t" && segments[2] === "mcp")
  );
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(text) });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

/**
 * Streamable HTTP transport for web MCP clients (Claude, Grok, ChatGPT…).
 * Runs stateless: every POST gets its own server instance, which keeps the
 * endpoint friendly to tunnels and load balancers that drop long-lived
 * streams. Binds to loopback only — expose it with `ngrok http <port>` or
 * equivalent; the shared token is the only gate once it is public.
 */
export async function startHttpTransport(options: HttpTransportOptions): Promise<HttpTransportHandle> {
  const logger: Logger = options.logger ?? silentLogger;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: Error) => {
      logger.log(`http request failed: ${error.message}`);
      if (!response.headersSent) send(response, 500, { ok: false });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    const pathname = url.pathname;

    if (!isMcpPath(pathname)) {
      send(response, 404, { error: "not found", hint: "the MCP endpoint is /mcp or /t/<token>/mcp" });
      return;
    }

    const provided = tokenFromRequest(request, pathname);
    if (!provided || !tokenMatches(options.token, provided)) {
      // No detail on purpose — nothing here confirms whether a token is close.
      send(response, 401, { error: "unauthorized" });
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { ...JSON_HEADERS, allow: "POST" });
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    let body: unknown;
    try {
      body = await readBody(request);
    } catch (error) {
      send(response, 400, { error: (error as Error).message });
      return;
    }

    // Stateless: one server + transport per request. Web connector clients
    // tolerate this fine; the Figma state lives in the bridge, not here.
    const mcp = options.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });

    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
    logger.log(`http ${pathname === "/mcp" ? "/mcp" : "/t/<token>/mcp"} handled`);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  logger.log(`streamable http listening on http://${HOST}:${port}/mcp`);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
