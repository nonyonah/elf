import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "../../mcp/src/client.js";
import { loadDotEnvFile } from "../../mcp/src/config.js";
import { BridgeError } from "../../mcp/src/errors.js";
import type { WatchBridge } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The bridge reads `ELF_MCP_*` from the environment. Load the repo's
 * `mcp/.env` and the consumer project's `.env` without overriding real shell
 * variables, then let BridgeClient.connect() apply its usual defaults.
 */
export function loadWatchEnv(projectRoot = process.cwd()): void {
  for (const path of [
    resolve(projectRoot, ".env"),
    resolve(projectRoot, ".env.local"),
    resolve(projectRoot, "mcp/.env"),
    resolve(process.cwd(), "mcp/.env"),
    resolve(here, "../../mcp/.env"),
  ]) {
    if (existsSync(path)) loadDotEnvFile(path);
  }
}

export async function connectWatchBridge(projectRoot = process.cwd()): Promise<WatchBridge> {
  loadWatchEnv(projectRoot);
  return BridgeClient.connect();
}

/** Is this a "start the bridge / open the plugin" problem rather than a code error? */
export function isBridgeUnavailable(error: unknown): boolean {
  if (error instanceof BridgeError) {
    return (
      error.code === "not-connected" ||
      error.code === "transport" ||
      error.code === "timeout" ||
      error.code === "disconnected"
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /not connected|ECONNREFUSED|socket hang up|is the MCP server running|No Figma plugin connected/i.test(
    message,
  );
}
