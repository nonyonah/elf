import { createHash, createHmac, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { BRIDGE_HOST, type BridgeStatus, type StatusListener } from "./bridge.js";
import { loadRuntimeBridgeConfig, type BridgeConfig } from "./config.js";
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
export interface PluginConnection {
  readonly status: BridgeStatus;
  readonly isConnected: boolean;
  onStatus(listener: StatusListener): () => void;
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
}

export class PluginClient {
  constructor(private readonly bridge: PluginConnection, private readonly transact?: <T>(fileKey: string, work: (client: BridgeClient) => Promise<T>) => Promise<T>) {}

  async mutate<T>(work: (client: PluginClient) => Promise<T>): Promise<T> {
    if (!this.transact) return work(this);
    const fileKey = this.status.file?.key;
    if (!fileKey) throw new Error("Connect the intended Figma file before editing it.");
    return this.transact(fileKey, connection => work(new PluginClient(connection)));
  }

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
 * A local client for the bridge's `/control` lane: one WebSocket, many
 * `call(tool, args)` round trips, each matched by its own id. Connecting
 * fails fast with an actionable message instead of hanging when the MCP
 * server isn't running, the token is wrong, or the plugin is closed.
 */
export class BridgeClient {
  private socket: WebSocket | null = null;
  private channel: {key: string; context: string; sent: number; received: number} | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private readonly listeners = new Set<StatusListener>();
  private bridgeStatus: BridgeStatus = {
    connected: false, port: null, address: null, file: null, plugin: null, connectedAt: null,
  };

  get status(): BridgeStatus { return this.bridgeStatus; }
  get isConnected(): boolean { return this.bridgeStatus.connected; }
  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, options: BridgeCallOptions = {}): Promise<T> {
    return this.call<T>(method, params, options);
  }
  private updateStatus(status: BridgeStatus): void {
    this.bridgeStatus = status;
    for (const listener of this.listeners) listener(status);
  }
  private readonly timeoutMs: number;
  private readonly address: string;

  constructor(private readonly options: Required<BridgeClientOptions>) {
    this.timeoutMs = options.timeoutMs;
    this.address = `ws://${options.host.includes(":") ? `[${options.host}]` : options.host}:${options.port}`;
  }

  /** Opens the connection. Options left out fall back to `ELF_MCP_*` env vars. */
  static async connect(options: BridgeClientOptions = {}): Promise<BridgeClient> {
    // A token passed in-code is authoritative; the environment only fills the
    // gaps. Without one anywhere, loadRuntimeBridgeConfig throws its own clear message.
    let env: BridgeConfig | null = null;
    try {
      env = options.token === undefined ? loadRuntimeBridgeConfig() : loadRuntimeBridgeConfig({ ...process.env, [TOKEN_ENV]: options.token });
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
      socket.send(this.encode({ type: "call", id, method, params }), (error) => {
        if (!error) return;
        this.settle(id, undefined, new BridgeError("transport", `Could not send "${method}": ${error.message}`));
      });
    });
  }

  /** Hold the shared bridge lane across a complete read/plan/write transaction. */
  async transaction<T>(fileKey: string, work: (client: BridgeClient) => Promise<T>): Promise<T> {
    await this.call("__elf_lock", { fileKey }, { timeoutMs: 30_000 });
    try { return await work(this); }
    finally { await this.call("__elf_unlock").catch(() => {}); }
  }

  close(): Promise<void> {
    const socket = this.socket;
    const closed = socket && socket.readyState !== WebSocket.CLOSED ? new Promise<void>(resolve => socket.once("close", () => resolve())) : Promise.resolve();
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "client closing");
    this.rejectAll(new BridgeError("disconnected", "The bridge client was closed."));
    this.updateStatus({ ...this.bridgeStatus, connected: false, file: null, plugin: null, connectedAt: null });
    return closed;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const nonce = randomBytes(32).toString("hex");
      const key = createHash("sha256").update("control\n" + this.options.token).digest("hex");
      this.channel = null;
      const socket = new WebSocket(`${this.address}${CONTROL_PATH}?nonce=${nonce}`);
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
        this.updateStatus({ ...this.bridgeStatus, connected: false, file: null, plugin: null, connectedAt: null });
        settleReject(error);
      });
      socket.on("message", data => {
        try {
          const message = JSON.parse(data.toString());
          if (!this.channel) {
            if (message.type !== "challenge" || typeof message.nonce !== "string" || !/^[a-f0-9]{64}$/.test(message.nonce) || typeof message.proof !== "string" || !/^[a-f0-9]{64}$/.test(message.proof)) throw new Error("Invalid bridge identity.");
            const context = `${nonce}\n${message.nonce}`;
            const expected = createHmac("sha256", Buffer.from(key, "hex")).update(`server\n${context}`).digest();
            if (!timingSafeEqual(expected, Buffer.from(message.proof, "hex"))) throw new Error("Could not verify the bridge identity.");
            this.channel = {key, context, sent: 0, received: 0};
            socket.send(JSON.stringify({type: "authenticate", proof: createHmac("sha256", Buffer.from(key, "hex")).update(`client\n${context}`).digest("hex")}));
            return;
          }
          this.receive(this.decode(message));
          if (!settled) { settled = true; clearTimeout(timer); resolve(); }
        } catch (error) {
          socket.close(AUTH_FAILED_CODE, "invalid bridge authentication");
          settleReject(new BridgeError("auth", (error as Error).message));
        }
      });
    });
  }

  private encode(message: unknown): string {
    const channel = this.channel;
    if (!channel) throw new BridgeError("auth", "The bridge has not authenticated.");
    const payload = JSON.stringify(message), sequence = ++channel.sent;
    const proof = createHmac("sha256", Buffer.from(channel.key, "hex")).update(`message-client\n${channel.context}\n${sequence}\n${payload}`).digest("hex");
    return JSON.stringify({type: "authenticated", sequence, payload, proof});
  }
  private decode(frame: any): string {
    const channel = this.channel!;
    if (frame.type !== "authenticated" || frame.sequence !== channel.received + 1 || typeof frame.payload !== "string" || typeof frame.proof !== "string" || !/^[a-f0-9]{64}$/.test(frame.proof)) throw new Error("Invalid authenticated frame.");
    const proof = createHmac("sha256", Buffer.from(channel.key, "hex")).update(`message-server\n${channel.context}\n${frame.sequence}\n${frame.payload}`).digest();
    if (!timingSafeEqual(proof, Buffer.from(frame.proof, "hex"))) throw new Error("Invalid bridge message proof.");
    channel.received++; return frame.payload;
  }

  private receive(raw: string): void {
    let message: BridgeControlResultMessage;
    try {
      message = JSON.parse(raw) as BridgeControlResultMessage;
    } catch {
      return;
    }
    const statusMessage = message as unknown as { type: string; status?: BridgeStatus };
    if (statusMessage.type === "bridge-status" && statusMessage.status) {
      this.updateStatus(statusMessage.status);
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