import WebSocket from "ws";
import type { BridgeMessage, BridgeRequestMessage } from "../../src/protocol.js";

export type MethodHandler = (params: Record<string, unknown>, request: BridgeRequestMessage) => unknown;

export interface FakePluginOptions {
  port: number;
  token: string;
  handlers?: Record<string, MethodHandler>;
  /** When set, the plugin accepts the connection but never answers. */
  silent?: boolean;
}

/**
 * Stands in for the plugin's UI iframe: opens the WebSocket and answers
 * requests with the same envelopes bridge-plugin/ui.html relays.
 */
export class FakePlugin {
  readonly requests: BridgeRequestMessage[] = [];

  private closeCode: number | null = null;
  private closeReason = "";

  private constructor(
    private readonly socket: WebSocket,
    private readonly options: FakePluginOptions,
  ) {
    this.socket.on("message", (data) => this.receive(data.toString()));
    this.socket.on("close", (code, reason) => {
      this.closeCode = code;
      this.closeReason = reason.toString();
    });
  }

  static connect(options: FakePluginOptions): Promise<FakePlugin> {
    const socket = new WebSocket(`ws://127.0.0.1:${options.port}/?token=${encodeURIComponent(options.token)}`);
    const plugin = new FakePlugin(socket, options);
    return new Promise((resolve, reject) => {
      const onOpen = (): void => {
        socket.off("error", onError);
        socket.off("close", onEarlyClose);
        resolve(plugin);
      };
      const onError = (error: Error): void => reject(error);
      const onEarlyClose = (code: number): void => reject(new Error(`closed before opening (code ${code})`));
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onEarlyClose);
    });
  }

  send(message: BridgeMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  sendStatus(file: { name: string; key: string }): void {
    this.send({ type: "status", file, plugin: { name: "Elf Bridge (fake)", apiVersion: "1.0.0" } });
  }

  close(code = 1000, reason = ""): void {
    this.socket.close(code, reason);
  }

  terminate(): void {
    this.socket.terminate();
  }

  /** Resolves with the close code the bridge sent — used for handshake assertions. */
  waitForClose(timeoutMs = 2000): Promise<{ code: number | null; reason: string }> {
    if (this.closeCode !== null) return Promise.resolve({ code: this.closeCode, reason: this.closeReason });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("plugin connection was not closed in time")), timeoutMs);
      this.socket.once("close", (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  private receive(raw: string): void {
    const message = JSON.parse(raw) as BridgeMessage;
    if (message.type !== "request") return;

    this.requests.push(message);
    if (this.options.silent) return;

    const handler = this.options.handlers?.[message.method];
    if (!handler) {
      this.respond(message.id, false, undefined, { message: `Unknown method: ${message.method}` });
      return;
    }
    try {
      this.respond(message.id, true, handler(message.params ?? {}, message));
    } catch (error) {
      // Mirrors the plugin: the Figma error message travels back untouched.
      this.respond(message.id, false, undefined, {
        message: (error as Error).message,
        name: (error as Error).name,
      });
    }
  }

  private respond(id: string, ok: boolean, result?: unknown, error?: { message: string; name?: string }): void {
    this.send({ type: "response", id, ok, result, error });
  }
}

/** Raw WebSocket connect without the helper — used for handshake/auth tests. */
export function rawConnect(port: number, query: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    socket.once("close", (code) => reject(new Error(`closed before opening (code ${code})`)));
  });
}

export function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("condition was not met in time"));
      setTimeout(tick, 10);
    };
    tick();
  });
}