import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "../../mcp/src/client.js";
import { loadDotEnvFile, loadRuntimeBridgeConfig } from "../../mcp/src/config.js";
import { BridgeError } from "../../mcp/src/errors.js";
import type { WatchBridge } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Choose the bridge identity from explicit process configuration or the private
 * machine identity before loading project settings. Legacy dotenv credentials
 * cannot silently split the shared bridge identity across workspaces.
 */
export function loadWatchEnv(projectRoot = process.cwd(), env: NodeJS.ProcessEnv = process.env, credentialDir?: string): void {
  // A project dotenv must not change the machine-wide bridge identity.
  // Explicit process environment overrides remain authoritative.
  env.ELF_MCP_TOKEN = loadRuntimeBridgeConfig(env,credentialDir).token;
  for (const path of [
    resolve(projectRoot, ".env"),
    resolve(projectRoot, ".env.local"),
    resolve(projectRoot, "mcp/.env"),
    resolve(process.cwd(), "mcp/.env"),
    resolve(here, "../../mcp/.env"),
  ]) {
    if (existsSync(path)) loadDotEnvFile(path,env);
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
