import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { PluginClient } from "../client.js";
import { describeError } from "../errors.js";

/** Every tool returns this shape; `ok: false` carries the reason. */
export interface ToolPayload {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * `handler` is declared method-style on purpose: that makes it bivariant, so a
 * tool with a concrete schema is assignable to `AnyToolDefinition`.
 */
export interface ToolDefinition<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  handler(client: PluginClient, args: z.objectOutputType<Shape, z.ZodTypeAny>): Promise<ToolPayload>;
}

export type AnyToolDefinition = ToolDefinition<z.ZodRawShape>;

export function registerTools(
  server: McpServer,
  client: PluginClient,
  tools: AnyToolDefinition[],
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const payload = await tool.handler(client, args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
            isError: payload.ok === false,
          };
        } catch (error) {
          // Connection/timeout/plugin failures: surface the message as-is.
          return {
            content: [{ type: "text" as const, text: describeError(error) }],
            isError: true,
          };
        }
      },
    );
  }
}