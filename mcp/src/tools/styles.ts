import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginClient } from "../client.js";
import { registerTools, type AnyToolDefinition, type ToolDefinition, type ToolPayload } from "./registry.js";

interface UpsertTextStyleResult {
  style: {
    id: string;
    name: string;
    codeKey: string | null;
    created: boolean;
    fontFamily: string;
    fontStyle: string;
    fontSize: number;
  };
}

interface UpsertEffectStyleResult {
  style: {
    id: string;
    name: string;
    codeKey: string | null;
    created: boolean;
    effectCount: number;
  };
}

const effectInput = z.object({
  type: z
    .enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"])
    .describe("Effect type. Blur types use only `radius`."),
  color: z.string().optional().describe('Shadow colour, hex or rgb(), e.g. "#00000040".'),
  offset: z.object({ x: z.number().optional(), y: z.number().optional() }).optional().describe("Shadow offset in px."),
  radius: z.number().optional().describe("Blur radius in px."),
  spread: z.number().optional().describe("Shadow spread in px (shadows only)."),
  visible: z.boolean().optional().describe("Default true."),
});

export const upsertTextStyleTool: ToolDefinition<{
  name: z.ZodString;
  codeKey: z.ZodOptional<z.ZodString>;
  description: z.ZodOptional<z.ZodString>;
  fontFamily: z.ZodOptional<z.ZodString>;
  fontStyle: z.ZodOptional<z.ZodString>;
  fontSize: z.ZodOptional<z.ZodNumber>;
  lineHeight: z.ZodOptional<z.ZodUnion<[z.ZodNumber, z.ZodObject<{ percent: z.ZodNumber }>, z.ZodLiteral<"auto">]>>;
  letterSpacing: z.ZodOptional<z.ZodUnion<[z.ZodNumber, z.ZodObject<{ percent: z.ZodNumber }>]>>;
}> = {
  name: "upsert_text_style",
  title: "Elf: upsert text style",
  description:
    "Create or update a local Figma text style (not a variable — named text styles live in the styles " +
    "panel). Matched by codeKey first, then by name. The font is loaded before anything is written, so an " +
    "unavailable family fails without leaving a half-configured style behind.",
  inputSchema: {
    name: z.string().describe('Style name, e.g. "Body/Regular".'),
    codeKey: z.string().optional().describe("Code-side key stored as shared plugin data; preferred match key."),
    description: z.string().optional().describe("Style description shown in Figma's styles panel."),
    fontFamily: z.string().optional().describe('Font family, default "Inter".'),
    fontStyle: z.string().optional().describe('Font style, default "Regular".'),
    fontSize: z.number().optional().describe("Font size in px."),
    lineHeight: z
      .union([z.number(), z.object({ percent: z.number() }), z.literal("auto")])
      .optional()
      .describe("Line height: px, { percent }, or \"auto\"."),
    letterSpacing: z
      .union([z.number(), z.object({ percent: z.number() })])
      .optional()
      .describe("Letter spacing: px or { percent }."),
  },
  handler: async (client: PluginClient, args): Promise<ToolPayload> => {
    const result = await client.call<UpsertTextStyleResult>("upsert_text_style", {
      name: args.name,
      codeKey: args.codeKey,
      description: args.description,
      fontFamily: args.fontFamily,
      fontStyle: args.fontStyle,
      fontSize: args.fontSize,
      lineHeight: args.lineHeight,
      letterSpacing: args.letterSpacing,
    });
    return { ok: true, style: result.style, created: result.style.created };
  },
};

export const upsertEffectStyleTool: ToolDefinition<{
  name: z.ZodString;
  codeKey: z.ZodOptional<z.ZodString>;
  description: z.ZodOptional<z.ZodString>;
  effects: z.ZodArray<typeof effectInput>;
}> = {
  name: "upsert_effect_style",
  title: "Elf: upsert effect style",
  description:
    "Create or update a local Figma effect style (shadows and blurs, e.g. elevation). Matched by codeKey " +
    "first, then by name. The whole effect list is replaced each call — effects are declarative, not merged.",
  inputSchema: {
    name: z.string().describe('Style name, e.g. "Elevation/2".'),
    codeKey: z.string().optional().describe("Code-side key stored as shared plugin data; preferred match key."),
    description: z.string().optional().describe("Style description shown in Figma's styles panel."),
    effects: z.array(effectInput).min(1).describe("The full effect list, top-most first."),
  },
  handler: async (client: PluginClient, args): Promise<ToolPayload> => {
    const result = await client.call<UpsertEffectStyleResult>("upsert_effect_style", {
      name: args.name,
      codeKey: args.codeKey,
      description: args.description,
      effects: args.effects,
    });
    return { ok: true, style: result.style, created: result.style.created };
  },
};

export const styleTools: AnyToolDefinition[] = [upsertTextStyleTool, upsertEffectStyleTool];

export function registerStyleTools(server: McpServer, client: PluginClient): void {
  registerTools(server, client, styleTools);
}
