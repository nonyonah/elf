#!/usr/bin/env node

import { McpFigmaOnboarding } from '../../src/mcp-figma-onboarding.js';
import { registerFigmaOnboardingTools } from './tools/onboarding.js';
import { registerMcpPresence } from './presence.js';
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findConfigPath } from "../../src/config.js";
import { ProjectService } from "../../src/project.js";
import { registerProjectTools } from "./tools/project.js";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { acquireBridge } from "./runtime.js";
import { PluginClient } from "./client.js";
import { loadRuntimeBridgeConfig, loadDotEnvFile, loadHttpPort, tokenFingerprint } from "./config.js";
import { startHttpTransport } from "./http.js";
import { stderrLogger } from "./logger.js";
import { TOKEN_ENV } from "./protocol.js";
import { registerAllTools } from "./tools/index.js";

/** `--http` serves Streamable HTTP (web clients + tunnels); default is stdio. */
// Imported project configuration may log; stdout is reserved for MCP frames.
console.log = (...args: unknown[]) => console.error(...args);

const USE_HTTP = process.argv.includes("--http");

function createServer(client: PluginClient, project?: ProjectService, onboarding?: McpFigmaOnboarding): McpServer {
  const server = new McpServer({ name: "elf-figma", version: "0.1.0" });
  registerAllTools(server, client);
  if (onboarding) registerFigmaOnboardingTools(server, onboarding);
  if (project) registerProjectTools(server, project);
  return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { console.error("elf mcp [--project <folder>] [--http]\nProject tools are local stdio tools. HTTP exposes Figma tools only."); return; }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--http") continue;
    if (args[i] === "--project" && args[i + 1] && !args[i + 1].startsWith("--")) { i += 1; continue; }
    throw new Error(`Unknown or incomplete MCP option: ${args[i]}`);
  }
  // `mcp/.env` sits next to this file's package, wherever the client starts us
  // from. Shell environment variables win over the file.
  loadDotEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));

  const projectIndex = process.argv.indexOf("--project");
  if (projectIndex >= 0 && !process.argv[projectIndex + 1]) throw new Error("--project needs a project folder.");
  const explicitProject = projectIndex >= 0 ? resolve(process.argv[projectIndex + 1], "elf.config.json") : null;
  if (explicitProject && (!existsSync(dirname(explicitProject)) || !statSync(dirname(explicitProject)).isDirectory())) throw new Error("Choose an existing project directory.");
  const projectPath = !USE_HTTP ? explicitProject ?? findConfigPath() : null;
  const config = loadRuntimeBridgeConfig();
  const runtime = await acquireBridge(config, stderrLogger);
  const project = projectPath ? new ProjectService(projectPath, runtime) : undefined;
  if (runtime.connection.status.port !== null) process.env.ELF_MCP_PORT = String(runtime.connection.status.port);
  const port = runtime.connection.status.port;
  const pairing = runtime.pairingCode;
  if (pairing) {
    stderrLogger.log(
      `pairing code ${pairing.code} — paste it into the Elf Bridge plugin ` +
        `(single-use; expires at ${new Date(pairing.expiresAt).toLocaleTimeString()})`,
    );
  }
  stderrLogger.log(`token fingerprint ${tokenFingerprint(config.token)} (${TOKEN_ENV})`);

  const onboarding = USE_HTTP ? undefined : new McpFigmaOnboarding(runtime, projectPath);
  const client = onboarding
    ? new PluginClient(onboarding.connection(), (_fileKey, work) => onboarding.transaction(work))
    : new PluginClient(runtime.connection, (fileKey, work) => runtime.transaction(fileKey, work, {authorization: 'strict'}));
  client.onStatus((status) => {
    stderrLogger.log(
      status.connected
        ? `plugin connected — ${status.file ? `${status.file.name} (${status.file.key})` : "file unknown"}`
        : `plugin not connected on port ${port}`,
    );
  });

  let shutdown: () => Promise<void>;
  const makeServer = () => {
    const server = createServer(client, project, onboarding);
    registerMcpPresence(server, {...config, port: port!}, stderrLogger);
    return server;
  };
  if (USE_HTTP) {
    const httpPort = loadHttpPort();
    const http = await startHttpTransport({
      token: config.token,
      port: httpPort,
      createServer: makeServer,
      logger: stderrLogger,
    });
    stderrLogger.log(
      `endpoint: http://127.0.0.1:${http.port}/mcp — tunnel this port; token via ` +
        `Authorization: Bearer or in the path as /t/<token>/mcp`,
    );
    shutdown = async () => {
      await http.close().catch(() => {});
      await runtime.close().catch(() => {});
      process.exit(0);
    };
  } else {
    const server = makeServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    stderrLogger.log("stdio transport ready");
    shutdown = async () => {
      await server.close().catch(() => {});
      await onboarding?.close().catch(() => {});
      await runtime.close().catch(() => {});
      process.exit(0);
    };
  }

  process.stdin.once("end", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error: Error) => {
  stderrLogger.log(`fatal: ${error.message}`);
  process.exit(1);
});
