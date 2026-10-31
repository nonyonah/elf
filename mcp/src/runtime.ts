import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge, type BridgePairing } from "./bridge.js";
import { BridgeClient, type PluginConnection } from "./client.js";
import type { BridgeConfig } from "./config.js";
import { silentLogger, type Logger } from "./logger.js";

export interface BridgeRuntime {
  connection: PluginConnection;
  pairingCode: BridgePairing | null;
  owned: boolean;
  control<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  revoke(fileKey: string): Promise<void>;
  transaction<T>(fileKey: string, work: (client: BridgeClient) => Promise<T>, options?: {authorization?: "strict" | "plugin"}): Promise<T>;
  refreshPairingCode(): Promise<BridgePairing>;
  close(): Promise<void>;
}

/** Authentication proves identity; capabilities separately prove runtime support. */
async function requireFileVerification(connection: BridgeClient): Promise<void> {
  try {
    const capabilities = await connection.call<{fileVerification?: number}>("__elf_capabilities", {}, {timeoutMs: 1500});
    if (capabilities?.fileVerification !== 1 || (capabilities as { accountRenewal?: number; documentApproval?: number }).accountRenewal !== 1 || (capabilities as {documentApproval?: number}).documentApproval !== 1) throw new Error("Unsupported bridge");
  } catch {
    await connection.close();
    throw new Error("An older Elf shared bridge is still running. Stop Elf watcher and MCP sessions, run elf bridge --stop (or node bin/elf-tokens.js bridge --stop in this repo), then run elf start again. Saved pairings are preserved.");
  }
}

/** Reuse only an authenticated bridge. A port collision is never treated as trust. */
export async function acquireBridge(config: BridgeConfig, logger: Logger = silentLogger): Promise<BridgeRuntime> {
  if (config.persistent) return acquireSharedHost(config, logger);
  const bridge = new Bridge({ ...config, logger });
  const transaction = async <T>(fileKey: string, work: (client: BridgeClient) => Promise<T>, options?: {authorization?: "strict" | "plugin"}): Promise<T> => {
    const client = await BridgeClient.connect({ ...config, port: boundPort });
    try { return await client.transaction(fileKey, work, options); } finally { client.close(); }
  };
  let boundPort = config.port;
  try {
    boundPort = await bridge.start();
    return {
      revoke: async fileKey => { const client = await BridgeClient.connect({ ...config, port: boundPort }); try { await client.call("__elf_revoke", { fileKey }); } finally { client.close(); } },
      control: async <T>(method: string, params: Record<string, unknown> = {}) => { const client = await BridgeClient.connect({...config, port: boundPort}); try {return await client.call<T>(method, params);} finally {await client.close();} },
      transaction, connection: bridge, pairingCode: bridge.pairingCode, owned: true,
      refreshPairingCode: async () => bridge.refreshPairingCode(),
      close: () => bridge.stop(),
    };
  } catch (error) {
    if (((error as Error).cause as NodeJS.ErrnoException | undefined)?.code !== "EADDRINUSE") throw error;
    let connection: BridgeClient;
    try { connection = await BridgeClient.connect(config); }
    catch (connectError) {
      const collision = identityCollision(connectError, config.port);
      if (collision) throw collision;
      throw connectError;
    }
    await requireFileVerification(connection);
    logger.log("using the existing authenticated Elf bridge");
    return {
      revoke: async fileKey => { await connection.call("__elf_revoke", { fileKey }); },
      control: <T>(method: string, params?: Record<string, unknown>) => connection.call<T>(method, params),
      transaction, connection, pairingCode: null, owned: false,
      refreshPairingCode: () => connection.call<BridgePairing>("__elf_pairing_refresh"),
      close: async () => connection.close(),
    };
  }
}

/** A shared host outlives individual adapters and watcher terminals. */
function identityCollision(error: unknown, port: number): Error | null {
  const cause = error as { name?: string; code?: string; message?: string };
  if (cause.name === "BridgeError" && cause.code === "auth") return new Error(
    `Port ${port} already serves an Elf bridge with different credentials. ` +
    "Close that bridge (or the terminal running it) and retry, set ELF_MCP_TOKEN to that bridge's secret if both projects should share it, " +
    "or set ELF_MCP_PORT to a free port to run this project's bridge independently. Authentication was verified and rejected the connection.",
  );
  return null;
}

async function acquireSharedHost(config: BridgeConfig, logger: Logger): Promise<BridgeRuntime> {
  let connection: BridgeClient;
  try { connection = await BridgeClient.connect(config); }
  catch (error) {
    const collision = identityCollision(error, config.port);
    if (collision) throw collision;
    if (!(error as Error).message.includes("Cannot reach the Elf bridge")) throw error;
    const require = createRequire(import.meta.url);
    const host = spawn(process.execPath, ["--import", require.resolve("tsx"), fileURLToPath(new URL("./host.ts", import.meta.url))], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "ELF_FIGMA_ACCOUNT_PATH", "ELECTRON_RUN_AS_NODE"].includes(key))), ELF_MCP_TOKEN: config.token, ELF_MCP_PORT: String(config.port), ELF_MCP_TIMEOUT_MS: String(config.timeoutMs), ...(config.sessionStorePath ? { ELF_BRIDGE_SESSION_PATH: config.sessionStorePath } : {}) },
      detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { host.disconnect?.(); reject(new Error("Timed out starting the Elf bridge.")); }, 10_000);
      host.once("error", error => { clearTimeout(timer); reject(error); });
      host.once("message", () => { clearTimeout(timer); resolve(); });
      host.once("exit", () => { clearTimeout(timer); resolve(); }); // A racing starter may have won the port.
    });
    if (host.connected) host.disconnect(); host.unref();
    try { connection = await BridgeClient.connect(config); }
    catch (connectedError) {
      const retryCollision = identityCollision(connectedError, config.port);
      if (retryCollision) { host.kill?.(); throw retryCollision; }
      throw connectedError;
    }
  }
  await requireFileVerification(connection);
  logger.log("using the shared authenticated Elf bridge");
  const pairingCode = await connection.call<BridgePairing | null>("__elf_pairing_current");
  return {
    connection, pairingCode, owned: false,
    control: <T>(method: string, params?: Record<string, unknown>) => connection.call<T>(method, params),
    transaction: async (fileKey, work, options) => {
      const client = await BridgeClient.connect(config);
      try { return await client.transaction(fileKey, work, options); } finally { client.close(); }
    },
    refreshPairingCode: () => connection.call<BridgePairing>("__elf_pairing_refresh"),
    revoke: async fileKey => { await connection.call("__elf_revoke", { fileKey }); },
    close: async () => connection.close(),
  };
}
