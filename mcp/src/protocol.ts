/**
 * Wire protocol shared by the MCP server and the bridge plugin.
 *
 * The plugin main thread cannot open sockets, so the UI iframe holds the
 * WebSocket and relays these envelopes in both directions via postMessage.
 * Every message is JSON.
 */

export const PLUGIN_NAMESPACE = "elf";
export const PLUGIN_CODE_KEY = "codeKey";

export const DEFAULT_PORT = 8765;
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Port for the optional Streamable HTTP transport (web clients + tunnels). */
export const DEFAULT_HTTP_PORT = 8788;

export const TOKEN_ENV = "ELF_MCP_TOKEN";
export const PORT_ENV = "ELF_MCP_PORT";
export const TIMEOUT_ENV = "ELF_MCP_TIMEOUT_MS";
export const HTTP_PORT_ENV = "ELF_MCP_HTTP_PORT";

export const NOT_CONNECTED_HINT =
  "open the Elf Bridge plugin in Figma (Plugins → Development) and keep it open";

/**
 * Path local controllers (the batch CLI) dial for direct tool calls. Same
 * token, same loopback bind as the plugin path — just a second lane so a
 * headless process can drive the bridge without speaking MCP.
 */
export const CONTROL_PATH = "/control";

export interface BridgeFileInfo {
  name: string;
  key: string;
}

export interface BridgePluginInfo {
  name: string;
  version?: string;
  apiVersion?: string;
}

export interface BridgeRequestMessage {
  type: "request";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface BridgeErrorPayload {
  message: string;
  name?: string;
}

export interface BridgeResponseMessage {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeErrorPayload;
}

export interface BridgeStatusMessage {
  type: "status";
  file?: BridgeFileInfo;
  plugin?: BridgePluginInfo;
}

export type BridgeMessage =
  | BridgeRequestMessage
  | BridgeResponseMessage
  | BridgeStatusMessage;

/** One tool call on the /control lane. */
export interface BridgeControlCallMessage {
  type: "call";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface BridgeControlResultMessage {
  type: "result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeErrorPayload & { code?: string };
}

export type BridgeControlMessage = BridgeControlCallMessage | BridgeControlResultMessage;

/** WebSocket close code sent when the handshake token is missing or wrong. */
export const AUTH_FAILED_CODE = 4001;

/** WebSocket close code sent to a plugin connection that a newer one replaces. */
export const REPLACED_CODE = 4002;