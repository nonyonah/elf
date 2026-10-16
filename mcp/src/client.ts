import { Bridge, type BridgeStatus, type StatusListener } from "./bridge.js";

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