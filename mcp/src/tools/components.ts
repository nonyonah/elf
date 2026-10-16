import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginClient } from "../client.js";
import type { PluginComponent, PluginNode } from "../plugin-types.js";
import { registerTools, type AnyToolDefinition, type ToolDefinition, type ToolPayload } from "./registry.js";

interface ComponentsResult {
  parentId: string;
  components: PluginComponent[];
}

interface CanvasChild {
  id: string;
  type: string;
  codeKey: string | null;
}

interface UpsertComponentResult {
  component: PluginComponent & { created: boolean };
  boundVariables: Record<string, { variableId: string; variableName: string }>;
  text: { id: string; characters: string } | null;
  children: CanvasChild[];
}

interface UpsertComponentSetResult {
  set: {
    id: string;
    name: string;
    codeKey: string | null;
    created: boolean;
    variantCount: number;
    variants: { id: string; name: string }[];
    parentId: string;
  };
}

interface GetNodeResult {
  node: PluginNode;
}

/** A literal number, or `{ variable: "name" }` to bind a FLOAT variable. */
const numberOrRef = z.union([
  z.number(),
  z.object({ variable: z.string() }).describe('FLOAT variable name, "collection/name", or id.'),
]);

/** A literal colour, or `{ variable: "name" }` to bind a COLOR variable. */
const fillInput = z.union([
  z.object({
    color: z.string().describe('Hex or rgb(), e.g. "#6366f1".'),
    opacity: z.number().min(0).max(1).optional(),
  }),
  z.object({
    variable: z.string().describe('COLOR variable name, "collection/name", or id.'),
    color: z
      .string()
      .optional()
      .describe('Fallback colour kept under the binding, e.g. "#000000".'),
  }),
]);

/** An instance slot: points at another component by its codeKey. */
const instanceChild = z.object({
  type: z.literal("instance"),
  component: z
    .string()
    .describe("codeKey of the component or component set to instantiate — it must already exist in the file."),
});

const layoutModeInput = z
  .enum(["HORIZONTAL", "VERTICAL", "NONE"])
  .optional()
  .describe("Auto-layout direction. `gap` and `padding` need HORIZONTAL or VERTICAL. Inherited on update.");

const paddingInput = z
  .object({
    all: numberOrRef.optional(),
    top: numberOrRef.optional(),
    right: numberOrRef.optional(),
    bottom: numberOrRef.optional(),
    left: numberOrRef.optional(),
  })
  .optional()
  .describe("Padding per side; `all` is the fallback for the sides that are not given.");

const gapInput = numberOrRef.optional().describe("Item spacing: a number, or { variable } for a FLOAT variable.");

const cornerRadiusInput = numberOrRef
  .optional()
  .describe("Corner radius: a number, or { variable } for a FLOAT variable.");

const fillField = fillInput
  .optional()
  .describe("Background fill: a literal colour, or { variable } for a COLOR variable.");

const sizeInput = z
  .object({ width: z.number(), height: z.number() })
  .optional()
  .describe("Explicit size in px. Omit to let auto layout size the node.");

const textInput = z
  .object({
    characters: z.string().describe("Label text. Created or updated as a single text child."),
    fontFamily: z.string().optional().describe('Font family, default "Inter" (loaded before writing).'),
    fontStyle: z.string().optional().describe('Font style, default "Regular".'),
    fontSize: z.number().optional().describe("Font size in px."),
    color: fillInput.optional().describe("Text colour: literal or bound to a COLOR variable."),
  })
  .optional()
  .describe("Optional text child. Upserted in place — repeated calls edit the same label.");

const childrenInput = z
  .array(instanceChild)
  .optional()
  .describe(
    "Instance slot children, in order. Providing this rebuilds the slots each call; omitting it leaves " +
      "existing children alone.",
  );

/** The styling fields shared by components, component sets and their variants. */
const componentSpecShape = {
  layoutMode: layoutModeInput,
  padding: paddingInput,
  gap: gapInput,
  cornerRadius: cornerRadiusInput,
  fill: fillField,
  size: sizeInput,
  text: textInput,
  children: childrenInput,
} satisfies z.ZodRawShape;

type ComponentSpecShape = typeof componentSpecShape;

export const listComponentsTool: ToolDefinition<{
  parentId: z.ZodOptional<z.ZodString>;
  deep: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: "list_components",
  title: "Elf: list components",
  description:
    "List components in the open Figma file, with their stored codeKey. Searches the current page by " +
    "default; pass `parentId` to scope it to a frame and `deep: true` to walk nested frames.",
  inputSchema: {
    parentId: z.string().optional().describe("Container node id. Defaults to the current page."),
    deep: z.boolean().optional().describe("Also walk into child frames. Default false (direct children only)."),
  },
  handler: async (client: PluginClient, args): Promise<ToolPayload> => {
    const result = await client.call<ComponentsResult>("list_components", {
      parentId: args.parentId,
      deep: args.deep,
    });
    return { ok: true, parentId: result.parentId, components: result.components };
  },
};

export const upsertComponentTool: ToolDefinition<
  ComponentSpecShape & {
    name: z.ZodString;
    codeKey: z.ZodOptional<z.ZodString>;
    parentId: z.ZodOptional<z.ZodString>;
  }
> = {
  name: "upsert_component",
  title: "Elf: upsert component",
  description:
    "Create or update one basic component (auto-layout direction, padding, gap, corner radius, fill, " +
    "optional text child, instance slot children). Matched by codeKey first, then by name — running this " +
    "twice updates instead of duplicating. Every numeric property and the fill take either a literal value " +
    'or { variable: "name" } to bind a Figma variable. Omitted properties are left untouched; `children` ' +
    "rebuilds the instance slots.",
  inputSchema: {
    name: z.string().describe('Component name, e.g. "Button/Primary".'),
    codeKey: z
      .string()
      .optional()
      .describe(
        'Code-side key stored as shared plugin data (namespace "elf", key "codeKey"); preferred match key.',
      ),
    parentId: z.string().optional().describe("Container node id. Defaults to the current page."),
    ...componentSpecShape,
  },
  handler: async (client: PluginClient, args): Promise<ToolPayload> => {
    const result = await client.call<UpsertComponentResult>("upsert_component", {
      name: args.name,
      codeKey: args.codeKey,
      parentId: args.parentId,
      layoutMode: args.layoutMode,
      padding: args.padding,
      gap: args.gap,
      cornerRadius: args.cornerRadius,
      fill: args.fill,
      size: args.size,
      text: args.text,
      children: args.children,
    });
    return {
      ok: true,
      component: result.component,
      created: result.component.created,
      boundVariables: result.boundVariables,
      text: result.text,
      children: result.children,
    };
  },
};

const variantInput = z.object({
  props: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .describe('Variant property values, e.g. { size: "sm", intent: "primary" }.'),
  spec: z
    .object(componentSpecShape)
    .optional()
    .describe("Per-variant overrides on top of the set-level styling fields."),
});

export const upsertComponentSetTool: ToolDefinition<
  ComponentSpecShape & {
    name: z.ZodString;
    codeKey: z.ZodOptional<z.ZodString>;
    parentId: z.ZodOptional<z.ZodString>;
    variants: z.ZodArray<typeof variantInput>;
  }
> = {
  name: "upsert_component_set",
  title: "Elf: upsert component set",
  description:
    "Create or update a Figma component set from explicit variants (e.g. size × intent). Each variant names " +
    "its property values and can override any styling field; all variants must declare the same properties. " +
    "A matching roster updates variants in place; a changed roster rebuilds the set — instances of the old " +
    "set detach (documented Figma behaviour).",
  inputSchema: {
    name: z.string().describe('Component set name, e.g. "Button".'),
    codeKey: z.string().optional().describe('Code-side key stored as shared plugin data; preferred match key.'),
    parentId: z.string().optional().describe("Container node id. Defaults to the current page."),
    variants: z
      .array(variantInput)
      .min(1)
      .describe("Variant list. The first variant defines the property keys every other variant must match."),
    ...componentSpecShape,
  },
  handler: async (client: PluginClient, args): Promise<ToolPayload> => {
    const result = await client.call<UpsertComponentSetResult>("upsert_component_set", {
      name: args.name,
      codeKey: args.codeKey,
      parentId: args.parentId,
      variants: args.variants,
      layoutMode: args.layoutMode,
      padding: args.padding,
      gap: args.gap,
      cornerRadius: args.cornerRadius,
      fill: args.fill,
      size: args.size,
      text: args.text,
      children: args.children,
    });
    return { ok: true, set: result.set, created: result.set.created };
  },
};

export const getNodeTool: ToolDefinition<{
  nodeId: z.ZodString;
  depth: z.ZodOptional<z.ZodNumber>;
}> = {
  name: "get_node",
  title: "Elf: read a node",
  description:
    "Read one node back: name, type, codeKey, layout (mode, padding, gap, corner radius), fills with " +
    "their bound variables, and the raw `boundVariables` map. Use it to verify what a write actually did.",
  inputSchema: {
    nodeId: z.string().describe('Node id, e.g. "12:34" (returned by upsert_component).'),
    depth: z
      .number()
      .optional()
      .describe("How many levels of children to include: 0–3, default 1."),
  },
  handler: async (client: PluginClient, args): Promise<ToolPayload> => {
    const result = await client.call<GetNodeResult>("get_node", { nodeId: args.nodeId, depth: args.depth });
    return { ok: true, node: result.node };
  },
};

export const componentTools: AnyToolDefinition[] = [
  listComponentsTool,
  upsertComponentTool,
  upsertComponentSetTool,
  getNodeTool,
];

export function registerComponentTools(server: McpServer, client: PluginClient): void {
  registerTools(server, client, componentTools);
}
