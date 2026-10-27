import { verifyPublicFile } from "../../src/figma/file-identity.js";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { SessionStore } from "./sessions.js";
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
  sessionStore?: SessionStore;
  shutdown?: () => void;
  token: string;
  port: number;
  timeoutMs?: number;
  logger?: Logger;
  /** How long the one-time pairing code stays valid. */
  pairingCodeTtlMs?: number;
  /** How long a session secret issued by pairing stays valid. */
  sessionTtlMs?: number;
  verifyPublicFile?: typeof verifyPublicFile;
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
 * UI iframe. Binds to IPv4 and IPv6 loopback.
 *
 * First pairing uses a one-time code. Persistent reconnects and controllers
 * verify fresh HMAC challenges and authenticate subsequent messages. Legacy
 * bearer sessions remain available only to nonpersistent compatibility hosts.
 */
export class Bridge {
  private server: WebSocketServer | null = null;
  private server6: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private activeSession: string | null = null;
  private pendingAuth = 0;
  private channels = new WeakMap<WebSocket, {key: string; context: string; sent: number; received: number}>();
  private readonly controls = new Set<WebSocket>();
  private keepalive: NodeJS.Timeout | null = null;
  private port: number | null = null;
  private boundAddress: string | null = null;
  private connectedAt: string | null = null;
  private file: BridgeFileInfo | null = null;
  private identityGeneration = 0;
  private publicIdentity = false;
  private plugin: BridgePluginInfo | null = null;
  private alive = false;
  private jobs: { queuedAt: number; owner: WebSocket | null; method: string; params: Record<string, unknown>; options: RequestOptions; resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  private processing = false;
  private lockOwner: WebSocket | null = null;
  private lockFile: string | null = null;
  private lockTimer: NodeJS.Timeout | null = null;

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

  /** Rotate only the unused pairing code; established sessions stay valid. */
  refreshPairingCode(): BridgePairing {
    if (!this.server) throw new Error("Start the Elf bridge before requesting a pairing code.");
    const pairing = createPairingCode(Date.now(), this.pairingTtlMs);
    this.pairing = { ...pairing, hash: pairingCodeDigest(pairing.code) };
    return { code: pairing.code, expiresAt: new Date(pairing.expiresAt).toISOString() };
  }

  /** Starts listening. Resolves with the bound port (port 0 picks a free one). */
  async start(): Promise<number> {
    if (this.server) throw new Error("Bridge already started.");

    const server = new WebSocketServer({ host: HOST, port: this.options.port, maxPayload: MAX_PAYLOAD_BYTES });
    this.server = server;
    server.on("connection", (socket, request) => { try { this.accept(socket, request.url ?? ""); } catch { socket.close(AUTH_FAILED_CODE, "pairing storage unavailable"); } });


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
            `Stop it or set a different ${"ELF_MCP_PORT"}.`, { cause: error },
        );
      }
      throw error;
    }

    const address = server.address() as AddressInfo | null;
    this.port = address?.port ?? this.options.port;
    this.boundAddress = address?.address ?? HOST;
    const ipv6 = new WebSocketServer({ host: "::1", port: this.port, maxPayload: MAX_PAYLOAD_BYTES });
    try {
      await new Promise<void>((resolve, reject) => { ipv6.once("listening", resolve); ipv6.once("error", reject); });
      this.server6 = ipv6;
      ipv6.on("connection", (socket, request) => { try { this.accept(socket, request.url ?? ""); } catch { socket.close(AUTH_FAILED_CODE, "pairing storage unavailable"); } });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL") {
        await this.stop();
        throw new Error("The IPv6 loopback bridge could not bind safely. Close the process using its port before starting Elf.", { cause: error });
      }
    }
    const pairing = createPairingCode(Date.now(), this.pairingTtlMs);
    this.pairing = { ...pairing, hash: pairingCodeDigest(pairing.code) };
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
    for (const job of this.jobs.splice(0)) job.reject(new BridgeError("disconnected", "The bridge shut down."));
    this.releaseLock();
    const server6 = this.server6; this.server6 = null;
    if (server6) { for (const client of server6.clients) client.terminate(); await new Promise<void>(resolve => server6.close(() => resolve())); }
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
  private async sendRequest<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const socket = this.socket;
    if (!socket) {
      throw new BridgeError("not-connected", `No Figma plugin connected — ${NOT_CONNECTED_HINT}.`);
    }

    if ((this.options.sessionStore || this.publicIdentity) && !this.file) throw new BridgeError("not-connected", "The Figma file has not been verified. Connect your account in Settings and check the plugin file link.");
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

      socket.send(this.encodePlugin(socket, { type: "request", id, method, params }), (error) => {
        if (!error) return;
        this.settle(id, undefined, new BridgeError("transport", `Could not send "${method}": ${error.message}`));
      });
    });
  }

  /** One bridge-wide lane, including requests from direct MCP adapters. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<T> {
    return this.schedule(null, method, params, options);
  }

  private schedule<T>(owner: WebSocket | null, method: string, params: Record<string, unknown>, options: RequestOptions = {}): Promise<T> {
    if (this.jobs.length >= 256) return Promise.reject(new BridgeError("transport", "The Elf bridge is busy. Try again shortly."));
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ queuedAt: Date.now(), owner, method, params, options, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.jobs.length) {
        const index = this.lockOwner ? this.jobs.findIndex(job => job.owner === this.lockOwner) : 0;
        if (index < 0) break;
        const job = this.jobs.splice(index, 1)[0];
        try {
          if (Date.now() - job.queuedAt >= (job.method === "__elf_lock" ? 30_000 : job.options.timeoutMs ?? this.timeoutMs)) throw new BridgeError("timeout", "The queued bridge operation expired before it started.");
          if (job.owner && job.owner.readyState !== WebSocket.OPEN) throw new BridgeError("disconnected", "The operation's controller disconnected.");
          if (job.method === "__elf_lock") {
            if (!job.owner || this.lockOwner) throw new Error("A transaction is already active on this connection.");
            const fileKey = job.params.fileKey;
            if (typeof fileKey !== "string" || !fileKey || this.file?.key !== fileKey || !this.socket) throw new Error("The connected Figma file does not match the operation's target.");
            this.lockOwner = job.owner;
            this.lockFile = fileKey;
            this.lockTimer = setTimeout(() => {
              this.lockOwner?.close(1008, "transaction expired");
              this.releaseLock();
            }, 120_000);
            job.resolve({ ok: true });
          } else if (job.method === "__elf_unlock") {
            if (!job.owner || job.owner !== this.lockOwner) throw new Error("This connection does not own the transaction.");
            this.releaseLock();
            job.resolve({ ok: true });
          } else {
            if (this.lockOwner === job.owner && this.lockFile && this.file?.key !== this.lockFile) throw new Error("The Figma file changed during the operation. Nothing else was written.");
            job.resolve(await this.sendRequest(job.method, job.params, job.options));
          }
        } catch (error) { job.reject(error instanceof Error ? error : new Error(String(error))); }
      }
    } finally { this.processing = false; }
  }

  private releaseLock(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null; this.lockOwner = null; this.lockFile = null;
    void this.drain();
  }

  private accept(socket: WebSocket, url: string): void {
    const params = queryFromUrl(url);

    if (pathFromUrl(url) === CONTROL_PATH) {
      if (params.has("nonce")) { this.authenticateSaved(socket, params, true); return; }
      if (this.options.sessionStore) { socket.close(AUTH_FAILED_CODE, "verified handshake required"); return; }
      if (!this.tokenMatches(params.get("token"))) {
        this.logger.log("rejected control connection: bad or missing handshake token");
        socket.close(AUTH_FAILED_CODE, "unauthorized");
        return;
      }
      this.acceptControl(socket);
      return;
    }

    if (params.has("hint") && this.options.sessionStore) { this.authenticateSaved(socket, params); return; }
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
      issued = this.options.sessionStore ? { session: this.options.sessionStore.issue(), expiresAt: 0 } : issueSession(this.options.token, Date.now(), this.sessionTtlMs);
      auth = "code";
    } else if (session) {
      if (this.options.sessionStore || verifySession(this.options.token, session) === null) {
        socket.close(AUTH_FAILED_CODE, "saved pairing requires a verified handshake; pair again"); return;
      }
      auth = "session";
    } else if (!this.tokenMatches(params.get("token"))) {
      this.logger.log("rejected connection: bad or missing handshake credentials");
      socket.close(AUTH_FAILED_CODE, "unauthorized");
      return;
    }

    this.acceptPlugin(socket, issued, auth);
    this.activeSession = this.options.sessionStore && issued ? createHash("sha256").update(issued.session).digest("hex") : null;
  }

  private authenticateSaved(socket: WebSocket, params: URLSearchParams, control = false): void {
    const client = params.get("nonce") ?? "";
    const key = control ? createHash("sha256").update("control\n" + this.options.token).digest("hex") : this.options.sessionStore!.keyForHint(params.get("hint") ?? "");
    if (!key || !/^[a-f0-9]{64}$/.test(client) || this.pendingAuth >= 32) {
      socket.close(AUTH_FAILED_CODE, "unauthorized"); return;
    }
    this.pendingAuth++;
    const server = randomBytes(32).toString("hex");
    const proof = (role: string) => createHmac("sha256", Buffer.from(key, "hex")).update(`${role}\n${client}\n${server}`).digest();
    const timer = setTimeout(() => socket.close(AUTH_FAILED_CODE, "authentication timed out"), 5000); timer.unref();
    let finished = false;
    const cleanup = () => { if (!finished) { finished = true; clearTimeout(timer); this.pendingAuth--; } };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
    socket.once("message", data => {
      cleanup();
      try {
        const message = JSON.parse(data.toString());
        if (message.type !== "authenticate" || typeof message.proof !== "string" || !/^[a-f0-9]{64}$/.test(message.proof) ||
            !timingSafeEqual(proof("client"), Buffer.from(message.proof, "hex")) || (!control && this.options.sessionStore!.keyForHint(params.get("hint")!) !== key)) {
          socket.close(AUTH_FAILED_CODE, "unauthorized"); return;
        }
        this.channels.set(socket, {key, context: `${client}\n${server}`, sent: 0, received: 0});
        if (control) this.acceptControl(socket);
        else { this.acceptPlugin(socket, null, "session"); this.activeSession = key; }
      } catch { socket.close(AUTH_FAILED_CODE, "unauthorized"); }
    });
    socket.send(JSON.stringify({ type: "challenge", nonce: server, proof: proof("server").toString("hex") }));
  }

  private sendControlResult(socket: WebSocket, message: BridgeControlResultMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(this.encodePlugin(socket, message));
  }
  private encodePlugin(socket: WebSocket, message: unknown): string {
    const channel = this.channels.get(socket);
    if (!channel) return JSON.stringify(message);
    const payload = JSON.stringify(message), sequence = ++channel.sent;
    const proof = createHmac("sha256", Buffer.from(channel.key, "hex")).update(`message-server\n${channel.context}\n${sequence}\n${payload}`).digest("hex");
    return JSON.stringify({type: "authenticated", sequence, payload, proof});
  }
  private decodePlugin(socket: WebSocket, raw: string): string {
    const channel = this.channels.get(socket);
    if (!channel) return raw;
    const frame = JSON.parse(raw);
    if (frame.type !== "authenticated" || frame.sequence !== channel.received + 1 || typeof frame.payload !== "string" || typeof frame.proof !== "string" || !/^[a-f0-9]{64}$/.test(frame.proof)) throw new Error("Invalid authenticated frame.");
    const expected = createHmac("sha256", Buffer.from(channel.key, "hex")).update(`message-client\n${channel.context}\n${frame.sequence}\n${frame.payload}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(frame.proof, "hex"))) throw new Error("Invalid message proof.");
    channel.received++; return frame.payload;
  }

  private acceptPlugin(
    socket: WebSocket,
    issued: SessionSecret | null,
    auth: "code" | "session" | "token",
  ): void {
    const previous = this.socket;
    if (previous) this.rejectAll("the plugin connection was replaced");
    this.socket = socket;
    if (previous) {
      this.logger.log("closing previous plugin connection");
      previous.close(REPLACED_CODE, "replaced by another plugin connection");
    }

    this.alive = true;
    this.connectedAt = new Date().toISOString();
    this.file = null;
    this.publicIdentity = false; this.identityGeneration++;
    this.plugin = null;
    if (auth === "code") this.logger.log("plugin paired with a one-time code");
    else if (auth === "session") this.logger.log("plugin reconnected with its saved session");
    else this.logger.log("plugin connected with the handshake token");
    this.emitStatus();

    socket.send(
      this.encodePlugin(socket, {
        type: "ready",
        fileVerification: 1,
        ...(issued
          ? { session: issued.session, ...(issued.expiresAt ? { sessionExpiresAt: new Date(issued.expiresAt).toISOString() } : {}) }
          : {}),
      }),
    );

    socket.on("pong", () => {
      this.alive = true;
    });
    socket.on("message", (data) => { if (this.socket === socket) { try { this.receive(this.decodePlugin(socket, data.toString())); } catch { socket.close(AUTH_FAILED_CODE, "pairing storage unavailable"); } } });
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
    socket.send(this.encodePlugin(socket, { type: "bridge-status", status: this.status }));
    this.logger.log("control client connected");

    socket.on("message", (data) => { try { void this.receiveControl(socket, this.decodePlugin(socket, data.toString())); } catch { socket.close(AUTH_FAILED_CODE, "invalid authenticated message"); } });
    socket.on("close", () => {
      this.controls.delete(socket);
      const abandoned = this.jobs.filter(job => job.owner === socket);
      this.jobs = this.jobs.filter(job => job.owner !== socket);
      for (const job of abandoned) job.reject(new BridgeError("disconnected", "The transaction controller disconnected."));
      if (this.lockOwner === socket) this.releaseLock();
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
      let result: unknown;
      if (message.method === "__elf_capabilities") result = {fileVerification: 1};
      else if (message.method === "__elf_pairing_refresh") result = this.refreshPairingCode();
      else if (message.method === "__elf_pairing_current") result = this.pairingCode;
      else if (message.method === "__elf_revoke") {
        const key = message.params?.fileKey;
        if (typeof key !== "string" || !key) throw new Error("Choose a Figma file to disconnect.");
        if (!this.options.sessionStore) throw new Error("Pairing revocation requires the shared persistent bridge.");
        this.options.sessionStore.revoke(key);
        if (this.file?.key === key) this.socket?.close(AUTH_FAILED_CODE, "pairing revoked");
        result = { ok: true };
      } else if (message.method === "__elf_shutdown") {
        if (this.controls.size > 1 || this.lockOwner) throw new Error("Other Elf clients are using the bridge. Close them before stopping it.");
        result = { ok: true };
        setTimeout(() => this.options.shutdown?.(), 50);
      } else result = await this.schedule(socket, message.method, message.params ?? {});
      this.sendControlResult(socket, { type: "result", id: message.id, ok: true, result });
    } catch (error) {
      const bridgeError =
        error instanceof BridgeError ? error : new BridgeError("plugin", (error as Error).message);
      this.sendControlResult(socket, {
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
    this.publicIdentity = false; this.identityGeneration++;
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

    if (message.type === "status" && message.file?.verification) {
      const socket = this.socket; const file = message.file; const generation = ++this.identityGeneration;
      this.publicIdentity = true;
      this.file = null; this.emitStatus();
      if (this.lockOwner) this.releaseLock();
      void (this.options.verifyPublicFile ?? verifyPublicFile)(file.key, file.verification!).then(() => {
        if (this.socket !== socket || !socket || generation !== this.identityGeneration) return;
        if (this.options.sessionStore && this.activeSession && !this.options.sessionStore.bindKey(this.activeSession, file.key)) throw new Error("Pairing belongs to a different file");
        this.file = file; this.plugin = message.plugin ?? null; this.emitStatus();
        socket.send(this.encodePlugin(socket, {type: "file-verified"}));
      }).catch(() => {
        if (this.socket === socket && generation === this.identityGeneration) socket?.close(4003, "File not verified. Connect Figma in Settings, check the file link, and retry after saving.");
      });
      return;
    }
    if (message.type === "status") {
      if (this.publicIdentity) {this.socket?.close(4003, "File verification is required for this session."); return;}
      this.identityGeneration++;
      if (this.options.sessionStore && this.activeSession) {
        const key = message.file?.key;
        if (!key || !this.options.sessionStore.bindKey(this.activeSession, key)) {
          this.socket?.close(AUTH_FAILED_CODE, "pairing belongs to another file"); return;
        }
      }
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
    for (const control of this.controls) {
      if (control.readyState === WebSocket.OPEN) control.send(this.encodePlugin(control, { type: "bridge-status", status }));
    }
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


function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export const BRIDGE_HOST = HOST;
