import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { PluginClient } from "../client.js";
import { NOT_CONNECTED_HINT } from "../protocol.js";
import { registerTools, type ToolDefinition, type ToolPayload } from "./registry.js";

/**
 * The one tool that works with the plugin closed — it is how you find out
 * whether the plugin is open, so it never fails with "not connected".
 */
export const statusTool: ToolDefinition<z.ZodRawShape> = {
  name: "status",
  title: "Elf: bridge status",
  description:
    "Report whether the Elf Bridge plugin is connected to this MCP server, which Figma file it is " +
    "attached to, and which port the bridge is listening on. Start here when any other tool fails.",
  inputSchema: {},
  handler: async (client: PluginClient): Promise<ToolPayload> => {
    const status = client.status;
    return {
      ok: true,
      connected: status.connected,
      file: status.file,
      plugin: status.plugin,
      port: status.port,
      address: status.address,
      connectedAt: status.connectedAt,
      hint: status.connected ? undefined : NOT_CONNECTED_HINT,
    };
  },
};

export function registerStatusTools(server: McpServer, client: PluginClient): void {
  registerTools(server, client, [statusTool]);
}