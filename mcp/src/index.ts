#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge.js";
import { PluginClient } from "./client.js";
import { loadBridgeConfig, loadDotEnvFile, loadHttpPort, tokenFingerprint } from "./config.js";
import { startHttpTransport } from "./http.js";
import { stderrLogger } from "./logger.js";
import { TOKEN_ENV } from "./protocol.js";
import { registerAllTools } from "./tools/index.js";

/** `--http` serves Streamable HTTP (web clients + tunnels); default is stdio. */
const USE_HTTP = process.argv.includes("--http");

function createServer(client: PluginClient): McpServer {
  const server = new McpServer({ name: "elf-figma", version: "0.1.0" });
  registerAllTools(server, client);
  return server;
}

async function main(): Promise<void> {
  // `mcp/.env` sits next to this file's package, wherever the client starts us
  // from. Shell environment variables win over the file.
  loadDotEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));

  const config = loadBridgeConfig();
  const bridge = new Bridge({ ...config, logger: stderrLogger });
  const port = await bridge.start();
  stderrLogger.log(`token fingerprint ${tokenFingerprint(config.token)} (${TOKEN_ENV})`);

  const client = new PluginClient(bridge);
  client.onStatus((status) => {
    stderrLogger.log(
      status.connected
        ? `plugin connected — ${status.file ? `${status.file.name} (${status.file.key})` : "file unknown"}`
        : `plugin not connected on port ${port}`,
    );
  });

  let shutdown: () => Promise<void>;
  if (USE_HTTP) {
    const httpPort = loadHttpPort();
    const http = await startHttpTransport({
      token: config.token,
      port: httpPort,
      createServer: () => createServer(client),
      logger: stderrLogger,
    });
    stderrLogger.log(
      `endpoint: http://127.0.0.1:${http.port}/mcp — tunnel this port; token via ` +
        `Authorization: Bearer or in the path as /t/<token>/mcp`,
    );
    shutdown = async () => {
      await http.close().catch(() => {});
      await bridge.stop().catch(() => {});
      process.exit(0);
    };
  } else {
    const server = createServer(client);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    stderrLogger.log("stdio transport ready");
    shutdown = async () => {
      await server.close().catch(() => {});
      await bridge.stop().catch(() => {});
      process.exit(0);
    };
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error: Error) => {
  stderrLogger.log(`fatal: ${error.message}`);
  process.exit(1);
});
