import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { BridgeError } from "./errors.js";
import { silentLogger, type Logger } from "./logger.js";
import {
  AUTH_FAILED_CODE,
  CONTROL_PATH,
  DEFAULT_TIMEOUT_MS,
  NOT_CONNECTED_HINT,
  REPLACED_CODE,
  type BridgeControlCallMessage,
  type BridgeControlResultMessage,
  type BridgeFileInfo,
  type BridgeMessage,
  type BridgePluginInfo,
  type BridgeResponseMessage,
} from "./protocol.js";
import {
  PAIRING_CODE_TTL_MS,
  SESSION_TTL_MS,
  createPairingCode,
  issueSession,
  pairingCodeDigest,
  verifySession,
  type SessionSecret,
} from "./pairing.js";

const HOST = "127.0.0.1";
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const KEEPALIVE_MS = 30_000;

export interface BridgeOptions {
  token: string;
  port: number;
  timeoutMs?: number;
  logger?: Logger;
  /** How long the one-time pairing code stays valid. */
  pairingCodeTtlMs?: number;
  /** How long a session secret issued by pairing stays valid. */
  sessionTtlMs?: number;
}

export interface BridgePairing {
  code: string;
  expiresAt: string;
}

export interface BridgeStatus {
  connected: boolean;
  /** Bound port, or null before start(). */
  port: number | null;
  /** Bound address — always loopback. */
  address: string | null;
  file: BridgeFileInfo | null;
  plugin: BridgePluginInfo | null;
  connectedAt: string | null;
}

export interface RequestOptions {
  timeoutMs?: number;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export type StatusListener = (status: BridgeStatus) => void;

/**
 * Local WebSocket bridge between the MCP server (Node) and the Figma plugin's
 * UI iframe. Binds to 127.0.0.1 only.
 *
 * Plugin handshakes use a one-time pairing code (`?code=`) or the longer-lived
 * session secret it returns (`?session=`). The shared token (`?token=`) stays
 * supported for existing panels and for the local /control lane.
 */
export class Bridge {
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private readonly controls = new Set<WebSocket>();
  private keepalive: NodeJS.Timeout | null = null;
  private port: number | null = null;
  private boundAddress: string | null = null;
  private connectedAt: string | null = null;
  private file: BridgeFileInfo | null = null;
  private plugin: BridgePluginInfo | null = null;
  private alive = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<StatusListener>();
  private readonly timeoutMs: number;
  private readonly pairingTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly logger: Logger;
  private pairing: { code: string; hash: Buffer; expiresAt: number } | null = null;

  constructor(private readonly options: BridgeOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pairingTtlMs = options.pairingCodeTtlMs ?? PAIRING_CODE_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.logger = options.logger ?? silentLogger;
  }

  get status(): BridgeStatus {
    return {
      connected: this.socket !== null,
      port: this.port,
      address: this.boundAddress,
      file: this.file,
      plugin: this.plugin,
      connectedAt: this.connectedAt,
    };
  }

  get isConnected(): boolean {
    return this.socket !== null;
  }

  /** The one-time code, while it is unused and unexpired. Safe to print once. */
  get pairingCode(): BridgePairing | null {
    const pairing = this.pairing;
    if (!pairing || Date.now() >= pairing.expiresAt) return null;
    return { code: pairing.code, expiresAt: new Date(pairing.expiresAt).toISOString() };
  }

  /** Starts listening. Resolves with the bound port (port 0 picks a free one). */
  async start(): Promise<number> {
    if (this.server) throw new Error("Bridge already started.");

    const server = new WebSocketServer({ host: HOST, port: this.options.port, maxPayload: MAX_PAYLOAD_BYTES });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    } catch (error) {
      this.server = null;
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new Error(
          `Port ${this.options.port} on ${HOST} is already in use — another bridge is probably running. ` +
            `Stop it or set a different ${"ELF_MCP_PORT"}.`,
        );
      }
      throw error;
    }

    const address = server.address() as AddressInfo | null;
    this.port = address?.port ?? this.options.port;
    this.boundAddress = address?.address ?? HOST;
    const pairing = createPairingCode(Date.now(), this.pairingTtlMs);
    this.pairing = { ...pairing, hash: pairingCodeDigest(pairing.code) };
    server.on("connection", (socket, request) => this.accept(socket, request.url ?? ""));
    this.logger.log(`bridge listening on ws://${HOST}:${this.port}`);

    this.keepalive = setInterval(() => this.ping(), KEEPALIVE_MS);
    this.keepalive.unref();
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    if (this.socket) this.socket.close(1001, "bridge shutting down");
    this.socket = null;
    this.pairing = null;
    for (const control of this.controls) control.close(1001, "bridge shutting down");
    this.controls.clear();
    this.rejectAll("bridge shut down");
    const server = this.server;
    this.server = null;
    if (!server) return;
    // Terminate stragglers first: server.close() waits for open sockets.
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.emitStatus();
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Sends one request to the plugin and waits for the matching response.
   * Rejects immediately when nothing is connected, and after `timeoutMs`
   * otherwise. Plugin errors are relayed with their original message so plan
   * limits stay visible to the caller.
   */
  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const socket = this.socket;
    if (!socket) {
      throw new BridgeError("not-connected", `No Figma plugin connected — ${NOT_CONNECTED_HINT}.`);
    }

    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            "timeout",
            `Timed out after ${timeoutMs}ms waiting for the plugin to answer "${method}" — ` +
              `${NOT_CONNECTED_HINT}, or the panel is busy.`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      socket.send(JSON.stringify({ type: "request", id, method, params }), (error) => {
        if (!error) return;
        this.settle(id, undefined, new BridgeError("transport", `Could not send "${method}": ${error.message}`));
      });
    });
  }

  private accept(socket: WebSocket, url: string): void {
    const params = queryFromUrl(url);

    if (pathFromUrl(url) === CONTROL_PATH) {
      if (!this.tokenMatches(params.get("token"))) {
        this.logger.log("rejected control connection: bad or missing handshake token");
        socket.close(AUTH_FAILED_CODE, "unauthorized");
        return;
      }
      this.acceptControl(socket);
      return;
    }

    const code = params.get("code");
    const session = params.get("session");
    let issued: SessionSecret | null = null;
    let auth: "code" | "session" | "token" = "token";

    if (code) {
      if (!this.consumePairingCode(code)) {
        this.logger.log("rejected connection: invalid, expired or already-used pairing code");
        socket.close(AUTH_FAILED_CODE, "unauthorized");
        return;
      }
      issued = issueSession(this.options.token, Date.now(), this.sessionTtlMs);
      auth = "code";
    } else if (session) {
      if (verifySession(this.options.token, session) === null) {
        this.logger.log("rejected connection: invalid or expired session");
        socket.close(AUTH_FAILED_CODE, "unauthorized");
        return;
      }
      auth = "session";
    } else if (!this.tokenMatches(params.get("token"))) {
      this.logger.log("rejected connection: bad or missing handshake credentials");
      socket.close(AUTH_FAILED_CODE, "unauthorized");
      return;
    }

    this.acceptPlugin(socket, issued, auth);
  }

  private acceptPlugin(
    socket: WebSocket,
    issued: SessionSecret | null,
    auth: "code" | "session" | "token",
  ): void {
    const previous = this.socket;
    this.socket = socket;
    if (previous) {
      this.logger.log("closing previous plugin connection");
      previous.close(REPLACED_CODE, "replaced by another plugin connection");
    }

    this.alive = true;
    this.connectedAt = new Date().toISOString();
    this.file = null;
    this.plugin = null;
    if (auth === "code") this.logger.log("plugin paired with a one-time code");
    else if (auth === "session") this.logger.log("plugin reconnected with its saved session");
    else this.logger.log("plugin connected with the handshake token");
    this.emitStatus();

    socket.send(
      JSON.stringify({
        type: "ready",
        ...(issued
          ? { session: issued.session, sessionExpiresAt: new Date(issued.expiresAt).toISOString() }
          : {}),
      }),
    );

    socket.on("pong", () => {
      this.alive = true;
    });
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("close", (code) => {
      if (this.socket === socket) this.disconnect(code);
    });
    socket.on("error", (error) => {
      this.logger.log(`socket error: ${error.message}`);
    });
  }

  private consumePairingCode(candidate: string): boolean {
    const pairing = this.pairing;
    if (!pairing) return false;
    if (Date.now() >= pairing.expiresAt) {
      this.pairing = null;
      this.logger.log("pairing code expired");
      return false;
    }
    if (!safeEqual(pairingCodeDigest(candidate), pairing.hash)) return false;
    // Single-use: consume before accepting, so two racing clients cannot both pair.
    this.pairing = null;
    return true;
  }

  /**
   * The /control lane: a local process (the batch CLI) sending `{ call }`
   * envelopes. Calls are answered per-connection and never touch the plugin
   * socket or its status — a controller coming and going goes unnoticed by
   * the plugin.
   */
  private acceptControl(socket: WebSocket): void {
    this.controls.add(socket);
    this.logger.log("control client connected");

    socket.on("message", (data) => void this.receiveControl(socket, data.toString()));
    socket.on("close", () => {
      this.controls.delete(socket);
      this.logger.log("control client disconnected");
    });
    socket.on("error", (error) => {
      this.logger.log(`control socket error: ${error.message}`);
    });
  }

  private async receiveControl(socket: WebSocket, raw: string): Promise<void> {
    let message: BridgeControlCallMessage;
    try {
      message = JSON.parse(raw) as BridgeControlCallMessage;
    } catch {
      this.logger.log("ignoring non-JSON message from a control client");
      return;
    }
    if (message.type !== "call" || typeof message.id !== "string" || typeof message.method !== "string") {
      this.logger.log(`ignoring unexpected control message type "${String((message as { type?: string }).type)}"`);
      return;
    }

    try {
      const result = await this.request(message.method, message.params ?? {});
      sendControlResult(socket, { type: "result", id: message.id, ok: true, result });
    } catch (error) {
      const bridgeError =
        error instanceof BridgeError ? error : new BridgeError("plugin", (error as Error).message);
      sendControlResult(socket, {
        type: "result",
        id: message.id,
        ok: false,
        error: { message: bridgeError.message, code: bridgeError.code },
      });
    }
  }

  private disconnect(code: number): void {
    this.socket = null;
    this.connectedAt = null;
    this.file = null;
    this.plugin = null;
    this.logger.log(`plugin disconnected (code ${code})`);
    this.rejectAll("the plugin disconnected while the request was in flight");
    this.emitStatus();
  }

  private receive(raw: string): void {
    let message: BridgeMessage;
    try {
      message = JSON.parse(raw) as BridgeMessage;
    } catch {
      this.logger.log("ignoring non-JSON message from the plugin");
      return;
    }

    if (message.type === "status") {
      this.file = message.file ?? null;
      this.plugin = message.plugin ?? null;
      this.emitStatus();
      return;
    }

    if (message.type !== "response") {
      this.logger.log(`ignoring unexpected message type "${String((message as { type?: string }).type)}"`);
      return;
    }

    const response = message as BridgeResponseMessage;
    if (!this.pending.has(response.id)) return;
    if (response.ok) {
      this.settle(response.id, response.result);
    } else {
      // Plugin API errors (including plan limits) travel untouched.
      const detail = response.error?.message ?? "Unknown plugin error.";
      this.settle(response.id, undefined, new BridgeError("plugin", detail));
    }
  }

  private settle(id: string, result?: unknown, error?: BridgeError): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  private rejectAll(reason: string): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, undefined, new BridgeError("disconnected", `Request "${this.pending.get(id)?.method}" failed: ${reason}.`));
    }
  }

  private ping(): void {
    const socket = this.socket;
    if (!socket) return;
    if (!this.alive) {
      this.logger.log("plugin stopped responding to pings, dropping the connection");
      socket.terminate();
      return;
    }
    this.alive = false;
    socket.ping();
  }

  private tokenMatches(candidate: string | null): boolean {
    if (!candidate) return false;
    return safeEqual(digest(candidate), digest(this.options.token));
  }

  private emitStatus(): void {
    const status = this.status;
    for (const listener of this.listeners) listener(status);
  }
}

function queryFromUrl(url: string): URLSearchParams {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  return new URLSearchParams(query);
}

function pathFromUrl(url: string): string {
  const path = url.split("?")[0];
  return path.startsWith("/") ? path : "/";
}

function sendControlResult(socket: WebSocket, message: BridgeControlResultMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export const BRIDGE_HOST = HOST;