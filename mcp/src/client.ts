import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { BRIDGE_HOST, Bridge, type BridgeStatus, type StatusListener } from "./bridge.js";
import { loadBridgeConfig, type BridgeConfig } from "./config.js";
import { BridgeError, type BridgeErrorCode } from "./errors.js";
import {
  AUTH_FAILED_CODE,
  CONTROL_PATH,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  TOKEN_ENV,
  type BridgeControlResultMessage,
} from "./protocol.js";

/**
 * Thin, typed-ish seam between the MCP tools and the bridge. Tools only ever
 * see this interface, which keeps them independent of WebSocket details and
 * makes "is the plugin open?" a single place.
 */
export class PluginClient {
  constructor(private readonly bridge: Bridge) {}

  get status(): BridgeStatus {
    return this.bridge.status;
  }

  get connected(): boolean {
    return this.bridge.isConnected;
  }

  onStatus(listener: StatusListener): () => void {
    return this.bridge.onStatus(listener);
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return this.bridge.request<T>(method, params, { timeoutMs });
  }
}

// ---------------------------------------------------------------------------
// /control client — how the batch CLI drives the bridge without speaking MCP.
// ---------------------------------------------------------------------------

export interface BridgeClientOptions {
  /** Loopback host to dial. Defaults to the bridge's own bind address. */
  host?: string;
  /** Bridge port. Defaults to `ELF_MCP_PORT` (see `mcp/.env`). */
  port?: number;
  /** Shared handshake token. Defaults to `ELF_MCP_TOKEN`. */
  token?: string;
  /** Per-call timeout. Defaults to `ELF_MCP_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface BridgeCallOptions {
  timeoutMs?: number;
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const CONNECT_TIMEOUT_MS = 5_000;
/**
 * The bridge closes the socket with 4001 right *after* the handshake when the
 * token is wrong, so a successful open only counts after this grace period.
 */
const AUTH_GRACE_MS = 150;

/**
 * A local client for the bridge's `/control` lane: one WebSocket, many
 * `call(tool, args)` round trips, each matched by its own id. Connecting
 * fails fast with an actionable message instead of hanging when the MCP
 * server isn't running, the token is wrong, or the plugin is closed.
 */
export class BridgeClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private readonly timeoutMs: number;
  private readonly address: string;

  constructor(private readonly options: Required<BridgeClientOptions>) {
    this.timeoutMs = options.timeoutMs;
    this.address = `ws://${options.host}:${options.port}`;
  }

  /** Opens the connection. Options left out fall back to `ELF_MCP_*` env vars. */
  static async connect(options: BridgeClientOptions = {}): Promise<BridgeClient> {
    // A token passed in-code is authoritative; the environment only fills the
    // gaps. Without one anywhere, loadBridgeConfig throws its own clear message.
    let env: BridgeConfig | null = null;
    try {
      env = loadBridgeConfig();
    } catch (error) {
      if (options.token === undefined) throw error;
    }

    const client = new BridgeClient({
      host: options.host ?? BRIDGE_HOST,
      port: options.port ?? env?.port ?? DEFAULT_PORT,
      token: options.token ?? env?.token ?? "",
      timeoutMs: options.timeoutMs ?? env?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    await client.open();
    return client;
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: BridgeCallOptions = {},
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new BridgeError("transport", `Not connected to the Elf bridge at ${this.address}.`);
    }

    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            "timeout",
            `Timed out after ${timeoutMs}ms waiting for the bridge to answer "${method}" — ` +
              `is the plugin panel responsive?`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ type: "call", id, method, params }), (error) => {
        if (!error) return;
        this.settle(id, undefined, new BridgeError("transport", `Could not send "${method}": ${error.message}`));
      });
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "client closing");
    this.rejectAll(new BridgeError("disconnected", "The bridge client was closed."));
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${this.address}${CONTROL_PATH}?token=${encodeURIComponent(this.options.token)}`);
      this.socket = socket;

      let settled = false;
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        socket.terminate();
        if (this.socket === socket) this.socket = null;
        settleReject(
          new BridgeError(
            "timeout",
            `Timed out connecting to the Elf bridge at ${this.address} — is the MCP server running?`,
          ),
        );
      }, CONNECT_TIMEOUT_MS);

      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (this.socket === socket) this.socket = null;
        settleReject(new BridgeError("transport", connectionError(error, this.address)));
      });
      socket.on("close", (code) => {
        if (this.socket === socket) this.socket = null;
        const error = closeError(code, this.address);
        this.rejectAll(error);
        settleReject(error);
      });
      socket.on("message", (data) => this.receive(data.toString()));
      socket.once("open", () => {
        clearTimeout(timer);
        // Give the bridge's 4001 close frame a moment to land before saying
        // "connected" — that frame is how a wrong token shows up here.
        setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve();
        }, AUTH_GRACE_MS);
      });
    });
  }

  private receive(raw: string): void {
    let message: BridgeControlResultMessage;
    try {
      message = JSON.parse(raw) as BridgeControlResultMessage;
    } catch {
      return;
    }
    if (message.type !== "result" || !this.pending.has(message.id)) return;

    if (message.ok) {
      this.settle(message.id, message.result);
      return;
    }
    // The bridge relays BridgeError codes; unknown ones fall back to "plugin"
    // so plan-limit and not-connected messages keep their exact text either way.
    const code = message.error?.code as BridgeErrorCode | undefined;
    this.settle(
      message.id,
      undefined,
      new BridgeError(code ?? "plugin", message.error?.message ?? "Unknown bridge error."),
    );
  }

  private settle(id: string, result?: unknown, error?: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.settle(id, undefined, error);
  }
}

/** Opens a `/control` connection to the bridge. */
export function createBridgeClient(options: BridgeClientOptions = {}): Promise<BridgeClient> {
  return BridgeClient.connect(options);
}

function connectionError(error: NodeJS.ErrnoException, address: string): string {
  if (error.code === "ECONNREFUSED") {
    return (
      `Cannot reach the Elf bridge at ${address} — start it first ` +
      `(cd mcp && npm run start, or npm run start:http for web clients).`
    );
  }
  return `Could not connect to the Elf bridge at ${address}: ${error.message}`;
}

function closeError(code: number, address: string): BridgeError {
  if (code === AUTH_FAILED_CODE) {
    return new BridgeError(
      "auth",
      `The Elf bridge rejected the token — batch and the MCP server must share the same ${TOKEN_ENV}.`,
    );
  }
  return new BridgeError("disconnected", `The Elf bridge connection closed (code ${code}) at ${address}.`);
}