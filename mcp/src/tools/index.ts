import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PluginClient } from "../client.js";
import { registerComponentTools } from "./components.js";
import { registerStatusTools } from "./status.js";
import { registerVariableTools } from "./variables.js";

export function registerAllTools(server: McpServer, client: PluginClient): void {
  registerStatusTools(server, client);
  registerVariableTools(server, client);
  registerComponentTools(server, client);
}

export { registerComponentTools, registerStatusTools, registerVariableTools };